// 自動生成ファイル（編集は scripts/ と scriptable/main.js で行い、node scriptable/build.mjs で作り直す）
// ペカセンの日付ページ（/store/<店>/<YYYYMMDD>）のHTMLから台データを取り出す
// 戻り値: [[機種, 台番, G数, BIG, REG, 差枚|null], ...]  ページの日付が違えば null
const strip = s => s.replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
const num = s => +String(s).replace(/[,\s]/g, '');

function parseDay(html, ymd) {
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

// 予測エンジン（ペカセンの台データ → 台番別の高設定期待度・検証）
// rows: [{s,d,m,no,g,b,r,sa}]  meta: {missing:[...]}  today: 'YYYYMMDD'（日本時間）
// plog: アプリが実際に出した予想の記録 {店: {対象日: [[台番, 機種, 期待度], ...]}}（答え合わせ用）
function runModel(rows, meta, today, plog){
const HALF=45, K=6, K2=15, BT=30;
const STORES=[['本館'],['新館'],['新橋UNO'],['セブンS川崎'],['ゴードン祖師谷'],['マルハン新宿東宝'],['楽園川崎']];
const SP={'マイジャグラーV':[[273.1,270.8,266.4,254.0,240.1,229.1],[409.6,385.5,336.1,290.0,268.6,229.1]],'マイジャグラー6':[[273.1,270.8,266.4,254.0,240.1,229.1],[409.6,385.5,336.1,290.0,268.6,229.1]],'ネオアイムジャグラーEX':[[273.1,269.7,269.7,259.0,259.0,255.0],[439.8,399.6,331.0,315.1,255.0,255.0]],'アイムジャグラーEX':[[273.1,269.7,269.7,259.0,259.0,255.0],[439.8,399.6,331.0,315.1,255.0,255.0]],'ゴーゴージャグラー3':[[259.0,258.0,257.0,254.0,247.3,234.9],[354.2,332.7,306.2,268.6,247.3,234.9]],'ファンキージャグラー2':[[266.4,259.0,256.0,249.2,240.9,219.9],[439.8,407.1,366.1,322.8,299.3,262.1]],'ファンキージャグラー2KT':[[266.4,259.0,256.0,249.2,240.9,219.9],[439.8,407.1,366.1,322.8,299.3,262.1]],'ジャグラーガールズSS':[[273.1,270.8,260.1,250.1,243.6,226.0],[381.0,350.5,316.6,281.3,270.8,252.1]],'ウルトラミラクルジャグラー':[[267.5,261.1,256.0,242.7,233.2,216.3],[425.6,402.1,350.5,322.8,297.9,284.9]],'ハッピージャグラーVIII':[[273.1,270.8,263.2,254.0,239.2,226.0],[397.2,362.1,332.7,300.6,273.1,256.0]],'ミスタージャグラー':[[268.6,267.5,260.1,249.2,240.9,237.4],[374.5,354.2,331.0,291.3,257.0,237.4]]};
const DAY=864e5, log=[];
// エスパス以外の店の強い日（2026/8〜11月のペカセンデータで高設定率が有意に高かった日。el は表示用）
const RULES={'ゴードン祖師谷':{E:d=>d%10===9,el:'9のつく日',txt:{T:'なし',E:'9のつく日'}}};
const ymd=D=>D.getFullYear()+String(D.getMonth()+1).padStart(2,'0')+String(D.getDate()).padStart(2,'0');
const dt=d=>new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6));
const addD=(d,n)=>{const D=dt(d);D.setDate(D.getDate()+n);return ymd(D)};
// ---------- 2. per-row features ----------
const evT=(s,d)=>{const D=dt(d),dd=D.getDate(),mm=D.getMonth()+1,wd=D.getDay(),why=[];let T=false,E=false;
 if(s!=='本館'&&s!=='新館'){const R=RULES[s];if(!R)return {typ:'通常',why:[],wd};
  if(R.T&&R.T(dd,wd,mm)){T=true;E=true;why.push(R.tl)}else if(R.E&&R.E(dd,wd,mm)){E=true;why.push(R.el)}
  return {typ:T?'特日':E?'旧イベ':'通常',why,wd}}
 if(s==='本館'){if(dd===21||dd===25)T=true;if(dd%10===7){E=true;why.push('7のつく日')}if([1,11,21,22,25].includes(dd)){E=true;why.push(dd+'日')}if(mm===dd){E=true;why.push('ゾロ目')}if(wd===6&&dd<=7){E=true;why.push('第1土曜')}}
 else{if(dd%10===4){T=true;E=true;why.push('4のつく日')}if(mm===dd){T=true;E=true;why.push('ゾロ目')}if(dd%10===7){E=true;why.push('7のつく日')}}
 return {typ:T?'特日':E?'旧イベ':'通常',why:[...new Set(why)],wd}};
