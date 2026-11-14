import { DetectedPool, EMPTY_MARKET, MarketData } from './types';
import { int, isSolanaAddress, num, parseIsoMs, str } from './util';

export const GT_DEFAULT_BASE = 'https://api.geckoterminal.com/api/v2';
export const DS_DEFAULT_BASE = 'https://api.dexscreener.com';

/** 「新規トークン」側ではなく建値側とみなす既知のミント */
export const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const stripNet = (id: unknown): string | null =>
  typeof id === 'string' && id.startsWith('solana_') ? id.slice(7) : null;

export function gtNewPoolsUrl(base: string): string {
  return `${base}/networks/solana/new_pools?include=base_token,quote_token,dex&page=1`;
}

/**
 * GeckoTerminal /networks/solana/new_pools の応答を正規化する。
 * 仕様: https://docs.coingecko.com/demo/reference/latest-pools-network
 * 形式が想定と異なる要素は捨てる（推測で補完しない）。
 */
export function parseGtNewPools(json: unknown): DetectedPool[] {
  const root = obj(json);
  const data = Array.isArray(root.data) ? root.data : [];
  const included = Array.isArray(root.included) ? root.included : [];

  const tokens = new Map<string, Obj>();
  const dexes = new Map<string, string | null>();
  for (const inc of included) {
    const o = obj(inc);
    if (o.type === 'token' && typeof o.id === 'string') tokens.set(o.id, obj(o.attributes));
    if (o.type === 'dex' && typeof o.id === 'string') dexes.set(o.id, str(obj(o.attributes).name));
  }

  const out: DetectedPool[] = [];
  for (const item of data) {
    const p = obj(item);
    const a = obj(p.attributes);
    const rel = obj(p.relationships);
    const poolAddress = str(a.address);
    const baseId = obj(obj(rel.base_token).data).id;
    const quoteId = obj(obj(rel.quote_token).data).id;
    const baseMint = stripNet(baseId);
    const quoteMint = stripNet(quoteId);
    if (!isSolanaAddress(poolAddress) || !isSolanaAddress(baseMint)) continue;

    // 通常は base が新規トークン。base が SOL/USDC 等なら quote 側を対象にする。
    const targetIsBase = !QUOTE_MINTS.has(baseMint) || !isSolanaAddress(quoteMint) || QUOTE_MINTS.has(quoteMint);
    if (QUOTE_MINTS.has(baseMint) && (!isSolanaAddress(quoteMint) || QUOTE_MINTS.has(quoteMint))) continue; // 建値同士
    const mint = targetIsBase ? baseMint : (quoteMint as string);
    const other = targetIsBase ? quoteMint : baseMint;
    const tAttr = tokens.get((targetIsBase ? baseId : quoteId) as string) ?? {};
    const oAttr = tokens.get((targetIsBase ? quoteId : baseId) as string) ?? {};

    const tx = obj(a.transactions);
    const vol = obj(a.volume_usd);
    const dexId = str(obj(obj(rel.dex).data).id);

    const market: MarketData = {
      ...EMPTY_MARKET,
      priceUsd: num(targetIsBase ? a.base_token_price_usd : a.quote_token_price_usd),
      // FDV / 時価総額は base トークン基準の値なので、対象が quote 側のときは未取得とする
      fdvUsd: targetIsBase ? num(a.fdv_usd) : null,
      marketCapUsd: targetIsBase ? num(a.market_cap_usd) : null,
      liquidityUsd: num(a.reserve_in_usd),
      volumeM5Usd: num(vol.m5),
      volumeH1Usd: num(vol.h1),
      volumeH24Usd: num(vol.h24),
      // buys/sells も base トークン基準
      buysM5: targetIsBase ? int(obj(tx.m5).buys) : null,
      sellsM5: targetIsBase ? int(obj(tx.m5).sells) : null,
      buysH1: targetIsBase ? int(obj(tx.h1).buys) : null,
      sellsH1: targetIsBase ? int(obj(tx.h1).sells) : null,
      buysH24: targetIsBase ? int(obj(tx.h24).buys) : null,
      sellsH24: targetIsBase ? int(obj(tx.h24).sells) : null,
      buyersH24: targetIsBase ? int(obj(tx.h24).buyers) : null,
      sellersH24: targetIsBase ? int(obj(tx.h24).sellers) : null,
    };

    out.push({
      poolAddress,
      mint,
      name: str(tAttr.name),
      symbol: str(tAttr.symbol, 40),
      decimals: int(tAttr.decimals),
      dexId,
      dexName: dexId ? (dexes.get(dexId) ?? null) : null,
      quoteMint: isSolanaAddress(other) ? other : null,
      quoteSymbol: str(oAttr.symbol, 40),
      poolCreatedAt: parseIsoMs(a.pool_created_at),
      market,
    });
  }
  return out;
}

export const DS_MAX_ADDRESSES = 30;

export function dsTokensUrl(base: string, mints: string[]): string {
  const safe = mints.filter(isSolanaAddress).slice(0, DS_MAX_ADDRESSES);
  return `${base}/tokens/v1/solana/${safe.join(',')}`;
}

export interface DsQuote {
  poolAddress: string | null;
  dexId: string | null;
  market: MarketData;
}

/**
 * DEX Screener /tokens/v1/solana/{mints} の応答（ペア配列）を、ミントごとに
 * 流動性が最大のペア 1 件へ正規化する。対象ミントが base 側のペアだけを使う
 * （priceUsd / fdv / marketCap は base トークン基準のため）。
 */
export function parseDsTokens(json: unknown, mints: string[]): Map<string, DsQuote> {
  const wanted = new Set(mints);
  const best = new Map<string, { liq: number; q: DsQuote }>();
  const pairs = Array.isArray(json) ? json : Array.isArray(obj(json).pairs) ? (obj(json).pairs as unknown[]) : [];
  for (const raw of pairs) {
    const p = obj(raw);
    if (p.chainId !== 'solana') continue;
    const mint = str(obj(p.baseToken).address);
    if (!mint || !wanted.has(mint)) continue;
    const tx = obj(p.txns);
    const vol = obj(p.volume);
    const liquidityUsd = num(obj(p.liquidity).usd);
    const pairAddress = str(p.pairAddress);
    const q: DsQuote = {
      poolAddress: isSolanaAddress(pairAddress) ? pairAddress : null,
      dexId: str(p.dexId, 60),
      market: {
        ...EMPTY_MARKET,
        priceUsd: num(p.priceUsd),
        fdvUsd: num(p.fdv),
        marketCapUsd: num(p.marketCap),
        liquidityUsd,
        volumeM5Usd: num(vol.m5),
        volumeH1Usd: num(vol.h1),
        volumeH24Usd: num(vol.h24),
        buysM5: int(obj(tx.m5).buys),
        sellsM5: int(obj(tx.m5).sells),
        buysH1: int(obj(tx.h1).buys),
        sellsH1: int(obj(tx.h1).sells),
        buysH24: int(obj(tx.h24).buys),
        sellsH24: int(obj(tx.h24).sells),
        // DEX Screener はユニーク購入者数を返さない → 未取得のまま
      },
    };
    const liq = liquidityUsd ?? -1;
    const cur = best.get(mint);
    if (!cur || liq > cur.liq) best.set(mint, { liq, q });
  }
  const out = new Map<string, DsQuote>();
  for (const [k, v] of best) out.set(k, v.q);
  return out;
}
