# jagler — エスパス上野 設定マップ

エスパス日拓上野（本館・新館）のジャグラー全台について、ペカセンの台データを毎朝取り込み、
台番ごとの「今日の高設定期待度」と、予想の当たり具合（過去30日の検証）を表示するアプリです。
PCを起動していなくても、GitHub Actions（無料）が毎朝自動で更新します。

- アプリ: `https://daisukenakagawa-blip.github.io/jagler/`（GitHub Pages を有効にした後）
- 自動更新: 日本時間 7:05・8:05・9:05・10:05・11:05。前日分がペカセンに載っていれば取り込みます
- 以前の「ジャグラー データ分析ツール」は `legacy/index.html` に残しています

## 最初に1回だけやること
1. **GitHub Pages を有効にする**：リポジトリの Settings → Pages → Build and deployment の Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にして Save。
2. **初回の取り込みを実行する**：Actions タブ →「設定予想の毎朝更新」→「Run workflow」。8/14からの全データを3〜5分で取り込みます（待たずに翌朝の自動実行に任せても大丈夫です）。

## ファイル
| ファイル | 中身 |
|---|---|
| `index.html` | アプリ画面（`predict.json` を読んで表示） |
| `predict.json` | 毎朝作り直す予想・検証データ |
| `data/rows.json` | 取り込んだ台データ（店, 日付, 機種, 台番, G数, BIG, REG, 差枚） |
| `data/status.json` | 最後の実行結果（取り込み件数、エラー） |
| `scripts/update.mjs` | 取り込み → 学習 → 予想の本体 |
| `scripts/parse.js` | ペカセンのページから台データを読む部分。ページ構造が変わったらここを直す |
| `scripts/model.js` | 高設定判定・学習・予想・検証 |
| `.github/workflows/update.yml` | 毎朝の自動実行の設定 |

## 注意
- このリポジトリは公開設定なので、取り込んだデータと予想は誰でも見られます。
- `data/status.json` に `"blocked": true` や `HTTP 403` が出たら、ペカセン側にアクセスを止められています。
- GitHubの定時実行は、混雑時に数分〜十数分遅れることがあります。
