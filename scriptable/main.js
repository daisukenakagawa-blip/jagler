// ===== Scriptable 用の本体（scriptable/build.mjs が parse.js・model.js と結合して bundle.js を作る） =====
// ペカセンの店 [アプリでの名前, ペカセンの店ID, 取り込み開始日]
const STORES = [['本館', 'esupasu-nittakuuenohon', '20260814'], ['新館', 'esupasu-nittakuuenoshin', '20260814'],
  ['ゴードン祖師谷', 'tokyo-717801', '20261001'], ['楽園川崎', 'rakuen-kawasaki', '20261001'], ['セブンS川崎', 'seven-s', '20261001'],
  ['マルハン新宿東宝', 'maruhan-shinjuku-toho', '20261001']];
const WAIT_MS = 400;
const PAGES = 'https://daisukenakagawa-blip.github.io/jagler/';

const pad2 = n => String(n).padStart(2, '0');
const ymdOf = d => d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
const addDay = (s, n) => { const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)); d.setDate(d.getDate() + n); return ymdOf(d); };
const wait = ms => new Promise(res => Timer.schedule(ms, false, () => res()));


// ---- 新橋UNO（P's CUBE）：台ごとのページを画面に出さないWebViewで開き、表示された表を読む ----
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const PSC = [   // P's CUBE（DMMぱちタウン経由）で台データを公開している店。台番は20スロのジャグラーのみ
  { name: '新橋UNO', code: 'c753216', dai: [...range(601, 667), ...range(672, 682)] },
];
const pscUrl = (st, no) => `https://www.pscube.jp/dedamajyoho-P-townDMMpachi/${st.code}/cgi-bin/nc-v06-001.php?cd_dai=${String(no).padStart(4, '0')}`;
// サイトの機種名（半角カナ・店ごとの記号付き）→ アプリの機種名
const KISYU = [['マイジャグラーVI', 'マイジャグラー6'], ['マイジャグラーV', 'マイジャグラーV'], ['ネオアイム', 'ネオアイムジャグラーEX'], ['アイムジャグラー', 'アイムジャグラーEX'],
  ['ゴーゴー', 'ゴーゴージャグラー3'], ['ファンキー', 'ファンキージャグラー2KT'], ['ハッピー', 'ハッピージャグラーVIII'], ['ガールズ', 'ジャグラーガールズSS'],
  ['ミスター', 'ミスタージャグラー'], ['ウルトラミラクル', 'ウルトラミラクルジャグラー']];