const cls=t=>t==='通常'?'N':t==='特日'?'T':'E';
rows.forEach(x=>{const sp=SP[x.m];x.ok=x.g>=3000;x.t=+dt(x.d);if(!sp){x.p=null;x.hi=false;x.unk=true}else{const ll=[0,1,2,3,4,5].map(i=>{const pb=1/sp[0][i],pr=1/sp[1][i];return x.b*Math.log(pb)-x.g*pb+x.r*Math.log(pr)-x.g*pr});const mx=Math.max(...ll);const p=ll.map(v=>Math.exp(v-mx));const s=p.reduce((a,b)=>a+b);x.p=p.map(v=>v/s);x.p456=x.p[3]+x.p[4]+x.p[5];x.hi=x.ok&&x.p456>=0.75;x.es=x.p.reduce((a,v,i)=>a+v*(i+1),0)}
 const e=evT(x.s,x.d);x.typ=e.typ;x.c=cls(e.typ);x.wd=e.wd;x.key=x.s+'|'+x.no+'|'+x.m;});
const grp=(a,k)=>{const m=new Map();a.forEach(x=>{const kk=k(x);if(!m.has(kk))m.set(kk,[]);m.get(kk).push(x)});return m};
for(const a of grp(rows,x=>x.s+x.d+x.m).values()){a.sort((p,q)=>p.no-q.no);let runs=[],cur=[];a.forEach(x=>{if(cur.length&&x.no!==cur[cur.length-1].no+1){runs.push(cur);cur=[]}cur.push(x)});runs.push(cur);
 runs.forEach(r=>{const sv=r.filter(y=>y.sa!==null);const isa=sv.length?sv.reduce((s,y)=>s+y.sa,0)/sv.length:null;r.forEach((x,i)=>{x.isa=isa;x.L=r[i-1]||null;x.R=r[i+1]||null;x.isl=r[0].no+'-'+r[r.length-1].no})})}
for(const a of grp(rows,x=>x.key).values()){a.sort((p,q)=>p.t-q.t);for(let i=1;i<a.length;i++)if(a[i].t-a[i-1].t<=DAY*1.5)a[i].prev=a[i-1];}
const CONDS={big:'前日+2000枚以上',dent:'前日−1000枚以下',neg3:'3日連続マイナス',phi:'前日高設定',isup:'島が前日平均+500以上',isdn:'島が前日平均−500以下',nbhi:'隣が前日高設定'};
const condsOf=p=>{if(!p)return [];const c=[];if(p.sa!==null&&p.sa>=2000)c.push('big');if(p.sa!==null&&p.sa<=-1000)c.push('dent');
 const p2=p.prev,p3=p2&&p2.prev;if([p,p2,p3].every(y=>y&&y.sa!==null&&y.sa<0))c.push('neg3');if(p.hi)c.push('phi');if(p.isa!==null&&p.isa>=500)c.push('isup');if(p.isa!==null&&p.isa<=-500)c.push('isdn');
 if([p.L,p.R].some(y=>y&&y.hi))c.push('nbhi');return c};
