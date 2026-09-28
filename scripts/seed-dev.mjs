/**
 * Fills the DEV project with a practice copy of SRS Trading, taken from the approved
 * prototype's own starting data: the same 5 people (Papa, Parth, Ramesh, Suresh, Anil),
 * the same grades with rates and trilingual info, and the same customers and special rates.
 * Used for Milestone 5 (real screens on the real database). Safe to run again: it only adds
 * what is missing. DEV ONLY — it refuses to run on any other project.
 *
 * Logins (dev test numbers, no real SMS, code 123456):
 *   Papa +91 90000 00001 · Parth …002 · Ramesh …003 · Suresh …004 · Anil …005
 *
 *   npm run seed:dev
 */
import fs from 'node:fs';
import path from 'node:path';
import { query, lit, PROJECT_REF, ROOT } from './lib/supabase.mjs';
import { loadPrototype } from '../packages/core/test/helpers/prototype.js';
import { GRADES } from './data/steel-grades.mjs';

const DEV_REF = 'xwyhgsukvspwinsskyjo';
if (PROJECT_REF !== DEV_REF) { console.error('✗ seed:dev only runs on the development project.'); process.exit(1); }

const BASE = `https://${PROJECT_REF}.supabase.co`;
const token = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/SUPABASE_ACCESS_TOKEN=(\S+)/)[1];
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } })).json();
const SECRET_KEY = keys.find((k) => k.name === 'service_role').api_key;

const proto = loadPrototype().dbData();
const NAME = 'SRS Trading (Dev)';
const phones = { u1: '+919000000001', u2: '+919000000002', u3: '+919000000003', u4: '+919000000004', u5: '+919000000005' };

let [co] = await query(`select id from public.companies where name = ${lit(NAME)}`);
if (!co) {
  [co] = await query(`with c as (insert into public.companies (name) values (${lit(NAME)}) returning id)
    , s as (insert into public.company_settings (company_id) select id from c) select id from c`);
  console.log(`+ company "${NAME}"`);
}
const C = lit(co.id);

let added = 0;
for (const u of proto.users) {
  const phone = phones[u.id];
  let [{ uid }] = await query(`select public.admin_auth_user_by_phone(${lit(phone)}) as uid`);
  if (!uid) {
    const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, phone_confirm: true }) });
    uid = (await r.json()).id;
  }
  const [r] = await query(`insert into public.people (company_id, auth_user_id, display_name, phone, role, perms)
      select ${C}, ${lit(uid)}, ${lit(u.name)}, ${lit(phone)}, ${lit(u.role)}, app.role_preset(${lit(u.role)})
      where not exists (select 1 from public.people where company_id = ${C} and phone = ${lit(phone)}) returning id`);
  if (r) { added++; console.log(`+ ${u.name} (${u.role}) ${phone}`); }
}

for (const m of proto.mats) {
  const [r] = await query(`with m as (insert into public.materials (company_id, code, family, density_override, active, info)
      select ${C}, ${lit(m.id)}, ${lit(m.family)}, ${m.density ?? 'null'}, ${m.active !== false}, ${lit(JSON.stringify(GRADES.find((g) => g.code === m.id)?.info ?? m.info ?? null))}::jsonb
      where not exists (select 1 from public.materials where company_id = ${C} and code = ${lit(m.id)}) returning id)
    insert into public.material_rates (company_id, material_id, sell_rate, cut_rate, note)
      select ${C}, id, ${Number(m.sell)}, ${Number(m.cut)}, 'starting rate from the prototype' from m returning material_id`);
  if (r) { added++; console.log(`+ grade ${m.id} ₹${m.sell}/kg, cutting ₹${m.cut}`); }
}

for (const c of proto.cust) {
  const [r] = await query(`insert into public.customers (company_id, name, phone)
      select ${C}, ${lit(c.name)}, ${c.phone ? lit(c.phone) : 'null'}
      where not exists (select 1 from public.customers where company_id = ${C} and name = ${lit(c.name)}) returning id`);
  if (r) {
    added++; console.log(`+ customer ${c.name}`);
    for (const [code, rate] of Object.entries(c.special || {})) {
      await query(`insert into public.customer_rates (company_id, customer_id, material_id, rate)
        select ${C}, ${lit(r.id)}, id, ${Number(rate)} from public.materials where company_id = ${C} and code = ${lit(code)}`);
      console.log(`  + special rate ${code} ₹${rate}/kg`);
    }
  }
}
console.log(added ? `Done: ${added} things added to "${NAME}".` : `"${NAME}" already has everything — nothing changed.`);
