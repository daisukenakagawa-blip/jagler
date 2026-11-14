import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearApiCache, handleApi } from '../src/worker/api';
import { FINAL_STAGE, detectionDelaySec, newTokenAllowance, nextSnapshotAt, runCleanup, runIngestion } from '../src/worker/ingest';
import { assess, parseLargestAccounts, parseMintAccount } from '../src/worker/risk';
import { SCHEMA_STATEMENTS, ensureSchema, resetSchemaCache } from '../src/worker/schema';
import { dsTokensUrl, parseDsTokens, parseGtNewPools } from '../src/worker/sources';
import type { Env } from '../src/worker/types';
import { fetchJson, isSolanaAddress, num, safeEqual } from '../src/worker/util';
import { USDC, WSOL, addr, dsPair, gtPool, gtResponse, jsonRes, makeD1, mockFetch, rpcLargest, rpcMint } from './helpers';

const T0 = Date.UTC(2026, 10, 14, 6, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function makeEnv(over: Partial<Env> = {}): Env & { DB: ReturnType<typeof makeD1> } {
  return { DB: makeD1(), ASSETS: {} as Fetcher, ...over } as Env & { DB: ReturnType<typeof makeD1> };
}
const count = (env: { DB: ReturnType<typeof makeD1> }, sql: string) =>
  (env.DB.raw.prepare(sql).get() as { n: number }).n;

beforeEach(() => {
  resetSchemaCache();
  clearApiCache();
});
afterEach(() => vi.unstubAllGlobals());

describe('util', () => {
  it('Solana アドレスの形式検証', () => {
    expect(isSolanaAddress(WSOL)).toBe(true);
    expect(isSolanaAddress('abc')).toBe(false);
    expect(isSolanaAddress(`${WSOL}/../x`)).toBe(false);
    expect(isSolanaAddress('0OIl' + 'a'.repeat(40))).toBe(false); // base58 に無い文字
    expect(isSolanaAddress(123)).toBe(false);
  });
  it('数値変換は失敗時に null（未取得）を返し 0 で埋めない', () => {
    expect(num('1.5')).toBe(1.5);
    expect(num(null)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(Infinity)).toBeNull();
    expect(num(0)).toBe(0);
  });
  it('定数時間比較', () => {
    expect(safeEqual('secret', 'secret')).toBe(true);
    expect(safeEqual('secret', 'secreT')).toBe(false);
    expect(safeEqual('secret', 'secret2')).toBe(false);
  });
  it('fetchJson: 5xx は再試行し、429 は再試行しない', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => (++n === 1 ? jsonRes({}, 503) : jsonRes({ ok: 1 })));
    const c = { apiCalls: 0 };
    expect(await fetchJson('x', 'https://example.test/', { retries: 1 }, c)).toEqual({ ok: 1 });
    expect(c.apiCalls).toBe(2);
    n = 0;
    vi.stubGlobal('fetch', async () => (n++, jsonRes({}, 429)));
    await expect(fetchJson('x', 'https://example.test/', { retries: 2 })).rejects.toMatchObject({ status: 429 });
    expect(n).toBe(1);
  });
  it('fetchJson: retries429 指定時だけ 429 を待って再試行し、POST 本文を送れる', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => (++n <= 2 ? jsonRes({}, 429) : jsonRes({ ok: 1 })));
    expect(await fetchJson('x', 'https://example.test/', { retries429: 2, retries: 0 })).toEqual({ ok: 1 });
    expect(n).toBe(3);
    n = 0;
    vi.stubGlobal('fetch', async () => (n++, jsonRes({}, 429)));
    await expect(fetchJson('x', 'https://example.test/', { retries429: 2, retries: 0 })).rejects.toMatchObject({ status: 429 });
    expect(n).toBe(3); // 上限で打ち切る
    let seen: RequestInit | undefined;
    vi.stubGlobal('fetch', async (_u: unknown, init: RequestInit) => ((seen = init), jsonRes({})));
    await fetchJson('x', 'https://example.test/', { body: { a: 1 } });
    expect(seen).toMatchObject({ method: 'POST', body: '{"a":1}' });
  }, 20_000);
});

