import { FINAL_STAGE, STAGE_OFFSETS_MIN, dailyBudget, runIngestion, writesUsedToday } from './ingest';
import { ensureSchema } from './schema';
import { Env } from './types';
import { isSolanaAddress, looksLikeAddress, safeEqual } from './util';

export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), camera=(), microphone=()',
};

function json(body: unknown, status = 200, cacheSec = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 認証付き応答を共有キャッシュに載せない
      'cache-control': cacheSec > 0 ? `private, max-age=${cacheSec}` : 'no-store',
      ...SECURITY_HEADERS,
    },
  });
}

const err = (status: number, code: string) => json({ error: code }, status);

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** isolate 内メモリキャッシュ。D1 の読み取り行数（無料枠 500 万/日）を守るため */
const memo = new Map<string, { exp: number; value: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.exp > now) return hit.value as T;
  const value = await fn();
  if (memo.size > 200) memo.clear();
  memo.set(key, { exp: now + ttlMs, value });
  return value;
}
export function clearApiCache(): void {
  memo.clear();
}

/** isolate 内の簡易レート制限（管理 API 用）。分散環境では厳密ではない */
const hits = new Map<string, { n: number; reset: number }>();
function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    if (hits.size > 1000) hits.clear();
    hits.set(key, { n: 1, reset: now + windowMs });
    return false;
  }
  h.n++;
  return h.n > limit;
}

const TOKEN_LIST_COLS = `mint, name, symbol, primary_dex_id, primary_pool_address, first_pool_created_at, detected_at,
  detection_delay_sec, snapshot_stage, initial_price_usd, last_price_usd, last_liquidity_usd, last_fdv_usd,
  last_market_cap_usd, last_volume_h24_usd, last_observed_at, last_source`;

async function getStatus(env: Env) {
  const db = env.DB;
  const now = Date.now();
  const d1 = now - 86_400_000;
  const [runs, lastRun, lastOk, delay, totals, errors, gaps] = await db.batch([
    db.prepare(
      `SELECT status, COUNT(*) AS n, COALESCE(SUM(tokens_new),0) AS tokens_new, COALESCE(SUM(tokens_skipped_budget),0) AS skipped,
              SUM(snapshots_written) AS snaps, SUM(snapshots_missing) AS snaps_missing, SUM(api_calls) AS api_calls
       FROM ingestion_runs WHERE job = 'ingest' AND started_at >= ?1 GROUP BY status`,
    ).bind(d1),
    db.prepare(`SELECT * FROM ingestion_runs WHERE job = 'ingest' ORDER BY id DESC LIMIT 1`),
    db.prepare(`SELECT started_at FROM ingestion_runs WHERE job = 'ingest' AND status = 'ok' ORDER BY id DESC LIMIT 1`),
    db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN detection_delay_sec IS NULL THEN 1 ELSE 0 END), 0) AS unknown,
              COALESCE(SUM(CASE WHEN detection_delay_sec <= 30 THEN 1 ELSE 0 END), 0) AS le30,
              COALESCE(SUM(CASE WHEN detection_delay_sec <= 60 THEN 1 ELSE 0 END), 0) AS le60,
              COALESCE(SUM(CASE WHEN detection_delay_sec <= 180 THEN 1 ELSE 0 END), 0) AS le180,
              COALESCE(SUM(CASE WHEN detection_delay_sec <= 300 THEN 1 ELSE 0 END), 0) AS le300
       FROM tokens WHERE detected_at >= ?1`,
    ).bind(d1),
    db.prepare(`SELECT COUNT(*) AS tracking FROM tokens WHERE next_snapshot_at IS NOT NULL`),
    db.prepare(
      `SELECT occurred_at, component, source, http_status, message FROM system_errors
       WHERE occurred_at >= ?1 ORDER BY id DESC LIMIT 20`,
    ).bind(d1),
    db.prepare(
      `SELECT data_quality, COUNT(*) AS n FROM price_snapshots WHERE observed_at >= ?1 GROUP BY data_quality`,
    ).bind(d1),
  ]);
  const used = await writesUsedToday(db, now);
  return {
    generated_at: now,
    last_run: lastRun.results[0] ?? null,
    last_ok_at: (lastOk.results[0] as { started_at: number } | undefined)?.started_at ?? null,
    runs_24h: runs.results,
    // 注意: 検出済み銘柄だけの遅延分布。検出漏れは含まれず、網羅的な「検出率」ではない
    detection_delay_24h: delay.results[0] ?? null,
    tracking_tokens: (totals.results[0] as { tracking: number } | undefined)?.tracking ?? 0,
    snapshot_quality_24h: gaps.results,
    errors_24h: errors.results,
    write_budget: { used_today: used, budget: dailyBudget(env), d1_free_limit: 100_000 },
    stage_offsets_min: STAGE_OFFSETS_MIN,
    final_stage: FINAL_STAGE,
    auth_required: !!env.ACCESS_TOKEN,
  };
}

async function listTokens(env: Env, url: URL) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const beforeRaw = Number(url.searchParams.get('before'));
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : Number.MAX_SAFE_INTEGER;
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 44);
  const sort = url.searchParams.get('sort') === 'liquidity' ? 'liquidity' : 'new';
  const minLiq = Math.max(0, Number(url.searchParams.get('min_liq')) || 0);

  const where: string[] = ['detected_at < ?1'];
  const binds: (string | number)[] = [before];
  if (q) {
    if (looksLikeAddress(q)) {
      where.push(`mint = ?${binds.length + 1}`);
      binds.push(q);
    } else {
      if (q.length < 2 || !/^[\p{L}\p{N} $._-]+$/u.test(q)) return { tokens: [], next_before: null };
      // 全件走査を避けるため直近 7 日に限定
      where.push(`detected_at >= ?${binds.length + 1}`);
      binds.push(Date.now() - 7 * 86_400_000);
      where.push(`(symbol LIKE ?${binds.length + 1} ESCAPE '\\' OR name LIKE ?${binds.length + 1} ESCAPE '\\')`);
      binds.push(`${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
  }
  if (sort === 'liquidity') {
    // 流動性順は直近 24 時間の検出分に限定（索引の範囲読み取りで済ませる）
    where.push(`detected_at >= ?${binds.length + 1}`);
    binds.push(Date.now() - 86_400_000);
  }
  if (minLiq > 0) {
    where.push(`last_liquidity_usd >= ?${binds.length + 1}`);
    binds.push(minLiq);
  }
  const order = sort === 'liquidity' ? 'last_liquidity_usd DESC, detected_at DESC' : 'detected_at DESC';
  const rows = (
    await env.DB.prepare(`SELECT ${TOKEN_LIST_COLS} FROM tokens WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`)
      .bind(...binds)
      .all<{ detected_at: number }>()
  ).results;
  const next = sort === 'new' && rows.length === limit ? rows[rows.length - 1].detected_at : null;
  return { tokens: rows, next_before: next, generated_at: Date.now() };
}

