# 進捗記録（次回再開用）

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
| 危険度分析の自動実行 | 3 | Solana RPC（getAccountInfo で Mint/Freeze 権限・Token-2022 拡張、getTokenLargestAccounts で集中度）。無料 RPC のレート制限調査が必要。現在は全銘柄 UNKNOWN 表示 |
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
