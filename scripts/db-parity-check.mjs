/**
 * Slip numbers are handed out by the database (so two phones never get the same one),
 * but their format is defined in @srs/core. This checks both give the SAME answer for
 * 2,000 moments — shop midnights, month ends, 31 March / 1 April (financial year) — in
 * India and in other time zones (for when other businesses use the platform).
 *
 *   npm run db:parity-check
 */
import { query, lit } from './lib/supabase.mjs';
import { formatSlipNo, slipKeyFor } from '../packages/core/src/index.js';

const zones = ['Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dubai', 'Europe/London', 'America/New_York', 'Australia/Sydney'];
const schemes = ['never', 'daily', 'monthly', 'yearly'];
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const cases = [];
const add = (iso) => { const tz = zones[cases.length % zones.length]; const scheme = schemes[Math.floor(rnd() * 4)]; cases.push({ iso, tz, scheme, n: 1 + Math.floor(rnd() * 500) }); };
// tricky moments: around midnight of month ends and the financial year change, every year 2025–2029
for (let y = 2025; y <= 2029; y++) for (let m = 0; m < 12; m++) for (const mins of [-1, 0, 1]) {
  for (let z = 0; z < 2; z++) add(new Date(Date.UTC(y, m + 1, 1, -5, -30 + mins)).toISOString()); // near Indian midnight
}
while (cases.length < 2000) add(new Date(Date.UTC(2025, 0, 1) + rnd() * 5 * 365 * 86400000).toISOString());

const values = cases.map((c, i) => `(${i}, ${lit(c.iso)}::timestamptz, ${lit(c.tz)}, ${lit(c.scheme)}, ${c.n})`).join(',\n');
const rows = await query(`select i, app.slip_label(s, at, tz, n) as label, app.slip_counter_key(s, at, tz) as key
  from (values ${values}) v(i, at, tz, s, n) order by i`);
let bad = 0;
for (const r of rows) {
  const c = cases[r.i];
  const label = formatSlipNo(c.scheme, c.iso, c.n, c.tz);
  const key = c.scheme === 'never' ? 'internal' : `${c.scheme}:${slipKeyFor(c.scheme, c.iso, c.tz)}`;
  if (c.scheme === 'never' ? r.label !== String(c.n) : r.label !== label || r.key !== key) {
    if (bad++ < 5) console.error(`  ✗ ${c.scheme} ${c.iso} ${c.tz}: database ${r.label} / ${r.key}, core ${label} / ${key}`);
  }
}
if (bad) { console.error(`✗ ${bad} of ${rows.length} slip numbers differ between the database and @srs/core.`); process.exit(1); }
console.log(`✓ Database and @srs/core give identical slip numbers for all ${rows.length} moments (${zones.length} time zones, all 4 schemes).`);