const DAYC={afterT:'特日の翌日',afterE:'旧イベ日の翌日',sat:'土曜',sun:'日曜'};
const dayCondsOf=(s,d)=>{const c=[];const pv=evT(s,addD(d,-1)).typ;if(pv==='特日')c.push('afterT');else if(pv==='旧イベ')c.push('afterE');const wd=dt(d).getDay();if(wd===6)c.push('sat');if(wd===0)c.push('sun');return c};
rows.forEach(x=>{x.cd=condsOf(x.prev);x.dc=dayCondsOf(x.s,x.d)});
// ---------- 3. model ----------
function train(tr,cut){
 const w=x=>Math.pow(0.5,(cut-x.t)/DAY/HALF);
 const A=new Map(),M=new Map();
 tr.forEach(x=>{if(!x.ok||x.unk)return;const ww=w(x);x.w=ww;const a=x.key+'|'+x.c,m=x.s+'|'+x.m+'|'+x.c;const ao=A.get(a)||[0,0],mo=M.get(m)||[0,0];ao[0]+=ww*x.hi;ao[1]+=ww;mo[0]+=ww*x.hi;mo[1]+=ww;A.set(a,ao);M.set(m,mo)});
 const prior=(s,m,c)=>{const o=M.get(s+'|'+m+'|'+c)||[0,0];const st=M.get(s+'|__|'+c);return (o[0]+3*0.15)/(o[1]+3)};
 const base=(key,s,m,c,x)=>{const o=A.get(key+'|'+c)||[0,0];let h=o[0],n=o[1];if(x){h-=x.w*x.hi;n-=x.w}return (h+K*prior(s,m,c))/(n+K)};
 const F={},D={};
 tr.forEach(x=>{if(!x.ok||x.unk||!x.prev)return;const g=x.c==='N'?'N':'ET';const b=base(x.key,x.s,x.m,x.c,x);x.cd.forEach(k=>{const kk=x.s+g+k;const o=F[kk]||[0,0,0];o[0]+=x.w*x.hi;o[1]+=x.w*b;o[2]++;F[kk]=o});
  x.dc.forEach(k=>{const kk=x.s+g+k;const o=D[kk]||[0,0,0];o[0]+=x.w*x.hi;o[1]+=x.w*b;o[2]++;D[kk]=o})});
 const fac=(o)=>o?(o[0]+K2)/(o[1]+K2):1;
 return {base,F,D,fac};
}
function predict(mdl,s,cands,target,prevDay){
 const c=cls(evT(s,target).typ),g=c==='N'?'N':'ET';const dcs=dayCondsOf(s,target);const dm=dcs.reduce((a,k)=>a*mdl.fac(mdl.D[s+g+k]),1);
 return cands.map(x=>{const b=mdl.base(x.key,x.s,x.m,c);const cd=prevDay?condsOf(prevDay.get(x.key)):[];let p=b*dm;const rs=[];cd.forEach(k=>{const f=mdl.fac(mdl.F[s+g+k]);p*=f;if(Math.abs(f-1)>=0.08)rs.push([k,+f.toFixed(2)])});
  dcs.forEach(k=>{const f=mdl.fac(mdl.D[s+g+k]);if(Math.abs(f-1)>=0.08)rs.push([k,+f.toFixed(2)])});return {x,b,p:Math.min(0.9,p),rs}})}
