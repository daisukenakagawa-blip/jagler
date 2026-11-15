// scripts/parse.js・scripts/model.js・scriptable/main.js を結合して Scriptable 用の bundle.js を作る
// 使い方: node scriptable/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const strip = f => readFileSync(f, 'utf8').replace(/^export /gm, '');
const out = '// 自動生成ファイル（編集は scripts/ と scriptable/main.js で行い、node scriptable/build.mjs で作り直す）\n'
  + strip('scripts/parse.js') + '\n' + strip('scripts/model.js') + '\n' + readFileSync('scriptable/main.js', 'utf8');
writeFileSync('scriptable/bundle.js', out);
console.log('bundle.js', out.length, 'bytes');
