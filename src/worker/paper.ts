// Phase 4: 仮想売買（ペーパートレード）。実資金は一切使わない。
//
// 未来情報を使わないための規則:
//  - シグナルは「その時点までに観測済みのスナップショット」だけで作る
//  - 約定は必ず「シグナルより後に観測したスナップショット」の価格・流動性で評価する
//    （例外は保有期限による決済のみ。期限は事前に決まっており価格に依存しないため、最終スナップショットで約定させる）
//  - 価格や流動性が観測できなければ買いは未約定、売りは持ち越し。最後まで売れなければ投下額の全損として確定する
//
// 約定モデル（保守的な近似）: プールを 50:50 の定積（x*y=k）とみなし、建値側の準備金 = 流動性 / 2 で価格影響を計算する。
// 実際のプール（ボンディングカーブ、集中流動性など）とは異なる。追跡間隔が粗い（5分〜18時間）ため、
// 利確・損切りは「条件を観測した次のスナップショット」での約定になり、狙った水準では決済できない。
import { FINAL_STAGE } from './ingest';
import { Env } from './types';

export const PAPER_CONFIG = {
  orderUsd: 50,
  minLiquidityUsd: 5000,
  /** 買いで許容する最大の価格影響。超える分は数量を減らす */
  maxSlippage: 0.05,
  minFillUsd: 5,
  feeRate: 0.01,
  priorityFeeUsd: 0.05,
  takeProfit: 1.0,
  stopLoss: 0.5,
  maxOpenPerStrategy: 100,
  momentumMinGain: 0.2,
  allowedRisk: ['LOW', 'MEDIUM'],
} as const;

export interface Snap {
  id: number;
  mint: string;
  stage: number;
  observed_at: number;
  price_usd: number | null;
  liquidity_usd: number | null;
  buys_m5: number | null;
  sells_m5: number | null;
}
type Ctx = { snap: Snap; prev: Snap | undefined; risk: string | null; mint: string };

/** mint から決まる固定の 0/1（乱数ではなく決定的。後から結果を見て選び直せない） */
export function coinFlip(mint: string): boolean {
  let h = 0;
  for (let i = 0; i < mint.length; i++) h = (h * 31 + mint.charCodeAt(i)) >>> 0;
  return (h & 1) === 1;
}

const baseOk = (c: Ctx) =>
  c.snap.price_usd !== null &&
  c.snap.price_usd > 0 &&
  (c.snap.liquidity_usd ?? 0) >= PAPER_CONFIG.minLiquidityUsd &&
  c.risk !== null &&
  (PAPER_CONFIG.allowedRisk as readonly string[]).includes(c.risk);

export const STRATEGIES: { id: string; label: string; entryStage: number; entry: (c: Ctx) => boolean }[] = [
  { id: 'baseline_all', label: '全件エントリー（基準）', entryStage: 0, entry: baseOk },
  { id: 'random_half', label: 'ランダム半数（対照）', entryStage: 0, entry: (c) => baseOk(c) && coinFlip(c.mint) },
  {
    id: 'momentum_5m',
    label: '5分モメンタム（+20%以上・買い優勢）',
    entryStage: 1,
    entry: (c) =>
      baseOk(c) &&
      !!c.prev?.price_usd &&
      c.snap.price_usd! >= c.prev.price_usd * (1 + PAPER_CONFIG.momentumMinGain) &&
      c.snap.buys_m5 !== null &&
      c.snap.sells_m5 !== null &&
      c.snap.buys_m5 > c.snap.sells_m5,
  },
];

export type BuyFill =
  | { ok: false; reason: string }
  | { ok: true; spentUsd: number; quantity: number; effPrice: number; feeUsd: number; slippageUsd: number; partial: boolean };

