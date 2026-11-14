# 進捗記録（次回再開用）

## 本番環境（2026-11-14 デプロイ）

- 公開 URL: https://meme-radar-ai.dadayop999.workers.dev
- Cloudflare: Worker `meme-radar-ai` / D1 `meme-radar-db`（AgentMint とは別リソース）
- デプロイ元: 非公開リポジトリ `dadayop999-sketch/meme-radar-ai`（push で自動デプロイ）
- 開発の push 先: 公開 `daisukenakagawa-blip/jagler` の `meme-radar` ブランチ
  → `.github/workflows/sync.yml` が 3 時間ごと（または手動実行）に非公開リポジトリへ複製する
- 本番で確認済み: Cron 毎分実行、GeckoTerminal からの実データ取得、D1 保存、PWA 表示
- 本番で判明: GeckoTerminal が断続的に HTTP 429 を返す（共有 IP が原因とみられる）→ 同一実行内で最大 2 回再試行を追加

## v0.4 で追加（Phase 3 の一部）

- Solana RPC による Mint/Freeze 権限、Token Program、Token-2022 拡張、上位口座の集中度の取得
- ルール v1 による LOW / MEDIUM / HIGH / UNKNOWN 判定（根拠・判定時刻つき）、一覧のリスク絞り込み
- 未検査: 開発者ウォレット、LP ロック/焼却、ウォッシュトレード、ボット購入、価格操作、売却シミュレーション


最終更新: 2026-11-14

## 完了（ローカルで検証済み）

- Phase 1: 環境調査。既存 Meme Radar v0.1/v0.2 のコードは作業環境・GitHub（`-`, `jagler`）に存在せず、新規実装とした
- Phase 2: 自動収集（GeckoTerminal 検出 → D1 保存 → DEX Screener 追跡）、重複排除、リトライ、エラー記録、書き込み予算、日次クリーンアップ
- D1 スキーマ 14 テーブル + schema_meta（Phase 3 以降のテーブルは定義のみ）
- 読み取り API（/api/status, /api/tokens, /api/tokens/:mint）、任意の Bearer 認証、入力値検証、CSP 等のヘッダ
- PWA（ダッシュボード / 新規トークン / 詳細 / 稼働状況 / 設定）、日本語、ダーク・ライト
- 単体テスト 30 件、workerd 上の結合テスト 23 項目が成功

## 未検証（この開発環境からは外部通信が遮断されていたため）

- [ ] 本物の GeckoTerminal / DEX Screener API への接続（応答形式は公式ドキュメントと照合したのみ）
- [ ] Cloudflare へのデプロイ、D1 自動作成、Cron の本番実行
- [ ] 本番での CPU 時間（無料枠 10ms）に収まるか
- [ ] 本番 D1 での rows_written 実測（ローカルでは 1 銘柄あたり約 29 行の見積り）
- [ ] iPhone 実機 Safari での表示と PWA インストール

デプロイ後の確認手順: 稼働状況画面で「正常」の実行回数が増えること、エラー欄、D1 書き込み行数の推移を見る。

## 未実装（完了条件のうち未達）

| 項目 | フェーズ | メモ |
|---|---|---|
| 危険度分析の残り | 3 | 開発者ウォレット特定、LP 状態、取引パターン分析。公開 RPC が Workers から使えない場合は SOLANA_RPC_URL（Secret）に無料 RPC を設定 |
| 発行時刻・初回取引・開発者ウォレット・LP 状況 | 3 | 同上 |
| 仮想売買の自動記録、コスト控除後損益 | 4 | 約定は「シグナル後に観測したスナップショット」のみで評価する設計（paper_trades.fill_snapshot_id）。追跡間隔が粗いので、候補銘柄だけ高頻度追跡する仕組みが要る |
| AI モデルの検証結果表示 | 5 | 実データ蓄積後。ウォークフォワード必須。不足時は「検証不足」表示 |
| 通知（Web Push）、日次レポート | 6 | iOS は 16.4 以降・ホーム画面追加済み PWA のみ対応 |
| 厳密なレート制限 | 6 | 現在は isolate 内の簡易版。Workers Rate Limiting binding を検討 |
| 独立した基準データによる検出率測定 | — | 基準データ源が無いため遅延分布のみ |

## 設計メモ

- 時刻はすべて UTC epoch ms。NULL = 未取得
- price_snapshots は UNIQUE(mint, stage)。API 障害や上場廃止は価格 NULL の欠損行（data_quality = missing_*）として残す → 生存者バイアス対策の基礎データ
- Workers ランタイムは fetch の `redirect: 'error'` 非対応（結合テストで発見、`manual` に修正済み）
