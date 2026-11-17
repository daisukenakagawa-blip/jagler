(() => {
const SP={'マイジャグラーV':[[273.1,270.8,266.4,254.0,240.1,229.1],[409.6,385.5,336.1,290.0,268.6,229.1]],'マイジャグラー6':[[273.1,270.8,266.4,254.0,240.1,229.1],[409.6,385.5,336.1,290.0,268.6,229.1]],'ネオアイムジャグラーEX':[[273.1,269.7,269.7,259.0,259.0,255.0],[439.8,399.6,331.0,315.1,255.0,255.0]],'アイムジャグラーEX':[[273.1,269.7,269.7,259.0,259.0,255.0],[439.8,399.6,331.0,315.1,255.0,255.0]],'ゴーゴージャグラー3':[[259.0,258.0,257.0,254.0,247.3,234.9],[354.2,332.7,306.2,268.6,247.3,234.9]],'ファンキージャグラー2':[[266.4,259.0,256.0,249.2,240.9,219.9],[439.8,407.1,366.1,322.8,299.3,262.1]],'ジャグラーガールズSS':[[273.1,270.8,260.1,250.1,243.6,226.0],[381.0,350.5,316.6,281.3,270.8,252.1]],'ウルトラミラクルジャグラー':[[267.5,261.1,256.0,242.7,233.2,216.3],[425.6,402.1,350.5,322.8,297.9,284.9]],'ハッピージャグラーVIII':[[273.1,270.8,263.2,254.0,239.2,226.0],[397.2,362.1,332.7,300.6,273.1,256.0]],'ミスタージャグラー':[[268.6,267.5,260.1,249.2,240.9,237.4],[374.5,354.2,331.0,291.3,257.0,237.4]]};
const W='日月火水木金土',pct=v=>(v*100).toFixed(1)+'%',sh=m=>m.replace('ジャグラー','J');
// drop partial days
const cnt={};__R.forEach(r=>{const k=r[0]+'|'+r[1];cnt[k]=(cnt[k]||0)+1});const med={};const by={};Object.entries(cnt).forEach(([k,n])=>{(by[k.split('|')[0]]=by[k.split('|')[0]]||[]).push(n)});Object.entries(by).forEach(([s,v])=>{v.sort((a,b)=>a-b);med[s]=v[v.length>>1]});
const R=__R.filter(r=>SP[r[2]]&&cnt[r[0]+'|'+r[1]]>=0.8*med[r[0]]);
const out=[];
for(const s of [...new Set(R.map(r=>r[0]))]){
 const rows=R.filter(r=>r[0]===s).map(r=>{const [,d,m,no,g,b,rg,sa]=r;const sp=SP[m];const ll=[0,1,2,3,4,5].map(i=>{const pb=1/sp[0][i],pr=1/sp[1][i];return b*Math.log(pb)-g*pb+rg*Math.log(pr)-g*pr});const mx=Math.max(...ll);const p=ll.map(v=>Math.exp(v-mx));const z=p.reduce((a,c)=>a+c);
  const D=new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6));return {d,m,no,g,sa,ok:g>=3000,hi:g>=3000&&(p[3]+p[4]+p[5])/z>=0.75,dd:D.getDate(),mm:D.getMonth()+1,wd:D.getDay(),t:+D,key:no+'|'+m}});
 const days=[...new Set(rows.map(x=>x.d))].sort();
 // island position & neighbors
 const g1=new Map();rows.forEach(x=>{const k=x.d+'|'+x.m;if(!g1.has(k))g1.set(k,[]);g1.get(k).push(x)});
 for(const a of g1.values()){a.sort((p,q)=>p.no-q.no);let run=[];const flush=()=>{run.forEach((x,i)=>{x.edge=run.length>=3&&(i===0||i===run.length-1);x.L=run[i-1];x.R=run[i+1]});run=[]};a.forEach(x=>{if(run.length&&x.no!==run[run.length-1].no+1)flush();run.push(x)});flush()}
 const byKey=new Map();rows.forEach(x=>{if(!byKey.has(x.key))byKey.set(x.key,[]);byKey.get(x.key).push(x)});
 for(const a of byKey.values()){a.sort((p,q)=>p.t-q.t);for(let i=1;i<a.length;i++)if(a[i].t-a[i-1].t<1.5*864e5)a[i].prev=a[i-1]}
 const O=rows.filter(x=>x.ok);const base=O.filter(x=>x.hi).length/O.length;
 // per-台 leave-one-out baseline (shrunk to store base)
 const kt=new Map();O.forEach(x=>{const o=kt.get(x.key)||[0,0];o[0]+=x.hi;o[1]++;kt.set(x.key,o)});
 const own=x=>{const o=kt.get(x.key);return (o[0]-x.hi+5*base)/(o[1]-1+5)};
 const sv=rows.filter(x=>x.sa!==null);
 out.push(`\n=== ${s}  ${days.length}日(${days[0].slice(4)}〜${days[days.length-1].slice(4)}) 台/日${Math.round(rows.length/days.length)} 判定可${pct(O.length/rows.length)} 高設定率${pct(base)} 平均差枚${Math.round(sv.reduce((a,x)=>a+x.sa,0)/sv.length)}`);
 // simple rate groups
 const grp=(f,min)=>{const m=new Map();O.forEach(x=>{const k=f(x);if(k==null)return;const o=m.get(k)||[0,0,new Set()];o[0]+=x.hi;o[1]++;o[2].add(x.d);m.set(k,o)});return [...m.entries()].filter(([k,o])=>o[1]>=(min||30)).map(([k,o])=>({k,h:o[0],n:o[1],nd:o[2].size,r:o[0]/o[1],z:(o[0]/o[1]-base)/Math.sqrt(base*(1-base)/o[1])}))};
 const fmt=a=>a.map(x=>`${x.k}:${pct(x.r)}(z${x.z.toFixed(1)}${x.nd?','+x.nd+'日':''})`).join(' ');
 out.push('末尾 '+fmt(grp(x=>x.dd%10).sort((a,b)=>a.k-b.k)));
 out.push('曜日 '+fmt(grp(x=>W[x.wd]).sort((a,b)=>W.indexOf(a.k)-W.indexOf(b.k))));
 out.push('特別 '+fmt(grp(x=>x.dd===x.mm?'ゾロ目':null,10).concat(grp(x=>x.dd%11===0&&x.dd!==x.mm?'11倍数':null,10),grp(x=>x.dd<=3?'1〜3日':null),grp(x=>x.dd>=28?'28日〜':null),grp(x=>x.wd===6&&x.dd<=7?'第1土':null,10),grp(x=>x.wd===0&&x.dd<=7?'第1日':null,10))));
 const dom=grp(x=>x.dd+'日',20).sort((a,b)=>b.z-a.z);out.push('日付上位 '+fmt(dom.slice(0,6))+' ／下位 '+fmt(dom.slice(-3)));
 out.push('機種 '+fmt(grp(x=>sh(x.m)).sort((a,b)=>b.r-a.r)).replace(/,\d+日/g,''));
 out.push('台番末尾 '+fmt(grp(x=>x.no%10).sort((a,b)=>a.k-b.k)).replace(/,\d+日/g,''));
 out.push('台番末尾=日付末尾 '+fmt(grp(x=>x.no%10===x.dd%10?'一致':'不一致')).replace(/,\d+日/g,'')+'  角台 '+fmt(grp(x=>x.edge===true?'角':x.edge===false?'中':null)).replace(/,\d+日/g,''));
 // O/E conditions vs own baseline
 const oe=(f,label)=>{const a=O.filter(f);if(a.length<20)return label+':少';const ob=a.filter(x=>x.hi).length,ex=a.reduce((t,x)=>t+own(x),0);const z=(ob-ex)/Math.sqrt(a.reduce((t,x)=>t+own(x)*(1-own(x)),0));return `${label}:×${(ob/ex).toFixed(2)}(z${z.toFixed(1)},${a.length})`};
 out.push('前日(台の普段比) '+[oe(x=>x.prev&&x.prev.hi,'前日高設定'),oe(x=>x.prev&&x.prev.hi&&x.prev.prev&&x.prev.prev.hi,'2日連続高設定'),oe(x=>x.prev&&x.prev.ok&&!x.prev.hi,'前日回って低設定'),oe(x=>x.prev&&x.prev.g<1500,'前日ほぼ空き台'),oe(x=>x.prev&&x.prev.sa!==null&&x.prev.sa>=2000,'前日+2000'),oe(x=>x.prev&&x.prev.sa!==null&&x.prev.sa<=-1500,'前日-1500以下'),oe(x=>{const p=x.prev,p2=p&&p.prev,p3=p2&&p2.prev;return [p,p2,p3].every(y=>y&&y.sa!==null&&y.sa<0)},'3連続マイナス'),oe(x=>x.prev&&[x.prev.L,x.prev.R].some(y=>y&&y.hi),'前日隣が高設定')].join(' '));
 out.push('並び(当日) '+[oe(x=>[x.L,x.R].some(y=>y&&y.hi),'隣が高設定'),oe(x=>x.L&&x.R&&x.L.hi&&x.R.hi,'両隣高設定')].join(' '));
 // 全台系っぽい日
 const md=grp(x=>x.d+'|'+sh(x.m),4).filter(a=>a.n>=4&&a.r>=0.5);out.push(`機種まとめ投入っぽい日 ${md.length}件: `+md.map(a=>{const [d,m]=a.k.split('|');return d.slice(4,6)+'/'+d.slice(6)+'('+W[new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6)).getDay()]+')'+m+' '+a.h+'/'+a.n}).slice(0,14).join(' '));
 // best/worst days
 const dr=grp(x=>x.d,1).sort((a,b)=>b.r-a.r);out.push('当たり日 '+dr.slice(0,6).map(a=>a.k.slice(4,6)+'/'+a.k.slice(6)+'('+W[new Date(+a.k.slice(0,4),+a.k.slice(4,6)-1,+a.k.slice(6)).getDay()]+')'+pct(a.r)).join(' '));
 // top machines
 const K=8;const nos=[...kt.entries()].map(([k,o])=>({k,h:o[0],n:o[1],s:(o[0]+K*base)/(o[1]+K)})).sort((a,b)=>b.s-a.s);out.push('台番上位 '+nos.slice(0,10).map(a=>a.k.split('|')[0]+sh(a.k.split('|')[1]).replace(/ジャグラー|J/,'')+' '+a.h+'/'+a.n).join(' | '));
}
document.body.innerHTML='<pre id="o"></pre>';document.getElementById('o').textContent=out.join('\n');return out.length;
})()
