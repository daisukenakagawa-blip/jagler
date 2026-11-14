import { Touched, runPaper } from './paper';
import { runRiskChecks } from './risk';
import { ensureSchema } from './schema';
import {
  DP_DEFAULT_BASE,
  DS_DEFAULT_BASE,
  DS_MAX_ADDRESSES,
  GT_DEFAULT_BASE,
  dpNewPoolsUrl,
  dsTokensUrl,
  gtNewPoolsUrl,
  parseDpNewPools,
  parseDsTokens,
  parseGtNewPools,
} from './sources';
import { DetectedPool, EMPTY_MARKET, Env, MarketData } from './types';
import { HttpError, fetchJson, intVar, utcDayStart } from './util';

/** 検出後の追跡スナップショット時点（分）。ステージ 0 は検出時。 */
export const STAGE_OFFSETS_MIN = [5, 15, 60, 360, 1440];
export const FINAL_STAGE = STAGE_OFFSETS_MIN.length;
/** API 障害時、この時間を超えて遅れた追跡は「欠損」として記録し先へ進める */
export const OVERDUE_GIVE_UP_MS = 10 * 60_000;
/** 予算のこの割合を超えたら新規トークンの保存を止め、既存銘柄の追跡を優先する */
export const NEW_TOKEN_BUDGET_RATIO = 0.85;

/**
 * 1 銘柄を検出から 24 時間追跡し終えるまでの D1 書き込み行数の見積り
 * （行 + 索引。収集・追跡で約 29 行（ローカル D1 実測）+ リスク判定で約 6 行 + 仮想売買で最大十数行）。新規保存ペースの計算に使う。
 */
export const EST_WRITES_PER_TOKEN = 50;

/**
 * その時点までに保存してよい新規銘柄の累計数。
 * 予算を 1 日に均等配分する（早い時間帯に枠を使い切って、時間帯の偏った標本になるのを防ぐ）。
 */
export function newTokenAllowance(now: number, budget: number, tokensToday: number): number {
  const minutesElapsed = Math.floor((now - utcDayStart(now)) / 60_000) + 1;
  const perMinute = (budget * NEW_TOKEN_BUDGET_RATIO) / EST_WRITES_PER_TOKEN / 1440;
  return Math.max(0, Math.floor(minutesElapsed * perMinute) - tokensToday);
}

export function nextSnapshotAt(detectedAt: number, completedStage: number): number | null {
  if (completedStage >= FINAL_STAGE) return null;
  return detectedAt + STAGE_OFFSETS_MIN[completedStage] * 60_000;
}

export function snapshotQuality(m: MarketData): 'ok' | 'partial' {
  return m.priceUsd !== null && m.liquidityUsd !== null ? 'ok' : 'partial';
}

export function detectionDelaySec(now: number, poolCreatedAt: number | null): number | null {
  if (poolCreatedAt === null) return null;
  return Math.max(0, Math.round((now - poolCreatedAt) / 1000));
}

interface RunStats {
  poolsSeen: number;
  tokensNew: number;
  tokensSkippedBudget: number;
  snapshotsWritten: number;
  snapshotsMissing: number;
  rowsWritten: number;
  apiCalls: number;
  /** この実行でスナップショットが増えた銘柄（仮想売買エンジンに渡す。DB には保存しない） */
  touched: Touched[];
}
interface RunError {
  component: string;
  source: string | null;
  status: number | null;
  message: string;
}

function toRunError(component: string, e: unknown): RunError {
  if (e instanceof HttpError) return { component, source: e.source, status: e.status, message: e.message };
  return { component, source: null, status: null, message: e instanceof Error ? e.message.slice(0, 300) : 'unknown error' };
}

function sumWritten(results: D1Result[]): number {
  let n = 0;
  for (const r of results) n += r.meta?.rows_written ?? r.meta?.changes ?? 0;
  return n;
}

const SNAPSHOT_SQL = `INSERT OR IGNORE INTO price_snapshots
  (mint, pool_address, source, stage, observed_at, price_usd, market_cap_usd, fdv_usd, liquidity_usd,
   volume_m5_usd, volume_h1_usd, volume_h24_usd, buys_m5, sells_m5, buys_h1, sells_h1, buys_h24, sells_h24,
   buyers_h24, sellers_h24, data_quality, saved_at)
  VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)`;

