// Phase 3: オンチェーンのリスク分析（ルールベース v1）。
// 判定は「確認できた範囲」のもので、LOW でも安全を保証しない。取得できない情報は UNKNOWN / 未取得のまま残す。
import { Env } from './types';
import { HttpError, fetchJson, int, intVar, num, str } from './util';

export const RULESET_VERSION = 'rules-v1';
export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
/** 公式の公開 RPC は Cloudflare からの接続を 403 で拒否することがある（本番で確認）ため、キー不要の公開 RPC を予備にする */
export const FALLBACK_RPC = 'https://solana-rpc.publicnode.com';
let preferredRpc = 0;
let holdersPausedUntil = 0;
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export interface Finding {
  check: string;
  severity: 'HIGH' | 'MEDIUM' | 'INFO';
  detail: string;
}
export interface MintInfo {
  program: string | null;
  isToken2022: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string | null;
  decimals: number | null;
  extensions: { name: string; state: Record<string, unknown> }[];
}
export interface HolderInfo {
  top1Pct: number | null;
  top10Pct: number | null;
  /** 2〜10 位の合計（最大口座はプール等の可能性があり区別できないため別に見る） */
  top2to10Pct: number | null;
  accounts: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});

/** getAccountInfo(jsonParsed) の応答。口座が無い / mint でない場合は null */
export function parseMintAccount(json: unknown): MintInfo | null {
  const value = obj(obj(json).result).value;
  if (!value) return null;
  const v = obj(value);
  const parsed = obj(obj(v.data).parsed);
  if (parsed.type !== 'mint') return null;
  const info = obj(parsed.info);
  const program = str(v.owner, 60);
  const exts = Array.isArray(info.extensions) ? info.extensions : [];
  return {
    program,
    isToken2022: program === TOKEN_2022_PROGRAM,
    mintAuthority: str(info.mintAuthority, 60),
    freezeAuthority: str(info.freezeAuthority, 60),
    supply: typeof info.supply === 'string' && /^\d+$/.test(info.supply) ? info.supply : null,
    decimals: int(info.decimals),
    extensions: exts
      .map((e) => ({ name: str(obj(e).extension, 60) ?? '', state: obj(obj(e).state) }))
      .filter((e) => e.name),
  };
}

/** getTokenLargestAccounts の応答と総供給量から集中度を計算。計算できなければ null */
export function parseLargestAccounts(json: unknown, supply: string | null): HolderInfo | null {
  const value = obj(obj(json).result).value;
  if (!Array.isArray(value) || !supply) return null;
  const total = Number(supply);
  if (!(total > 0)) return null;
  const amounts = value
    .map((a) => Number(obj(a).amount))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => b - a);
  if (amounts.length === 0) return null;
  const pct = (n: number) => Math.min(100, (n / total) * 100);
  const top10 = amounts.slice(0, 10);
  return {
    top1Pct: pct(top10[0]),
    top10Pct: pct(top10.reduce((a, b) => a + b, 0)),
    top2to10Pct: pct(top10.slice(1).reduce((a, b) => a + b, 0)),
    accounts: amounts.length,
  };
}

/** 売却不能・強制移転・追加課金などに直結する Token-2022 拡張 */
const HIGH_EXTENSIONS: Record<string, string> = {
  permanentDelegate: '発行者側が保有者の残高を移転・焼却できる（永久委任）',
  nonTransferable: '譲渡不可トークン（売却できない）',
  transferHook: '転送のたびに外部プログラムが実行され、転送を拒否できる',
  pausableConfig: '発行者側が全転送を停止できる',
};
/** リスクに直結しない既知の拡張（情報として記録のみ） */
const BENIGN_EXTENSIONS = new Set([
  'tokenMetadata', 'metadataPointer', 'mintCloseAuthority', 'groupPointer', 'groupMemberPointer', 'tokenGroup',
  'tokenGroupMember', 'interestBearingConfig', 'scaledUiAmountConfig', 'confidentialTransferMint',
  'confidentialTransferFeeConfig', 'uninitialized',
]);
export const CONCENTRATION_MEDIUM_PCT = 30;

