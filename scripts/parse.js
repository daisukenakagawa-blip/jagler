// ペカセンの日付ページ（/store/<店>/<YYYYMMDD>）のHTMLから台データを取り出す
// 戻り値: [[機種, 台番, G数, BIG, REG, 差枚|null], ...]  ページの日付が違えば null
const strip = s => s.replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const num = s => +String(s).replace(/[,\s]/g, '');

export function parseDay(html, ymd) {
  const t = html.match(/<title>([^<]*)<\/title>/);
  if (!t) return null;
  const m = t[1].match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m || m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0') !== ymd) return null;
  const out = [];
  for (const part of html.split('class="dayblock"').slice(1)) {
    const mm = part.match(/class="dd"[^>]*>([\s\S]*?)<\/a>/);
    if (!mm) continue;
    const machine = strip(mm[1]).replace(/^S(?=[ァ-ヶ])/, '');   // 「SアイムジャグラーEX」などの頭のSを取る
    if (!/ジャグラー/.test(machine) || machine.length >= 20) continue;   // ジャグラー以外は除く
    const th = part.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
    if (!th || !/台番/.test(th[1])) continue;
    const tb = part.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/);
    if (!tb) continue;
    for (const tr of tb[1].split(/<tr[\s>]/).slice(1)) {
      const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => strip(c[1]));
      if (cells.length < 6 || cells[0].startsWith('平均')) continue;
      const no = num(cells[0]);
      if (!no) continue;
      const sa = cells[5];
      out.push([machine, no, num(cells[1]), num(cells[2]), num(cells[3]),
        sa === '' || sa === '−' || sa === '-' ? null : num(sa.replace('+', ''))]);
    }
  }
  return out;
}