function snapshotStmt(
  db: D1Database,
  mint: string,
  pool: string | null,
  source: string,
  stage: number,
  now: number,
  m: MarketData,
  quality: string,
): D1PreparedStatement {
  return db
    .prepare(SNAPSHOT_SQL)
    .bind(
      mint, pool, source, stage, now, m.priceUsd, m.marketCapUsd, m.fdvUsd, m.liquidityUsd,
      m.volumeM5Usd, m.volumeH1Usd, m.volumeH24Usd, m.buysM5, m.sellsM5, m.buysH1, m.sellsH1,
      m.buysH24, m.sellsH24, m.buyersH24, m.sellersH24, quality, now,
    );
}

async function selectIn(db: D1Database, sql: string, values: string[]): Promise<Set<string>> {
  if (values.length === 0) return new Set();
  const ph = values.map((_, i) => `?${i + 1}`).join(',');
  const res = await db.prepare(sql.replace('__IN__', ph)).bind(...values).all<{ v: string }>();
  return new Set(res.results.map((r) => r.v));
}

/** 新規プールの一覧を取得する。GeckoTerminal が失敗したら DexPaprika を予備として使う */
async function fetchNewPools(env: Env, stats: RunStats, errors: RunError[]): Promise<{ source: string; pools: DetectedPool[] }> {
  try {
    const json = await fetchJson(
      'geckoterminal',
      gtNewPoolsUrl(env.GT_BASE_URL || GT_DEFAULT_BASE),
      { retries429: 1 }, // 共有 IP 由来とみられる 429 が出るため、同じ実行内で 1 回だけ待って再試行
      stats,
    );
    return { source: 'geckoterminal', pools: parseGtNewPools(json) };
  } catch (primary) {
    try {
      const json = await fetchJson('dexpaprika', dpNewPoolsUrl(env.DP_BASE_URL || DP_DEFAULT_BASE), { retries: 0 }, stats);
      // 予備で取得できた場合も、主系の失敗は記録に残す（稼働状況で見えるように）
      errors.push(toRunError('discover_primary', primary));
      return { source: 'dexpaprika', pools: parseDpNewPools(json) };
    } catch (fallback) {
      errors.push(toRunError('discover_fallback', fallback));
      throw primary;
    }
  }
}

