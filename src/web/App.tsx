import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError, NA, QUALITY_LABEL, RUN_STATUS_LABEL, api, fmtAgo, fmtDelay, fmtInt, fmtPct, fmtPrice, fmtTime, fmtUsd,
  getAccessToken, getTheme, pctChange, setAccessToken, setTheme, shortAddr, stageLabel,
} from './lib';

// ---------- 型（API 応答） ----------
interface TokenRow {
  mint: string;
  name: string | null;
  symbol: string | null;
  primary_dex_id: string | null;
  first_pool_created_at: number | null;
  detected_at: number;
  detection_delay_sec: number | null;
  snapshot_stage: number;
  initial_price_usd: number | null;
  last_price_usd: number | null;
  last_liquidity_usd: number | null;
  last_fdv_usd: number | null;
  last_market_cap_usd: number | null;
  last_volume_h24_usd: number | null;
  last_observed_at: number | null;
  last_source: string | null;
  risk_level: string | null;
  security_score: number | null;
}
interface TokenList {
  tokens: TokenRow[];
  next_before: number | null;
  generated_at?: number;
}
interface Snapshot {
  stage: number;
  source: string;
  observed_at: number;
  price_usd: number | null;
  liquidity_usd: number | null;
  fdv_usd: number | null;
  market_cap_usd: number | null;
  volume_h24_usd: number | null;
  buys_h24: number | null;
  sells_h24: number | null;
  buyers_h24: number | null;
  data_quality: string;
}
interface Pool {
  pool_address: string;
  dex_id: string | null;
  dex_name: string | null;
  quote_symbol: string | null;
  pool_created_at: number | null;
}
interface Finding {
  check: string;
  severity: 'HIGH' | 'MEDIUM' | 'INFO';
  detail: string;
}
interface Detail {
  token: TokenRow & {
    decimals: number | null;
    primary_pool_address: string | null;
    token_program: string | null;
    mint_authority_state: string | null;
    freeze_authority_state: string | null;
  };
  risk: { assessed_at: number; risk_level: string; security_score: number | null; ruleset_version: string; findings: Finding[] } | null;
  holders: { observed_at: number; top1_pct: number | null; top10_pct: number | null } | null;
  pools: Pool[];
  snapshots: Snapshot[];
  stage_offsets_min: number[];
  generated_at: number;
}
interface Status {
  generated_at: number;
  last_run: { started_at: number; status: string; pools_seen: number; tokens_new: number; error_summary: string | null } | null;
  last_ok_at: number | null;
  runs_24h: { status: string; n: number; tokens_new: number; skipped: number; snaps: number; snaps_missing: number; api_calls: number }[];
  detection_delay_24h: { total: number; unknown: number; le30: number; le60: number; le180: number; le300: number } | null;
  tracking_tokens: number;
  snapshot_quality_24h: { data_quality: string; n: number }[];
  risk_levels_24h?: { level: string; n: number }[];
  errors_24h: { occurred_at: number; component: string; source: string | null; http_status: number | null; message: string }[];
  write_budget: { used_today: number; budget: number; d1_free_limit: number };
}

// ---------- 共通 ----------
function useHashRoute(): string {
  const [h, setH] = useState(() => location.hash.slice(1) || '/');
  useEffect(() => {
    const f = () => {
      setH(location.hash.slice(1) || '/');
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return h;
}

function useApi<T>(path: string | null, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(path);
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id !== seq.current) return;
      if (e instanceof ApiError && e.status === 401) setError('認証が必要です。設定画面でアクセストークンを入力してください。');
      else if (e instanceof ApiError && e.status === 404) setError('データが見つかりません。');
      else setError('取得に失敗しました。通信状況を確認してください（表示中の値は古い可能性があります）。');
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void load();
    if (!intervalMs) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, intervalMs);
    const vis = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [load, intervalMs]);
  return { data, error, loading, reload: load };
}

function Stamp({ at, loading, onReload }: { at?: number | null; loading: boolean; onReload: () => void }) {
  return (
    <div className="stamp">
      <span>データ取得: {at ? fmtTime(at) : '—'}</span>
      <button className="btn-ghost" onClick={onReload} disabled={loading}>
        {loading ? '更新中…' : '更新'}
      </button>
    </div>
  );
}