/** 買いの約定評価。観測価格・流動性が無ければ約定させない */
export function simulateBuy(requestedUsd: number, price: number | null, liquidityUsd: number | null): BuyFill {
  if (price === null || !(price > 0)) return { ok: false, reason: 'no_price_at_fill' };
  if (liquidityUsd === null || !(liquidityUsd > 0)) return { ok: false, reason: 'no_liquidity_at_fill' };
  const reserve = liquidityUsd / 2;
  const spend = Math.min(requestedUsd, reserve * PAPER_CONFIG.maxSlippage);
  if (spend < PAPER_CONFIG.minFillUsd) return { ok: false, reason: 'insufficient_liquidity' };
  const feeUsd = spend * PAPER_CONFIG.feeRate;
  const net = spend - feeUsd;
  const effPrice = price * (1 + net / reserve); // 定積: 平均約定価格 = p * (1 + 投入額 / 準備金)
  const quantity = net / effPrice;
  return { ok: true, spentUsd: spend, quantity, effPrice, feeUsd, slippageUsd: net - quantity * price, partial: spend < requestedUsd };
}

export type SellFill = { ok: false; reason: string } | { ok: true; proceedsUsd: number; feeUsd: number; slippageUsd: number; price: number };

/** 売りの約定評価。流動性が細ければ受取額は準備金に頭打ちされる（流動性消失の損失を反映） */
export function simulateSell(quantity: number, price: number | null, liquidityUsd: number | null): SellFill {
  if (price === null || !(price > 0)) return { ok: false, reason: 'no_price_at_fill' };
  if (liquidityUsd === null || !(liquidityUsd > 0)) return { ok: false, reason: 'no_liquidity_at_fill' };
  const reserve = liquidityUsd / 2;
  const value = quantity * price;
  const gross = (reserve * value) / (reserve + value);
  const feeUsd = gross * PAPER_CONFIG.feeRate;
  return { ok: true, proceedsUsd: gross - feeUsd, feeUsd, slippageUsd: value - gross, price };
}

interface OrderRow {
  id: number;
  mint: string;
  strategy_id: string;
  side: 'BUY' | 'SELL';
  signal_stage: number;
  requested_usd: number;
  status: string;
  reason: string | null;
}
interface PosRow {
  id: number;
  mint: string;
  strategy_id: string;
  status: string;
  quantity: number;
  cost_usd: number;
  entry_price_usd: number;
  opened_stage?: number;
}
export interface Touched {
  mint: string;
  stage: number;
}

const written = (r: D1Result | D1Result[]) =>
  (Array.isArray(r) ? r : [r]).reduce((n, x) => n + (x.meta?.rows_written ?? x.meta?.changes ?? 0), 0);

