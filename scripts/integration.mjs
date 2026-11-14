// 結合テスト: 本物の Workers ランタイム（workerd / wrangler dev）+ ローカル D1 で、
// Cron → 外部 API 取得 → D1 保存 → 読み取り API → 静的配信 までを通しで確認する。
// 外部 API だけはローカルの模擬サーバーに差し替える（応答形式は公式ドキュメント準拠）。
// ※ 本物の GeckoTerminal / DEX Screener への接続確認は、このテストには含まれない。
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = 8799;
const MOCK = 9911;
const BASE = `http://127.0.0.1:${PORT}`;
const WSOL = 'So11111111111111111111111111111111111111112';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const addr = (seed) => { let s = '', x = seed * 7919 + 13; for (let i = 0; i < 44; i++) { x = (x * 1103515245 + 12345) % 2147483648; s += B58[x % 58]; } return s; };
const MINTS = [addr(1), addr(2), addr(3)];
const dsRequests = [];

const mock = createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith('/networks/solana/new_pools')) {
    return send({
      data: MINTS.map((m, i) => ({
        id: `solana_${addr(100 + i)}`, type: 'pool',
        attributes: {
          base_token_price_usd: '0.00002', quote_token_price_usd: '150', address: addr(100 + i), name: `IT${i} / SOL`,
          pool_created_at: new Date(Date.now() - 25_000).toISOString(), fdv_usd: '20000', market_cap_usd: null, reserve_in_usd: '7000',
          transactions: { m5: { buys: 3, sells: 1, buyers: 3, sellers: 1 }, h1: { buys: 3, sells: 1, buyers: 3, sellers: 1 }, h24: { buys: 3, sells: 1, buyers: 3, sellers: 1 } },
          volume_usd: { m5: '100', h1: '100', h24: '100' },
        },
        relationships: {
          base_token: { data: { id: `solana_${m}`, type: 'token' } },
          quote_token: { data: { id: `solana_${WSOL}`, type: 'token' } },
          dex: { data: { id: 'pumpswap', type: 'dex' } },
        },
      })),
      included: [
        ...MINTS.map((m, i) => ({ id: `solana_${m}`, type: 'token', attributes: { address: m, name: `Integration ${i}`, symbol: `IT${i}`, decimals: 6 } })),
        { id: `solana_${WSOL}`, type: 'token', attributes: { address: WSOL, name: 'Wrapped SOL', symbol: 'SOL', decimals: 9 } },
        { id: 'pumpswap', type: 'dex', attributes: { name: 'PumpSwap' } },
      ],
    });
  }
  if (req.url.startsWith('/tokens/v1/solana/')) {
    const mints = req.url.split('/tokens/v1/solana/')[1].split(',');
    dsRequests.push(mints);
    // 1 件目だけ応答し、2 件目は「ペアなし」（流動性消失の再現）
    return send(mints.filter((m) => m === MINTS[0]).map((m) => ({
      chainId: 'solana', dexId: 'pumpswap', pairAddress: addr(100), baseToken: { address: m }, quoteToken: { address: WSOL },
      priceUsd: '0.00005', txns: { m5: { buys: 1, sells: 1 }, h1: { buys: 5, sells: 4 }, h24: { buys: 5, sells: 4 } },
      volume: { m5: 10, h1: 200, h24: 200 }, liquidity: { usd: 9100 }, fdv: 50000, marketCap: 50000,
    })));
  }
  res.writeHead(404); res.end();
});