export function assess(mint: MintInfo | null, holders: HolderInfo | null): { level: RiskLevel; score: number | null; findings: Finding[] } {
  if (!mint) {
    return {
      level: 'UNKNOWN',
      score: null,
      findings: [{ check: 'mint_account', severity: 'INFO', detail: 'Mint 口座の情報を取得できなかったため判定できません' }],
    };
  }
  const f: Finding[] = [];
  f.push({
    check: 'token_program',
    severity: 'INFO',
    detail: mint.isToken2022 ? 'Token-2022 プログラム' : mint.program === TOKEN_PROGRAM ? 'SPL Token プログラム（従来型）' : `未知のプログラム: ${mint.program ?? '未取得'}`,
  });
  if (mint.program !== TOKEN_PROGRAM && !mint.isToken2022)
    f.push({ check: 'token_program', severity: 'HIGH', detail: '標準のトークンプログラムではありません' });

  f.push(
    mint.mintAuthority
      ? { check: 'mint_authority', severity: 'HIGH', detail: `Mint 権限が残っています（追加発行が可能）: ${mint.mintAuthority}` }
      : { check: 'mint_authority', severity: 'INFO', detail: 'Mint 権限は放棄済み（追加発行不可）' },
    mint.freezeAuthority
      ? { check: 'freeze_authority', severity: 'HIGH', detail: `Freeze 権限が残っています（口座を凍結され売却不能になり得る）: ${mint.freezeAuthority}` }
      : { check: 'freeze_authority', severity: 'INFO', detail: 'Freeze 権限は放棄済み' },
  );

  for (const e of mint.extensions) {
    if (HIGH_EXTENSIONS[e.name]) {
      f.push({ check: `ext:${e.name}`, severity: 'HIGH', detail: HIGH_EXTENSIONS[e.name] });
    } else if (e.name === 'defaultAccountState') {
      const frozen = e.state.accountState === 'frozen';
      f.push({
        check: 'ext:defaultAccountState',
        severity: frozen ? 'HIGH' : 'INFO',
        detail: frozen ? '新規口座が既定で凍結状態になる（発行者の解除なしに売却できない）' : '既定の口座状態が設定されている（凍結ではない）',
      });
    } else if (e.name === 'transferFeeConfig') {
      const bps = num(obj(e.state.newerTransferFee).transferFeeBasisPoints) ?? num(obj(e.state.olderTransferFee).transferFeeBasisPoints);
      if (bps === null) f.push({ check: 'ext:transferFee', severity: 'MEDIUM', detail: '転送手数料の設定あり（料率は未取得）' });
      else if (bps >= 1000) f.push({ check: 'ext:transferFee', severity: 'HIGH', detail: `転送手数料 ${(bps / 100).toFixed(2)}%（発行者が変更できる場合あり）` });
      else if (bps > 0) f.push({ check: 'ext:transferFee', severity: 'MEDIUM', detail: `転送手数料 ${(bps / 100).toFixed(2)}%（発行者が変更できる場合あり）` });
      else f.push({ check: 'ext:transferFee', severity: 'MEDIUM', detail: '転送手数料の仕組みあり（現在 0%。後から引き上げられる場合あり）' });
    } else if (!BENIGN_EXTENSIONS.has(e.name)) {
      f.push({ check: `ext:${e.name}`, severity: 'MEDIUM', detail: `未評価の Token-2022 拡張: ${e.name}` });
    }
  }

  if (holders) {
    const t1 = holders.top1Pct?.toFixed(1);
    const rest = holders.top2to10Pct ?? 0;
    f.push({
      check: 'holder_concentration',
      severity: rest >= CONCENTRATION_MEDIUM_PCT ? 'MEDIUM' : 'INFO',
      detail: `最大口座 ${t1}%、2〜10位の合計 ${rest.toFixed(1)}%。最大口座はプールやボンディングカーブの可能性があり、開発者の保有とは区別できていません`,
    });
  } else {
    f.push({ check: 'holder_concentration', severity: 'INFO', detail: '保有者の分布: 未取得（キー不要の公開 RPC では取得できないため。専用 RPC の設定で取得可能）' });
  }
  f.push({
    check: 'not_checked',
    severity: 'INFO',
    detail: '未検査: 開発者ウォレットの保有・売却、LP のロック/焼却、ウォッシュトレード、ボット購入、価格操作',
  });

  const highs = f.filter((x) => x.severity === 'HIGH').length;
  const meds = f.filter((x) => x.severity === 'MEDIUM').length;
  return {
    level: highs > 0 ? 'HIGH' : meds > 0 ? 'MEDIUM' : 'LOW',
    score: Math.max(0, 100 - highs * 50 - meds * 20),
    findings: f,
  };
}