// ---------- 4. backtest + forecast per store ----------
const latest={};rows.forEach(x=>{if(!latest[x.s]||x.d>latest[x.s])latest[x.s]=x.d});const out={gen:new Date().toISOString(),latest,log,stores:{},byno:[],codes:{...CONDS,...DAYC}};
for(const [s] of STORES){if(!latest[s])continue;const S=rows.filter(x=>x.s===s);const days=[...new Set(S.map(x=>x.d))].sort();
 const byDay=grp(S,x=>x.d);
 // backtest
 const hist=[];let H10=0,N10=0,HB=0,NB=0,HD=0,ND=0,HBase10=0,NBase10=0;
 // 答え合わせ用：期待度の帯ごとの [予想の合計, 当たり, 判定できた台数] と、日ごとの上位10台の結果（1=高設定 0=外れ -1=3000G未満で判定不能）
 const binOf=p=>p<0.1?0:p<0.2?1:p<0.3?2:p<0.4?3:4;const newCal=()=>[0,1,2,3,4].map(()=>[0,0,0]);
 const addCal=(cal,p,x)=>{if(!x.ok)return;const c=cal[binOf(p)];c[0]+=p;c[1]+=x.hi?1:0;c[2]++};
 const stOf=x=>!x?-2:x.ok?(x.hi?1:0):-1;
 const btCal=newCal(),btDays=[];
 for(const d of days.slice(-BT)){const cut=+dt(d);const tr=S.filter(x=>x.t<cut);if(tr.length<2000)continue;const mdl=train(tr,cut);
  const dayRows=byDay.get(d).filter(x=>!x.unk);const prevD=addD(d,-1);const pmap=byDay.has(prevD)?new Map(byDay.get(prevD).map(y=>[y.key,y])):null;
  const prAll=predict(mdl,s,dayRows,d,pmap);prAll.forEach(o=>addCal(btCal,o.p,o.x));
  btDays.push([d,prAll.slice().sort((a,b)=>b.p-a.p).slice(0,10).map(o=>[o.x.no,o.x.m,+o.p.toFixed(3),stOf(o.x)])]);
  const pr=prAll.filter(o=>o.x.ok);const okN=pr.length,okH=pr.filter(o=>o.x.hi).length;
  const top=pr.slice().sort((a,b)=>b.p-a.p).slice(0,10),topB=pr.slice().sort((a,b)=>b.b-a.b).slice(0,10);
  const h10=top.filter(o=>o.x.hi).length,hb10=topB.filter(o=>o.x.hi).length;H10+=h10;N10+=top.length;HBase10+=hb10;NBase10+=topB.length;HD+=okH;ND+=okN;
  hist.push([d,h10,top.length,okH,okN,hb10]);
  if(d===days[days.length-1])out.stores[s]={yday:{d,top:top.map(o=>[o.x.no,o.x.m,+o.p.toFixed(3),o.x.hi?1:0])}};}
 // 実際に出した予想の答え合わせ
 const rCal=newCal(),rDays=[];const PL=(plog&&plog[s])||{};
 for(const d of Object.keys(PL).sort()){if(!byDay.has(d))continue;const km=new Map(byDay.get(d).map(y=>[y.no+'|'+y.m,y]));
  PL[d].forEach(q=>{const x=km.get(q[0]+'|'+q[1]);if(x)addCal(rCal,q[2],x)});
  rDays.push([d,PL[d].slice(0,10).map(q=>[q[0],q[1],q[2],stOf(km.get(q[0]+'|'+q[1]))])]);}
 // forecast
 const L=days[days.length-1];let target=addD(L,1);if(target<today)target=today;const prevDay=target===addD(L,1)?new Map(byDay.get(L).map(y=>[y.key,y])):null;
 const cut=+dt(target);const mdl=train(S,cut);const cands=byDay.get(L).filter(x=>!x.unk);
 const pr=predict(mdl,s,cands,target,prevDay).sort((a,b)=>b.p-a.p);const e=evT(s,target);const g=cls(e.typ)==='N'?'N':'ET';
 const facs=g2=>Object.keys(CONDS).map(k=>{const o=mdl.F[s+g2+k];return [k,o?+o[0].toFixed(1):0,o?+o[1].toFixed(1):0,+mdl.fac(o).toFixed(2),o?o[2]:0]});
 const dfacs=g2=>Object.keys(DAYC).map(k=>{const o=mdl.D[s+g2+k];return [k,o?+o[0].toFixed(1):0,o?+o[1].toFixed(1):0,+mdl.fac(o).toFixed(2),o?o[2]:0]});
 Object.assign(out.stores[s]=out.stores[s]||{},{rule:s==='本館'?{T:'21・25日',E:'1・7・11・21・22・25日、ゾロ目、第1土曜'}:s==='新館'?{T:'4のつく日・ゾロ目',E:'4・7のつく日、ゾロ目'}:(RULES[s]?RULES[s].txt:null),target,typ:e.typ,why:e.why,wd:e.wd,prevOk:!!prevDay,lastData:L,
  preds:pr.map(o=>[o.x.no,o.x.m,+o.p.toFixed(3),+o.b.toFixed(3),o.rs]),
  bt:{days:hist.length,h10:H10,n10:N10,hb10:HBase10,nb10:NBase10,hd:HD,nd:ND,hist},
  acc:{real:{days:rDays,cal:rCal.map(c=>[+c[0].toFixed(2),c[1],c[2]])},bt:{days:btDays,cal:btCal.map(c=>[+c[0].toFixed(2),c[1],c[2]])}},
  fac:{N:facs('N'),ET:facs('ET')},dfac:{N:dfacs('N'),ET:dfacs('ET')}});
 // byno stats (current machines)
 const cur=new Set(cands.map(x=>x.key));for(const [key,a] of grp(S.filter(x=>cur.has(x.key)),x=>x.key)){const x0=a[0];const st=f=>{const o=a.filter(y=>y.ok&&f(y));return [o.filter(y=>y.hi).length,o.length]};
  const r=c=>c[1]?+(100*c[0]/c[1]).toFixed(1):null;const cA=st(()=>true),cT=st(y=>y.c==='T'),cE=st(y=>y.c!=='N'),cN=st(y=>y.c==='N');const ok=a.filter(y=>y.ok);const sv=a.filter(y=>y.sa!==null);const ds=a.map(y=>y.d).sort();
  out.byno.push([s,x0.no,x0.m,r(cA),r(cT),r(cE),r(cN),cA,cT,cE,cN,ok.length?+(ok.reduce((t,y)=>t+y.es,0)/ok.length).toFixed(2):null,Math.round(a.reduce((t,y)=>t+y.g,0)/a.length),sv.length?Math.round(sv.reduce((t,y)=>t+y.sa,0)/sv.length):null,sv.length?+(100*sv.filter(y=>y.sa>0).length/sv.length).toFixed(1):null,ds[0].slice(4,6)+'/'+ds[0].slice(6)+'〜'+ds[ds.length-1].slice(4,6)+'/'+ds[ds.length-1].slice(6)]);}
}
out.missing=(meta.missing||[]).slice().sort();out.rowCount=rows.length;
return out;
}

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
  if (rows.length && (added || dropped || !out || out.today !== today)) {
    const objs = rows.map(r => ({ s: r[0], d: r[1], m: r[2], no: r[3], g: r[4], b: r[5], r: r[6], sa: r[7] }));
    // アプリが出した予想を記録しておき、データが入った日に答え合わせする（60日分）
    const plog = await readJson('predlog.json', {});
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
