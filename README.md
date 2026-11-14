# Meme Radar AI（v0.3 / Phase 1–2）

Solana の新規流動性プールを毎分自動検出し、検出後 24 時間まで価格・流動性を追跡して Cloudflare D1 に保存する PWA です。
**実資金の売買機能はありません。** 表示値はすべて外部 API の実測値で、取得できない項目は「未取得」と表示します。

## 構成

| 役割 | 実装 |
|---|---|
| 定期収集 | Cloudflare Workers Cron（毎分・1 本のみ） |
| 新規検出 | GeckoTerminal `GET /networks/solana/new_pools`（キー不要・30 回/分） |
| 追跡価格 | DEX Screener `GET /tokens/v1/solana/{mints}`（キー不要・300 回/分、最大 30 件/回） |
| 保存 | Cloudflare D1（スキーマは初回アクセス時に自動作成） |
| 画面 | React + TypeScript の PWA（Worker の静的アセットとして同居） |

追跡時点: 検出時 → +5 分 → +15 分 → +1 時間 → +6 時間 → +24 時間。

## デプロイ（iPhone だけで可能・GitHub 連携）

1. Cloudflare ダッシュボード → **Workers & Pages** → **Create** → **Import a repository** でこのリポジトリを選ぶ
2. Build command: `npm run build` / Deploy command: `npx wrangler deploy`（プロジェクト名は `meme-radar-ai` のまま）
3. デプロイ完了後、表示された `https://meme-radar-ai.<サブドメイン>.workers.dev` を Safari で開く
4. 1〜2 分待つとダッシュボードの「最終実行」が動き始める
5. Safari の共有 →「ホーム画面に追加」で PWA として利用

- D1 データベース `meme-radar-db` は初回デプロイ時に wrangler が自動作成します（ID の設定不要）。
- 既存の Worker（AgentMint など）とは別名・別リソースで、既存設定は変更しません。
- **注意:** 無料プランの Cron Trigger はアカウント全体で 5 本までです。既存 Worker で 5 本使用済みだとデプロイが失敗します。
- 課金が発生する操作は含まれません（Workers Free / D1 Free の範囲）。

### 任意: アクセス制限

Worker の Settings → Variables and Secrets で Secret を追加:

- `ACCESS_TOKEN` … 設定すると全 API が Bearer 認証必須になる（アプリの設定画面で同じ値を入力）
- `ADMIN_TOKEN` … 設定すると `POST /api/admin/run`（手動収集、`x-admin-token` ヘッダ）が有効になる

## 無料枠と自主制限

| 制限（Workers Free） | 値 | 本システムの対応 |
|---|---|---|
| D1 書き込み | 10 万行/日 | 自主上限 8 万行（`DAILY_WRITE_BUDGET`）。新規保存を 1 日に均等配分（約 2,200 銘柄/日）し、85% 超で新規停止、100% で全停止 |
| D1 読み取り | 500 万行/日 | API 応答を 20〜30 秒メモリキャッシュ、画面の自動更新は 60 秒・表示中のみ |
| CPU 時間 | 10 ms/回 | 1 回の処理を最小限に。**本番での実測は未確認**（超過時は Workers Paid 月 $5 が必要） |
| サブリクエスト | 50/回 | 1 回の実行で外部 API 最大 2〜4 回 + D1 数回 |
| Cron | 5 本/アカウント | 1 本だけ使用（日次クリーンアップも同じ Cron 内） |

## 既知の限界（重要）

- 検出は GeckoTerminal の新規プール一覧（先頭 20 件・毎分）に依存。**全銘柄の網羅ではなく標本**です。発行〜プール作成前の段階（Pump.fun ボンディングカーブ上の発行直後など）は GeckoTerminal に載るまで検出できません。
- 「検出遅延」は検出済み銘柄だけの分布で、検出漏れを含む検出率ではありません。
- 発行時刻・初回取引時刻・保有者・権限・LP 状況はオンチェーン取得（Phase 3）が未実装で、すべて未取得です。
- Cloudflare 無料プランは稼働率を保証しません。

## 開発

```bash
npm install
npm test                  # 単体テスト（50 件）
npm run build && npm run test:integration   # workerd + ローカル D1 での結合テスト
npm run typecheck
npm run dev:worker        # ローカル実行（http://localhost:8787）
```

進捗と残作業は [PROGRESS.md](./PROGRESS.md) を参照。