const Err = ({ msg }: { msg: string | null }) => (msg ? <div className="alert" role="alert">{msg}</div> : null);
const Val = ({ v }: { v: string }) => <span className={v === NA ? 'na' : undefined}>{v}</span>;

function Pct({ v }: { v: number | null }) {
  if (v === null) return <span className="na">{NA}</span>;
  return <span className={v >= 0 ? 'up' : 'down'}>{fmtPct(v)}</span>;
}

const RISK_LABEL: Record<string, string> = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', UNKNOWN: 'UNKNOWN', PENDING: '未判定' };
function RiskBadge({ level }: { level: string | null }) {
  const l = level ?? 'PENDING';
  return <span className={`risk risk-${l.toLowerCase()}`}>{RISK_LABEL[l] ?? l}</span>;
}
const AUTH_LABEL: Record<string, string> = { present: '残っている', revoked: '放棄済み' };
const PROGRAM_LABEL: Record<string, string> = {
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token（従来型）',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
};

function TokenItem({ t }: { t: TokenRow }) {
  const chg = pctChange(t.initial_price_usd, t.last_price_usd);
  return (
    <a className="row" href={`#/token/${t.mint}`}>
      <div className="row-main">
        <div className="row-title">
          <strong>{t.symbol ?? '（シンボル未取得）'}</strong>
          <span className="muted ellipsis">{t.name ?? ''}</span>
        </div>
        <div className="row-sub">
          <span className="mono">{shortAddr(t.mint)}</span>
          <RiskBadge level={t.risk_level} />
          {t.primary_dex_id && <span className="chip">{t.primary_dex_id}</span>}
          <span>検出 {fmtAgo(t.detected_at)}</span>
        </div>
      </div>
      <div className="row-side">
        <div><Val v={fmtPrice(t.last_price_usd)} /></div>
        <div className="row-sub">
          流動性 <Val v={fmtUsd(t.last_liquidity_usd)} />
        </div>
        {t.last_source === 'dexscreener' && (
          <div className="row-sub">
            検出比 <Pct v={chg} />
          </div>
        )}
      </div>
    </a>
  );
}

