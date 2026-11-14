// src/worker/schema.ts から migrations/0001_init.sql を生成する（wrangler d1 migrations を使う場合用）
import { writeFileSync } from 'node:fs';
import { build } from 'vite';
const out = await build({
  logLevel: 'silent',
  build: { write: false, lib: { entry: 'src/worker/schema.ts', formats: ['es'] }, rollupOptions: {} },
});
const code = (Array.isArray(out) ? out[0] : out).output[0].code;
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const sql =
  '-- 自動生成: npm run gen:migration （編集しない。定義元は src/worker/schema.ts）\n' +
  mod.SCHEMA_STATEMENTS.map((s) => s.replace(/\n {2}/g, '\n') + ';').join('\n\n') +
  `\n\nINSERT INTO schema_meta(key, value) VALUES('version', '${mod.SCHEMA_VERSION}') ON CONFLICT(key) DO UPDATE SET value = excluded.value;\n`;
writeFileSync('migrations/0001_init.sql', sql);
console.log('migrations/0001_init.sql generated');
