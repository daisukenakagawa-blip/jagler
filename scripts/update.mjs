// エスパス上野 設定マップ — 毎朝の更新スクリプト（GitHub Actionsで実行）
// ペカセンから未取得の日の台データを取り込み、学習・予想・検証をして predict.json を書き出す。
// 使い方: node scripts/update.mjs [--force]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseDay } from './parse.js';
import { runModel } from './model.js';

process.env.TZ = 'Asia/Tokyo';
const STORES = [['本館', 'esupasu-nittakuuenohon'], ['新館', 'esupasu-nittakuuenoshin']];
const START = '20260814';      // 取り込み開始日
const MAX_FETCH = 400;         // 1回で取りに行くページ数の上限
const WAIT_MS = +(process.env.WAIT_MS ?? 600);           // ページ取得の間隔（ペカセンに負荷をかけないため）
const UA = 'Mozilla/5.0 (compatible; ueno-setting-map/1.0; personal use)';
const ROWS = 'data/rows.json', META = 'data/meta.json', STATUS = 'data/status.json', OUT = 'predict.json';

const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
const addD = (s, n) => { const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)); d.setDate(d.getDate() + n); return ymd(d); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = async (p, dflt) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return dflt; } };

const force = process.argv.includes('--force');
const today = ymd(new Date()), yday = addD(today, -1), twoDaysAgo = addD(today, -2);
await mkdir('data', { recursive: true });
// rows: [店, 日付, 機種, 台番, G数, BIG, REG, 差枚]
const rows = await readJson(ROWS, []);
const meta = await readJson(META, { missing: [] });
const have = new Set(rows.map(r => r[0] + r[1]));
const miss = new Set(meta.missing);
const log = [];
let added = 0, fetched = 0, blocked = false;

outer:
for (const [sn, slug] of STORES) {
  for (let d = START; d <= yday; d = addD(d, 1)) {
    if (have.has(sn + d) || miss.has(sn + d)) continue;
    if (fetched >= MAX_FETCH) { log.push(`上限${MAX_FETCH}ページに達したので続きは次回`); break outer; }
    if (fetched) await sleep(WAIT_MS);
    fetched++;
    let res;
    try {
      res = await fetch(`https://pekasen.com/store/${slug}/${d}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
    } catch (e) { log.push(`${sn}${d} 取得エラー ${e.message}`); continue; }
    if (!res.ok) {
      log.push(`${sn}${d} HTTP ${res.status}`);
      if ([403, 429, 503].includes(res.status)) { blocked = true; break outer; }
      continue;
    }
    const r = parseDay(await res.text(), d);
    if (r && r.length) {
      r.forEach(x => rows.push([sn, d, ...x]));
      have.add(sn + d); added += r.length;
    } else if (d < twoDaysAgo) {
      miss.add(sn + d);      // 2日以上前でデータが無い日は欠けとして記録（休業日など）
    } else {
      log.push(`${sn}${d} はまだ掲載されていません`);
    }
  }
}
meta.missing = [...miss].sort();
rows.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]) || a[3] - b[3]);
if (added) await writeFile(ROWS, '[\n' + rows.map(r => JSON.stringify(r)).join(',\n') + '\n]\n');
await writeFile(META, JSON.stringify(meta, null, 1) + '\n');

const prev = await readJson(OUT, null);
let recomputed = false;
if (rows.length && (force || added || !prev || prev.today !== today)) {
  const objs = rows.map(r => ({ s: r[0], d: r[1], m: r[2], no: r[3], g: r[4], b: r[5], r: r[6], sa: r[7] }));
  const out = runModel(objs, meta, today);
  out.today = today;
  out.log = log.slice(-20);
  await writeFile(OUT, JSON.stringify(out));
  recomputed = true;
}
const latest = {};
rows.forEach(r => { if (!latest[r[0]] || r[1] > latest[r[0]]) latest[r[0]] = r[1]; });
const status = { finished: new Date().toISOString(), today, fetched, added, recomputed, blocked, latest, rowCount: rows.length, log: log.slice(-30) };
await writeFile(STATUS, JSON.stringify(status, null, 1) + '\n');
console.log(JSON.stringify(status, null, 1));
if (blocked) process.exitCode = 1;