async function tokenDetail(env: Env, mint: string) {
  const db = env.DB;
  const [tok, pools, snaps, events] = await db.batch([
    db.prepare(`SELECT * FROM tokens WHERE mint = ?1`).bind(mint),
    db.prepare(`SELECT * FROM liquidity_pools WHERE mint = ?1 ORDER BY pool_created_at LIMIT 20`).bind(mint),
    db.prepare(`SELECT * FROM price_snapshots WHERE mint = ?1 ORDER BY stage`).bind(mint),
    db.prepare(`SELECT event_type, ref, source, observed_at FROM token_events WHERE mint = ?1 ORDER BY id LIMIT 50`).bind(mint),
  ]);
  if (!tok.results[0]) return null;
  return {
    token: tok.results[0],
    pools: pools.results,
    snapshots: snaps.results,
    events: events.results,
    // Phase 3 以降で取得する項目。現時点では取得処理が無いため「未取得」
    not_collected: [
      'minted_at', 'first_trade_at', 'holder_count', 'top_holder_pct', 'developer_wallet', 'mint_authority',
      'freeze_authority', 'token_program', 'token_2022_extensions', 'lp_status', 'unique_buyers',
    ],
    stage_offsets_min: STAGE_OFFSETS_MIN,
    generated_at: Date.now(),
  };
}

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // 同一オリジン専用。CORS ヘッダは返さない（= 他オリジンのブラウザからは読めない）
  if (req.method === 'OPTIONS') return err(405, 'method_not_allowed');

  if (path === '/api/health') return json({ ok: true, auth_required: !!env.ACCESS_TOKEN });

  if (env.ACCESS_TOKEN) {
    const t = bearer(req);
    if (!t || !safeEqual(t, env.ACCESS_TOKEN)) {
      const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
      if (rateLimited(`auth:${ip}`, 20, 60_000)) return err(429, 'too_many_requests');
      return err(401, 'unauthorized');
    }
  }

  try {
    if (path.startsWith('/api/admin/')) {
      if (!env.ADMIN_TOKEN) return err(404, 'not_found');
      const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
      if (rateLimited(`admin:${ip}`, 6, 60_000)) return err(429, 'too_many_requests');
      const t = req.headers.get('x-admin-token');
      if (!t || !safeEqual(t, env.ADMIN_TOKEN)) return err(401, 'unauthorized');
      if (path === '/api/admin/run' && req.method === 'POST') {
        const r = await runIngestion(env);
        clearApiCache();
        return json({ status: r.status, stats: r.stats, errors: r.errors.map((e) => ({ component: e.component, message: e.message })) });
      }
      return err(404, 'not_found');
    }

    if (req.method !== 'GET') return err(405, 'method_not_allowed');
    await ensureSchema(env.DB);

    if (path === '/api/status') return json(await cached('status', 30_000, () => getStatus(env)), 200, 15);
    if (path === '/api/tokens') {
      const key = `tokens:${url.searchParams.toString().slice(0, 200)}`;
      return json(await cached(key, 20_000, () => listTokens(env, url)), 200, 10);
    }
    const m = path.match(/^\/api\/tokens\/([^/]+)$/);
    if (m) {
      if (!isSolanaAddress(m[1])) return err(400, 'invalid_mint');
      const d = await cached(`token:${m[1]}`, 20_000, () => tokenDetail(env, m[1]));
      return d ? json(d, 200, 10) : err(404, 'not_found');
    }
    return err(404, 'not_found');
  } catch (e) {
    console.error('api error', path, e instanceof Error ? e.message : 'unknown');
    return err(500, 'internal_error');
  }
}