/** この実行でスナップショットが増えた銘柄だけを処理する（全件走査しない） */
export async function runPaper(env: Env, now: number, touched: Touched[], stats: { rowsWritten: number }): Promise<void> {
  if (touched.length === 0) return;
  const db = env.DB;
  const mints = [...new Set(touched.map((t) => t.mint))];
  const ph = mints.map((_, i) => `?${i + 1}`).join(',');
  const [snapR, orderR, posR, tokR, openR] = await db.batch([
    db.prepare(`SELECT id, mint, stage, observed_at, price_usd, liquidity_usd, buys_m5, sells_m5 FROM price_snapshots WHERE mint IN (${ph})`).bind(...mints),
    db.prepare(`SELECT id, mint, strategy_id, side, signal_stage, requested_usd, status, reason FROM paper_orders WHERE mint IN (${ph})`).bind(...mints),
    db.prepare(`SELECT id, mint, strategy_id, status, quantity, cost_usd, entry_price_usd FROM paper_positions WHERE mint IN (${ph})`).bind(...mints),
    db.prepare(`SELECT mint, risk_level FROM tokens WHERE mint IN (${ph})`).bind(...mints),
    db.prepare(`SELECT strategy_id, COUNT(*) AS n FROM paper_positions WHERE status = 'open' GROUP BY strategy_id`),
  ]);
  const snaps = new Map<string, Snap>();
  for (const s of snapR.results as Snap[]) snaps.set(`${s.mint}:${s.stage}`, s);
  const orders = orderR.results as OrderRow[];
  const positions = posR.results as PosRow[];
  const risk = new Map((tokR.results as { mint: string; risk_level: string | null }[]).map((t) => [t.mint, t.risk_level]));
  const openCount = new Map((openR.results as { strategy_id: string; n: number }[]).map((r) => [r.strategy_id, r.n]));
  const C = PAPER_CONFIG;
  const later: D1PreparedStatement[] = [];
  const setOrder = (id: number, status: string, reject: string | null) =>
    db.prepare(`UPDATE paper_orders SET status = ?2, reject_reason = ?3 WHERE id = ?1`).bind(id, status, reject);

  const closePosition = async (pos: PosRow, order: OrderRow | null, snap: Snap, reason: string): Promise<boolean> => {
    const f = simulateSell(pos.quantity, snap.price_usd, snap.liquidity_usd);
    if (!f.ok) return false;
    let orderId = order?.id;
    if (!orderId) {
      // 期限決済でシグナル行が無い場合（取りこぼし時の保険）
      const r = await db
        .prepare(`INSERT INTO paper_orders (mint, strategy_id, side, signal_at, signal_stage, requested_usd, status, reason, saved_at) VALUES (?1,?2,'SELL',?3,?4,?5,'filled',?6,?7)`)
        .bind(pos.mint, pos.strategy_id, snap.observed_at, snap.stage, pos.quantity * f.price, reason, now)
        .run();
      stats.rowsWritten += written(r);
      orderId = r.meta.last_row_id;
    }
    const t = await db
      .prepare(
        `INSERT INTO paper_trades (order_id, mint, filled_at, fill_price_usd, fill_snapshot_id, quantity, fee_usd, priority_fee_usd, slippage_usd, saved_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
      )
      .bind(orderId, pos.mint, snap.observed_at, f.price, snap.id, pos.quantity, f.feeUsd, C.priorityFeeUsd, f.slippageUsd, now)
      .run();
    stats.rowsWritten += written(t);
    const net = f.proceedsUsd - C.priorityFeeUsd;
    later.push(
      db
        .prepare(`UPDATE paper_positions SET status = 'closed', closed_at = ?2, exit_trade_id = ?3, realized_pnl_usd = ?4, proceeds_usd = ?5, exit_reason = ?6 WHERE id = ?1`)
        .bind(pos.id, snap.observed_at, t.meta.last_row_id, net - pos.cost_usd, net, reason),
    );
    if (order) later.push(setOrder(order.id, 'filled', null));
    pos.status = 'closed';
    openCount.set(pos.strategy_id, Math.max(0, (openCount.get(pos.strategy_id) ?? 1) - 1));
    return true;
  };

  for (const { mint, stage } of touched) {
    const snap = snaps.get(`${mint}:${stage}`);
    if (!snap) continue;
    const myOrders = orders.filter((o) => o.mint === mint);
    const myPos = positions.filter((p) => p.mint === mint);
    const openedNow = new Set<string>();

    // --- A. 以前のシグナルを、今回観測した価格で約定評価する ---
    for (const o of myOrders) {
      if (o.status !== 'pending' || o.signal_stage >= stage) continue;
      if (o.side === 'BUY') {
        if ((openCount.get(o.strategy_id) ?? 0) >= C.maxOpenPerStrategy) {
          later.push(setOrder(o.id, 'unfilled', 'max_positions'));
          o.status = 'unfilled';
          continue;
        }
        const f = simulateBuy(o.requested_usd, snap.price_usd, snap.liquidity_usd);
        if (!f.ok) {
          later.push(setOrder(o.id, 'unfilled', f.reason));
          o.status = 'unfilled';
          continue;
        }
        const t = await db
          .prepare(
            `INSERT INTO paper_trades (order_id, mint, filled_at, fill_price_usd, fill_snapshot_id, quantity, fee_usd, priority_fee_usd, slippage_usd, saved_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
          )
          .bind(o.id, mint, snap.observed_at, f.effPrice, snap.id, f.quantity, f.feeUsd, C.priorityFeeUsd, f.slippageUsd, now)
          .run();
        stats.rowsWritten += written(t);
        later.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO paper_positions (mint, strategy_id, opened_at, entry_trade_id, status, quantity, cost_usd, entry_price_usd, saved_at)
               VALUES (?1,?2,?3,?4,'open',?5,?6,?7,?8)`,
            )
            .bind(mint, o.strategy_id, snap.observed_at, t.meta.last_row_id, f.quantity, f.spentUsd + C.priorityFeeUsd, f.effPrice, now),
          setOrder(o.id, f.partial ? 'partial' : 'filled', null),
        );
        o.status = 'filled';
        openedNow.add(o.strategy_id);
        openCount.set(o.strategy_id, (openCount.get(o.strategy_id) ?? 0) + 1);
      } else {
        const pos = myPos.find((p) => p.strategy_id === o.strategy_id && p.status === 'open');
        if (!pos) {
          later.push(setOrder(o.id, 'unfilled', 'no_position'));
          o.status = 'unfilled';
          continue;
        }
        if (await closePosition(pos, o, snap, o.reason ?? 'signal')) {
          o.status = 'filled';
        } else if (stage >= FINAL_STAGE) {
          // 最後まで売れなかった: 利益は確定させず、投下額の全損として記録する
          later.push(
            db
              .prepare(`UPDATE paper_positions SET status = 'unsellable', closed_at = ?2, realized_pnl_usd = ?3, proceeds_usd = 0, exit_reason = 'unsellable' WHERE id = ?1`)
              .bind(pos.id, snap.observed_at, -pos.cost_usd),
            setOrder(o.id, 'unfilled', 'unsellable'),
          );
          pos.status = 'unsellable';
          o.status = 'unfilled';
          openCount.set(pos.strategy_id, Math.max(0, (openCount.get(pos.strategy_id) ?? 1) - 1));
        } // それ以外は pending のまま次のスナップショットで再評価
      }
    }

    // --- B. 今回の観測値で新しいシグナルを作る（約定は次回以降の観測値） ---
    const newOrder = (strategy: string, side: 'BUY' | 'SELL', usd: number, reason: string) =>
      later.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO paper_orders (mint, strategy_id, side, signal_at, signal_stage, requested_usd, status, reason, saved_at)
             VALUES (?1,?2,?3,?4,?5,?6,'pending',?7,?8)`,
          )
          .bind(mint, strategy, side, snap.observed_at, stage, usd, reason, now),
      );
    const ctx: Ctx = { snap, prev: snaps.get(`${mint}:${stage - 1}`), risk: risk.get(mint) ?? null, mint };
    for (const s of STRATEGIES) {
      if (s.entryStage !== stage || stage >= FINAL_STAGE) continue;
      if (myOrders.some((o) => o.strategy_id === s.id && o.side === 'BUY')) continue;
      // 枠が埋まっている間は注文自体を作らない（約定時にも再確認する）
      if ((openCount.get(s.id) ?? 0) >= C.maxOpenPerStrategy) continue;
      if (s.entry(ctx)) newOrder(s.id, 'BUY', C.orderUsd, 'entry');
    }
    for (const pos of myPos) {
      if (pos.status !== 'open' || openedNow.has(pos.strategy_id)) continue;
      const hasPendingSell = myOrders.some((o) => o.strategy_id === pos.strategy_id && o.side === 'SELL' && o.status === 'pending');
      if (stage >= FINAL_STAGE) {
        // 保有期限。シグナル行が無い建玉もここで必ず決済を試みる
        if (!hasPendingSell && !(await closePosition(pos, null, snap, 'max_hold'))) {
          later.push(
            db
              .prepare(`UPDATE paper_positions SET status = 'unsellable', closed_at = ?2, realized_pnl_usd = ?3, proceeds_usd = 0, exit_reason = 'unsellable' WHERE id = ?1`)
              .bind(pos.id, snap.observed_at, -pos.cost_usd),
          );
          pos.status = 'unsellable';
        }
        continue;
      }
      if (hasPendingSell) continue;
      const p = snap.price_usd;
      let reason: string | null = null;
      if (p !== null && p >= pos.entry_price_usd * (1 + C.takeProfit)) reason = 'take_profit';
      else if (p !== null && p <= pos.entry_price_usd * (1 - C.stopLoss)) reason = 'stop_loss';
      else if (stage === FINAL_STAGE - 1) reason = 'max_hold';
      if (reason) newOrder(pos.strategy_id, 'SELL', p !== null ? pos.quantity * p : 0, reason);
    }
  }
  if (later.length) stats.rowsWritten += written(await db.batch(later));
}

