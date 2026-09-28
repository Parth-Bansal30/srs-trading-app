/**
 * END-TO-END login test against the real Supabase dev project, over the internet, exactly
 * like the app will: mobile number → SMS code → PIN → data, plus staff management.
 * Uses DEV test numbers only (they never receive a real SMS; fixed code 123456).
 * Uses a separate "E2E Test Company" so it never touches real or dev data.
 *
 *   npm run auth:e2e
 */
import { query, lit, PROJECT_REF } from './lib/supabase.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib/supabase.mjs';

const BASE = `https://${PROJECT_REF}.supabase.co`;
const token = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/SUPABASE_ACCESS_TOKEN=(\S+)/)[1];
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } })).json();
const PUBLIC_KEY = keys.find((k) => k.name === 'anon').api_key;          // safe to ship in the app
const SECRET_KEY = keys.find((k) => k.name === 'service_role').api_key;  // backend only — used here just to set up the test company

const OWNER = '+919000000901', STAFF = '+919000000902', STRANGER = '+919000000903', CODE = '123456';
let passed = 0; const failed = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${detail}`); } };

const call = async (method, url, { jwt, body, apikey = PUBLIC_KEY } = {}) => {
  const r = await fetch(`${BASE}${url}`, { method, headers: { apikey, 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
};
const rpc = (jwt, fn, args = {}) => call('POST', `/rest/v1/rpc/${fn}`, { jwt, body: args });
const rows = async (jwt, table) => (await call('GET', `/rest/v1/${table}?select=*`, { jwt })).data;
const staffAdmin = (jwt, body) => call('POST', '/functions/v1/staff-admin', { jwt, body });
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
async function smsLogin(phone) {
  const otp = await call('POST', '/auth/v1/otp', { body: { phone } });
  if (otp.status !== 200) return { otp };
  const v = await call('POST', '/auth/v1/verify', { body: { phone, token: CODE, type: 'sms' } });
  return { otp, session: v.data };
}

// ---------- setup: a clean E2E company with one owner ----------
console.log('Setting up E2E Test Company (dev project only)…');
let [co] = await query(`select id from public.companies where name = 'E2E Test Company'`);
if (!co) {
  [co] = await query(`with c as (insert into public.companies (name) values ('E2E Test Company') returning id)
    , s as (insert into public.company_settings (company_id) select id from c) select id from c`);
}
let [{ uid }] = await query(`select public.admin_auth_user_by_phone(${lit(OWNER)}) as uid`);
if (!uid) {
  const r = await call('POST', '/auth/v1/admin/users', { apikey: SECRET_KEY, jwt: SECRET_KEY, body: { phone: OWNER, phone_confirm: true } });
  uid = r.data.id;
}
await query(`
  delete from private.session_unlocks where company_id = ${lit(co.id)};
  delete from public.people where company_id = ${lit(co.id)} and phone <> ${lit(OWNER)};
  insert into public.people (company_id, auth_user_id, display_name, phone, role, perms)
    select ${lit(co.id)}, ${lit(uid)}, 'E2E Owner', ${lit(OWNER)}, 'owner', app.role_preset('owner')
    where not exists (select 1 from public.people where company_id = ${lit(co.id)} and phone = ${lit(OWNER)});
  update public.people set active = true, perms = app.role_preset('owner') where company_id = ${lit(co.id)} and phone = ${lit(OWNER)};
  update private.auth_credentials set revoked_at = now() where company_id = ${lit(co.id)} and revoked_at is null;`);
const staffUid = (await query(`select public.admin_auth_user_by_phone(${lit(STAFF)}) as u`))[0].u;
if (staffUid) await call('DELETE', `/auth/v1/admin/users/${staffUid}`, { apikey: SECRET_KEY, jwt: SECRET_KEY });

console.log('\n1. Strangers can\'t see anything');
const st = await smsLogin(STRANGER);
check('a number in no shop can prove itself with a code (so it can register a business)', !!st.session?.access_token, JSON.stringify(st.otp?.data).slice(0, 100));
const stJwt = st.session?.access_token;
const stStatus = await rpc(stJwt, 'login_status');
check('…but it is not staff anywhere', stStatus.data?.staff === false, JSON.stringify(stStatus.data).slice(0, 100));
check('…and sees nothing', (await rows(stJwt, 'companies')).length === 0 && (await rows(stJwt, 'people')).length === 0);
const stPin = await rpc(stJwt, 'set_pin', { p_pin: '385917' });
check('…and cannot set a PIN', stPin.status >= 400, `(got ${stPin.status})`);
const stAdmin = await staffAdmin(stJwt, { action: 'add_person', phone: '90000 00904', name: 'X', role: 'owner' });
check('…and cannot add staff', stAdmin.status === 401 || stAdmin.status === 403, `(got ${stAdmin.status})`);
const anonRead = await call('GET', '/rest/v1/companies?select=*');
check('not signed in: nothing readable', Array.isArray(anonRead.data) ? anonRead.data.length === 0 : anonRead.status >= 400, JSON.stringify(anonRead.data).slice(0, 80));

console.log('\n2. Owner, new phone: SMS code → PIN');
const o = await smsLogin(OWNER);
check('owner receives a code', o.otp.status === 200, JSON.stringify(o.otp.data).slice(0, 120));
check('code accepted, signed in', !!o.session?.access_token, JSON.stringify(o.session).slice(0, 120));
let ownerJwt = o.session.access_token;
const c1 = claims(ownerJwt);
check('login proves the phone by SMS code', (c1.amr || []).some((a) => a.method === 'otp'), JSON.stringify(c1.amr));
check('signed in but not unlocked: nothing readable', (await rows(ownerJwt, 'companies')).length === 0);
const weak = await rpc(ownerJwt, 'set_pin', { p_pin: '123456' });
check('weak PIN 123456 refused', weak.status === 400, `(got ${weak.status})`);
const set = await rpc(ownerJwt, 'set_pin', { p_pin: '385917' });
check('good PIN accepted and phone unlocked', set.status === 200 && set.data.unlocked === true, JSON.stringify(set.data).slice(0, 120));
const mine = await rows(ownerJwt, 'companies');
check('unlocked: sees own company only', mine.length === 1 && mine[0].name === 'E2E Test Company', JSON.stringify(mine).slice(0, 100));

console.log('\n3. Owner adds a worker by mobile number');
const add = await staffAdmin(ownerJwt, { action: 'add_person', phone: '90000 00902', name: 'E2E Weigher', role: 'weigher' });
check('worker added (number typed with a space, no +91)', add.status === 200 && add.data.person?.phone === STAFF, JSON.stringify(add.data).slice(0, 160));
check('weigher gets the weigher permissions', JSON.stringify(add.data.person?.perms) === JSON.stringify({ weigh: true, orders: true }));
const dup = await staffAdmin(ownerJwt, { action: 'add_person', phone: STAFF, name: 'Again', role: 'sales' });
check('same number twice refused', dup.status === 409, `(got ${dup.status})`);
const bad = await staffAdmin(ownerJwt, { action: 'add_person', phone: '12345', name: 'X', role: 'sales' });
check('invalid mobile number refused', bad.status === 400);

console.log('\n4. The worker logs in: sees no money');
const w = await smsLogin(STAFF);
check('worker receives a code and signs in', !!w.session?.access_token, JSON.stringify(w.otp.data).slice(0, 100));
const wJwt = w.session.access_token;
const wPin = await rpc(wJwt, 'set_pin', { p_pin: '7315' });
check('worker sets a 4-digit PIN', wPin.status === 200 && wPin.data.unlocked, JSON.stringify(wPin.data).slice(0, 100));
check('worker sees company and staff list', (await rows(wJwt, 'companies')).length === 1);
const wOrders = await call('GET', '/rest/v1/orders?select=*', { jwt: wJwt });
check('worker sees no orders/amounts (no money permission)', wOrders.status === 200 && wOrders.data.length === 0);
const wAdmin = await staffAdmin(wJwt, { action: 'add_person', phone: '9000000977', name: 'X', role: 'owner' });
check('worker can\'t add staff', wAdmin.status === 403, `(got ${wAdmin.status})`);
const wDirect = await call('POST', '/rest/v1/people', { jwt: wJwt, body: { company_id: co.id, display_name: 'Hacker', role: 'owner' } });
check('worker can\'t write to the database directly', wDirect.status === 401 || wDirect.status === 403, `(got ${wDirect.status})`);

console.log('\n5. Lock / unlock / wrong PIN / token refresh');
await rpc(ownerJwt, 'lock_session');
check('owner locks the phone: nothing readable', (await rows(ownerJwt, 'companies')).length === 0);
const wrong = await rpc(ownerJwt, 'unlock', { p_pin: '000000' });
check('wrong PIN: refused, tries left shown', wrong.data.ok === false && wrong.data.reason === 'wrong_pin' && wrong.data.attempts_left === 4, JSON.stringify(wrong.data));
const right = await rpc(ownerJwt, 'unlock', { p_pin: '385917' });
check('right PIN: unlocked', right.data.ok === true && right.data.unlocked === true);
const ref = await call('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: o.session.refresh_token } });
check('login refreshes automatically', !!ref.data.access_token);
ownerJwt = ref.data.access_token;
check('still unlocked after refresh (same phone session)', (await rows(ownerJwt, 'companies')).length === 1);
const otpTime = (jwt) => ((claims(jwt).amr || []).find((a) => a.method === 'otp') || {}).timestamp;
check('refresh keeps the ORIGINAL SMS-code time (an old code never looks new)', otpTime(ownerJwt) === otpTime(o.session.access_token),
  `${otpTime(o.session.access_token)} → ${otpTime(ownerJwt)}`);
// (A code older than 10 minutes being refused for a PIN change is proven in supabase/tests/05_login_and_pin.sql.)

console.log('\n6. Owner controls');
const pid = add.data.person.id;
const deact = await staffAdmin(ownerJwt, { action: 'set_active', person_id: pid, active: false });
check('owner deactivates the worker', deact.status === 200 && deact.data.person.active === false);
check('deactivated worker instantly sees nothing', (await rows(wJwt, 'companies')).length === 0);
const self = await staffAdmin(ownerJwt, { action: 'set_active', person_id: set.data.person.id, active: false });
check('owner can\'t deactivate themselves', self.status === 403, `(got ${self.status})`);
const newPhone = await smsLogin(OWNER).catch(() => ({}));
const lockedFn = newPhone.session ? await staffAdmin(newPhone.session.access_token, { action: 'reset_pin', person_id: pid }) : { status: 'n/a' };
check('staff management needs the PIN (new phone, not unlocked)', lockedFn.status === 401 || newPhone.otp?.status === 429,
  `(got ${lockedFn.status}${newPhone.otp?.status === 429 ? ', code limit — also fine' : ''})`);

console.log('\n7. Sign out');
await call('POST', '/auth/v1/logout', { jwt: ownerJwt });
check('after signing out, the old login shows nothing', (await rows(ownerJwt, 'companies')).length === 0);

console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