describe('GeckoTerminal 正規化', () => {
  it('base 側が新規トークンの通常ケース', () => {
    const r = parseGtNewPools(gtResponse([gtPool(1, iso(T0))]));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ mint: addr(1001), poolAddress: addr(2001), symbol: 'TKN0', decimals: 6, dexId: 'pumpswap', dexName: 'PumpSwap', quoteMint: WSOL, quoteSymbol: 'SOL', poolCreatedAt: T0 });
    expect(r[0].market).toMatchObject({ priceUsd: 0.0000123, fdvUsd: 12300, marketCapUsd: null, liquidityUsd: 8000.5, buysM5: 4, buyersH24: 7, volumeH24Usd: 900 });
  });
  it('base が SOL のとき quote 側を対象にし、base 基準の FDV・売買回数は未取得にする', () => {
    const r = parseGtNewPools(gtResponse([gtPool(2, iso(T0), { baseIsSol: true })]));
    expect(r[0].mint).toBe(addr(1002));
    expect(r[0].market.priceUsd).toBe(150.5); // quote_token_price_usd
    expect(r[0].market.fdvUsd).toBeNull();
    expect(r[0].market.buysH24).toBeNull();
    expect(r[0].market.liquidityUsd).toBe(8000.5);
  });
  it('価格が null なら null のまま（補完しない）', () => {
    const r = parseGtNewPools(gtResponse([gtPool(3, iso(T0), { price: null })]));
    expect(r[0].market.priceUsd).toBeNull();
  });
  it('建値同士・不正な形式・想定外の応答は捨てる', () => {
    const solUsdc = gtPool(4, iso(T0));
    solUsdc.relationships.base_token.data.id = `solana_${WSOL}`;
    solUsdc.relationships.quote_token.data.id = `solana_${USDC}`;
    const bad = gtPool(5, iso(T0));
    bad.attributes.address = 'not-an-address';
    const eth = gtPool(6, iso(T0));
    eth.relationships.base_token.data.id = 'eth_0xabc';
    expect(parseGtNewPools(gtResponse([solUsdc, bad, eth]))).toHaveLength(0);
    expect(parseGtNewPools(null)).toEqual([]);
    expect(parseGtNewPools({ data: 'x' })).toEqual([]);
    expect(parseGtNewPools({ data: [null, 1, {}] })).toEqual([]);
  });
});

describe('DEX Screener 正規化', () => {
  it('ミントごとに流動性最大のペアを選ぶ。対象外ミント・他チェーン・quote 側一致は無視', () => {
    const a = addr(1), b = addr(2);
    const other = { ...dsPair(addr(9), addr(19), '9', 9e9) };
    const wrongChain = { ...dsPair(a, addr(18), '7', 9e9), chainId: 'base' };
    const asQuote = { ...dsPair(WSOL, addr(17), '150', 9e9), quoteToken: { address: a } };
    const m = parseDsTokens([dsPair(a, addr(11), '0.5', 100), dsPair(a, addr(12), '0.6', 5000), other, wrongChain, asQuote], [a, b]);
    expect(m.get(a)).toMatchObject({ poolAddress: addr(12), market: { priceUsd: 0.6, liquidityUsd: 5000, buysH24: 100, buyersH24: null } });
    expect(m.has(b)).toBe(false);
    expect(m.size).toBe(1);
  });
  it('URL には検証済みアドレスだけを最大30件入れる', () => {
    const url = dsTokensUrl('https://api.dexscreener.com', [addr(1), 'evil/../../x', '', ...Array.from({ length: 40 }, (_, i) => addr(100 + i))]);
    const list = url.split('/solana/')[1].split(',');
    expect(list).toHaveLength(30);
    expect(list.every(isSolanaAddress)).toBe(true);
  });
});

describe('スケジュール', () => {
  it('追跡時点は検出から 5分・15分・1時間・6時間・24時間、最後は null', () => {
    expect(nextSnapshotAt(T0, 0)).toBe(T0 + 5 * 60_000);
    expect(nextSnapshotAt(T0, 1)).toBe(T0 + 15 * 60_000);
    expect(nextSnapshotAt(T0, 4)).toBe(T0 + 1440 * 60_000);
    expect(nextSnapshotAt(T0, FINAL_STAGE)).toBeNull();
  });
  it('検出遅延: 作成時刻が無ければ null、未来時刻は 0', () => {
    expect(detectionDelaySec(T0, T0 - 42_000)).toBe(42);
    expect(detectionDelaySec(T0, null)).toBeNull();
    expect(detectionDelaySec(T0, T0 + 5000)).toBe(0);
  });
});

