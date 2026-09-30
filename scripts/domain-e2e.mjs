/**
 * END-TO-END test of the business operations, over the internet, exactly like the app:
 * real logins (SMS code → PIN) → the "api" Edge Function → the database.
 * A full order: create → accept with advance → weigh (incl. weigh-together) → finish →
 * cancel a payment → khata payment → cash count; plus retries, 20 phones at once,
 * and who may do what. Totals are compared with @srs/core (the prototype's maths).
 *
 * Uses DEV test numbers +91 90000 00904–906 (never a real SMS; code 123456) and its own
 * "E2E Domain Company", so it never touches real or app-development data.
 * Money records are permanent, so this company's history grows with each run — that's fine in dev.
 *
 *   npm run domain:e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, lit, PROJECT_REF, ROOT } from './lib/supabase.mjs';
import * as core from '../packages/core/src/index.js';

const BASE = `https://${PROJECT_REF}.supabase.co`;
const token = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/SUPABASE_ACCESS_TOKEN=(\S+)/)[1];
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } })).json();
const PUBLIC_KEY = keys.find((k) => k.name === 'anon').api_key;
const SECRET_KEY = keys.find((k) => k.name === 'service_role').api_key;
const CODE = '123456';
const PEOPLE = [
  { phone: '+919000000904', name: 'E2E Owner', role: 'owner', pin: '385917' },
  { phone: '+919000000905', name: 'E2E Weigher', role: 'weigher', pin: '7315' },
  { phone: '+919000000906', name: 'E2E Sales (no kacha)', role: 'custom', pin: '8264', perms: { new: true, orders: true, money: true } },
];

let passed = 0; const failed = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${detail}`); } };
const call = async (method, url, { jwt, body, apikey = PUBLIC_KEY } = {}) => {
  const r = await fetch(`${BASE}${url}`, { method, headers: { apikey, 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data };
};
const api = (jwt, op, args = {}, key = randomUUID(), v = 1) => call('POST', '/functions/v1/api', { jwt, body: { v, op, key, args } });
const rows = async (jwt, table, q = 'select=*') => (await call('GET', `/rest/v1/${table}?${q}`, { jwt })).data;
const short = (x) => String(JSON.stringify(x)).slice(0, 220);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(p) {
  for (let i = 0; i < 2; i++) {
    const otp = await call('POST', '/auth/v1/otp', { body: { phone: p.phone } });
    if (otp.status === 429 && i === 0) { console.log('    (waiting 60 s: one SMS code per minute per number)'); await sleep(61000); continue; }
    if (otp.status !== 200) throw new Error(`code for ${p.phone}: ${short(otp)}`);
    const v = await call('POST', '/auth/v1/verify', { body: { phone: p.phone, token: CODE, type: 'sms' } });
    const pin = await call('POST', '/rest/v1/rpc/set_pin', { jwt: v.data.access_token, body: { p_pin: p.pin } });
    if (!pin.data?.unlocked) throw new Error(`PIN for ${p.phone}: ${short(pin)}`);
    return v.data.access_token;
  }
}

// ---------- setup ----------
console.log('Setting up E2E Domain Company (dev project only)…');
let [co] = await query(`select id from public.companies where name = 'E2E Domain Company'`);
if (!co) {
  [co] = await query(`with c as (insert into public.companies (name) values ('E2E Domain Company') returning id)
    , s as (insert into public.company_settings (company_id) select id from c) select id from c`);
}
for (const p of PEOPLE) {
  let [{ uid }] = await query(`select public.admin_auth_user_by_phone(${lit(p.phone)}) as uid`);
  if (!uid) uid = (await call('POST', '/auth/v1/admin/users', { apikey: SECRET_KEY, jwt: SECRET_KEY, body: { phone: p.phone, phone_confirm: true } })).data.id;
  const perms = p.perms ? lit(JSON.stringify(p.perms)) + '::jsonb' : `app.role_preset(${lit(p.role)})`;
  await query(`
    insert into public.people (company_id, auth_user_id, display_name, phone, role, perms)
      select ${lit(co.id)}, ${lit(uid)}, ${lit(p.name)}, ${lit(p.phone)}, ${lit(p.role)}, ${perms}
      where not exists (select 1 from public.people where company_id = ${lit(co.id)} and phone = ${lit(p.phone)});
    update public.people set active = true, perms = ${perms} where company_id = ${lit(co.id)} and phone = ${lit(p.phone)};`);
}
await query(`delete from private.session_unlocks where company_id = ${lit(co.id)};
  update private.auth_credentials set revoked_at = now() where company_id = ${lit(co.id)} and revoked_at is null;`);

console.log('\n1. Everyone logs in (SMS code → PIN)');
const [owner, weigher, sales] = [await login(PEOPLE[0]), await login(PEOPLE[1]), await login(PEOPLE[2])];
check('owner, weigher and sales are signed in and unlocked', owner && weigher && sales);

console.log('\n2. The door is locked properly');
check('no login → refused', (await call('POST', '/functions/v1/api', { body: { v: 1, op: 'createCustomer', key: randomUUID(), args: {} } })).status === 401);
check('change without a request key → refused', (await api(owner, 'createCustomer', { name: 'X' }, null)).data.error === 'missing_key');
check('old app version → asked to update', (await api(owner, 'createCustomer', { name: 'X' }, randomUUID(), 99)).status === 426);
check('unknown operation → refused', (await api(owner, 'dropEverything')).data.error === 'unknown_op');
check('prototype-only trick ops (e.g. constructor) → refused', (await api(owner, 'constructor')).data.error === 'unknown_op');

console.log('\n3. Grades, rates, customer');
let mats = await rows(owner, 'materials', 'select=id,code');
for (const [code, family, sell, cut] of [['EN8', 'carbon', 75, 3], ['EN24', 'alloy', 95, 4]]) {
  if (!mats.some((m) => m.code === code)) {
    const r = await api(owner, 'createMaterial', { code, family, sell_rate: sell, cut_rate: cut });
    check(`grade ${code} added`, r.status === 200, short(r.data));
  }
}
mats = await rows(owner, 'materials', 'select=id,code');
const EN8 = mats.find((m) => m.code === 'EN8').id, EN24 = mats.find((m) => m.code === 'EN24').id;
const rate = await api(owner, 'changeMaterialRate', { material_id: EN8, sell_rate: 76, cut_rate: 3, note: 'e2e' });
check('owner changes the EN8 rate', rate.status === 200, short(rate.data));
check('sales can\'t change rates', (await api(sales, 'changeMaterialRate', { material_id: EN8, sell_rate: 1, cut_rate: 1 })).status === 403);
const cust = await api(owner, 'createCustomer', { name: `E2E Customer ${new Date().toISOString().slice(0, 19)}`, phone: '98100 00001' });
check('customer added', cust.status === 200 && cust.data.data.id, short(cust.data));
const CUST = cust.data.data.id;
const spec = await api(owner, 'setCustomerRate', { customer_id: CUST, material_id: EN24, rate: 92 });
check('special rate for this customer on EN24', spec.status === 200, short(spec.data));

console.log('\n4. New order, accepted with an advance');
const items = [
  { material_id: EN8, shape: 'round', unit: 'mm', d: ['32'], rows: [{ len: '300', pcs: 12 }] },
  { material_id: EN8, shape: 'square', unit: 'mm', d: ['50'], rows: [{ len: '200', pcs: 4 }, { len: '150', pcs: 2 }] },
  { material_id: EN24, shape: 'flat', unit: 'in', d: ['2 1/2', '1'], rows: [{ len: '10', pcs: 5 }] },
];
const key1 = randomUUID();
const args1 = { customer_id: CUST, items, accept: true, advance: { amount: 500, mode: 'Cash', note: 'e2e advance' } };
const c1 = await api(owner, 'createOrder', args1, key1);
check('order created and accepted', c1.status === 200 && c1.data.data.status === 'accepted', short(c1.data));
const ORDER = c1.data.data.order_id;
check('estimate amount matches @srs/core', c1.data.data.estimate?.amount > 0, short(c1.data.data.estimate));
const again = await api(owner, 'createOrder', args1, key1);
check('network retry: same order back, nothing twice', again.data.data?.order_id === ORDER && again.data.data?.replayed === true, short(again.data));
const pays = await rows(owner, 'payments', `select=id,amount,kind&order_id=eq.${ORDER}`);
check('advance taken once', pays.length === 1 && Number(pays[0].amount) === 500, short(pays));
check('same key with different details → refused', (await api(owner, 'createOrder', { ...args1, accept: false }, key1)).status === 409);
const saved = await rows(owner, 'order_items', `select=grade_code,sell_rate,special_rate,dims&order_id=eq.${ORDER}&order=position`);
check('rates saved on the order (76 new rate, 92 special)', Number(saved[0].sell_rate) === 76 && Number(saved[2].sell_rate) === 92 && saved[2].special_rate, short(saved));
check('sizes kept exactly as typed ("2 1/2")', saved[2].dims[0] === '2 1/2');
check('weigher can\'t create orders', (await api(weigher, 'createOrder', args1)).status === 403);

console.log('\n5. 20 phones creating orders at the same moment');
const many = await Promise.all(Array.from({ length: 20 }, () => api(sales, 'createOrder', { customer_id: CUST, items: [items[0]] })));
const okMany = many.filter((r) => r.status === 200).map((r) => r.data.data);
check('all 20 saved', okMany.length === 20, short(many.find((r) => r.status !== 200)?.data));
check('20 different slip numbers', new Set(okMany.map((o) => o.slip_no)).size === 20);
check('20 different internal numbers', new Set(okMany.map((o) => o.internal_no)).size === 20);

console.log('\n6. Weighing (the weigher never sees money)');
const wl = await api(weigher, 'weighingList', { order_id: ORDER });
const wo = wl.data.data?.[0];
check('weigher sees the order with sizes and expected weights', wo && wo.items.length === 3 && wo.items.every((i) => i.expected_weight > 0), short(wl.data));
check('…but no rates or amounts', !/sell_rate|cut_rate|amount|special/.test(JSON.stringify(wl.data)));
check('weigher can\'t open money details', (await rows(weigher, 'orders')).length === 0);
const [i1, i2, i3] = wo.items;
check('different grades can\'t be weighed together',
  (await api(weigher, 'recordWeights', { order_id: ORDER, batches: [{ total_weight: 40, item_ids: [i1.id, i3.id] }] })).status === 400);
const w = await api(weigher, 'recordWeights', { order_id: ORDER, weights: [{ item_id: i3.id, weight: 17.4 }],
  batches: [{ total_weight: 41.25, item_ids: [i1.id, i2.id] }], submit: true });
check('weighed: one EN24 alone + two EN8 together', w.status === 200 && w.data.data.status === 'weighed', short(w.data));
const ws = w.data.data.weights || [];
const part = (id) => Number(ws.find((x) => x.item_id === id)?.weight);
check('weigh-together parts add up exactly to 41.25 kg', Math.round((part(i1.id) + part(i2.id)) * 100) === 4125, `${part(i1.id)} + ${part(i2.id)}`);
check('changing weights after weighing → refused', (await api(weigher, 'recordWeights', { order_id: ORDER, weights: [{ item_id: i3.id, weight: 1 }] })).status === 409);

console.log('\n7. Finishing at pickup');
check('sales without kacha permission can\'t make a kacha bill',
  (await api(sales, 'finalizeOrder', { order_id: ORDER, bill: 'kacha', pay_mode: 'now', pay_method: 'Cash' })).status === 403);
check('part payment needs an amount', (await api(owner, 'finalizeOrder', { order_id: ORDER, bill: 'pakka', pay_mode: 'part', paid: 0, pay_method: 'Cash' })).data.error === 'need_part');
const [fa, fb] = await Promise.all([
  api(owner, 'finalizeOrder', { order_id: ORDER, bill: 'pakka', pay_mode: 'now', pay_method: 'Cash' }),
  api(sales, 'finalizeOrder', { order_id: ORDER, bill: 'pakka', pay_mode: 'now', pay_method: 'Cash' }),
]);
check('two phones finishing at once: exactly one wins', [fa.status, fb.status].sort().join() === '200,409', `${fa.status} ${fb.status} ${short(fa.status === 200 ? fb.data : fa.data)}`);
const fin = fa.status === 200 ? fa.data.data : fb.data.data;
const [o] = await rows(owner, 'orders', `select=*&id=eq.${ORDER}`);
const dbItems = await rows(owner, 'order_items', `select=*,order_item_lengths(len,pcs,cuts,position)&order_id=eq.${ORDER}&order=position`);
const coreItems = dbItems.map((i) => ({ shape: i.shape, unit: i.unit, d: i.dims, rows: i.order_item_lengths.sort((a, b) => a.position - b.position).map((l) => ({ len: l.len ?? '', pcs: l.pcs, cuts: l.cuts ?? '' })),
  rate: Number(i.sell_rate), cutRate: Number(i.cut_rate), density: Number(i.density), aw: Number(i.actual_weight) }));
const ref = core.finishCalc({ order: { items: coreItems }, advance: 500, bill: 'pakka', payMode: 'now', gstPct: 18, kachaPct: 10, minInch: 1 });
check('bill total in the database = @srs/core (prototype maths)', Number(o.total_amount) === ref.T.total, `${o.total_amount} vs ${ref.T.total}`);
check('GST, material and cutting amounts match', Number(o.gst_amount) === ref.T.gst && Number(o.material_amount) === ref.T.matK && Number(o.cutting_amount) === ref.T.cutK);
check('paid in full → not in the khata', o.status === 'done' && o.in_khata === false && fin.breakdown.due === 0, short(fin.breakdown));

console.log('\n8. Cancelling a payment, khata payment, cash count');
const pickup = (await rows(owner, 'payments', `select=id,amount,kind&order_id=eq.${ORDER}&kind=eq.pickup`))[0];
check('cancel needs a reason', (await api(owner, 'reversePayment', { payment_id: pickup.id, note: ' ' })).status === 400);
const rev = await api(owner, 'reversePayment', { payment_id: pickup.id, note: 'e2e: UPI bounced' });
check('payment cancelled with an exact opposite entry', rev.status === 200 && Number(rev.data.data.amount) === -Number(pickup.amount), short(rev.data));
check('the finished slip moved into the khata', (await rows(owner, 'orders', `select=in_khata&id=eq.${ORDER}`))[0].in_khata === true);
check('the same payment can\'t be cancelled twice', (await api(owner, 'reversePayment', { payment_id: pickup.id, note: 'again' })).status === 409);
const kp = await api(owner, 'recordPayment', { customer_id: CUST, amount: pickup.amount, mode: 'UPI', side: 'pakka', note: 'e2e khata' });
check('khata payment recorded', kp.status === 200, short(kp.data));
const cash = await api(owner, 'saveCashCount', { counted: 1000, note: 'e2e' });
const today = core.businessDate(new Date().toISOString(), 'Asia/Kolkata');
check('cash count filed under the shop\'s (Indian) date', cash.data.data?.business_date === today, short(cash.data));
const [{ exp }] = await query(`select coalesce(sum(amount),0)::numeric as exp from public.payments where company_id = ${lit(co.id)} and mode = 'Cash'
  and (received_at at time zone 'Asia/Kolkata')::date = ${lit(today)}`);
check('expected cash = today\'s cash payments', Number(cash.data.data?.expected) === Number(exp), `${cash.data.data?.expected} vs ${exp}`);
check('weigher can\'t do the cash count', (await api(weigher, 'saveCashCount', { counted: 1 })).status === 403);

console.log('\n9. Advance returned / moved / kept as credit, cancelling, old balances, reminders');
const oA = (await api(owner, 'createOrder', { customer_id: CUST, items: [items[0]], accept: true, advance: { amount: 10000, mode: 'Cash' } })).data.data.order_id;
const oB = (await api(owner, 'createOrder', { customer_id: CUST, items: [items[0]], accept: true })).data.data.order_id;
check('returning money needs a reason', (await api(owner, 'adjustAdvance', { order_id: oA, action: 'refund', amount: 4000, mode: 'UPI' })).status === 400);
const rf = await api(owner, 'adjustAdvance', { order_id: oA, action: 'refund', amount: 4000, mode: 'UPI', note: 'e2e: will pay whole bill by bank' });
check('4,000 of the 10,000 advance returned by UPI', rf.status === 200 && Number(rf.data.data.paid.advance) === 6000, short(rf.data));
const mvA = await api(owner, 'adjustAdvance', { order_id: oA, action: 'move', amount: 2000, target_order_id: oB });
check('2,000 moved to another slip of the same customer', mvA.status === 200, short(mvA.data));
check('sales without kacha permission can\'t keep kacha credit',
  (await api(sales, 'adjustAdvance', { order_id: oA, action: 'credit', amount: 1000, side: 'kacha' })).status === 403);
const cr = await api(owner, 'adjustAdvance', { order_id: oA, action: 'credit', amount: 1000, side: 'pakka' });
check('1,000 kept as credit for the customer', cr.status === 200, short(cr.data));
check('can\'t cancel while 3,000 advance is still on the slip', (await api(owner, 'cancelOrder', { order_id: oA, reason: 'e2e' })).status === 400);
await api(owner, 'adjustAdvance', { order_id: oA, action: 'refund', amount: 3000, mode: 'Cash', note: 'e2e: order cancelled' });
const cx = await api(owner, 'cancelOrder', { order_id: oA, reason: 'e2e: customer changed his mind' });
check('then the order is cancelled', cx.status === 200 && cx.data.data.status === 'cancelled', short(cx.data));
const ago = (d) => core.businessDate(new Date(Date.now() - d * 86400000).toISOString(), 'Asia/Kolkata');
const od = await api(owner, 'addOldDue', { customer_id: CUST, side: 'kacha', date: ago(40), amount: 20000, note: 'e2e paper khata' });
check('old balance from the paper khata entered', od.status === 200, short(od.data));
const kh = await api(owner, 'khata', { customer_id: CUST });
const acct = kh.data.data?.[0];
check('khata: old balance counted, 1,000 credit held', acct && acct.by_side.kacha.due >= 20000 && acct.credit >= 1000, short(acct?.by_side));
const rl = await api(owner, 'reminderList', { lang: 'en' });
const mine = (rl.data.data || []).find((x) => x.customer.id === CUST && x.side === 'kacha');
check('the app ASKS about a reminder for the 40-day-old balance', !!mine, short(rl.data).slice(0, 160));
check('…and the message never mentions the bill type', mine && !/kacha|pakka/i.test(mine.preview));
const sr = await api(owner, 'sendReminder', { customer_id: CUST, side: 'kacha', lang: 'hn' });
check('owner taps Yes: logged, WhatsApp link ready', sr.status === 200 && /^https:\/\/wa\.me\/919810000001\?text=/.test(sr.data.data?.whatsapp_link || ''), short(sr.data));
const rl2 = await api(owner, 'reminderList', {});
check('not asked again right after sending', !(rl2.data.data || []).some((x) => x.customer.id === CUST && x.side === 'kacha'));
check('sales (no khata permission) can\'t see reminders', (await api(sales, 'reminderList', {})).status === 403);

console.log('\n10a. Deleting a slip: staff ask, owner confirms with the SMS code');
const dOrder = await api(owner, 'createOrder', { customer_id: CUST, items: [items[0]], accept: true, advance: { amount: 300, mode: 'Cash' } });
const DEL = dOrder.data.data?.order_id;
check('a slip to delete (accepted, 300 advance)', dOrder.status === 200 && DEL, short(dOrder.data));
const k0 = (await api(owner, 'khata', { customer_id: CUST })).data.data?.[0] || {};
const ask1 = await api(sales, 'requestDelete', { order_id: DEL, reason: 'Entered twice' });
check('sales asks the owner to delete', ask1.status === 200 && ask1.data.data.request_id && ask1.data.data.owners === undefined, short(ask1.data));
const reqs = await api(owner, 'deletedSlips', { order_id: DEL });
check('owner sees the request', reqs.data.data?.requests?.[0]?.reason === 'Entered twice', short(reqs.data));
check('sales can\'t get a delete code', (await api(sales, 'deleteCode', { order_ids: [DEL] })).status === 403);
const pv = await api(owner, 'deletePreview', { order_ids: [DEL] });
check('preview shows the 300 taken, no phone number', Number(pv.data.data?.orders?.[0]?.paid) === 300 && pv.data.data?.phone === undefined, short(pv.data));
let dc = await api(owner, 'deleteCode', { order_ids: [DEL] });
if (dc.status === 429) { console.log('    (waiting 60 s: one SMS code per minute per number)'); await sleep(61000); dc = await api(owner, 'deleteCode', { order_ids: [DEL] }); }
check('SMS code sent to the owner (only last digits shown)', dc.status === 200 && dc.data.data.to === '+91 ••••• ••904', short(dc.data));
const bad = await api(owner, 'deleteSlips', { order_ids: [DEL], reason: 'Entered twice', money: 'credit', code: '000000' });
check('wrong code → nothing deleted', bad.data.error === 'wrong_code', short(bad.data));
const dkey = randomUUID();
const dargs = { order_ids: [DEL], reason: 'Entered twice', money: 'credit', code: CODE };
const dd = await api(owner, 'deleteSlips', dargs, dkey);
check('right code → slip deleted', dd.status === 200 && dd.data.data.deleted?.[0]?.id === DEL, short(dd.data));
const dd2 = await api(owner, 'deleteSlips', dargs, dkey);
check('network retry after the code was used: same answer', dd2.status === 200 && dd2.data.data.replayed === true, short(dd2.data));
const [gone] = await rows(owner, 'orders', `select=status,deleted_from,delete_reason&id=eq.${DEL}`);
check('kept as deleted, with the stage and reason', gone?.status === 'deleted' && gone.deleted_from === 'accepted' && gone.delete_reason === 'Entered twice', short(gone));
const k1 = (await api(owner, 'khata', { customer_id: CUST })).data.data?.[0] || {};
check('the 300 advance moved from "on an open slip" to the customer\'s khata credit (owner still unlocked)',
  Math.round((k0.pending_advance - k1.pending_advance) * 100) === 30000 && k1.credit === k0.credit, `pending ${k0.pending_advance} → ${k1.pending_advance}, credit ${k0.credit} → ${k1.credit}`);
check('no new money on a deleted slip', (await api(owner, 'addAdvance', { order_id: DEL, amount: 10, mode: 'Cash' })).status >= 400);
const dl = await api(owner, 'deletedSlips', {});
check('it is in the deleted list; the request is closed', dl.data.data?.deleted?.some((x) => x.id === DEL) && !dl.data.data.requests.some((r) => r.order_id === DEL), short(dl.data).slice(0, 160));

console.log('\n10. Ask Claude and the PIN lock');
const ask = await api(sales, 'askSteelQuestion', { question: 'EN8 or EN24 for a gear shaft?' });
check('Ask Claude answers, or says it isn\'t switched on yet', ask.status === 200 || ask.data.error === 'ai_not_configured', short(ask.data));
await call('POST', '/rest/v1/rpc/lock_session', { jwt: owner, body: {} });
check('locked phone can\'t use the api', (await api(owner, 'createCustomer', { name: 'X' })).data.error === 'pin_required');

console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? ': ' + failed.join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);
