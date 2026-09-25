/**
 * Proves the database can be rebuilt from nothing using ONLY the migration files
 * (no manual dashboard changes hiding anywhere). Inside ONE transaction it drops every
 * object our migrations created, replays all migrations from the first, runs the
 * structure safety-net test, and then ROLLS BACK — so the real database is untouched.
 *
 *   npm run db:replay-check
 */
import fs from 'node:fs';
import path from 'node:path';
import { query, ROOT } from './lib/supabase.mjs';

const migDir = path.join(ROOT, 'supabase/migrations');
const files = fs.readdirSync(migDir).filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)).sort();
const migrations = files.map((f) => `-- ===== ${f}\n${fs.readFileSync(path.join(migDir, f), 'utf8')}`).join('\n;\n');
const guards = fs.readFileSync(path.join(ROOT, 'supabase/tests/04_structure_guards.sql'), 'utf8');

// Everything our migrations own lives in schemas app/private or in these public tables.
const ours = await query(`select string_agg(format('%I.%I', schemaname, tablename), ', ') as t from pg_tables where schemaname = 'public'`);
const drop = `
  ${ours[0].t ? `drop table if exists ${ours[0].t} cascade;` : ''}
  drop schema if exists app cascade;
  drop schema if exists private cascade;
  do $$ begin assert (select count(*) from pg_tables where schemaname in ('public','private')) = 0, 'clean slate expected'; end $$;`;

const t0 = Date.now();
try {
  await query(`begin;\n${drop}\n${migrations}\n;\n${guards}\n;rollback;`);
  console.log(`✓ All ${files.length} migrations rebuilt the database from nothing and passed the structure checks (${Date.now() - t0} ms). Rolled back — nothing changed.`);
} catch (e) {
  console.error(`✗ Rebuild from migrations failed (rolled back, nothing changed):\n  ${e.message.split('\n').slice(0, 4).join('\n  ')}`);
  process.exit(1);
}
const after = await query(`select count(*)::int as tables from pg_tables where schemaname in ('public','private')`);
console.log(`Real database still has its ${after[0].tables} tables.`);