export const MIN_SAMPLE_FOR_STATS = 100;

/** 戦略別の成績。すべて手数料・優先手数料・価格影響を控除した後の値 */
export async function paperSummary(db: D1Database) {
  const [closedR, tradeR, orderR, openR] = await db.batch([
    db.prepare(`SELECT strategy_id, status, realized_pnl_usd, cost_usd FROM paper_positions WHERE status != 'open' ORDER BY closed_at LIMIT 5000`),
    db.prepare(
      `SELECT o.strategy_id, SUM(t.fee_usd + t.priority_fee_usd) AS fees, SUM(t.slippage_usd) AS slip
       FROM paper_trades t JOIN paper_orders o ON o.id = t.order_id GROUP BY o.strategy_id`,
    ),
    db.prepare(`SELECT strategy_id, side, status, COUNT(*) AS n FROM paper_orders GROUP BY strategy_id, side, status`),
    db.prepare(`SELECT strategy_id, COUNT(*) AS n, SUM(cost_usd) AS cost FROM paper_positions WHERE status = 'open' GROUP BY strategy_id`),
  ]);
  const closed = closedR.results as { strategy_id: string; status: string; realized_pnl_usd: number; cost_usd: number }[];
  const strategies = STRATEGIES.map((s) => {
    const rows = closed.filter((r) => r.strategy_id === s.id);
    const pnl = rows.map((r) => r.realized_pnl_usd ?? 0);
    const wins = pnl.filter((x) => x > 0);
    const losses = pnl.filter((x) => x <= 0);
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    let cum = 0;
    let peak = 0;
    let maxDd = 0;
    for (const x of pnl) {
      cum += x;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
    }
    const grossLoss = -sum(losses);
    const tr = (tradeR.results as { strategy_id: string; fees: number; slip: number }[]).find((r) => r.strategy_id === s.id);
    const ord = (orderR.results as { strategy_id: string; side: string; status: string; n: number }[]).filter((r) => r.strategy_id === s.id);
    const op = (openR.results as { strategy_id: string; n: number; cost: number }[]).find((r) => r.strategy_id === s.id);
    const n = rows.length;
    return {
      id: s.id,
      label: s.label,
      closed_trades: n,
      win_rate: n ? wins.length / n : null,
      avg_win_usd: wins.length ? sum(wins) / wins.length : null,
      avg_loss_usd: losses.length ? sum(losses) / losses.length : null,
      expectancy_usd: n ? sum(pnl) / n : null,
      total_pnl_usd: sum(pnl),
      max_drawdown_usd: maxDd,
      profit_factor: grossLoss > 0 ? sum(wins) / grossLoss : null,
      fees_usd: tr?.fees ?? 0,
      slippage_usd: tr?.slip ?? 0,
      unsellable: rows.filter((r) => r.status === 'unsellable').length,
      unfilled_orders: ord.filter((r) => r.status === 'unfilled').reduce((a, r) => a + r.n, 0),
      pending_orders: ord.filter((r) => r.status === 'pending').reduce((a, r) => a + r.n, 0),
      open_positions: op?.n ?? 0,
      open_cost_usd: op?.cost ?? 0,
      // サンプルが少ないうちは、どの数値も優位性の根拠にならない
      sample_sufficient: n >= MIN_SAMPLE_FOR_STATS,
    };
  });
  return { strategies, config: PAPER_CONFIG, min_sample: MIN_SAMPLE_FOR_STATS, generated_at: Date.now() };
}

export async function paperPositions(db: D1Database, status: 'open' | 'closed') {
  const where = status === 'open' ? `p.status = 'open'` : `p.status != 'open'`;
  const order = status === 'open' ? 'p.opened_at' : 'p.closed_at';
  const rows = await db
    .prepare(
      `SELECT p.id, p.mint, p.strategy_id, p.status, p.opened_at, p.closed_at, p.quantity, p.cost_usd, p.entry_price_usd,
              p.proceeds_usd, p.realized_pnl_usd, p.exit_reason, t.symbol, t.name, t.last_price_usd, t.last_observed_at
       FROM paper_positions p LEFT JOIN tokens t ON t.mint = p.mint WHERE ${where} ORDER BY ${order} DESC LIMIT 100`,
    )
    .all();
  return { positions: rows.results, generated_at: Date.now() };
}
