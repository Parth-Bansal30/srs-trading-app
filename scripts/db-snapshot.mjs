/**
 * A copy of tables before a database change: every row as JSON in backups/<date-time>/<table>.json (git-ignored, stays
 * on this computer). `node scripts/db-snapshot.mjs` = every public table; or name some: `… bank_lines payments`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { query, ROOT } from './lib/supabase.mjs';

const want = process.argv.slice(2);
const all = (await query(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`)).map((r) => r.table_name);
const tables = want.length ? want.filter((t) => all.includes(t)) : all;
const dir = path.join(ROOT, 'backups', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
fs.mkdirSync(dir, { recursive: true });
let rows = 0;
for (const t of tables) {
  const r = await query(`select coalesce(json_agg(x), '[]'::json) as rows from public.${t} x`);
  const list = r[0]?.rows || [];
  rows += list.length;
  fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(list));
}
fs.writeFileSync(path.join(dir, 'README.txt'), `Snapshot of ${tables.length} tables, ${rows} rows, taken ${new Date().toISOString()} before a database change.\n`);
console.log(`saved ${tables.length} tables (${rows} rows) in ${path.relative(ROOT, dir)}`);
