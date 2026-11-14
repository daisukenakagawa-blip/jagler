export const NA = '未取得';

const TOKEN_KEY = 'mr_access_token';
const THEME_KEY = 'mr_theme';

function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function lsSet(k: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* プライベートブラウズ等では保存できない */
  }
}

export const getAccessToken = () => lsGet(TOKEN_KEY) ?? '';
export const setAccessToken = (v: string) => lsSet(TOKEN_KEY, v || null);
export const getTheme = () => (lsGet(THEME_KEY) === 'light' ? 'light' : 'dark');
export function setTheme(t: 'dark' | 'light'): void {
  lsSet(THEME_KEY, t);
  document.documentElement.dataset.theme = t;
}

export class ApiError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

export async function api<T>(path: string): Promise<T> {
  const t = getAccessToken();
  const res = await fetch(path, { headers: t ? { authorization: `Bearer ${t}` } : {} });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return NA;
  if (v === 0) return '$0';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(3)}`;
}

export function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined) return NA;
  if (v >= 1) return `$${v.toFixed(4)}`;
  if (v >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toExponential(3)}`;
}

export function fmtInt(v: number | null | undefined): string {
  return v === null || v === undefined ? NA : v.toLocaleString('ja-JP');
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return NA;
  return new Date(ms).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function fmtAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return NA;
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

export function fmtDelay(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return NA;
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${sec % 60}秒`;
  return `${(sec / 3600).toFixed(1)}時間`;
}

/** 実測 2 点間の変化率。どちらかが未取得なら null（推測しない） */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined || from <= 0) return null;
  return ((to - from) / from) * 100;
}

export function fmtPct(v: number | null): string {
  if (v === null) return NA;
  const s = v >= 0 ? '+' : '';
  return `${s}${Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1)}%`;
}

export const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export const stageLabel = (stage: number, offsets: number[]): string => {
  if (stage === 0) return '検出時';
  const m = offsets[stage - 1];
  if (m === undefined) return `#${stage}`;
  return m < 60 ? `+${m}分` : `+${m / 60}時間`;
};

export const QUALITY_LABEL: Record<string, string> = {
  ok: '正常',
  partial: '一部未取得',
  missing_not_listed: '欠損（ペア応答なし）',
  missing_api_error: '欠損（API障害）',
};

export const RUN_STATUS_LABEL: Record<string, string> = {
  ok: '正常',
  partial: '一部失敗',
  failed: '失敗',
  budget_exhausted: '書き込み枠到達で停止',
};
