// テスト用: node:sqlite 上の最小 D1 互換層と、公式ドキュメントの応答形式に沿ったフィクスチャ。
// フィクスチャの値はテスト専用の作り物で、アプリ本体には一切含まれない。
import { DatabaseSync } from 'node:sqlite';

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: unknown[] = [],
  ) {}
  bind(...p: unknown[]) {
    return new Stmt(this.db, this.sql, p);
  }
  private named() {
    // D1 の ?1, ?2… を node:sqlite の番号付きパラメータへ
    const o: Record<string, unknown> = {};
    this.params.forEach((v, i) => (o[`?${i + 1}`] = v ?? null));
    return o;
  }
  private exec() {
    const st = this.db.prepare(this.sql);
    const usesNumbered = /\?\d/.test(this.sql);
    const args = usesNumbered ? [this.named()] : this.params.map((v) => v ?? null);
    if (/^\s*(SELECT|WITH)/i.test(this.sql)) {
      const results = st.all(...(args as never[]));
      return { results, success: true, meta: { rows_written: 0, changes: 0 } };
    }
    const r = st.run(...(args as never[]));
    return { results: [], success: true, meta: { rows_written: Number(r.changes), changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async all() {
    return this.exec();
  }
  async run() {
    return this.exec();
  }
  async first() {
    return (this.exec().results[0] as unknown) ?? null;
  }
  _exec() {
    return this.exec();
  }
}

export function makeD1(): D1Database & { raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  return {
    raw,
    prepare: (sql: string) => new Stmt(raw, sql),
    batch: async (stmts: Stmt[]) => {
      raw.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as D1Database & { raw: DatabaseSync };
}

export const WSOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** 決定的なテスト用アドレス（base58・44文字） */
export function addr(seed: number): string {
  let s = '';
  let x = seed * 7919 + 13;
  for (let i = 0; i < 44; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    s += B58[x % 58];
  }
  return s;
}

export function gtPool(i: number, createdAtIso: string, opts: { baseIsSol?: boolean; price?: string | null } = {}) {
  const mint = addr(1000 + i);
  const pool = addr(2000 + i);
  const base = opts.baseIsSol ? WSOL : mint;
  const quote = opts.baseIsSol ? mint : WSOL;
  return {
    id: `solana_${pool}`,
    type: 'pool',
    attributes: {
      base_token_price_usd: opts.price === undefined ? '0.0000123' : opts.price,
      quote_token_price_usd: '150.5',
      address: pool,
      name: `TKN${i} / SOL`,
      pool_created_at: createdAtIso,
      fdv_usd: '12300',
      market_cap_usd: null,
      reserve_in_usd: '8000.5',
      price_change_percentage: { m5: '1.2', h1: '3', h24: '3' },
      transactions: { m5: { buys: 4, sells: 1, buyers: 3, sellers: 1 }, h1: { buys: 9, sells: 2, buyers: 7, sellers: 2 }, h24: { buys: 9, sells: 2, buyers: 7, sellers: 2 } },
      volume_usd: { m5: '500.1', h1: '900', h24: '900' },
    },
    relationships: {
      base_token: { data: { id: `solana_${base}`, type: 'token' } },
      quote_token: { data: { id: `solana_${quote}`, type: 'token' } },
      dex: { data: { id: 'pumpswap', type: 'dex' } },
    },
  };
}

export function gtResponse(pools: ReturnType<typeof gtPool>[]) {
  const included: unknown[] = [
    { id: `solana_${WSOL}`, type: 'token', attributes: { address: WSOL, name: 'Wrapped SOL', symbol: 'SOL', decimals: 9 } },
    { id: 'pumpswap', type: 'dex', attributes: { name: 'PumpSwap' } },
  ];
  pools.forEach((p, idx) => {
    for (const k of ['base_token', 'quote_token'] as const) {
      const id = p.relationships[k].data.id;
      if (id !== `solana_${WSOL}`)
        included.push({ id, type: 'token', attributes: { address: id.slice(7), name: `Token ${idx}`, symbol: `TKN${idx}`, decimals: 6 } });
    }
  });
  return { data: pools, included };
}

export function dsPair(mint: string, pair: string, priceUsd: string, liqUsd: number) {
  return {
    chainId: 'solana',
    dexId: 'pumpswap',
    pairAddress: pair,
    baseToken: { address: mint, name: 'T', symbol: 'T' },
    quoteToken: { address: WSOL, name: 'Wrapped SOL', symbol: 'SOL' },
    priceNative: '0.0000001',
    priceUsd,
    txns: { m5: { buys: 1, sells: 2 }, h1: { buys: 10, sells: 12 }, h24: { buys: 100, sells: 90 } },
    volume: { m5: 10.5, h1: 100, h24: 2000 },
    liquidity: { usd: liqUsd, base: 1, quote: 1 },
    fdv: 50000,
    marketCap: 50000,
    pairCreatedAt: 1760000000000,
  };
}

/** getAccountInfo(jsonParsed) 形式の mint 口座応答 */
export function rpcMint(over: { mintAuthority?: string | null; freezeAuthority?: string | null; token2022?: boolean; extensions?: unknown[]; supply?: string } = {}) {
  return {
    jsonrpc: '2.0', id: 1,
    result: {
      context: { slot: 1 },
      value: {
        owner: over.token2022 ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        data: {
          program: over.token2022 ? 'spl-token-2022' : 'spl-token',
          parsed: {
            type: 'mint',
            info: {
              decimals: 6, isInitialized: true, supply: over.supply ?? '1000000000000000',
              mintAuthority: over.mintAuthority ?? null, freezeAuthority: over.freezeAuthority ?? null,
              ...(over.extensions ? { extensions: over.extensions } : {}),
            },
          },
        },
      },
    },
  };
}
/** getTokenLargestAccounts 形式。amounts は最小単位の整数文字列 */
export const rpcLargest = (amounts: string[]) => ({
  jsonrpc: '2.0', id: 1,
  result: { context: { slot: 1 }, value: amounts.map((amount, i) => ({ address: addr(5000 + i), amount, decimals: 6 })) },
});

type RpcHandler = (method: string, params: unknown[]) => Response | Promise<Response>;
/** fetch を差し替え、ホストごとに応答を返す。呼ばれた URL を記録する。rpc 未指定時は「権限放棄済み・分散」の応答 */
export function mockFetch(routes: { gt?: () => Response | Promise<Response>; ds?: (url: string) => Response | Promise<Response>; dp?: () => Response | Promise<Response>; rpc?: RpcHandler | ((method: string, params: unknown[], url: string) => Response | Promise<Response>) }) {
  const calls: string[] = [];
  const defaultRpc: RpcHandler = (method) =>
    jsonRes(method === 'getAccountInfo' ? rpcMint() : rpcLargest(['800000000000000', '20000000000000', '10000000000000']));
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('geckoterminal') && routes.gt) return routes.gt();
    if (url.includes('dexscreener') && routes.ds) return routes.ds(url);
    if (url.includes('dexpaprika') && routes.dp) return routes.dp();
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return (routes.rpc ?? defaultRpc)(body.method, body.params, url);
    }
    throw new Error('unexpected fetch ' + url);
  };
  return { fn: fn as typeof fetch, calls };
}

export const dpPool = (i: number, createdAtIso: string, solFirst = false) => ({
  id: addr(2000 + i), dex_id: 'pumpfun', dex_name: 'Pump.fun', chain: 'solana', created_at: createdAtIso,
  volume_usd_24h: 179.5, price_usd: 0.0000023, liquidity_usd: 1234.5,
  tokens: solFirst ? [{ id: WSOL, chain: 'solana' }, { id: addr(1000 + i), chain: 'solana' }] : [{ id: addr(1000 + i), chain: 'solana' }, { id: WSOL, chain: 'solana' }],
});

export const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
