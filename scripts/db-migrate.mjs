/**
 * Applies database migrations (supabase/migrations/*.sql) in order, each in its own
 * transaction, and records them in Supabase's own migration history table — the same one
 * `supabase db push` uses, so GitHub Actions can take over later without conflicts.
 *
 * Rules: migrations are append-only. If an already-applied file is edited, this stops
 * and asks for a NEW migration instead.
 *
 *   node scripts/db-migrate.mjs            apply pending migrations
 *   node scripts/db-migrate.mjs --status   list applied / pending, change nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { query, lit, ROOT, PROJECT_REF } from './lib/supabase.mjs';

const dir = path.join(ROOT, 'supabase/migrations');
const statusOnly = process.argv.includes('--status');
const files = fs.readdirSync(dir).filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f)).sort();

await query(`create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);`);
const applied = new Map((await query('select version, name, statements from supabase_migrations.schema_migrations')).map((r) => [r.version, r]));

console.log(`Project ${PROJECT_REF}: ${files.length} migration file(s), ${applied.size} applied before this run`);
let changed = 0;
for (const f of files) {
  const version = f.slice(0, 14);
  const name = f.slice(15, -4);
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  const prev = applied.get(version);
  if (prev) {
    if ((prev.statements || []).join('') !== sql) {
      console.error(`✗ ${f} was edited after it was applied. Migrations are append-only — add a new migration instead.`);
      process.exit(1);
    }
    console.log(`  ✓ ${f} (already applied)`);
    continue;
  }
  if (statusOnly) { console.log(`  … ${f} (pending)`); continue; }
  if (/^\s*(begin|commit|rollback)\s*;/im.test(sql)) { console.error(`✗ ${f}: don't put begin/commit in a migration; each one is wrapped automatically.`); process.exit(1); }
  try {
    await query(`begin;\n${sql}\n;insert into supabase_migrations.schema_migrations (version, name, statements) values (${lit(version)}, ${lit(name)}, array[${lit(sql)}]);\ncommit;`);
    console.log(`  + ${f} applied`);
    changed++;
  } catch (e) {
    console.error(`✗ ${f} failed and was rolled back — nothing from it was kept.\n  ${e.message}`);
    process.exit(1);
  }
}
console.log(statusOnly ? 'Status only — nothing changed.' : changed ? `Done: ${changed} migration(s) applied.` : 'Up to date.');