let failed = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond ? '' : ' ' + extra}`);
  if (!cond) failed++;
};
const getJson = async (p) => { const r = await fetch(BASE + p); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };

rmSync('.wrangler/it-state', { recursive: true, force: true });
await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
const wr = spawn('npx', [
  'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--test-scheduled', '--persist-to', '.wrangler/it-state',
  '--var', 'DAILY_WRITE_BUDGET:50000000', '--var', `GT_BASE_URL:http://127.0.0.1:${MOCK}`, '--var', `DS_BASE_URL:http://127.0.0.1:${MOCK}`, '--show-interactive-dev-session=false',
], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
let log = '';
wr.stdout.on('data', (d) => (log += d));
wr.stderr.on('data', (d) => (log += d));

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  }
  if (!up) throw new Error('wrangler dev が起動しませんでした');

  console.log('起動・初期状態');
  let s = await getJson('/api/status');
  check('初回アクセスでスキーマが自動作成され status が返る', s.status === 200 && s.body.last_run === null, JSON.stringify(s.body));
  check('収集前の一覧は空（見本データなし）', (await getJson('/api/tokens')).body.tokens.length === 0);

  console.log('Cron 1 回目（検出）');
  const now = Date.now();
  const c1 = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=${now}`);
  check('scheduled ハンドラが成功', c1.ok, `status ${c1.status}`);
  await new Promise((r) => setTimeout(r, 21_000)); // API のメモリキャッシュ(20秒)が切れるのを待つ
  const list = await getJson('/api/tokens');
  check('上限 2 件だけ保存される（3 件中）', list.body.tokens.length === 2, JSON.stringify(list.body.tokens.map((t) => t.symbol)));
  const t0 = list.body.tokens.find((t) => t.mint === MINTS[0]);
  check('実測値が保存されている', t0 && t0.last_price_usd === 0.00002 && t0.last_liquidity_usd === 7000 && t0.detection_delay_sec >= 20 && t0.detection_delay_sec <= 40, JSON.stringify(t0));

  console.log('Cron 2 回目（同じ応答 → 重複排除）');
  await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=${now + 60_000}`);
  console.log('Cron 3 回目（5 分後 → 追跡）');
  const c3 = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&time=${now + 5 * 60_000 + 1000}`);
  check('scheduled ハンドラが成功', c3.ok);
  check('DEX Screener へ期限到来の 2 銘柄をまとめて 1 回で照会', dsRequests.length === 1 && dsRequests[0].length === 2, JSON.stringify(dsRequests));
  await new Promise((r) => setTimeout(r, 31_000));

  const d0 = (await getJson(`/api/tokens/${MINTS[0]}`)).body;
  check('銘柄 A: +5分スナップショットが dexscreener の実測値で保存', d0.snapshots.length === 2 && d0.snapshots[1].stage === 1 && d0.snapshots[1].price_usd === 0.00005 && d0.snapshots[1].source === 'dexscreener' && d0.snapshots[1].data_quality === 'ok', JSON.stringify(d0.snapshots));
  check('銘柄 A: 検出時価格は保持、最新値は更新', d0.token.initial_price_usd === 0.00002 && d0.token.last_price_usd === 0.00005 && d0.token.snapshot_stage === 1);
  check('銘柄 A: プールは重複していない', d0.pools.length === 1);
  const d1 = (await getJson(`/api/tokens/${MINTS[1]}`)).body;
  check('銘柄 B: ペアなし → 価格 null の欠損として記録', d1.snapshots.length === 2 && d1.snapshots[1].price_usd === null && d1.snapshots[1].data_quality === 'missing_not_listed', JSON.stringify(d1.snapshots));
  check('銘柄 B: 最新値は検出時のまま（捏造・上書きなし）', d1.token.last_price_usd === 0.00002 && d1.token.last_source === 'geckoterminal');

  s = await getJson('/api/status');
  const runs = s.body.runs_24h.find((r) => r.status === 'ok');
  // 1 回目に上限で見送った 3 件目は、2 回目の実行で保存される
  check('実行記録 3 回・新規 計3（2+1）・見送りあり・欠損 1', runs && runs.n === 3 && runs.tokens_new === 3 && runs.skipped >= 1 && runs.snaps_missing === 1, JSON.stringify(s.body.runs_24h));
  check('D1 の rows_written が実測で集計されている', s.body.write_budget.used_today > 0, JSON.stringify(s.body.write_budget));
  console.log(`    （参考: 3 回の実行で rows_written = ${s.body.write_budget.used_today}）`);
  check('エラー記録なし', s.body.errors_24h.length === 0, JSON.stringify(s.body.errors_24h));

  console.log('入力検証・静的配信');
  check('不正な mint は 400', (await getJson('/api/tokens/abc')).status === 400);
  check('POST は 405', (await fetch(`${BASE}/api/tokens`, { method: 'POST' })).status === 405);
  check('管理 API はトークン未設定なら 404', (await fetch(`${BASE}/api/admin/run`, { method: 'POST' })).status === 404);
  const html = await fetch(`${BASE}/`);
  const text = await html.text();
  check('PWA の HTML が配信される', html.ok && text.includes('<div id="root">'));
  check('HTML に CSP ヘッダが付く', (html.headers.get('content-security-policy') ?? '').includes("default-src 'self'"), String(html.headers.get('content-security-policy')));
  check('manifest と Service Worker が配信される', (await fetch(`${BASE}/manifest.webmanifest`)).ok && (await fetch(`${BASE}/sw.js`)).ok);
  check('未知のパスは SPA にフォールバック', (await fetch(`${BASE}/some/deep/link`)).ok);
} catch (e) {
  failed++;
  console.error('結合テスト異常終了:', e.message);
  console.error(log.slice(-3000));
} finally {
  try { process.kill(-wr.pid, 'SIGTERM'); } catch { wr.kill('SIGTERM'); }
  mock.close();
}
console.log(failed ? `\n${failed} 件失敗` : '\nすべて成功');
if (failed) console.error(log.slice(-2000));
process.exit(failed ? 1 : 0);
