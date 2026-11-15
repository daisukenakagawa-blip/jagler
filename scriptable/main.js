// ===== Scriptable 用の本体（scriptable/build.mjs が parse.js・model.js と結合して bundle.js を作る） =====
const STORES = [['本館', 'esupasu-nittakuuenohon'], ['新館', 'esupasu-nittakuuenoshin']];
const START = '20260814';
const WAIT_MS = 400;
const PAGES = 'https://daisukenakagawa-blip.github.io/jagler/';

const pad2 = n => String(n).padStart(2, '0');
const ymdOf = d => d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
const addDay = (s, n) => { const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)); d.setDate(d.getDate() + n); return ymdOf(d); };
const wait = ms => new Promise(res => Timer.schedule(ms, false, () => res()));

async function main() {
  const fm = FileManager.iCloud();
  const dir = fm.joinPath(fm.documentsDirectory(), 'jagler');
  if (!fm.fileExists(dir)) fm.createDirectory(dir);
  const P = name => fm.joinPath(dir, name);
  const readJson = async (name, dflt) => {
    const p = P(name);
    if (!fm.fileExists(p)) return dflt;
    if (!fm.isFileDownloaded(p)) await fm.downloadFileFromiCloud(p);
    try { return JSON.parse(fm.readString(p)); } catch (e) { return dflt; }
  };
  const inApp = config.runsInApp;

  // ---- 1. 未取得の日をペカセンから取り込む ----
  const rows = await readJson('rows.json', []);   // [店, 日付, 機種, 台番, G数, BIG, REG, 差枚]
  const meta = await readJson('meta.json', { missing: [] });
  const have = new Set(rows.map(r => r[0] + r[1]));
  const miss = new Set(meta.missing);
  const today = ymdOf(new Date()), yday = addDay(today, -1), twoDaysAgo = addDay(today, -2);
  const todo = [];
  for (const [sn, slug] of STORES)
    for (let d = START; d <= yday; d = addDay(d, 1))
      if (!have.has(sn + d) && !miss.has(sn + d)) todo.push([sn, slug, d]);

  if (inApp && todo.length > 20) {
    const a = new Alert();
    a.title = '初回の取り込み';
    a.message = `ペカセンから${todo.length}日分を取り込みます。${Math.ceil(todo.length * 0.9 / 60)}分ほどかかるので、Scriptableを開いたまま待ってください。`;
    a.addAction('始める');
    await a.present();
  }
  const log = [];
  let added = 0, blocked = false;
  for (let i = 0; i < todo.length; i++) {
    const [sn, slug, d] = todo[i];
    if (i) await wait(WAIT_MS);
    const req = new Request(`https://pekasen.com/store/${slug}/${d}`);
    req.headers = { 'Accept-Language': 'ja' };
    let html;
    try { html = await req.loadString(); } catch (e) { log.push(`${sn}${d} 取得エラー`); continue; }
    const code = req.response && req.response.statusCode;
    if (code && code !== 200) {
      log.push(`${sn}${d} HTTP ${code}`);
      if ([403, 429, 503].includes(code)) { blocked = true; break; }
      continue;
    }
    const r = parseDay(html, d);
    if (r && r.length) { r.forEach(x => rows.push([sn, d, ...x])); have.add(sn + d); added += r.length; }
    else if (d < twoDaysAgo) miss.add(sn + d);
    if (i % 20 === 19) {        // 途中経過を保存（途中で止まっても続きから再開できる）
      fm.writeString(P('rows.json'), JSON.stringify(rows));
      fm.writeString(P('meta.json'), JSON.stringify({ missing: [...miss] }));
    }
  }
  meta.missing = [...miss].sort();
  if (added) fm.writeString(P('rows.json'), JSON.stringify(rows));
  fm.writeString(P('meta.json'), JSON.stringify(meta));

  // ---- 2. 学習・予想・検証 ----
  let out = await readJson('predict.json', null);
  if (rows.length && (added || !out || out.today !== today)) {
    const objs = rows.map(r => ({ s: r[0], d: r[1], m: r[2], no: r[3], g: r[4], b: r[5], r: r[6], sa: r[7] }));
    out = runModel(objs, meta, today);
    out.today = today;
    out.log = log.slice(-20);
    fm.writeString(P('predict.json'), JSON.stringify(out));
  }

  if (blocked) {
    const msg = 'ペカセンにアクセスを拒否されました（' + log[log.length - 1] + '）。時間をおいて開き直してください。';
    if (inApp) { const a = new Alert(); a.title = '取り込みできませんでした'; a.message = msg; a.addAction('OK'); await a.present(); }
    else { const n = new Notification(); n.title = 'エスパス上野 設定マップ'; n.body = msg; await n.schedule(); }
  }
  if (!out) return;

  // ---- 3. 表示 ----
  if (inApp) {
    let html = null;
    try { html = await new Request(PAGES + 'index.html?t=' + Date.now()).loadString(); fm.writeString(P('index.html'), html); }
    catch (e) { if (fm.fileExists(P('index.html'))) { if (!fm.isFileDownloaded(P('index.html'))) await fm.downloadFileFromiCloud(P('index.html')); html = fm.readString(P('index.html')); } }
    if (!html) { const a = new Alert(); a.title = '画面を読み込めませんでした'; a.message = '電波の良い所で開き直してください。'; a.addAction('OK'); await a.present(); return; }
    html = html.replace(/fetch\("predict\.json"[^)]*\)\.then\(r=>\{[^}]*\}\)/, 'Promise.resolve(window.__PREDICT__)');
    html = html.replace('<script>', '<script>window.__PREDICT__=' + JSON.stringify(out).replace(/</g, '\\u003c') + ';</script><script>');
    const wv = new WebView();
    await wv.loadHTML(html, PAGES);
    await wv.present(true);
  } else {
    const n = new Notification();
    n.title = 'エスパス上野 今日の予想';
    n.body = ['本館', '新館'].map(s => {
      const S = out.stores[s];
      if (!S) return s + ': データなし';
      return `${s}（${S.typ === '旧イベ' ? '旧イベ日' : S.typ}）: ` + S.preds.slice(0, 5).map(p => `${p[0]} ${Math.round(p[2] * 100)}%`).join(' / ');
    }).join('\n');
    await n.schedule();
  }
}
module.exports = { main };
