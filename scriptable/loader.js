// エスパス上野 設定マップ（Scriptable用）
// このファイルの中身をそのまま Scriptable の新しいスクリプトに貼り付けて使う。
// 本体は毎回 GitHub Pages から最新版を読み込むので、ここは今後書き換え不要。
const fm = FileManager.iCloud();
const dir = fm.joinPath(fm.documentsDirectory(), "jagler");
if (!fm.fileExists(dir)) fm.createDirectory(dir);
const path = fm.joinPath(dir, "bundle.js");
try {
  const code = await new Request("https://daisukenakagawa-blip.github.io/jagler/scriptable/bundle.js?t=" + Date.now()).loadString();
  if (code.includes("module.exports")) fm.writeString(path, code);
} catch (e) {}
if (fm.fileExists(path) && !fm.isFileDownloaded(path)) await fm.downloadFileFromiCloud(path);
const app = importModule("jagler/bundle");
await app.main();
Script.complete();