describe('リスク判定（ルール v1）', () => {
  const dist = parseLargestAccounts(rpcLargest(['800', '20', '10']), '1000');
  it('RPC 応答の解析: 権限・拡張・集中度', () => {
    const m = parseMintAccount(rpcMint({ mintAuthority: addr(1), token2022: true, extensions: [{ extension: 'transferHook', state: {} }] }));
    expect(m).toMatchObject({ isToken2022: true, mintAuthority: addr(1), freezeAuthority: null, decimals: 6, extensions: [{ name: 'transferHook' }] });
    expect(dist).toMatchObject({ top1Pct: 80, top10Pct: 83, top2to10Pct: 3, accounts: 3 });
    expect(parseMintAccount({ result: { value: null } })).toBeNull();
    expect(parseMintAccount({ result: { value: { data: { parsed: { type: 'account' } } } } })).toBeNull();
    expect(parseMintAccount('garbage')).toBeNull();
    expect(parseLargestAccounts(rpcLargest(['1']), null)).toBeNull();
    expect(parseLargestAccounts(rpcLargest([]), '100')).toBeNull();
  });
  it('権限が放棄済みで分散していれば LOW（ただし未検査項目を必ず明記）', () => {
    const a = assess(parseMintAccount(rpcMint()), dist);
    expect(a.level).toBe('LOW');
    expect(a.score).toBe(100);
    expect(a.findings.some((f) => f.check === 'not_checked')).toBe(true);
  });
  it('Mint 権限・Freeze 権限が残っていれば HIGH', () => {
    expect(assess(parseMintAccount(rpcMint({ mintAuthority: addr(1) })), dist).level).toBe('HIGH');
    const a = assess(parseMintAccount(rpcMint({ freezeAuthority: addr(2) })), dist);
    expect(a.level).toBe('HIGH');
    expect(a.findings.find((f) => f.check === 'freeze_authority')?.detail).toContain(addr(2));
  });
  it('Token-2022: 危険な拡張は HIGH、転送手数料・未知の拡張は MEDIUM、メタデータ等は影響なし', () => {
    const t22 = (extensions: unknown[]) => assess(parseMintAccount(rpcMint({ token2022: true, extensions })), dist).level;
    expect(t22([{ extension: 'permanentDelegate', state: {} }])).toBe('HIGH');
    expect(t22([{ extension: 'nonTransferable', state: {} }])).toBe('HIGH');
    expect(t22([{ extension: 'defaultAccountState', state: { accountState: 'frozen' } }])).toBe('HIGH');
    expect(t22([{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 2500 } } }])).toBe('HIGH');
    expect(t22([{ extension: 'transferFeeConfig', state: { newerTransferFee: { transferFeeBasisPoints: 100 } } }])).toBe('MEDIUM');
    expect(t22([{ extension: 'somethingNew', state: {} }])).toBe('MEDIUM');
    expect(t22([{ extension: 'tokenMetadata', state: {} }, { extension: 'metadataPointer', state: {} }])).toBe('LOW');
  });
  it('2〜10位の合計が 30% 以上なら MEDIUM。最大口座だけが大きい場合は格上げしない', () => {
    expect(assess(parseMintAccount(rpcMint()), parseLargestAccounts(rpcLargest(['500', '200', '150']), '1000')).level).toBe('MEDIUM');
    expect(assess(parseMintAccount(rpcMint()), parseLargestAccounts(rpcLargest(['950', '10']), '1000')).level).toBe('LOW');
  });
  it('情報が取れなければ UNKNOWN、保有者だけ取れなければ未取得と明記して判定', () => {
    expect(assess(null, null)).toMatchObject({ level: 'UNKNOWN', score: null });
    const a = assess(parseMintAccount(rpcMint()), null);
    expect(a.level).toBe('LOW');
    expect(a.findings.find((f) => f.check === 'holder_concentration')?.detail).toContain('未取得');
  });
});

