// ===== Scriptable 用の本体（scriptable/build.mjs が parse.js・model.js と結合して bundle.js を作る） =====
const STORES = [['本館', 'esupasu-nittakuuenohon'], ['新館', 'esupasu-nittakuuenoshin']];
const START = '20260814';
const WAIT_MS = 400;
const PAGES = 'https://daisukenakagawa-blip.github.io/jagler/';

const pad2 = n => String(n).padStart(2, '0');
const ymdOf = d => d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
const addDay = (s, n) => { const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)); d.setDate(d.getDate() + n); return ymdOf(d); };
const wait = ms => new Promise(res => Timer.schedule(ms, false, () => res()));


// ---- 新橋UNO（P's CUBE）：台ごとのページを画面に出さないWebViewで開き、表示された表を読む ----
const UNO = '新橋UNO';
const UNO_BASE = 'https://www.pscube.jp/dedamajyoho-P-townDMMpachi/c753216/cgi-bin/nc-v06-001.php?cd_dai=';
const UNO_DAI = [];
for (let n = 601; n <= 667; n++) UNO_DAI.push(n);
for (let n = 672; n <= 682; n++) UNO_DAI.push(n);
const UNO_NAME = { 'マイジャグラーVI': 'マイジャグラー6' };
// WebView の中で動く関数（表が表示されるまで最大15秒待つ）
const unoScrape = function () {
  let n = 0;
  const go = () => {
    const t = document.querySelectorAll('table');
    const m = document.body.innerText.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):\d{2}\s*更新/);
    const row = t[3] && t[3].rows[0];
    if (row && m && row.cells.length >= 2) {
      const days = [...row.cells].map(c => { let e = c; while (e.children.length === 1) e = e.children[0]; return [...e.children].map(k => k.textContent.trim()); });
      if (days[0][0] === '本日' && days.some(d => /^\d+$/.test(d[9] || ''))) {
        completion(JSON.stringify({ u: m.slice(1), name: (document.title.split('｜')[1] || ''), days }));
        return;
      }
    }
    if (++n > 50) completion(null); else setTimeout(go, 300);
  };
  go();
};
async function unoFetch(wv, no) {
  await wv.loadURL(UNO_BASE + String(no).padStart(4, '0'));
  const s = await wv.evaluateJavaScript('(' + unoScrape.toString() + ')()', true);
  if (!s) return null;
  const j = JSON.parse(s);
  let name = j.name.normalize('NFKC').trim();
  name = UNO_NAME[name] || name;
  const upd = j.u[0] + j.u[1].padStart(2, '0') + j.u[2].padStart(2, '0'), hour = +j.u[3];
  const out = [];
  for (const c of j.days) {
    const k = c[0] === '本日' ? 0 : parseInt(c[0], 10);
    if (!(k >= 0) || (k === 0 && hour < 23)) continue;     // 営業中の「本日」は使わない
    const g = parseInt(c[9], 10);
    if (!(g >= 0)) continue;
    const sa = c[11] ? (c[11].startsWith('▲') ? -1 : 1) * parseInt(c[11].replace(/[^\d]/g, ''), 10) : null;
    out.push([addDay(upd, -k), name, no, g, parseInt(c[2], 10) || 0, parseInt(c[3], 10) || 0, Number.isFinite(sa) ? sa : null]);
  }
  return out;
}

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


  // ---- 1b. 新橋UNO（アプリで開いたときだけ。サイトに残るのは直近6日分） ----
  let unoAdded = 0, unoFail = 0;
  if (inApp) {
    const haveU = new Set(rows.filter(r => r[0] === UNO).map(r => r[1] + '|' + r[3]));
    const todoU = UNO_DAI.filter(no => !haveU.has(yday + '|' + no));
    if (todoU.length) {
      if (todoU.length > 10) {
        const a = new Alert();
        a.title = '新橋UNOの取り込み';
        a.message = `${todoU.length}台分のページを1台ずつ開きます。数分かかるので、Scriptableを開いたまま待ってください。`;
        a.addAction('始める'); a.addCancelAction('今日はしない');
        if (await a.present() === -1) todoU.length = 0;
      }
      const wv = new WebView();
      let streak = 0;
      for (let i = 0; i < todoU.length; i++) {
        const no = todoU[i];
        let r = null;
        for (let t = 0; t < 2 && !r; t++) { try { r = await unoFetch(wv, no); } catch (e) { r = null; } }
        if (!r) { unoFail++; streak++; log.push(`${UNO}${no}番 取得できず`); if (streak >= 5) { log.push(`${UNO} 5台続けて失敗したので中止`); break; } continue; }
        streak = 0;
        for (const x of r) if (!haveU.has(x[0] + '|' + no)) { rows.push([UNO, ...x]); haveU.add(x[0] + '|' + no); unoAdded++; }
        if (i % 10 === 9) fm.writeString(P('rows.json'), JSON.stringify(rows));
      }
      if (unoAdded) fm.writeString(P('rows.json'), JSON.stringify(rows));
      if (!unoAdded && unoFail) { const a = new Alert(); a.title = '新橋UNOを取り込めませんでした'; a.message = '電波の良い所で開き直してください。続く場合はサイトの作りが変わった可能性があります。'; a.addAction('OK'); await a.present(); }
      added += unoAdded;
    }
  }

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
    n.title = 'ジャグラー 今日の予想';
    n.body = ['本館', '新館', UNO].map(s => {
      const S = out.stores[s];
      if (!S) return s + ': データなし';
      return `${s}（${S.typ === '旧イベ' ? '旧イベ日' : S.typ}）: ` + S.preds.slice(0, 5).map(p => `${p[0]} ${Math.round(p[2] * 100)}%`).join(' / ');
    }).join('\n') + '\n（新橋UNOはアプリを開いたときに取り込みます）';
    await n.schedule();
  }
}
module.exports = { main };