/** 新規プールの検出と保存 */
async function discover(env: Env, now: number, allowance: number, stats: RunStats, errors: RunError[]): Promise<void> {
  const db = env.DB;
  const fetched = await fetchNewPools(env, stats, errors);
  const source = fetched.source;
  const seen = new Set<string>();
  const pools: DetectedPool[] = [];
  for (const p of fetched.pools) {
    if (seen.has(p.poolAddress)) continue;
    seen.add(p.poolAddress);
    pools.push(p);
  }
  stats.poolsSeen = pools.length;
  if (pools.length === 0) return;

  const knownPools = await selectIn(
    db,
    `SELECT pool_address AS v FROM liquidity_pools WHERE pool_address IN (__IN__)`,
    pools.map((p) => p.poolAddress),
  );
  const fresh = pools.filter((p) => !knownPools.has(p.poolAddress));
  if (fresh.length === 0) return;
  const knownMints = await selectIn(
    db,
    `SELECT mint AS v FROM tokens WHERE mint IN (__IN__)`,
    [...new Set(fresh.map((p) => p.mint))],
  );

  const maxNew = Math.min(intVar(env.MAX_NEW_TOKENS_PER_RUN, 2, 0, 20), allowance);
  const allowNew = allowance > 0;
  const newTokenPools: DetectedPool[] = [];
  const extraPools: DetectedPool[] = [];
  const decided = new Set<string>();
  for (const p of fresh) {
    const isNewToken = !knownMints.has(p.mint) && !decided.has(p.mint);
    if (!allowNew || (isNewToken && newTokenPools.length >= maxNew)) {
      if (isNewToken) {
        stats.tokensSkippedBudget++;
        decided.add(p.mint); // 同一ミントの二重カウント防止（保存はしない）
        knownMints.add(p.mint);
      }
      continue;
    }
    if (isNewToken) {
      decided.add(p.mint);
      newTokenPools.push(p);
    } else if (knownMints.has(p.mint) && !newTokenPools.some((n) => n.mint === p.mint) && decided.has(p.mint)) {
      continue; // 今回見送ったミントの別プール
    } else {
      extraPools.push(p);
    }
  }

  // 予備の検出元は名前・価格を持たないので、保存する銘柄だけ DEX Screener で実測値を補う
  let snapshotSource = source;
  if (source === 'dexpaprika' && newTokenPools.length > 0) {
    try {
      const mints = newTokenPools.map((p) => p.mint);
      const quotes = parseDsTokens(await fetchJson('dexscreener', dsTokensUrl(env.DS_BASE_URL || DS_DEFAULT_BASE, mints), {}, stats), mints);
      for (const p of newTokenPools) {
        const q = quotes.get(p.mint);
        if (!q) continue;
        p.name = q.name;
        p.symbol = q.symbol;
        p.market = q.market;
      }
      snapshotSource = 'dexscreener';
    } catch (e) {
      errors.push(toRunError('discover_enrich', e)); // 補えなければ価格等は未取得のまま保存する
    }
  }

  const stmts: D1PreparedStatement[] = [];
  const poolStmts = (p: DetectedPool) => [
    db
      .prepare(
        `INSERT OR IGNORE INTO liquidity_pools
         (pool_address, mint, dex_id, dex_name, quote_mint, quote_symbol, pool_created_at, source, observed_at, saved_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?9,?8,?8)`,
      )
      .bind(p.poolAddress, p.mint, p.dexId, p.dexName, p.quoteMint, p.quoteSymbol, p.poolCreatedAt, now, source),
    db
      .prepare(
        `INSERT OR IGNORE INTO token_events (mint, event_type, ref, source, observed_at, payload, saved_at)
         VALUES (?1,'pool_detected',?2,?5,?3,?4,?3)`,
      )
      .bind(p.mint, p.poolAddress, now, JSON.stringify({ dex: p.dexId, pool_created_at: p.poolCreatedAt }), source),
  ];
  for (const p of newTokenPools) {
    const m = p.market;
    const snapSrc = m.priceUsd !== null && snapshotSource === 'dexscreener' ? 'dexscreener' : source;
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO tokens
           (mint, name, symbol, decimals, first_pool_created_at, detected_at, detection_source, detection_delay_sec,
            primary_pool_address, primary_dex_id, snapshot_stage, next_snapshot_at, initial_price_usd,
            last_price_usd, last_liquidity_usd, last_fdv_usd, last_market_cap_usd, last_volume_h24_usd,
            last_observed_at, last_source, data_quality, saved_at)
           VALUES (?1,?2,?3,?4,?5,?6,?16,?7,?8,?9,0,?10,?11,?11,?12,?13,?14,?15,?6,?17,'partial',?6)`,
        )
        .bind(
          p.mint, p.name, p.symbol, p.decimals, p.poolCreatedAt, now, detectionDelaySec(now, p.poolCreatedAt),
          p.poolAddress, p.dexId, nextSnapshotAt(now, 0), m.priceUsd, m.liquidityUsd, m.fdvUsd, m.marketCapUsd,
          m.volumeH24Usd, source, snapSrc,
        ),
      snapshotStmt(db, p.mint, p.poolAddress, snapSrc, 0, now, m, snapshotQuality(m)),
      ...poolStmts(p),
    );
  }
  for (const p of extraPools) stmts.push(...poolStmts(p));
  if (stmts.length === 0) return;
  stats.rowsWritten += sumWritten(await db.batch(stmts));
  stats.tokensNew = newTokenPools.length;
  for (const p of newTokenPools) stats.touched.push({ mint: p.mint, stage: 0 });
  stats.snapshotsWritten += newTokenPools.length;
}

interface DueRow {
  mint: string;
  snapshot_stage: number;
  detected_at: number;
  next_snapshot_at: number;
}

/** 追跡スナップショット（検出から 5分/15分/1時間/6時間/24時間後） */
async function followUp(env: Env, now: number, stats: RunStats): Promise<void> {
  const db = env.DB;
  const due = (
    await db
      .prepare(
        `SELECT mint, snapshot_stage, detected_at, next_snapshot_at FROM tokens
         WHERE next_snapshot_at IS NOT NULL AND next_snapshot_at <= ?1
         ORDER BY next_snapshot_at LIMIT ${DS_MAX_ADDRESSES}`,
      )
      .bind(now)
      .all<DueRow>()
  ).results;
  if (due.length === 0) return;

  const advance = (r: DueRow) =>
    db
      .prepare(`UPDATE tokens SET snapshot_stage = ?2, next_snapshot_at = ?3 WHERE mint = ?1`)
      .bind(r.mint, r.snapshot_stage + 1, nextSnapshotAt(r.detected_at, r.snapshot_stage + 1));

  let quotes;
  try {
    const json = await fetchJson(
      'dexscreener',
      dsTokensUrl(env.DS_BASE_URL || DS_DEFAULT_BASE, due.map((d) => d.mint)),
      {},
      stats,
    );
    quotes = parseDsTokens(json, due.map((d) => d.mint));
  } catch (e) {
    // 取得失敗: 大きく遅れた分だけ「欠損」として確定させ、残りは次回再試行
    const stmts: D1PreparedStatement[] = [];
    for (const r of due) {
      if (now - r.next_snapshot_at <= OVERDUE_GIVE_UP_MS) continue;
      stmts.push(
        snapshotStmt(db, r.mint, null, 'dexscreener', r.snapshot_stage + 1, now, EMPTY_MARKET, 'missing_api_error'),
        advance(r),
      );
      stats.snapshotsMissing++;
      stats.touched.push({ mint: r.mint, stage: r.snapshot_stage + 1 });
    }
    if (stmts.length) stats.rowsWritten += sumWritten(await db.batch(stmts));
    throw e;
  }

  const stmts: D1PreparedStatement[] = [];
  for (const r of due) {
    const stage = r.snapshot_stage + 1;
    stats.touched.push({ mint: r.mint, stage });
    const q = quotes.get(r.mint);
    if (!q) {
      // API は応答したがペアが返らない（上場廃止・流動性消失など）。価格は捏造せず欠損として残す
      stmts.push(snapshotStmt(db, r.mint, null, 'dexscreener', stage, now, EMPTY_MARKET, 'missing_not_listed'), advance(r));
      stats.snapshotsMissing++;
      continue;
    }
    const m = q.market;
    stmts.push(
      snapshotStmt(db, r.mint, q.poolAddress, 'dexscreener', stage, now, m, snapshotQuality(m)),
      db
        .prepare(
          `UPDATE tokens SET snapshot_stage = ?2, next_snapshot_at = ?3, last_price_usd = ?4, last_liquidity_usd = ?5,
             last_fdv_usd = ?6, last_market_cap_usd = ?7, last_volume_h24_usd = ?8, last_observed_at = ?9,
             last_source = 'dexscreener', name = COALESCE(name, ?10), symbol = COALESCE(symbol, ?11)
           WHERE mint = ?1`,
        )
        .bind(
          r.mint, stage, nextSnapshotAt(r.detected_at, stage), m.priceUsd, m.liquidityUsd, m.fdvUsd, m.marketCapUsd,
          m.volumeH24Usd, now, q.name, q.symbol,
        ),
    );
    stats.snapshotsWritten++;
  }
  stats.rowsWritten += sumWritten(await db.batch(stmts));
}

export async function usageToday(db: D1Database, now: number): Promise<{ rows: number; tokens: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(rows_written), 0) AS n, COALESCE(SUM(tokens_new), 0) AS t
       FROM ingestion_runs WHERE started_at >= ?1`,
    )
    .bind(utcDayStart(now))
    .first<{ n: number; t: number }>();
  return { rows: row?.n ?? 0, tokens: row?.t ?? 0 };
}