describe('スキーマ', () => {
  it('v1 の既存 DB に列が追加される（稼働中 DB のアップグレード）', async () => {
    const env = makeEnv();
    env.DB.raw.exec(`CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES('version','1');
      CREATE TABLE tokens (mint TEXT PRIMARY KEY, detected_at INTEGER NOT NULL, next_snapshot_at INTEGER);
      INSERT INTO tokens VALUES('keep-me', 1, NULL);`);
    await ensureSchema(env.DB);
    const cols = (env.DB.raw.prepare(`PRAGMA table_info(tokens)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['risk_level', 'security_score', 'risk_assessed_at']));
    expect(count(env, `SELECT COUNT(*) n FROM tokens`)).toBe(1);
    expect((env.DB.raw.prepare(`SELECT value v FROM schema_meta`).get() as { v: string }).v).toBe('2');
  });
  it('必須 14 テーブルがすべて作成され、再実行しても壊れない', async () => {
    const env = makeEnv();
    await ensureSchema(env.DB);
    resetSchemaCache();
    await ensureSchema(env.DB);
    const names = (env.DB.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    for (const t of ['tokens', 'token_events', 'liquidity_pools', 'price_snapshots', 'holder_snapshots', 'developer_wallets', 'risk_assessments', 'model_predictions', 'paper_orders', 'paper_trades', 'paper_positions', 'strategy_results', 'ingestion_runs', 'system_errors'])
      expect(names).toContain(t);
  });
  it('migrations/0001_init.sql が schema.ts と同期している', () => {
    const sql = readFileSync('migrations/0001_init.sql', 'utf8').replace(/\s+/g, ' ');
    for (const s of SCHEMA_STATEMENTS) expect(sql).toContain(s.replace(/\s+/g, ' '));
  });
});

describe('収集パイプライン', () => {
  it('新規トークンを保存し、同じ応答を再取得しても二重計上しない', async () => {
    const env = makeEnv({ MAX_NEW_TOKENS_PER_RUN: '10' });
    const body = gtResponse([gtPool(1, iso(T0 - 20_000)), gtPool(2, iso(T0 - 90_000))]);
    const f = mockFetch({ gt: () => jsonRes(body) });
    vi.stubGlobal('fetch', f.fn);

    const r1 = await runIngestion(env, T0);
    expect(r1.status).toBe('ok');
    expect(r1.stats).toMatchObject({ poolsSeen: 2, tokensNew: 2, snapshotsWritten: 2 });
    const tok = env.DB.raw.prepare(`SELECT * FROM tokens WHERE mint = ?`).get(addr(1001)) as Record<string, unknown>;
    expect(tok).toMatchObject({ detected_at: T0, detection_delay_sec: 20, first_pool_created_at: T0 - 20_000, snapshot_stage: 0, next_snapshot_at: T0 + 300_000, initial_price_usd: 0.0000123, last_liquidity_usd: 8000.5, minted_at: null });

    const r2 = await runIngestion(env, T0 + 60_000);
    expect(r2.stats.tokensNew).toBe(0);
    expect(count(env, `SELECT COUNT(*) n FROM tokens`)).toBe(2);
    expect(count(env, `SELECT COUNT(*) n FROM liquidity_pools`)).toBe(2);
    expect(count(env, `SELECT COUNT(*) n FROM price_snapshots`)).toBe(2);
    expect(count(env, `SELECT COUNT(*) n FROM token_events`)).toBe(2);
    expect(count(env, `SELECT COUNT(*) n FROM ingestion_runs`)).toBe(2);
    // 追跡時刻前なので DEX Screener は呼ばれない
    expect(f.calls.filter((u) => u.includes('dexscreener'))).toHaveLength(0);
  });

  it('1 回あたりの新規保存上限を守り、超過分を「未保存」として数える', async () => {
    const env = makeEnv({ MAX_NEW_TOKENS_PER_RUN: '2' });
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([1, 2, 3, 4, 5].map((i) => gtPool(i, iso(T0))))) }).fn);
    const r = await runIngestion(env, T0);
    expect(r.stats).toMatchObject({ tokensNew: 2, tokensSkippedBudget: 3 });
    expect(count(env, `SELECT COUNT(*) n FROM tokens`)).toBe(2);
    expect(count(env, `SELECT COUNT(*) n FROM liquidity_pools`)).toBe(2);
  });

  it('既存トークンの別プールは、トークンを重複させずプールだけ追加する', async () => {
    const env = makeEnv();
    const p1 = gtPool(1, iso(T0));
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([p1])) }).fn);
    await runIngestion(env, T0);
    const p2 = gtPool(1, iso(T0 + 30_000));
    p2.attributes.address = addr(7777);
    p2.id = `solana_${addr(7777)}`;
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([p2])) }).fn);
    const r = await runIngestion(env, T0 + 60_000);
    expect(r.stats.tokensNew).toBe(0);
    expect(count(env, `SELECT COUNT(*) n FROM tokens`)).toBe(1);
    expect(count(env, `SELECT COUNT(*) n FROM liquidity_pools`)).toBe(2);
    expect((env.DB.raw.prepare(`SELECT primary_pool_address p FROM tokens`).get() as { p: string }).p).toBe(addr(2001));
  });

  it('追跡: 期限到来分だけ DEX Screener から取得し、ステージを進める', async () => {
    const env = makeEnv({ MAX_NEW_TOKENS_PER_RUN: '10' });
    const mint = addr(1001);
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(T0))])) }).fn);
    await runIngestion(env, T0);

    const f = mockFetch({ gt: () => jsonRes({ data: [] }), ds: () => jsonRes([dsPair(mint, addr(2001), '0.0000246', 9000)]) });
    vi.stubGlobal('fetch', f.fn);
    const t1 = T0 + 5 * 60_000;
    const r = await runIngestion(env, t1);
    expect(r.status).toBe('ok');
    expect(r.stats).toMatchObject({ snapshotsWritten: 1, snapshotsMissing: 0 });
    expect(f.calls.find((u) => u.includes('dexscreener'))).toContain(`/tokens/v1/solana/${mint}`);
    const tok = env.DB.raw.prepare(`SELECT * FROM tokens`).get() as Record<string, unknown>;
    expect(tok).toMatchObject({ snapshot_stage: 1, next_snapshot_at: T0 + 15 * 60_000, last_price_usd: 0.0000246, last_source: 'dexscreener', last_observed_at: t1, initial_price_usd: 0.0000123 });
    const snap = env.DB.raw.prepare(`SELECT * FROM price_snapshots WHERE stage = 1`).get() as Record<string, unknown>;
    expect(snap).toMatchObject({ observed_at: t1, price_usd: 0.0000246, liquidity_usd: 9000, data_quality: 'ok', buyers_h24: null });
  });

  it('追跡: ペアが返らない銘柄は価格を捏造せず「欠損」として記録し、最終値は上書きしない', async () => {
    const env = makeEnv();
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(T0))])) }).fn);
    await runIngestion(env, T0);
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes({ data: [] }), ds: () => jsonRes([]) }).fn);
    const r = await runIngestion(env, T0 + 5 * 60_000);
    expect(r.stats).toMatchObject({ snapshotsWritten: 0, snapshotsMissing: 1 });
    const snap = env.DB.raw.prepare(`SELECT * FROM price_snapshots WHERE stage = 1`).get() as Record<string, unknown>;
    expect(snap).toMatchObject({ price_usd: null, liquidity_usd: null, data_quality: 'missing_not_listed' });
    const tok = env.DB.raw.prepare(`SELECT * FROM tokens`).get() as Record<string, unknown>;
    expect(tok).toMatchObject({ snapshot_stage: 1, last_price_usd: 0.0000123, last_source: 'geckoterminal' });
  });

  it('API 障害: エラーを記録して次回再試行し、10分超の遅れは欠損として確定する', async () => {
    const env = makeEnv();
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(T0))])) }).fn);
    await runIngestion(env, T0);

    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes({ data: [] }), ds: () => jsonRes({}, 500) }).fn);
    const r1 = await runIngestion(env, T0 + 5 * 60_000);
    expect(r1.status).toBe('partial');
    expect(count(env, `SELECT COUNT(*) n FROM price_snapshots`)).toBe(1); // 進めない
    expect(count(env, `SELECT COUNT(*) n FROM system_errors WHERE source='dexscreener' AND http_status=500`)).toBe(1);
    expect((env.DB.raw.prepare(`SELECT snapshot_stage s FROM tokens`).get() as { s: number }).s).toBe(0);

    const r2 = await runIngestion(env, T0 + 16 * 60_000);
    expect(r2.stats.snapshotsMissing).toBe(1);
    const snap = env.DB.raw.prepare(`SELECT * FROM price_snapshots WHERE stage = 1`).get() as Record<string, unknown>;
    expect(snap).toMatchObject({ price_usd: null, data_quality: 'missing_api_error' });
    expect((env.DB.raw.prepare(`SELECT snapshot_stage s FROM tokens`).get() as { s: number }).s).toBe(1);
  });

  it('両方の API が落ちても例外で止まらず failed として記録する', async () => {
    const env = makeEnv();
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(T0))])) }).fn);
    await runIngestion(env, T0);
    vi.stubGlobal('fetch', async () => { throw new Error('network down'); });
    const r = await runIngestion(env, T0 + 5 * 60_000);
    expect(r.status).toBe('failed');
    const run = env.DB.raw.prepare(`SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1`).get() as Record<string, unknown>;
    expect(run.status).toBe('failed');
    expect(String(run.error_summary)).toContain('network down');
    expect(count(env, `SELECT COUNT(*) n FROM system_errors`)).toBe(2); // discover / follow_up（判定済みなので RPC は呼ばれない）
  });

  it('書き込み予算: 85% 超で新規保存を止め、100% で全停止する', async () => {
    const env = makeEnv({ DAILY_WRITE_BUDGET: '1000' });
    await ensureSchema(env.DB);
    const seed = (n: number) =>
      env.DB.raw.prepare(`INSERT INTO ingestion_runs (job, started_at, finished_at, status, rows_written) VALUES ('ingest', ?, ?, 'ok', ?)`).run(T0 - 1000, T0 - 1000, n);
    const f = mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(T0))])) });
    vi.stubGlobal('fetch', f.fn);

    seed(900);
    const r1 = await runIngestion(env, T0);
    expect(r1.stats).toMatchObject({ tokensNew: 0, tokensSkippedBudget: 1 });
    expect(count(env, `SELECT COUNT(*) n FROM tokens`)).toBe(0);

    seed(200);
    const before = f.calls.length;
    const r2 = await runIngestion(env, T0 + 60_000);
    expect(r2.status).toBe('budget_exhausted');
    expect(f.calls.length).toBe(before); // API も呼ばない
  });

  it('新規保存は 1 日に均等配分される（早い時間帯に枠を使い切らない）', async () => {
    // 予算 1000 行 → 新規枠 850 行 ÷ 36 行/銘柄 ÷ 1440 分。06:00 UTC（361 分経過）時点の累計許容は 5 銘柄
    expect(newTokenAllowance(T0, 1000, 0)).toBe(5);
    expect(newTokenAllowance(T0, 1000, 5)).toBe(0);
    expect(newTokenAllowance(T0 - 6 * 3600_000, 1000, 0)).toBe(0); // 日付が変わった直後
    expect(newTokenAllowance(T0, 80_000, 0)).toBeGreaterThan(400);
    const env = makeEnv({ DAILY_WRITE_BUDGET: '1000', MAX_NEW_TOKENS_PER_RUN: '20' });
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse(Array.from({ length: 10 }, (_, i) => gtPool(i + 1, iso(T0))))) }).fn);
    const r1 = await runIngestion(env, T0);
    expect(r1.stats).toMatchObject({ tokensNew: 5, tokensSkippedBudget: 5 });
    const r2 = await runIngestion(env, T0 + 60_000);
    expect(r2.stats).toMatchObject({ tokensNew: 0, tokensSkippedBudget: 5 }); // 枠が回復するまで見送り
  });

  it('前日の書き込みは当日の予算に数えない（UTC 0時リセット）', async () => {
    const env = makeEnv({ DAILY_WRITE_BUDGET: '1000' });
    await ensureSchema(env.DB);
    const yesterday = T0 - 86_400_000;
    env.DB.raw.prepare(`INSERT INTO ingestion_runs (job, started_at, finished_at, status, rows_written) VALUES ('ingest', ?, ?, 'ok', 5000)`).run(yesterday, yesterday);
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(T0))])) }).fn);
    expect((await runIngestion(env, T0)).stats.tokensNew).toBe(1);
  });

  it('クリーンアップ: 保持期間を過ぎた銘柄と関連データだけを削除する', async () => {
    const env = makeEnv({ RETENTION_DAYS: '30', MAX_NEW_TOKENS_PER_RUN: '10' });
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(T0))])) }).fn);
    await runIngestion(env, T0);
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(2, iso(T0))])) }).fn);
    const later = T0 + 40 * 86_400_000;
    await runIngestion(env, later);
    await runCleanup(env, later + 1000);
    expect((env.DB.raw.prepare(`SELECT mint FROM tokens`).all() as { mint: string }[]).map((r) => r.mint)).toEqual([addr(1002)]);
    expect(count(env, `SELECT COUNT(*) n FROM price_snapshots`)).toBe(1);
    expect(count(env, `SELECT COUNT(*) n FROM liquidity_pools`)).toBe(1);
    expect(count(env, `SELECT COUNT(*) n FROM ingestion_runs WHERE job='cleanup' AND status='ok'`)).toBe(1);
  });
});

describe('リスク判定の自動実行', () => {
  it('検出した銘柄を判定して根拠・時刻つきで保存し、API で返す', async () => {
    const env = makeEnv({ MAX_NEW_TOKENS_PER_RUN: '10' });
    const now = Date.now();
    const f = mockFetch({
      gt: () => jsonRes(gtResponse([gtPool(1, iso(now - 20_000)), gtPool(2, iso(now - 30_000))])),
      rpc: (method, params) =>
        jsonRes(method === 'getAccountInfo' ? rpcMint(params[0] === addr(1001) ? { freezeAuthority: addr(9) } : {}) : rpcLargest(['900000000000000', '1000000000000'])),
    });
    vi.stubGlobal('fetch', f.fn);
    const r = await runIngestion(env, now);
    expect(r.status).toBe('ok');
    const t = (m: string) => env.DB.raw.prepare(`SELECT * FROM tokens WHERE mint = ?`).get(m) as Record<string, unknown>;
    expect(t(addr(1001))).toMatchObject({ risk_level: 'HIGH', freeze_authority_state: 'present', mint_authority_state: 'revoked', risk_assessed_at: now, token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
    expect(t(addr(1002))).toMatchObject({ risk_level: 'LOW', security_score: 100 });
    expect(count(env, `SELECT COUNT(*) n FROM risk_assessments`)).toBe(2);
    expect(count(env, `SELECT COUNT(*) n FROM holder_snapshots WHERE top1_pct = 90`)).toBe(2);

    await runIngestion(env, now + 60_000); // 判定済みは再判定しない
    expect(count(env, `SELECT COUNT(*) n FROM risk_assessments`)).toBe(2);

    const d = (await (await handleApi(new Request(`https://app.test/api/tokens/${addr(1001)}`), env, ctx)).json()) as { risk: { risk_level: string; findings: { check: string; severity: string }[] }; holders: { top1_pct: number } };
    expect(d.risk.risk_level).toBe('HIGH');
    expect(d.risk.findings).toContainEqual(expect.objectContaining({ check: 'freeze_authority', severity: 'HIGH' }));
    expect(d.holders.top1_pct).toBe(90);
    clearApiCache();
    const high = (await (await handleApi(new Request('https://app.test/api/tokens?risk=HIGH'), env, ctx)).json()) as { tokens: { mint: string }[] };
    expect(high.tokens.map((x) => x.mint)).toEqual([addr(1001)]);
  });

  it('RPC 障害時は判定を書かず未判定のまま残し、エラーを記録して次回再試行する', async () => {
    const env = makeEnv();
    const now = Date.now();
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(now))])), rpc: () => jsonRes({}, 403) }).fn);
    const r = await runIngestion(env, now);
    expect(r.status).toBe('partial');
    expect(count(env, `SELECT COUNT(*) n FROM tokens WHERE risk_level IS NULL`)).toBe(1);
    expect(count(env, `SELECT COUNT(*) n FROM risk_assessments`)).toBe(0);
    expect(count(env, `SELECT COUNT(*) n FROM system_errors WHERE source='solana_rpc' AND http_status=403`)).toBe(1);
    const unk = (await (await handleApi(new Request('https://app.test/api/tokens?risk=UNKNOWN'), env, ctx)).json()) as { tokens: unknown[] };
    expect(unk.tokens).toHaveLength(1); // 未判定は UNKNOWN として絞り込める

    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes({ data: [] }) }).fn);
    await runIngestion(env, now + 60_000);
    expect(count(env, `SELECT COUNT(*) n FROM tokens WHERE risk_level = 'LOW'`)).toBe(1);
  });

  it('RPC がエラー本文（JSON-RPC error）を返した場合も失敗として扱う', async () => {
    const env = makeEnv();
    const now = Date.now();
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(now))])), rpc: () => jsonRes({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Too many requests' } }) }).fn);
    const r = await runIngestion(env, now);
    expect(r.errors.map((e) => e.component)).toEqual(['risk']);
    expect(count(env, `SELECT COUNT(*) n FROM risk_assessments`)).toBe(0);
  });

  it('Mint 口座が存在しない場合は UNKNOWN として記録する', async () => {
    const env = makeEnv();
    const now = Date.now();
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(now))])), rpc: () => jsonRes({ jsonrpc: '2.0', id: 1, result: { value: null } }) }).fn);
    await runIngestion(env, now);
    expect((env.DB.raw.prepare(`SELECT risk_level r, security_score s FROM tokens`).get() as Record<string, unknown>)).toMatchObject({ r: 'UNKNOWN', s: null });
  });
});