async function rpc(env: Env, method: string, params: unknown[], counter: { apiCalls: number }): Promise<unknown> {
  // 既定は予備側を先に試す: 公式の公開 RPC は Workers からだと 403 になる（本番で継続的に確認）。
  // isolate は実行ごとに作り直されることがあり、「前回通った方」の記憶には頼れない
  const endpoints = env.SOLANA_RPC_URL ? [env.SOLANA_RPC_URL] : [FALLBACK_RPC, DEFAULT_RPC];
  let json: unknown;
  let lastErr: unknown = null;
  for (let i = 0; i < endpoints.length; i++) {
    const idx = (preferredRpc + i) % endpoints.length;
    try {
      json = await fetchJson(
        'solana_rpc',
        endpoints[idx],
        { body: { jsonrpc: '2.0', id: 1, method, params }, timeoutMs: 6000, retries: 0 },
        counter,
      );
      preferredRpc = idx; // 次回からは通った方を先に使う
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  const e = obj(obj(json).error);
  if (e.message || e.code) throw new HttpError('solana_rpc', null, `RPC ${method}: ${String(e.message ?? e.code).slice(0, 120)}`);
  return json;
}

/**
 * 直近 1 時間に検出された未判定の銘柄を新しい順に数件だけ判定する。
 * RPC が失敗した銘柄は何も書かず（= 未判定のまま）、次回以降に再試行される。
 */
export async function runRiskChecks(
  env: Env,
  now: number,
  stats: { apiCalls: number; rowsWritten: number },
): Promise<number> {
  const db = env.DB;
  const limit = intVar(env.MAX_RISK_CHECKS_PER_RUN, 2, 0, 5);
  if (limit === 0) return 0;
  const rows = (
    await db
      .prepare(
        `SELECT mint FROM tokens WHERE risk_level IS NULL AND detected_at >= ?1 ORDER BY detected_at DESC LIMIT ${limit}`,
      )
      .bind(now - 3_600_000)
      .all<{ mint: string }>()
  ).results;
  let done = 0;
  let firstError: unknown = null;
  for (const { mint } of rows) {
    let info: MintInfo | null;
    try {
      info = parseMintAccount(await rpc(env, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }], stats));
    } catch (e) {
      firstError ??= e;
      break; // RPC 自体が不調なら残りも試さない（レート制限を悪化させない）
    }
    let holders: HolderInfo | null = null;
    let holderErr = false;
    // 保有者分布（getTokenLargestAccounts）はキー不要の公開 RPC では拒否される（本番で 403 を確認）。
    // 専用 RPC（SOLANA_RPC_URL）が設定されているときだけ取得する
    if (info && env.SOLANA_RPC_URL && now >= holdersPausedUntil) {
      try {
        holders = parseLargestAccounts(await rpc(env, 'getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], stats), info.supply);
      } catch (e) {
        holderErr = true; // 権限情報だけで判定を続ける（保有者分布は未取得と明示される）
        // 公開 RPC はこのメソッドを提供しないことがある（本番で 403 を確認）。
        // 毎分同じエラーを積まないよう、1 時間は呼び出しを止めて最初の 1 回だけ記録する
        holdersPausedUntil = now + 3_600_000;
        firstError ??= e;
      }
    }
    const a = assess(info, holders);
    const stmts = [
      db
        .prepare(
          `INSERT OR IGNORE INTO risk_assessments (mint, assessed_at, risk_level, security_score, evidence, ruleset_version, saved_at)
           VALUES (?1,?2,?3,?4,?5,?6,?2)`,
        )
        .bind(mint, now, a.level, a.score, JSON.stringify({ findings: a.findings, rpc_holder_error: holderErr }), RULESET_VERSION),
      db
        .prepare(
          `UPDATE tokens SET risk_level = ?2, security_score = ?3, risk_assessed_at = ?4, token_program = ?5,
             mint_authority_state = ?6, freeze_authority_state = ?7, decimals = COALESCE(decimals, ?8)
           WHERE mint = ?1`,
        )
        .bind(
          mint, a.level, a.score, now, info?.program ?? null,
          info ? (info.mintAuthority ? 'present' : 'revoked') : null,
          info ? (info.freezeAuthority ? 'present' : 'revoked') : null,
          info?.decimals ?? null,
        ),
    ];
    if (holders)
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO holder_snapshots (mint, source, observed_at, holder_count, top1_pct, top10_pct, top20_pct, data_quality, saved_at)
             VALUES (?1,'solana_rpc',?2,NULL,?3,?4,NULL,'partial',?2)`,
          )
          .bind(mint, now, holders.top1Pct, holders.top10Pct),
      );
    const res = await db.batch(stmts);
    for (const r of res) stats.rowsWritten += r.meta?.rows_written ?? r.meta?.changes ?? 0;
    done++;
  }
  if (firstError) throw firstError;
  return done;
}

/** テスト用 */
export function resetRpcPreference(): void {
  preferredRpc = 0;
  holdersPausedUntil = 0;
}