// ---------- 画面 ----------
function Dashboard() {
  const st = useApi<Status>('/api/status', 60_000);
  const tk = useApi<TokenList>('/api/tokens?limit=8', 60_000);
  const s = st.data;
  const sum = (k: 'tokens_new' | 'skipped' | 'snaps' | 'snaps_missing' | 'n') =>
    s ? s.runs_24h.reduce((a, r) => a + (r[k] ?? 0), 0) : null;
  const d = s?.detection_delay_24h;
  const known = d ? d.total - d.unknown : 0;
  const share = (n: number) => (known > 0 ? `${((n / known) * 100).toFixed(0)}%` : NA);
  const stale = s?.last_run ? Date.now() - s.last_run.started_at > 5 * 60_000 : false;
  const b = s?.write_budget;

  return (
    <>
      <h1>ダッシュボード</h1>
      <Stamp at={s?.generated_at} loading={st.loading} onReload={() => { void st.reload(); void tk.reload(); }} />
      <Err msg={st.error} />
      {s && !s.last_run && <div className="alert">まだ収集が一度も実行されていません。デプロイ直後は 1〜2 分お待ちください。</div>}
      {s && stale && <div className="alert">最後の収集から 5 分以上経過しています。定期実行が止まっている可能性があります。</div>}
      {s && (
        <>
          <div className="grid">
            <div className="card">
              <div className="label">最終実行</div>
              <div className="big">{s.last_run ? fmtAgo(s.last_run.started_at) : '—'}</div>
              <div className={`sub ${s.last_run && s.last_run.status !== 'ok' ? 'warn' : ''}`}>
                {s.last_run ? (RUN_STATUS_LABEL[s.last_run.status] ?? s.last_run.status) : '未実行'}
              </div>
            </div>
            <div className="card">
              <div className="label">新規検出（24時間）</div>
              <div className="big">{fmtInt(sum('tokens_new'))}</div>
              <div className="sub">上限による見送り 延べ{fmtInt(sum('skipped'))}</div>
            </div>
            <div className="card">
              <div className="label">追跡中の銘柄</div>
              <div className="big">{fmtInt(s.tracking_tokens)}</div>
              <div className="sub">検出後24時間まで</div>
            </div>
            <div className="card">
              <div className="label">追跡スナップショット（24時間）</div>
              <div className="big">{fmtInt(sum('snaps'))}</div>
              <div className={`sub ${(sum('snaps_missing') ?? 0) > 0 ? 'warn' : ''}`}>欠損 {fmtInt(sum('snaps_missing'))}</div>
            </div>
          </div>

          <section className="card">
            <div className="label">検出遅延の分布（24時間・検出済み銘柄のみ）</div>
            <table className="kv">
              <tbody>
                <tr><th>30秒以内</th><td>{d ? `${fmtInt(d.le30)} 件（${share(d.le30)}）` : NA}</td></tr>
                <tr><th>1分以内</th><td>{d ? `${fmtInt(d.le60)} 件（${share(d.le60)}）` : NA}</td></tr>
                <tr><th>3分以内</th><td>{d ? `${fmtInt(d.le180)} 件（${share(d.le180)}）` : NA}</td></tr>
                <tr><th>5分以内</th><td>{d ? `${fmtInt(d.le300)} 件（${share(d.le300)}）` : NA}</td></tr>
                <tr><th>作成時刻が未取得</th><td>{d ? `${fmtInt(d.unknown)} 件` : NA}</td></tr>
              </tbody>
            </table>
            <p className="note">
              プール作成時刻（GeckoTerminal 報告値）から本システムが検出するまでの時間です。検出できなかった銘柄は分母に含まれないため、網羅的な「検出率」ではありません。
            </p>
          </section>

          {s.risk_levels_24h && (
            <section className="card">
              <div className="label">リスク判定の内訳（24時間に検出した銘柄）</div>
              <table className="kv">
                <tbody>
                  {['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN', 'PENDING'].map((lv) => (
                    <tr key={lv}>
                      <th><RiskBadge level={lv} /></th>
                      <td>{fmtInt(s.risk_levels_24h?.find((r) => r.level === lv)?.n ?? 0)} 件</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note">
                権限・Token-2022 拡張・保有集中だけを見たルール判定です。LOW でも安全は保証されません。開発者の売却や LP の状態は未検査です。
              </p>
            </section>
          )}

          {b && (
            <section className="card">
              <div className="label">本日の D1 書き込み（UTC 0時リセット）</div>
              <progress value={Math.min(b.used_today, b.budget)} max={b.budget} />
              <div className="sub">
                {fmtInt(b.used_today)} / 自主上限 {fmtInt(b.budget)} 行（無料枠 {fmtInt(b.d1_free_limit)} 行/日）
              </div>
            </section>
          )}
        </>
      )}

      <h2>最新の検出</h2>
      <Err msg={tk.error} />
      <div className="list">
        {tk.data?.tokens.map((t) => <TokenItem key={t.mint} t={t} />)}
        {tk.data && tk.data.tokens.length === 0 && <p className="empty">まだ検出された銘柄がありません。</p>}
      </div>
      <a className="more" href="#/tokens">すべて見る</a>
      <p className="note">
        表示はすべて外部 API とオンチェーンの実測値です。仮想売買・収益予測は未実装で、本画面は投資判断の根拠になりません。
      </p>
    </>
  );
}

function Tokens() {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [sort, setSort] = useState<'new' | 'liquidity'>('new');
  const [minLiq, setMinLiq] = useState(0);
  const [risk, setRisk] = useState('');
  const [extra, setExtra] = useState<TokenRow[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const qs = `sort=${sort}${risk ? `&risk=${risk}` : ''}${minLiq ? `&min_liq=${minLiq}` : ''}${applied ? `&q=${encodeURIComponent(applied)}` : ''}`;
  const { data, error, loading, reload } = useApi<TokenList>(`/api/tokens?limit=50&${qs}`, 60_000);

  useEffect(() => {
    setExtra([]);
    setNextBefore(data?.next_before ?? null);
  }, [data]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setMoreLoading(true);
    try {
      const d = await api<TokenList>(`/api/tokens?limit=50&before=${nextBefore}&${qs}`);
      setExtra((x) => [...x, ...d.tokens]);
      setNextBefore(d.next_before);
    } catch {
      /* 上部の更新ボタンで再試行できる */
    } finally {
      setMoreLoading(false);
    }
  };
  const all = [...(data?.tokens ?? []), ...extra];

  return (
    <>
      <h1>新規発行トークン</h1>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(q.trim());
        }}
      >
        <input
          type="search" inputMode="search" placeholder="シンボル・名前・Mintアドレス" value={q}
          onChange={(e) => setQ(e.target.value)} aria-label="検索" autoCapitalize="off" autoCorrect="off"
        />
        <button className="btn" type="submit">検索</button>
      </form>
      <div className="filters">
        <label>
          並び順
          <select value={sort} onChange={(e) => setSort(e.target.value as 'new' | 'liquidity')}>
            <option value="new">新着順</option>
            <option value="liquidity">流動性順（24時間内）</option>
          </select>
        </label>
        <label>
          最低流動性
          <select value={minLiq} onChange={(e) => setMinLiq(Number(e.target.value))}>
            <option value={0}>指定なし</option>
            <option value={1000}>$1K 以上</option>
            <option value={10000}>$10K 以上</option>
            <option value={50000}>$50K 以上</option>
          </select>
        </label>
        <label className="span2">
          リスク判定
          <select value={risk} onChange={(e) => setRisk(e.target.value)}>
            <option value="">すべて</option>
            <option value="HIGH">HIGH（危険銘柄）</option>
            <option value="MEDIUM">MEDIUM</option>
            <option value="LOW">LOW</option>
            <option value="UNKNOWN">UNKNOWN・未判定</option>
          </select>
        </label>
      </div>
      <Stamp at={data?.generated_at} loading={loading} onReload={() => void reload()} />
      <Err msg={error} />
      <div className="list">
        {all.map((t) => <TokenItem key={t.mint} t={t} />)}
        {data && all.length === 0 && <p className="empty">条件に合う銘柄がありません。</p>}
      </div>
      {nextBefore && sort === 'new' && (
        <button className="btn wide" onClick={() => void loadMore()} disabled={moreLoading}>
          {moreLoading ? '読み込み中…' : 'さらに読み込む'}
        </button>
      )}
      <p className="note">リスク絞り込みは直近 7 日の検出分が対象です。期待収益スコア順は、予測モデル（Phase 5）が未実装のため提供していません。</p>
    </>
  );
}

function TokenDetail({ mint }: { mint: string }) {
  const { data, error, loading, reload } = useApi<Detail>(`/api/tokens/${mint}`, 60_000);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* コピー不可の環境ではアドレスを長押しで選択できる */
    }
  };
  const t = data?.token;
  const offsets = data?.stage_offsets_min ?? [];
  const first = data?.snapshots.find((s) => s.stage === 0);
  const stages = offsets.length + 1;

  return (
    <>
      <a className="back" href="#/tokens">‹ 一覧へ</a>
      <h1>{t ? (t.symbol ?? '（シンボル未取得）') : 'トークン詳細'}</h1>
      {t?.name && <p className="muted">{t.name}</p>}
      <Stamp at={data?.generated_at} loading={loading} onReload={() => void reload()} />
      <Err msg={error} />

      <section className="card">
        <div className="label">Mint アドレス</div>
        <div className="addr mono">{mint}</div>
        <div className="actions">
          <button className="btn" onClick={() => void copy()}>{copied ? 'コピーしました' : 'アドレスをコピー'}</button>
          <a className="btn" href={`https://dexscreener.com/solana/${mint}`} target="_blank" rel="noopener noreferrer">DEX Screener</a>
          <a className="btn" href={`https://explorer.solana.com/address/${mint}`} target="_blank" rel="noopener noreferrer">Solana Explorer</a>
        </div>
      </section>

      {t && data && (
        <>
          <section className="card">
            <div className="label">リスク判定{data.risk ? `（${fmtTime(data.risk.assessed_at)} 時点 / ${data.risk.ruleset_version}）` : ''}</div>
            <div className={`big risk-text-${(data.risk?.risk_level ?? 'unknown').toLowerCase()}`}>{data.risk?.risk_level ?? 'UNKNOWN'}</div>
            {data.risk?.security_score != null && <div className="sub">Security Score {data.risk.security_score} / 100</div>}
            {!data.risk && <p className="note">まだ判定されていません（検出から 1 時間以内に順次判定。RPC 障害時は未判定のまま残ります）。</p>}
            {data.risk && (
              <ul className="findings">
                {data.risk.findings.map((f, i) => (
                  <li key={i} className={`sev-${f.severity.toLowerCase()}`}>
                    <span className="sev">{f.severity === 'INFO' ? '確認' : f.severity}</span>
                    <span className="small">{f.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="note">
              判定は取得できた情報の範囲に限られます。LOW でも安全を保証せず、詐欺リスクを排除するものではありません。
            </p>
          </section>

          <section className="card">
            <div className="label">最新の市場データ（{t.last_source ?? '—'} / {fmtTime(t.last_observed_at)}）</div>
            <table className="kv">
              <tbody>
                <tr><th>価格</th><td><Val v={fmtPrice(t.last_price_usd)} /></td></tr>
                <tr><th>流動性</th><td><Val v={fmtUsd(t.last_liquidity_usd)} /></td></tr>
                <tr><th>時価総額</th><td><Val v={fmtUsd(t.last_market_cap_usd)} /></td></tr>
                <tr><th>FDV</th><td><Val v={fmtUsd(t.last_fdv_usd)} /></td></tr>
                <tr><th>24時間取引量</th><td><Val v={fmtUsd(t.last_volume_h24_usd)} /></td></tr>
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="label">検出情報</div>
            <table className="kv">
              <tbody>
                <tr><th>初回プール作成</th><td><Val v={fmtTime(t.first_pool_created_at)} /></td></tr>
                <tr><th>検出時刻</th><td>{fmtTime(t.detected_at)}</td></tr>
                <tr><th>検出までの遅延</th><td><Val v={fmtDelay(t.detection_delay_sec)} /></td></tr>
                <tr><th>DEX</th><td><Val v={t.primary_dex_id ?? NA} /></td></tr>
                <tr><th>小数桁</th><td><Val v={fmtInt(t.decimals)} /></td></tr>
                <tr><th>Token Program</th><td><Val v={t.token_program ? (PROGRAM_LABEL[t.token_program] ?? t.token_program) : NA} /></td></tr>
                <tr><th>Mint権限</th><td className={t.mint_authority_state === 'present' ? 'warn' : undefined}><Val v={t.mint_authority_state ? AUTH_LABEL[t.mint_authority_state] : NA} /></td></tr>
                <tr><th>Freeze権限</th><td className={t.freeze_authority_state === 'present' ? 'warn' : undefined}><Val v={t.freeze_authority_state ? AUTH_LABEL[t.freeze_authority_state] : NA} /></td></tr>
                <tr><th>最大口座の保有割合</th><td><Val v={data.holders?.top1_pct != null ? `${data.holders.top1_pct.toFixed(1)}%` : NA} /></td></tr>
                <tr><th>上位10口座の合計</th><td><Val v={data.holders?.top10_pct != null ? `${data.holders.top10_pct.toFixed(1)}%` : NA} /></td></tr>
                {['発行時刻', '初回取引時刻', '保有者数', '開発者ウォレット', 'LP管理状況', 'ユニーク購入者数（追跡時）'].map((k) => (
                  <tr key={k}><th>{k}</th><td><span className="na">{NA}</span></td></tr>
                ))}
              </tbody>
            </table>
            <p className="note">「未取得」は取得処理が未実装、または取得に失敗した項目です。推測値は表示しません。最大口座はプール等の可能性があります。</p>
          </section>

          <section className="card">
            <div className="label">追跡スナップショット（実測）</div>
            <div className="scroll">
              <table className="tbl">
                <thead>
                  <tr><th>時点</th><th>価格</th><th>検出比</th><th>流動性</th><th>取得元</th><th>状態</th></tr>
                </thead>
                <tbody>
                  {Array.from({ length: stages }, (_, i) => {
                    const s = data.snapshots.find((x) => x.stage === i);
                    if (!s) {
                      return (
                        <tr key={i}>
                          <td>{stageLabel(i, offsets)}</td>
                          <td colSpan={5} className="muted">未到来</td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={i}>
                        <td>{stageLabel(i, offsets)}<div className="tiny">{fmtTime(s.observed_at)}</div></td>
                        <td><Val v={fmtPrice(s.price_usd)} /></td>
                        <td>{i === 0 ? '—' : <Pct v={pctChange(first?.price_usd, s.price_usd)} />}</td>
                        <td><Val v={fmtUsd(s.liquidity_usd)} /></td>
                        <td>{s.source}</td>
                        <td className={s.data_quality.startsWith('missing') ? 'warn' : undefined}>
                          {QUALITY_LABEL[s.data_quality] ?? s.data_quality}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="note">
              検出比は観測値どうしの単純な比で、手数料・スリッページ・売却可否を考慮していません。この値は売買で得られる損益を意味しません。
            </p>
          </section>

          <section className="card">
            <div className="label">流動性プール</div>
            {data.pools.map((p) => (
              <div key={p.pool_address} className="pool">
                <div className="mono small">{p.pool_address}</div>
                <div className="row-sub">
                  <span className="chip">{p.dex_name ?? p.dex_id ?? 'DEX未取得'}</span>
                  <span>建値 {p.quote_symbol ?? NA}</span>
                  <span>作成 {fmtTime(p.pool_created_at)}</span>
                </div>
              </div>
            ))}
          </section>
        </>
      )}
    </>
  );
}

function System() {
  const { data: s, error, loading, reload } = useApi<Status>('/api/status', 60_000);
  return (
    <>
      <h1>システム稼働状況</h1>
      <Stamp at={s?.generated_at} loading={loading} onReload={() => void reload()} />
      <Err msg={error} />
      {s && (
        <>
          <section className="card">
            <div className="label">定期実行（24時間）</div>
            <table className="kv">
              <tbody>
                <tr><th>最後に正常終了</th><td><Val v={s.last_ok_at ? `${fmtTime(s.last_ok_at)}（${fmtAgo(s.last_ok_at)}）` : NA} /></td></tr>
                {s.runs_24h.map((r) => (
                  <tr key={r.status}>
                    <th>{RUN_STATUS_LABEL[r.status] ?? r.status}</th>
                    <td className={r.status === 'ok' ? undefined : 'warn'}>{fmtInt(r.n)} 回</td>
                  </tr>
                ))}
                <tr><th>API 呼び出し</th><td>{fmtInt(s.runs_24h.reduce((a, r) => a + (r.api_calls ?? 0), 0))} 回</td></tr>
              </tbody>
            </table>
            {s.runs_24h.length === 0 && <p className="empty">直近 24 時間の実行記録がありません。</p>}
            <p className="note">毎分 1 回の実行で 1 日 1,440 回が目安です。回数が少ない場合は欠測があります。</p>
          </section>

          <section className="card">
            <div className="label">スナップショットの品質（24時間）</div>
            <table className="kv">
              <tbody>
                {s.snapshot_quality_24h.map((g) => (
                  <tr key={g.data_quality}>
                    <th>{QUALITY_LABEL[g.data_quality] ?? g.data_quality}</th>
                    <td className={g.data_quality.startsWith('missing') ? 'warn' : undefined}>{fmtInt(g.n)} 件</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.snapshot_quality_24h.length === 0 && <p className="empty">記録がありません。</p>}
          </section>

          <section className="card">
            <div className="label">エラー（24時間・最新20件）</div>
            {s.errors_24h.length === 0 && <p className="empty">エラーはありません。</p>}
            {s.errors_24h.map((e, i) => (
              <div key={i} className="errrow">
                <div className="row-sub">
                  <span>{fmtTime(e.occurred_at)}</span>
                  <span className="chip">{e.source ?? e.component}</span>
                  {e.http_status && <span className="chip">HTTP {e.http_status}</span>}
                </div>
                <div className="small">{e.message}</div>
              </div>
            ))}
          </section>

          <section className="card">
            <div className="label">既知の制限</div>
            <ul className="bullets">
              <li>検出は GeckoTerminal の新規プール一覧（毎分・先頭20件）に依存します。発行直後や一覧から流れた銘柄は検出できません。</li>
              <li>D1 無料枠（書き込み10万行/日）を守るため、新規保存は 1 日に均等配分した少数（既定で約 1,900 銘柄/日）に制限しています。全銘柄の網羅ではなく標本です。</li>
              <li>Cloudflare 無料プランは稼働率を保証しません。定期実行が遅延・欠落することがあります。</li>
              <li>リスク判定は権限・Token-2022 拡張・保有集中のみ。開発者ウォレット、LP 状態、ウォッシュトレード等は未検査です。</li>
              <li>通知（Web Push）、仮想売買、予測モデルは未実装です。</li>
            </ul>
          </section>
        </>
      )}
    </>
  );
}

function Settings() {
  const [tok, setTok] = useState(getAccessToken());
  const [theme, setTh] = useState(getTheme());
  const [saved, setSaved] = useState(false);
  const health = useApi<{ ok: boolean; auth_required: boolean }>('/api/health');
  return (
    <>
      <h1>設定</h1>
      <section className="card">
        <div className="label">表示テーマ</div>
        <div className="actions">
          {(['dark', 'light'] as const).map((t) => (
            <button
              key={t} className={`btn ${theme === t ? 'on' : ''}`}
              onClick={() => { setTheme(t); setTh(t); }}
            >
              {t === 'dark' ? 'ダーク' : 'ライト'}
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <div className="label">アクセストークン</div>
        <p className="note">
          サーバー側で ACCESS_TOKEN を設定した場合のみ必要です（現在: {health.data ? (health.data.auth_required ? '認証あり' : '認証なし') : '確認中'}）。この端末のブラウザ内にだけ保存されます。
        </p>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            setAccessToken(tok.trim());
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
        >
          <input type="password" value={tok} onChange={(e) => setTok(e.target.value)} aria-label="アクセストークン" autoComplete="off" />
          <button className="btn" type="submit">{saved ? '保存しました' : '保存'}</button>
        </form>
      </section>
      <section className="card">
        <div className="label">未実装の画面</div>
        <ul className="bullets">
          <li>AI監視候補（スコアリングの残り: Momentum / Expected Return）</li>
          <li>仮想売買履歴・仮想ポートフォリオ（Phase 4）</li>
          <li>収益分析・予測モデルの検証結果（Phase 5）</li>
          <li>通知・仮想売買の条件設定（Phase 4〜6）</li>
        </ul>
        <p className="note">実データが無い画面は、見本データで埋めずに未実装としています。</p>
      </section>
      <section className="card">
        <div className="label">免責</div>
        <p className="note">
          本アプリは情報収集と仮想検証のためのものです。実資金の売買機能はありません。詐欺リスクを完全に排除することはできず、利益や勝率を保証するものではありません。
        </p>
      </section>
    </>
  );
}

const TABS = [
  { href: '#/', label: 'ダッシュボード', match: (r: string) => r === '/' },
  { href: '#/tokens', label: 'トークン', match: (r: string) => r.startsWith('/token') },
  { href: '#/system', label: '稼働状況', match: (r: string) => r === '/system' },
  { href: '#/settings', label: '設定', match: (r: string) => r === '/settings' },
];

export function App() {
  const route = useHashRoute();
  const m = route.match(/^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  let page;
  if (m) page = <TokenDetail key={m[1]} mint={m[1]} />;
  else if (route === '/tokens') page = <Tokens />;
  else if (route === '/system') page = <System />;
  else if (route === '/settings') page = <Settings />;
  else page = <Dashboard />;
  return (
    <>
      <main>{page}</main>
      <nav className="tabs" aria-label="メインメニュー">
        {TABS.map((t) => (
          <a key={t.href} href={t.href} className={t.match(route) ? 'active' : undefined} aria-current={t.match(route) ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
    </>
  );
}