const kisyuOf = raw => { const n = raw.normalize('NFKC').replace(/\s+/g, ''); const k = KISYU.find(([key]) => n.includes(key)); return k ? k[1] : n; };
// WebView の中で動く関数（表が表示されるまで最大15秒待つ）
const unoScrape = function () {
  let n = 0;
  const go = () => {
    const t = document.querySelectorAll('table');
    const m = document.body.innerText.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):\d{2}\s*更新/);
    const row = t[3] && t[3].rows[0];
    if (row && m && row.cells.length >= 2) {
      const days = [...row.cells].map(c => { let e = c; while (e.children.length === 1) e = e.children[0]; return [...e.children].map(k => k.textContent.trim()); });
      if (days[0][0] === '本日' && days[0].length >= 11) {
        completion(JSON.stringify({ u: m.slice(1), name: (document.title.split('｜')[1] || ''), days }));
        return;
      }
    }
    if (++n > 50) completion(null); else setTimeout(go, 300);
  };
  go();
};
async function pscFetch(wv, st, no) {
  await wv.loadURL(pscUrl(st, no));
  const s = await wv.evaluateJavaScript('(' + unoScrape.toString() + ')()', true);
  if (!s) return null;
  const j = JSON.parse(s);
  const name = kisyuOf(j.name);
  const upd = j.u[0] + j.u[1].padStart(2, '0') + j.u[2].padStart(2, '0'), hour = +j.u[3];
  const out = [];
  for (const c of j.days) {
    const k = c[0] === '本日' ? 0 : parseInt(c[0], 10);
    if (!(k >= 0) || (k === 0 && hour < 23)) continue;     // 営業中の「本日」は使わない
    // 列の並び：AT列・出枚数ありの店 [名, BONUS, BIG, REG, AT, BIG確率, REG確率, AT確率, 合成, 累計G, 最終G, 出枚数, 最大放出, BIG最高]
    //          AT列・出枚数なしの店 [名, BONUS, BIG, REG, BIG確率, REG確率, 合成, 累計G, 最終G, 最大放出, BIG最高]
    const wide = c.length >= 14;
    const g = parseInt(c[wide ? 9 : 7], 10);
    if (!(g >= 0)) continue;
    const sc = wide ? c[11] : '';
    const sa = sc ? (sc.startsWith('▲') ? -1 : 1) * parseInt(sc.replace(/[^\d]/g, ''), 10) : null;
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
  const known = new Set([...STORES.map(x => x[0]), ...PSC.map(x => x.name)]);
  const rows0 = await readJson('rows.json', []);   // [店, 日付, 機種, 台番, G数, BIG, REG, 差枚]
  const meta0 = await readJson('meta.json', { missing: [] });
  // アプリから外した店のデータは捨てる。v2：セブンS川崎の取得元をDMM(P's CUBE)からペカセンに変えたので、旧データを1回だけ消す
  const rows = rows0.filter(r => known.has(r[0]) && !(meta0.v !== 2 && r[0] === 'セブンS川崎'));
  const dropped = rows.length !== rows0.length;
  const meta = meta0;
  meta.v = 2;
  const have = new Set(rows.map(r => r[0] + r[1]));
  const miss = new Set(meta.missing);
  const today = ymdOf(new Date()), yday = addDay(today, -1), twoDaysAgo = addDay(today, -2);
  const todo = [];
  for (const [sn, slug, start] of STORES)
    for (let d = start; d <= yday; d = addDay(d, 1))
      if (!have.has(sn + d) && !miss.has(sn + d)) todo.push([sn, slug, d]);

  if (inApp && todo.length > 20) {   // 初回や店を増やしたとき
    const a = new Alert();
    a.title = 'ペカセンからまとめて取り込み';
    a.message = `${todo.length}日分（店×日）を取り込みます。${Math.ceil(todo.length * 2 / 60)}分ほどかかり、通信量も多い（1日分で約0.5MB）ので、Wi-Fiにつないで、Scriptableを開いたまま待ってください。`;
    a.addAction('始める');
    await a.present();
  }
  const log = [];
  let added = 0, blocked = false;
  const typical = {};
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
    // 直近の日はペカセンの更新途中で一部の機種しか載っていないことがある → 台数が普段の8割未満なら次回取り直す
    if (r && r.length && d >= twoDaysAgo) {
      if (!typical[sn]) { const c = {}; rows.forEach(x => { if (x[0] === sn) c[x[1]] = (c[x[1]] || 0) + 1; }); const v = Object.values(c).sort((a, b) => a - b); typical[sn] = v.length ? v[v.length >> 1] : 0; }
      if (r.length < typical[sn] * 0.8) { log.push(`${sn}${d} 更新途中（${r.length}台）`); continue; }
    }
    if (r && r.length) { r.forEach(x => rows.push([sn, d, ...x])); have.add(sn + d); added += r.length; }
    else if (d < twoDaysAgo) miss.add(sn + d);
    if (i % 20 === 19) {        // 途中経過を保存（途中で止まっても続きから再開できる）
      fm.writeString(P('rows.json'), JSON.stringify(rows));
      fm.writeString(P('meta.json'), JSON.stringify({ missing: [...miss], v: 2 }));
    }
  }
  meta.missing = [...miss].sort();
  if (added || dropped) fm.writeString(P('rows.json'), JSON.stringify(rows));
  fm.writeString(P('meta.json'), JSON.stringify(meta));


  // ---- 1b. P's CUBE の店（アプリで開いたときだけ。サイトに残るのは直近6日分） ----
  if (inApp) for (const st of PSC) {
    const haveU = new Set(rows.filter(r => r[0] === st.name).map(r => r[1] + '|' + r[3]));
    const todoU = st.dai.filter(no => !haveU.has(yday + '|' + no));
    if (!todoU.length) continue;
    if (todoU.length > 10) {
      const a = new Alert();
      a.title = st.name + 'の取り込み';
      a.message = `${todoU.length}台分のページを1台ずつ開きます。数分かかるので、Scriptableを開いたまま待ってください。`;
      a.addAction('始める'); a.addCancelAction('今日はしない');
      if (await a.present() === -1) continue;
    }
    const wv = new WebView();
    let streak = 0, got = 0, fail = 0;
    for (let i = 0; i < todoU.length; i++) {
      const no = todoU[i];
      if (i) await wait(1500);   // サイトに負担をかけないよう1台ごとに間をあける
      let r = null;
      for (let t = 0; t < 2 && !r; t++) { try { r = await pscFetch(wv, st, no); } catch (e) { r = null; } }
      if (!r) { fail++; streak++; log.push(`${st.name}${no}番 取得できず`); if (streak >= 5) { log.push(`${st.name} 5台続けて失敗したので中止（次に開いたとき続きから）`); break; } continue; }
      streak = 0;
      for (const x of r) if (!haveU.has(x[0] + '|' + no)) { rows.push([st.name, ...x]); haveU.add(x[0] + '|' + no); got++; }
      if (i % 10 === 9) fm.writeString(P('rows.json'), JSON.stringify(rows));
    }
    if (got) fm.writeString(P('rows.json'), JSON.stringify(rows));
    if (!got && fail) { const a = new Alert(); a.title = st.name + 'を取り込めませんでした'; a.message = '電波の良い所で開き直してください。続く場合はサイトの作りが変わった可能性があります。'; a.addAction('OK'); await a.present(); }
    added += got;
  }

  // ---- 2. 学習・予想・検証 ----
  let out = await readJson('predict.json', null);
  if (rows.length && (added || dropped || !out || out.today !== today || out.ver !== 2)) {   // ver 2：期待度＝設定4・5・6の確率
    const objs = rows.map(r => ({ s: r[0], d: r[1], m: r[2], no: r[3], g: r[4], b: r[5], r: r[6], sa: r[7] }));
    // アプリが出した予想を記録しておき、データが入った日に答え合わせする（60日分）
    let plog = await readJson('predlog.json', {});
    if (!out || out.ver !== 2) plog = {};   // 期待度の意味が変わったので古い記録は捨てる
    out = runModel(objs, meta, today, plog);
    for (const [sn, S] of Object.entries(out.stores)) {
      if (!S.preds || !(S.target > S.lastData)) continue;
      (plog[sn] = plog[sn] || {})[S.target] = S.preds.map(p => [p[0], p[1], p[2]]);
      for (const d of Object.keys(plog[sn])) if (d < addDay(today, -60)) delete plog[sn][d];
    }
    fm.writeString(P('predlog.json'), JSON.stringify(plog));
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
    n.body = [...STORES.map(x => x[0]), ...PSC.map(x => x.name)].map(s => {
      const S = out.stores[s];
      if (!S) return s + ': データなし';
      return `${s}（${S.typ === '旧イベ' ? '旧イベ日' : S.typ}）: ` + S.preds.slice(0, 3).map(p => `${p[0]} ${Math.round(p[2] * 100)}%`).join(' / ');
    }).join('\n') + '\n（新橋UNOはアプリを開いたときに取り込みます）';
    await n.schedule();
  }
}
module.exports = { main };
