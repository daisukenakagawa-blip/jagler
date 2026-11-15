# jagler — エスパス上野 設定マップ

エスパス日拓上野（本館・新館）のジャグラー全台について、ペカセンの台データを毎朝取り込み、
台番ごとの「今日の高設定期待度」と、予想の当たり具合（過去30日の検証）を表示するアプリです。
ペカセンがサーバーからの自動アクセスを拒否するため、データの取得はiPhoneの「Scriptable」アプリで行います（下記）。

- アプリ: `https://daisukenakagawa-blip.github.io/jagler/`（GitHub Pages を有効にした後）
- 自動更新: 日本時間 7:05・8:05・9:05・10:05・11:05。前日分がペカセンに載っていれば取り込みます
- 以前の「ジャグラー データ分析ツール」は `legacy/index.html` に残しています

## 最初に1回だけやること
1. **GitHub Pages を有効にする**：リポジトリの Settings → Pages → Build and deployment の Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にして Save。
2. **初回の取り込みを実行する**：Actions タブ →「設定予想の毎朝更新」→「Run workflow」。8/14からの全データを3〜5分で取り込みます（待たずに翌朝の自動実行に任せても大丈夫です）。

## iPhone（Scriptable）で使う
1. App Storeで「Scriptable」（無料）を入れる
2. Scriptableを開き、右上の「＋」で新しいスクリプトを作り、`scriptable/loader.js` の中身を貼り付けて、名前を「エスパス上野」にする
3. 実行する（▶）。初回は8/14からの全データを取り込むので3分ほどかかる。終わると設定マップの画面が開く
4. ホーム画面に置く：スクリプトの設定（⚙）→「Add to Home Screen」
5. 毎朝自動で更新して通知を受け取る：ショートカットApp →「オートメーション」→「＋」→「時刻」（例 7:30・毎日・すぐに実行）→ アクション「Scriptable」の「Run Script」で「エスパス上野」を選ぶ

本体（`scriptable/bundle.js`）は毎回ここから最新版を読み込みます。`scripts/` や `scriptable/main.js` を直したら `node scriptable/build.mjs` で作り直してプッシュします。

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
