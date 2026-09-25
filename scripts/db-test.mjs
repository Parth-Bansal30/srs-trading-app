/**
 * Runs the database tests (supabase/tests/*.sql) against the dev project. Each file runs
 * inside a transaction that is ALWAYS rolled back, so tests never leave data behind.
 * A test fails by raising an error (ASSERT / RAISE EXCEPTION).
 *
 *   node scripts/db-test.mjs            run all
 *   node scripts/db-test.mjs 01         run files whose name contains "01"
 */
import fs from 'node:fs';
import path from 'node:path';
import { query, ROOT } from './lib/supabase.mjs';

const dir = path.join(ROOT, 'supabase/tests');
const filter = process.argv[2] || '';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !f.startsWith('00_') && f.includes(filter)).sort();
let failed = 0;
for (const f of files) {
  if (f.startsWith('00_')) continue; // shared fixtures, not a test on their own
  let sql = fs.readFileSync(path.join(dir, f), 'utf8');
  // "-- @fixtures" loads 00_fixtures.sql; "-- @fixtures fixtures business" loads 00_fixtures.sql then 00_business.sql.
  const fx = sql.match(/^--\s*@fixtures([^\n]*)/m);
  if (fx) {
    const names = fx[1].trim().split(/\s+/).filter(Boolean);
    sql = (names.length ? names : ['fixtures']).map((n) => fs.readFileSync(path.join(dir, `00_${n}.sql`), 'utf8')).join('\n') + '\n' + sql;
  }
  if (/^\s*commit\s*;/im.test(sql)) { console.error(`✗ ${f}: tests must not commit`); failed++; continue; }
  const t0 = Date.now();
  try {
    await query(`begin;\n${sql}\n;rollback;`);
    console.log(`  ✓ ${f} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${f}\n    ${e.message.split('\n').slice(0, 3).join('\n    ')}`);
  }
}
const left = await query(`select (select count(*) from public.companies where name <> 'E2E Test Company') as companies`).catch(() => [{ companies: 'n/a' }]);
console.log(`${files.length - failed}/${files.length} test files passed. Test companies left behind: ${left[0].companies} (tests always roll back; the separate E2E login-test company is kept on purpose).`);
process.exit(failed ? 1 : 0);
