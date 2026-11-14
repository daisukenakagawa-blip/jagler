const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Solana アドレス（base58, 32〜44 文字）の形式検証。URL や SQL に入れる前に必ず通す。 */
export function isSolanaAddress(v: unknown): v is string {
  return typeof v === 'string' && BASE58_RE.test(v);
}

/** 文字列/数値を有限の number に。変換できなければ null（= 未取得）。 */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

export function str(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export function parseIsoMs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function intVar(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** タイミング攻撃を避けるための定数時間比較 */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function utcDayStart(now: number): number {
  return now - (now % 86_400_000);
}

export class HttpError extends Error {
  constructor(
    public source: string,
    public status: number | null,
    message: string,
  ) {
    super(message);
  }
}

/**
 * JSON 取得。タイムアウトあり。ネットワークエラーと 5xx のみ再試行する
 * （429 は再試行しない: レート制限を悪化させないため）。
 */
export async function fetchJson(
  source: string,
  url: string,
  opts: {
    timeoutMs?: number;
    retries?: number;
    /** 429 のときだけ行う追加の再試行回数（待機 1.5 秒 × 回数）。既定 0 */
    retries429?: number;
    headers?: Record<string, string>;
    /** 指定すると JSON を POST する */
    body?: unknown;
  } = {},
  counter?: { apiCalls: number },
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const retries = opts.retries ?? 1;
  let lastErr: HttpError | null = null;
  let left429 = opts.retries429 ?? 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
    if (counter) counter.apiCalls++;
    try {
      const res = await fetch(url, {
        method: opts.body === undefined ? 'GET' : 'POST',
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        headers: {
          accept: 'application/json',
          // Workers の fetch は既定で User-Agent を付けない。UA 無しを厳しく制限する API があるため明示する
          'user-agent': 'meme-radar-ai/0.4 (Cloudflare Workers; read-only market data collector)',
          ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(opts.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
        // Workers ランタイムは redirect:'error' 非対応。manual にして 3xx は res.ok=false で失敗扱い（リダイレクト先へは行かない）
        redirect: 'manual',
      });
      if (res.ok) return await res.json();
      lastErr = new HttpError(source, res.status, `HTTP ${res.status}`);
      if (res.status === 429 && left429 > 0) {
        left429--;
        attempt--; // 429 用の再試行は通常の再試行回数を消費しない
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (res.status < 500) break;
    } catch (e) {
      lastErr = new HttpError(source, null, e instanceof Error ? e.message.slice(0, 200) : 'fetch failed');
    }
  }
  throw lastErr ?? new HttpError(source, null, 'fetch failed');
}

/** 型を絞り込まない版（検索語の分岐用） */
export function looksLikeAddress(v: string): boolean {
  return BASE58_RE.test(v);
}
