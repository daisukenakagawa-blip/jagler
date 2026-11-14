export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** 設定すると /api/* 全体で Bearer 認証を要求する（Secret） */
  ACCESS_TOKEN?: string;
  /** /api/admin/* 用（Secret）。未設定なら管理 API は無効 */
  ADMIN_TOKEN?: string;
  DAILY_WRITE_BUDGET?: string;
  MAX_NEW_TOKENS_PER_RUN?: string;
  RETENTION_DAYS?: string;
  /** 結合テスト用の上書き。本番では未設定（既定の公式ホストを使う） */
  GT_BASE_URL?: string;
  DS_BASE_URL?: string;
  DP_BASE_URL?: string;
  /** Solana JSON-RPC。未設定なら公開エンドポイント。API キー入り URL は Secret で設定する */
  SOLANA_RPC_URL?: string;
  MAX_RISK_CHECKS_PER_RUN?: string;
}

/** 正規化済みの市場データ。null = 未取得（推測で埋めない） */
export interface MarketData {
  priceUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  volumeM5Usd: number | null;
  volumeH1Usd: number | null;
  volumeH24Usd: number | null;
  buysM5: number | null;
  sellsM5: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  buysH24: number | null;
  sellsH24: number | null;
  buyersH24: number | null;
  sellersH24: number | null;
}

export interface DetectedPool {
  poolAddress: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  dexId: string | null;
  dexName: string | null;
  quoteMint: string | null;
  quoteSymbol: string | null;
  poolCreatedAt: number | null;
  market: MarketData;
}

export const EMPTY_MARKET: MarketData = {
  priceUsd: null,
  marketCapUsd: null,
  fdvUsd: null,
  liquidityUsd: null,
  volumeM5Usd: null,
  volumeH1Usd: null,
  volumeH24Usd: null,
  buysM5: null,
  sellsM5: null,
  buysH1: null,
  sellsH1: null,
  buysH24: null,
  sellsH24: null,
  buyersH24: null,
  sellersH24: null,
};
