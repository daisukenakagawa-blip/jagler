-- 自動生成: npm run gen:migration （編集しない。定義元は src/worker/schema.ts）
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  decimals INTEGER,
  token_program TEXT,
  mint_authority_state TEXT,
  freeze_authority_state TEXT,
  minted_at INTEGER,
  first_pool_created_at INTEGER,
  first_trade_at INTEGER,
  detected_at INTEGER NOT NULL,
  detection_source TEXT NOT NULL,
  detection_delay_sec INTEGER,
  primary_pool_address TEXT,
  primary_dex_id TEXT,
  snapshot_stage INTEGER NOT NULL DEFAULT 0,
  next_snapshot_at INTEGER,
  initial_price_usd REAL,
  last_price_usd REAL,
  last_liquidity_usd REAL,
  last_fdv_usd REAL,
  last_market_cap_usd REAL,
  last_volume_h24_usd REAL,
  last_observed_at INTEGER,
  last_source TEXT,
  data_quality TEXT NOT NULL DEFAULT 'partial',
  saved_at INTEGER NOT NULL,
  risk_level TEXT,
  security_score REAL,
  risk_assessed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tokens_detected_at ON tokens(detected_at);

CREATE INDEX IF NOT EXISTS idx_tokens_next_snapshot ON tokens(next_snapshot_at) WHERE next_snapshot_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  event_type TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  payload TEXT,
  saved_at INTEGER NOT NULL,
  UNIQUE(mint, event_type, ref, source)
);

CREATE TABLE IF NOT EXISTS liquidity_pools (
  pool_address TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  dex_id TEXT,
  dex_name TEXT,
  quote_mint TEXT,
  quote_symbol TEXT,
  pool_created_at INTEGER,
  lp_status TEXT,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  saved_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pools_mint ON liquidity_pools(mint);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  pool_address TEXT,
  source TEXT NOT NULL,
  stage INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  price_usd REAL,
  market_cap_usd REAL,
  fdv_usd REAL,
  liquidity_usd REAL,
  volume_m5_usd REAL,
  volume_h1_usd REAL,
  volume_h24_usd REAL,
  buys_m5 INTEGER,
  sells_m5 INTEGER,
  buys_h1 INTEGER,
  sells_h1 INTEGER,
  buys_h24 INTEGER,
  sells_h24 INTEGER,
  buyers_h24 INTEGER,
  sellers_h24 INTEGER,
  data_quality TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  UNIQUE(mint, stage)
);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  holder_count INTEGER,
  top1_pct REAL,
  top10_pct REAL,
  top20_pct REAL,
  data_quality TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  UNIQUE(mint, source, observed_at)
);

CREATE TABLE IF NOT EXISTS developer_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  role TEXT NOT NULL,
  holding_pct REAL,
  source TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  UNIQUE(mint, wallet, role)
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  assessed_at INTEGER NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','UNKNOWN')),
  security_score REAL,
  evidence TEXT NOT NULL,
  ruleset_version TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  UNIQUE(mint, assessed_at, ruleset_version)
);

CREATE TABLE IF NOT EXISTS model_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  model_version TEXT NOT NULL,
  predicted_at INTEGER NOT NULL,
  features_observed_until INTEGER NOT NULL,
  momentum_score REAL,
  expected_return_score REAL,
  status TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  UNIQUE(mint, model_version, predicted_at)
);

CREATE TABLE IF NOT EXISTS paper_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  signal_at INTEGER NOT NULL,
  requested_usd REAL NOT NULL,
  status TEXT NOT NULL,
  reject_reason TEXT,
  saved_at INTEGER NOT NULL,
  UNIQUE(mint, strategy_id, side, signal_at)
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE,
  mint TEXT NOT NULL,
  filled_at INTEGER NOT NULL,
  fill_price_usd REAL NOT NULL,
  fill_snapshot_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  fee_usd REAL NOT NULL,
  priority_fee_usd REAL NOT NULL,
  slippage_usd REAL NOT NULL,
  saved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  entry_trade_id INTEGER NOT NULL,
  exit_trade_id INTEGER,
  status TEXT NOT NULL,
  realized_pnl_usd REAL,
  exit_reason TEXT,
  saved_at INTEGER NOT NULL,
  UNIQUE(mint, strategy_id, opened_at)
);

CREATE TABLE IF NOT EXISTS strategy_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  metrics TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  UNIQUE(strategy_id, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  pools_seen INTEGER NOT NULL DEFAULT 0,
  tokens_new INTEGER NOT NULL DEFAULT 0,
  tokens_skipped_budget INTEGER NOT NULL DEFAULT 0,
  snapshots_written INTEGER NOT NULL DEFAULT 0,
  snapshots_missing INTEGER NOT NULL DEFAULT 0,
  api_calls INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON ingestion_runs(started_at);

CREATE TABLE IF NOT EXISTS system_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at INTEGER NOT NULL,
  component TEXT NOT NULL,
  source TEXT,
  http_status INTEGER,
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_errors_occurred ON system_errors(occurred_at);

INSERT INTO schema_meta(key, value) VALUES('version', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
