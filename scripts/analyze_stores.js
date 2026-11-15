// ブラウザで実行：window.__R（[店, 日付, 機種, 台番, G, BIG, REG, 差枚]）を店ごとに分析して文字列を返す
(() => {
const SP={'マイジャグラーV':[[273.1,270.8,266.4,254.0,240.1,229.1],[409.6,385.5,336.1,290.0,268.6,229.1]],'マイジャグラー6':[[273.1,270.8,266.4,254.0,240.1,229.1],[409.6,385.5,336.1,290.0,268.6,229.1]],'ネオアイムジャグラーEX':[[273.1,269.7,269.7,259.0,259.0,255.0],[439.8,399.6,331.0,315.1,255.0,255.0]],'アイムジャグラーEX':[[273.1,269.7,269.7,259.0,259.0,255.0],[439.8,399.6,331.0,315.1,255.0,255.0]],'ゴーゴージャグラー3':[[259.0,258.0,257.0,254.0,247.3,234.9],[354.2,332.7,306.2,268.6,247.3,234.9]],'ファンキージャグラー2':[[266.4,259.0,256.0,249.2,240.9,219.9],[439.8,407.1,366.1,322.8,299.3,262.1]],'ジャグラーガールズSS':[[273.1,270.8,260.1,250.1,243.6,226.0],[381.0,350.5,316.6,281.3,270.8,252.1]],'ウルトラミラクルジャグラー':[[267.5,261.1,256.0,242.7,233.2,216.3],[425.6,402.1,350.5,322.8,297.9,284.9]],'ハッピージャグラーVIII':[[273.1,270.8,263.2,254.0,239.2,226.0],[397.2,362.1,332.7,300.6,273.1,256.0]],'ミスタージャグラー':[[268.6,267.5,260.1,249.2,240.9,237.4],[374.5,354.2,331.0,291.3,257.0,237.4]]};
const W='日月火水木金土';
const rows=window.__R.filter(r=>SP[r[2]]).map(r=>{const [s,d,m,no,g,b,rg,sa]=r;const sp=SP[m];const ll=[0,1,2,3,4,5].map(i=>{const pb=1/sp[0][i],pr=1/sp[1][i];return b*Math.log(pb)-g*pb+rg*Math.log(pr)-g*pr});const mx=Math.max(...ll);const p=ll.map(v=>Math.exp(v-mx));const z=p.reduce((a,c)=>a+c);const p456=(p[3]+p[4]+p[5])/z;
 const D=new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6));return {s,d,m,no,g,b,r:rg,sa,ok:g>=3000,hi:g>=3000&&p456>=0.75,dd:D.getDate(),mm:D.getMonth()+1,wd:D.getDay(),wk:Math.floor((D.getDate()-1)/7)+1}});
const out=[];const pct=v=>(v*100).toFixed(1)+'%';
for(const s of [...new Set(rows.map(x=>x.s))]){
 const S=rows.filter(x=>x.s===s),O=S.filter(x=>x.ok);const base=O.filter(x=>x.hi).length/O.length;const days=[...new Set(S.map(x=>x.d))].sort();
 const sv=S.filter(x=>x.sa!==null);const avgSa=sv.reduce((a,x)=>a+x.sa,0)/sv.length;
 out.push(`=== ${s}  ${days.length}日 ${days[0]}〜${days[days.length-1]}  台数/日 ${Math.round(S.length/days.length)}  判定可能 ${O.length}台日  高設定率 ${pct(base)}  平均差枚 ${Math.round(avgSa)}`);
 const grp=(f,label)=>{const m=new Map();O.forEach(x=>{const k=f(x);if(k===null||k===undefined)return;const o=m.get(k)||[0,0,new Set(),0,0];o[0]+=x.hi;o[1]++;o[2].add(x.d);m.set(k,o)});
  sv.forEach(x=>{const k=f(x);if(k===null||k===undefined)return;const o=m.get(k);if(o){o[3]+=x.sa;o[4]++}});
  return [...m.entries()].map(([k,o])=>{const r=o[0]/o[1];const se=Math.sqrt(base*(1-base)/o[1]);return {k,h:o[0],n:o[1],nd:o[2].size,r,lift:r/base,z:(r-base)/se,sa:o[4]?Math.round(o[3]/o[4]):null}})};
 const show=(arr,label,minN)=>out.push(label+': '+arr.filter(a=>a.n>=minN).map(a=>`${a.k}=${pct(a.r)}(×${a.lift.toFixed(2)},z${a.z.toFixed(1)},${a.nd}日,差${a.sa})`).join('  '));
 show(grp(x=>x.dd%10,'末尾').sort((a,b)=>a.k-b.k),'末尾',30);
 show(grp(x=>W[x.wd]).sort((a,b)=>W.indexOf(a.k)-W.indexOf(b.k)),'曜日',30);
 show(grp(x=>x.dd===x.mm?'ゾロ目':(x.dd%11===0?'11の倍数':null)),'ゾロ目系',10);
 const dom=grp(x=>x.dd+'日').filter(a=>a.n>=20).sort((a,b)=>b.z-a.z);show(dom.slice(0,6),'日付 上位',20);show(dom.slice(-3),'日付 下位',20);
 const dayr=grp(x=>x.d).sort((a,b)=>b.r-a.r);show(dayr.slice(0,8).map(a=>({...a,k:a.k.slice(4,6)+'/'+a.k.slice(6)+'('+W[new Date(+a.k.slice(0,4),+a.k.slice(4,6)-1,+a.k.slice(6)).getDay()]+')'})),'当たり日 上位8',1);
 show(grp(x=>x.m).sort((a,b)=>b.r-a.r),'機種',30);
 // 台番：縮小推定
 const K=8;const nos=grp(x=>x.no+' '+x.m.replace('ジャグラー','J')).map(a=>({...a,sh:(a.h+K*base)/(a.n+K)})).sort((a,b)=>b.sh-a.sh);
 out.push('台番 上位10: '+nos.slice(0,10).map(a=>`${a.k} ${a.h}/${a.n}`).join(' | '));
 out.push('台番 下位5: '+nos.slice(-5).map(a=>`${a.k} ${a.h}/${a.n}`).join(' | '));
 // 全台系っぽい日：機種で高設定率50%以上（判定可能4台以上）
 const zm=grp(x=>x.d+'|'+x.m).filter(a=>a.n>=4&&a.r>=0.5).map(a=>a.k);const zc={};zm.forEach(k=>{const [d,m]=k.split('|');const D=new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6));const key=D.getDate()+'日';zc[key]=(zc[key]||0)+1});
 out.push(`機種まるごと高設定っぽい日（判定4台以上で半分以上）: ${zm.length}件  日付別 `+Object.entries(zc).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>k+':'+v).join(' '));
}
return out.join('\n');
})()
