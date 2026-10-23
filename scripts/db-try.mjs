/**
 * Tries NEW migrations and their database tests WITHOUT applying anything: inside one transaction it runs
 * the migrations that are not applied yet, then the chosen test files (with their fixtures), then ROLLS BACK.
 * Use it while writing a migration; `npm run db:migrate` applies it for real once it is right.
 *
 *   node scripts/db-try.mjs 15        pending migrations + tests whose name contains "15"
 */
import fs from 'node:fs';
import path from 'node:path';
import { query, ROOT } from './lib/supabase.mjs';

const migDir = path.join(ROOT, 'supabase/migrations');
const testDir = path.join(ROOT, 'supabase/tests');
const filter = process.argv[2] || '';
const applied = new Set((await query('select version from supabase_migrations.schema_migrations')).map((r) => r.version));
const pending = fs.readdirSync(migDir).filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f) && !applied.has(f.slice(0, 14))).sort();
const tests = fs.readdirSync(testDir).filter((f) => f.endsWith('.sql') && !f.startsWith('00_') && f.includes(filter)).sort();
console.log(`pending: ${pending.join(', ') || 'none'}`);
let failed = 0;
for (const f of tests) {
  let sql = fs.readFileSync(path.join(testDir, f), 'utf8');
  const fx = sql.match(/^--\s*@fixtures([^\n]*)/m);
  if (fx) {
    const names = fx[1].trim().split(/\s+/).filter(Boolean);
    sql = (names.length ? names : ['fixtures']).map((n) => fs.readFileSync(path.join(testDir, `00_${n}.sql`), 'utf8')).join('\n') + '\n' + sql;
  }
  const mig = pending.map((m) => fs.readFileSync(path.join(migDir, m), 'utf8')).join('\n;\n');
  const t0 = Date.now();
  try {
    await query(`begin;\n${mig}\n;\n${sql}\n;rollback;`);
    console.log(`  ✓ ${f} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${f}\n    ${e.message.split('\n').slice(0, 4).join('\n    ')}`);
  }
}
process.exit(failed ? 1 : 0);
