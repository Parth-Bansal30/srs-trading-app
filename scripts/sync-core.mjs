/**
 * Copies the business rules (packages/core/src) next to the Edge Functions, because a
 * deployed function can only include files from inside supabase/functions.
 * The copy is NOT kept in git (it is made fresh before every deploy), so it can never drift.
 *
 *   node scripts/sync-core.mjs          make the copy
 *   node scripts/sync-core.mjs --check  fail if the copy is missing or different
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(ROOT, 'packages/core/src');
const dst = path.join(ROOT, 'supabase/functions/_shared/core');
const files = fs.readdirSync(src).filter((f) => f.endsWith('.js')).sort();

if (process.argv.includes('--check')) {
  const bad = files.filter((f) => !fs.existsSync(path.join(dst, f)) || fs.readFileSync(path.join(dst, f), 'utf8') !== fs.readFileSync(path.join(src, f), 'utf8'));
  if (bad.length) { console.error(`✗ Edge Function copy of @srs/core is out of date: ${bad.join(', ')}. Run: node scripts/sync-core.mjs`); process.exit(1); }
  console.log(`✓ Edge Function copy of @srs/core matches (${files.length} files).`);
} else {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  console.log(`✓ Copied @srs/core (${files.length} files) into supabase/functions/_shared/core`);
}