export async function writesUsedToday(db: D1Database, now: number): Promise<number> {
  return (await usageToday(db, now)).rows;
}

export function dailyBudget(env: Env): number {
  return intVar(env.DAILY_WRITE_BUDGET, 80_000, 1_000, 50_000_000);
}

async function recordRun(
  db: D1Database,
  job: string,
  startedAt: number,
  status: string,
  stats: RunStats,
  errors: RunError[],
): Promise<void> {
  const finishedAt = Date.now();
  // この記録自体の書き込み（行 + 索引）を概算で加算する
  const selfWrites = 2 + errors.length * 2;
  const stmts = [
    db
      .prepare(
        `INSERT INTO ingestion_runs
         (job, started_at, finished_at, status, pools_seen, tokens_new, tokens_skipped_budget, snapshots_written,
          snapshots_missing, api_calls, rows_written, error_summary)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
      )
      .bind(
        job, startedAt, finishedAt, status, stats.poolsSeen, stats.tokensNew, stats.tokensSkippedBudget,
        stats.snapshotsWritten, stats.snapshotsMissing, stats.apiCalls, stats.rowsWritten + selfWrites,
        errors.length ? errors.map((e) => `${e.component}: ${e.message}`).join(' | ').slice(0, 500) : null,
      ),
    ...errors.map((e) =>
      db
        .prepare(`INSERT INTO system_errors (occurred_at, component, source, http_status, message) VALUES (?1,?2,?3,?4,?5)`)
        .bind(finishedAt, e.component, e.source, e.status, e.message),
    ),
  ];
  await db.batch(stmts);
}

const emptyStats = (): RunStats => ({
  poolsSeen: 0,
  tokensNew: 0,
  tokensSkippedBudget: 0,
  snapshotsWritten: 0,
  snapshotsMissing: 0,
  rowsWritten: 0,
  apiCalls: 0,
  touched: [],
});

/** 1 分ごとの定期処理本体 */
export async function runIngestion(env: Env, now = Date.now()): Promise<{ status: string; stats: RunStats; errors: RunError[] }> {
  const stats = emptyStats();
  const errors: RunError[] = [];
  let status = 'ok';
  try {
    await ensureSchema(env.DB);
    const budget = dailyBudget(env);
    const usage = await usageToday(env.DB, now);
    if (usage.rows >= budget) {
      status = 'budget_exhausted';
    } else {
      const allowance =
        usage.rows < budget * NEW_TOKEN_BUDGET_RATIO ? newTokenAllowance(now, budget, usage.tokens) : 0;
      try {
        await discover(env, now, allowance, stats, errors);
      } catch (e) {
        errors.push(toRunError('discover', e));
      }
      try {
        await followUp(env, now, stats);
      } catch (e) {
        errors.push(toRunError('follow_up', e));
      }
      const failed = (c: string) => errors.some((e) => e.component === c);
      const coreFailed = failed('discover') && failed('follow_up');
      try {
        await runRiskChecks(env, now, stats);
      } catch (e) {
        errors.push(toRunError('risk', e));
      }
      try {
        await runPaper(env, now, stats.touched, stats);
      } catch (e) {
        errors.push(toRunError('paper', e));
      }
      if (coreFailed) status = 'failed';
      else if (errors.length > 0) status = 'partial';
    }
  } catch (e) {
    errors.push(toRunError('run', e));
    status = 'failed';
  }
  try {
    await recordRun(env.DB, 'ingest', now, status, stats, errors);
  } catch (e) {
    // DB 自体が使えない場合は Workers Logs にだけ残す（シークレットは含めない）
    console.error('recordRun failed', e instanceof Error ? e.message : 'unknown');
  }
  return { status, stats, errors };
}

/** 日次の古いデータ整理。1 回あたりの削除量に上限を設ける（書き込み枠の保護） */
export async function runCleanup(env: Env, now = Date.now()): Promise<void> {
  const stats = emptyStats();
  const errors: RunError[] = [];
  try {
    await ensureSchema(env.DB);
    const db = env.DB;
    const days = intVar(env.RETENTION_DAYS, 90, 7, 3650);
    const cutoff = now - days * 86_400_000;
    const opsCutoff = now - 14 * 86_400_000;
    const old = `SELECT mint FROM tokens WHERE detected_at < ?1 ORDER BY detected_at LIMIT 1000`;
    const res = await db.batch([
      db.prepare(`DELETE FROM price_snapshots WHERE mint IN (${old})`).bind(cutoff),
      db.prepare(`DELETE FROM token_events WHERE mint IN (${old})`).bind(cutoff),
      db.prepare(`DELETE FROM liquidity_pools WHERE mint IN (${old})`).bind(cutoff),
      db.prepare(`DELETE FROM tokens WHERE mint IN (${old})`).bind(cutoff),
      db.prepare(`DELETE FROM ingestion_runs WHERE id IN (SELECT id FROM ingestion_runs WHERE started_at < ?1 LIMIT 3000)`).bind(opsCutoff),
      db.prepare(`DELETE FROM system_errors WHERE id IN (SELECT id FROM system_errors WHERE occurred_at < ?1 LIMIT 3000)`).bind(opsCutoff),
    ]);
    stats.rowsWritten = sumWritten(res);
  } catch (e) {
    errors.push(toRunError('cleanup', e));
  }
  try {
    await recordRun(env.DB, 'cleanup', now, errors.length ? 'failed' : 'ok', stats, errors);
  } catch (e) {
    console.error('recordRun failed', e instanceof Error ? e.message : 'unknown');
  }
}
