// 予測エンジン（ペカセンの台データ → 台番別の高設定期待度・検証）
// rows: [{s,d,m,no,g,b,r,sa}]  meta: {missing:[...]}  today: 'YYYYMMDD'（日本時間）
export function runModel(rows, meta, today){
const HALF=45, K=6, K2=15, BT=30;
const STORES=[['本館'],['新館'],['新橋UNO'],['セブンS川崎']];
const SP={'マイジャグラーV':[[273.1,270.8,266.4,254.0,240.1,229.1],[409.6,385.5,336.1,290.0,268.6,229.1]],'マイジャグラー6':[[273.1,270.8,266.4,254.0,240.1,229.1],[409.6,385.5,336.1,290.0,268.6,229.1]],'ネオアイムジャグラーEX':[[273.1,269.7,269.7,259.0,259.0,255.0],[439.8,399.6,331.0,315.1,255.0,255.0]],'アイムジャグラーEX':[[273.1,269.7,269.7,259.0,259.0,255.0],[439.8,399.6,331.0,315.1,255.0,255.0]],'ゴーゴージャグラー3':[[259.0,258.0,257.0,254.0,247.3,234.9],[354.2,332.7,306.2,268.6,247.3,234.9]],'ファンキージャグラー2':[[266.4,259.0,256.0,249.2,240.9,219.9],[439.8,407.1,366.1,322.8,299.3,262.1]],'ファンキージャグラー2KT':[[266.4,259.0,256.0,249.2,240.9,219.9],[439.8,407.1,366.1,322.8,299.3,262.1]],'ジャグラーガールズSS':[[273.1,270.8,260.1,250.1,243.6,226.0],[381.0,350.5,316.6,281.3,270.8,252.1]],'ウルトラミラクルジャグラー':[[267.5,261.1,256.0,242.7,233.2,216.3],[425.6,402.1,350.5,322.8,297.9,284.9]],'ハッピージャグラーVIII':[[273.1,270.8,263.2,254.0,239.2,226.0],[397.2,362.1,332.7,300.6,273.1,256.0]],'ミスタージャグラー':[[268.6,267.5,260.1,249.2,240.9,237.4],[374.5,354.2,331.0,291.3,257.0,237.4]]};
const DAY=864e5, log=[];
const ymd=D=>D.getFullYear()+String(D.getMonth()+1).padStart(2,'0')+String(D.getDate()).padStart(2,'0');
const dt=d=>new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6));
const addD=(d,n)=>{const D=dt(d);D.setDate(D.getDate()+n);return ymd(D)};
// ---------- 2. per-row features ----------
const evT=(s,d)=>{const D=dt(d),dd=D.getDate(),mm=D.getMonth()+1,wd=D.getDay(),why=[];let T=false,E=false;
 if(s!=='本館'&&s!=='新館')return {typ:'通常',why:[],wd};
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
 for(const d of days.slice(-BT)){const cut=+dt(d);const tr=S.filter(x=>x.t<cut);if(tr.length<2000)continue;const mdl=train(tr,cut);
  const dayRows=byDay.get(d).filter(x=>!x.unk);const prevD=addD(d,-1);const pmap=byDay.has(prevD)?new Map(byDay.get(prevD).map(y=>[y.key,y])):null;
  const pr=predict(mdl,s,dayRows,d,pmap).filter(o=>o.x.ok);const okN=pr.length,okH=pr.filter(o=>o.x.hi).length;
  const top=pr.slice().sort((a,b)=>b.p-a.p).slice(0,10),topB=pr.slice().sort((a,b)=>b.b-a.b).slice(0,10);
  const h10=top.filter(o=>o.x.hi).length,hb10=topB.filter(o=>o.x.hi).length;H10+=h10;N10+=top.length;HBase10+=hb10;NBase10+=topB.length;HD+=okH;ND+=okN;
  hist.push([d,h10,top.length,okH,okN,hb10]);
  if(d===days[days.length-1])out.stores[s]={yday:{d,top:top.map(o=>[o.x.no,o.x.m,+o.p.toFixed(3),o.x.hi?1:0])}};}
 // forecast
 const L=days[days.length-1];let target=addD(L,1);if(target<today)target=today;const prevDay=target===addD(L,1)?new Map(byDay.get(L).map(y=>[y.key,y])):null;
 const cut=+dt(target);const mdl=train(S,cut);const cands=byDay.get(L).filter(x=>!x.unk);
 const pr=predict(mdl,s,cands,target,prevDay).sort((a,b)=>b.p-a.p);const e=evT(s,target);const g=cls(e.typ)==='N'?'N':'ET';
 const facs=g2=>Object.keys(CONDS).map(k=>{const o=mdl.F[s+g2+k];return [k,o?+o[0].toFixed(1):0,o?+o[1].toFixed(1):0,+mdl.fac(o).toFixed(2),o?o[2]:0]});
 const dfacs=g2=>Object.keys(DAYC).map(k=>{const o=mdl.D[s+g2+k];return [k,o?+o[0].toFixed(1):0,o?+o[1].toFixed(1):0,+mdl.fac(o).toFixed(2),o?o[2]:0]});
 Object.assign(out.stores[s]=out.stores[s]||{},{target,typ:e.typ,why:e.why,wd:e.wd,prevOk:!!prevDay,lastData:L,
  preds:pr.map(o=>[o.x.no,o.x.m,+o.p.toFixed(3),+o.b.toFixed(3),o.rs]),
  bt:{days:hist.length,h10:H10,n10:N10,hb10:HBase10,nb10:NBase10,hd:HD,nd:ND,hist},
  fac:{N:facs('N'),ET:facs('ET')},dfac:{N:dfacs('N'),ET:dfacs('ET')}});
 // byno stats (current machines)
 const cur=new Set(cands.map(x=>x.key));for(const [key,a] of grp(S.filter(x=>cur.has(x.key)),x=>x.key)){const x0=a[0];const st=f=>{const o=a.filter(y=>y.ok&&f(y));return [o.filter(y=>y.hi).length,o.length]};
  const r=c=>c[1]?+(100*c[0]/c[1]).toFixed(1):null;const cA=st(()=>true),cT=st(y=>y.c==='T'),cE=st(y=>y.c!=='N'),cN=st(y=>y.c==='N');const ok=a.filter(y=>y.ok);const sv=a.filter(y=>y.sa!==null);const ds=a.map(y=>y.d).sort();
  out.byno.push([s,x0.no,x0.m,r(cA),r(cT),r(cE),r(cN),cA,cT,cE,cN,ok.length?+(ok.reduce((t,y)=>t+y.es,0)/ok.length).toFixed(2):null,Math.round(a.reduce((t,y)=>t+y.g,0)/a.length),sv.length?Math.round(sv.reduce((t,y)=>t+y.sa,0)/sv.length):null,sv.length?+(100*sv.filter(y=>y.sa>0).length/sv.length).toFixed(1):null,ds[0].slice(4,6)+'/'+ds[0].slice(6)+'〜'+ds[ds.length-1].slice(4,6)+'/'+ds[ds.length-1].slice(6)]);}
}
out.missing=(meta.missing||[]).slice().sort();out.rowCount=rows.length;
return out;
}