describe('API', () => {
  const get = (env: Env, path: string, headers: Record<string, string> = {}, method = 'GET') =>
    handleApi(new Request(`https://app.test${path}`, { method, headers }), env, ctx);

  async function seeded(over: Partial<Env> = {}) {
    const env = makeEnv({ MAX_NEW_TOKENS_PER_RUN: '10', ...over });
    vi.stubGlobal('fetch', mockFetch({ gt: () => jsonRes(gtResponse([gtPool(1, iso(T0 - 20_000)), gtPool(2, iso(T0 - 200_000))])) }).fn);
    await runIngestion(env, Date.now());
    return env;
  }

  it('一覧・詳細・ステータスを返し、セキュリティヘッダを付け、CORS は許可しない', async () => {
    const env = await seeded();
    const list = await get(env, '/api/tokens');
    expect(list.status).toBe(200);
    expect(list.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(list.headers.get('access-control-allow-origin')).toBeNull();
    const body = (await list.json()) as { tokens: { mint: string }[] };
    expect(body.tokens).toHaveLength(2);

    const d = await get(env, `/api/tokens/${addr(1001)}`);
    const detail = (await d.json()) as { token: { mint: string }; snapshots: unknown[]; pools: unknown[]; not_collected: string[] };
    expect(detail.token.mint).toBe(addr(1001));
    expect(detail.snapshots).toHaveLength(1);
    expect(detail.pools).toHaveLength(1);
    expect(detail.not_collected).toContain('developer_wallet');

    const s = (await (await get(env, '/api/status')).json()) as { last_run: { status: string }; detection_delay_24h: Record<string, number>; write_budget: { used_today: number } };
    expect(s.last_run.status).toBe('ok');
    expect(s.detection_delay_24h).toMatchObject({ total: 2, unknown: 0 });
    expect(s.write_budget.used_today).toBeGreaterThan(0);
  });

  it('入力値検証: 不正な mint は 400、存在しない mint は 404、SQL 断片は無害', async () => {
    const env = await seeded();
    expect((await get(env, '/api/tokens/abc')).status).toBe(400);
    expect((await get(env, `/api/tokens/${addr(9999)}`)).status).toBe(404);
    const inj = await get(env, `/api/tokens?q=${encodeURIComponent("' OR 1=1 --")}`);
    expect(((await inj.json()) as { tokens: unknown[] }).tokens).toHaveLength(0);
    const like = await get(env, `/api/tokens?q=${encodeURIComponent('%')}`);
    expect(((await like.json()) as { tokens: unknown[] }).tokens).toHaveLength(0);
    const ok = await get(env, '/api/tokens?q=TKN1');
    expect(((await ok.json()) as { tokens: unknown[] }).tokens).toHaveLength(1);
    const byMint = await get(env, `/api/tokens?q=${addr(1002)}`);
    expect(((await byMint.json()) as { tokens: unknown[] }).tokens).toHaveLength(1);
    expect(count(env, `SELECT COUNT(*) n FROM tokens`)).toBe(2);
  });

  it('GET 以外は拒否する', async () => {
    const env = await seeded();
    expect((await get(env, '/api/tokens', {}, 'POST')).status).toBe(405);
    expect((await get(env, '/api/tokens', {}, 'DELETE')).status).toBe(405);
  });

  it('ACCESS_TOKEN 設定時は Bearer 必須（health だけ公開）', async () => {
    const env = await seeded({ ACCESS_TOKEN: 'tok-123' });
    expect((await get(env, '/api/health')).status).toBe(200);
    expect((await get(env, '/api/tokens')).status).toBe(401);
    expect((await get(env, '/api/tokens', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await get(env, '/api/tokens', { authorization: 'Bearer tok-123' })).status).toBe(200);
  });

  it('管理 API: ADMIN_TOKEN 未設定なら存在しない扱い、設定時はトークン必須', async () => {
    const env = await seeded();
    expect((await get(env, '/api/admin/run', {}, 'POST')).status).toBe(404);
    const env2 = await seeded({ ADMIN_TOKEN: 'adm' });
    expect((await get(env2, '/api/admin/run', {}, 'POST')).status).toBe(401);
    expect((await get(env2, '/api/admin/run', { 'x-admin-token': 'adm' }, 'POST')).status).toBe(200);
  });
});
