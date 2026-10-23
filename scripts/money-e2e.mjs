/**
 * END-TO-END test of the features added on 23 Oct 2026, over the internet like the app:
 * shop expenses, money moved between accounts, the cash book with cash taken home, balances,
 * entries made offline (sent later with their real time and the phone's own ids), the supplier
 * GST check, and fingerprint unlock (a pretend phone signs like a real one).
 *
 * Uses the "E2E Domain Company" and its DEV test numbers (+91 90000 00904 owner, 00906 sales).
 * Run it at least a minute after domain:e2e (one SMS code per minute per number).
 *
 *   npm run money:e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, lit, PROJECT_REF, ROOT } from './lib/supabase.mjs';
import * as core from '../packages/core/src/index.js';
import { phone } from '../packages/core/test/helpers/phone.js';

const BASE = `https://${PROJECT_REF}.supabase.co`;
const token = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/SUPABASE_ACCESS_TOKEN=(\S+)/)[1];
const keys = await (await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys?reveal=true`, { headers: { Authorization: `Bearer ${token}` } })).json();
const PUBLIC_KEY = keys.find((k) => k.name === 'anon').api_key;
const CODE = '123456';
const OWNER = { phone: '+919000000904', pin: '385917' };
const SALES = { phone: '+919000000906', pin: '8264' };

let passed = 0; const failed = [];
const check = (name, ok, detail = '') => { if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed.push(name); console.log(`  ✗ ${name} ${detail}`); } };
const call = async (method, url, { jwt, body } = {}) => {
  const r = await fetch(`${BASE}${url}`, { method, headers: { apikey: PUBLIC_KEY, 'Content-Type': 'application/json', ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data };
};
const api = (jwt, op, args = {}, key = randomUUID()) => call('POST', '/functions/v1/api', { jwt, body: { v: 1, op, key, args } });
const ok = async (jwt, op, args, key) => { const r = await api(jwt, op, args, key); if (!r.data?.ok) throw new Error(`${op}: ${JSON.stringify(r.data).slice(0, 300)}`); return r.data.data; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (n) => Math.round(n * 100) / 100;

async function login(p) {
  for (let i = 0; i < 2; i++) {
    const otp = await call('POST', '/auth/v1/otp', { body: { phone: p.phone } });
    if (otp.status === 429 && i === 0) { console.log('    (waiting 60 s: one SMS code per minute per number)'); await sleep(61000); continue; }
    if (otp.status !== 200) throw new Error(`code for ${p.phone}: ${JSON.stringify(otp.data)}`);
    const v = await call('POST', '/auth/v1/verify', { body: { phone: p.phone, token: CODE, type: 'sms' } });
    const pin = await call('POST', '/rest/v1/rpc/set_pin', { jwt: v.data.access_token, body: { p_pin: p.pin } });
    if (!pin.data?.unlocked) throw new Error(`PIN for ${p.phone}: ${JSON.stringify(pin.data)}`);
    return v.data.access_token;
  }
}

const [co] = await query(`select id from public.companies where name = 'E2E Domain Company'`);
if (!co) throw new Error('Run npm run domain:e2e first (it makes the E2E Domain Company).');
await query(`update public.people set perms = app.role_preset('owner') where company_id = ${lit(co.id)} and phone = ${lit(OWNER.phone)}`);

console.log('1. Logins');
const owner = await login(OWNER);
const sales = await login(SALES);
check('owner and sales unlocked', owner && sales);

console.log('\n2. Shop expenses');
let accounts = await ok(owner, 'accounts', { all: true });
const drawer = accounts.find((a) => a.is_drawer);
let sbi = accounts.find((a) => a.name === 'E2E SBI');
if (!sbi) sbi = { id: (await ok(owner, 'saveAccount', { account: { name: 'E2E SBI', kind: 'bank', owner: 'firm' } })).id };
const tea = await ok(owner, 'saveExpense', { category: 'tea', amount: 120, account_id: drawer.id, paid_to: 'Chai wala' });
check('tea from the drawer saved', tea.expense_id && tea.mode === 'Cash');
const blade = await ok(owner, 'saveExpense', { category: 'blade', amount: 4720, account_id: sbi.id, method: 'NEFT', gst_bill: true, gst_amount: 720, seller_gstin: '07AAACR5055K1Z9', bill_no: 'B-77' });
check('a blade bill with GST from the bank', blade.mode === 'Bank');
check('sales can\'t enter expenses', (await api(sales, 'saveExpense', { category: 'tea', amount: 10, account_id: drawer.id })).status === 403);
const today = (await ok(owner, 'cashBook', {})).today;
const list = await ok(owner, 'expenses', { from: today, to: today });
check('the list has them, totals add up', list.items.some((e) => e.id === tea.expense_id) && list.totals.total >= 4840 && list.totals.gst >= 720);
const changed = await ok(owner, 'saveExpense', { category: 'tea', amount: 150, account_id: drawer.id, replaces_id: tea.expense_id });
const after = await ok(owner, 'expenses', { from: today, to: today });
check('changing = old cancelled, new one saved', after.items.find((e) => e.id === tea.expense_id)?.status === 'cancelled' && after.items.find((e) => e.id === changed.expense_id)?.amount == 150);

console.log('\n3. Money moved, cash book, cash taken home');
await ok(owner, 'recordPayment', { customer_id: (await query(`select id from public.customers where company_id = ${lit(co.id)} limit 1`))[0].id,
  side: 'pakka', amount: 10000, account_id: drawer.id });
const dep = await ok(owner, 'saveTransfer', { from_account: drawer.id, to_account: sbi.id, amount: 1000, reason: 'deposit' });
check('cash deposited in the bank', !!dep.transfer_id);
let cb = await ok(owner, 'cashBook', {});
check('cash book adds up: opening + in − out = should be there', r2(cb.opening + cb.in - cb.out) === cb.expected || cb.counted_before, JSON.stringify({ o: cb.opening, i: cb.in, out: cb.out, e: cb.expected }));
const exp = cb.expected;
const close = await ok(owner, 'saveCashCount', { counted: exp, take: Math.max(0, r2(exp - 500)), note: 'e2e' });
check('count matches; 500 stays for tomorrow', close.difference === 0 && close.left === Math.min(500, exp), JSON.stringify(close));
cb = await ok(owner, 'cashBook', {});
check('after closing the drawer should have what stayed', cb.expected === close.left);
const bals = await ok(owner, 'accountBalances', {});
check('balances: drawer = what stayed; cash at home has the rest', bals.find((a) => a.is_drawer).balance === close.left
  && (close.taken_out === 0 || bals.find((a) => a.id === close.taken_to)?.balance >= close.taken_out));
await ok(owner, 'setBalance', { id: sbi.id, balance: 50000, note: 'passbook' });
const book = await ok(owner, 'accountBook', { id: sbi.id, from: today, to: today });
check('the bank book has the passbook figure', book.now.known && book.now.balance === 50000);
const day = await ok(owner, 'daySummary', {});
check('evening summary: money out and the cash book', day.summary.out.total >= 4870 && day.summary.cash.book === true);

console.log('\n4. Made without internet, sent later');
const cust = (await query(`select id from public.customers where company_id = ${lit(co.id)} limit 1`))[0].id;
const mat = (await query(`select m.id from public.materials m join public.current_material_rates r on r.material_id = m.id where m.company_id = ${lit(co.id)} and m.code = 'EN8'`))[0].id;
const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
const oid = randomUUID(); const iid = randomUUID();
const made = await ok(owner, 'createOrder', { customer_id: cust, order_id: oid, accept: true, offline_at: hourAgo,
  items: [{ id: iid, material_id: mat, shape: 'round', unit: 'mm', d: ['32'], rows: [{ len: '300', pcs: 2 }] }] });
check('slip saved with the phone\'s id and gets a real number', made.order_id === oid && !!made.slip_no);
const weighed = await ok(owner, 'recordWeights', { order_id: oid, weights: [{ item_id: iid, weight: 3.8 }], submit: true, offline_at: new Date(Date.now() - 3000 * 1000).toISOString() });
check('weighed offline (the phone\'s item id)', weighed.status === 'weighed');
const done = await ok(owner, 'finalizeOrder', { order_id: oid, bill: 'pakka', pay_mode: 'now', account_id: drawer.id, offline_at: new Date(Date.now() - 2400 * 1000).toISOString() });
check('finished offline', done.status === 'done');
const [o] = await query(`select created_at, done_at, entered_offline from public.orders where id = ${lit(oid)}`);
check('times are when it really happened', Math.abs(Date.parse(o.created_at) - Date.parse(hourAgo)) < 2000 && o.entered_offline);
const retry = await api(owner, 'createOrder', { customer_id: cust, order_id: oid, accept: true, items: [{ material_id: mat, shape: 'round', unit: 'mm', d: ['32'], rows: [{ len: '300', pcs: 2 }] }] });
check('the same slip id again (a different request) is refused', retry.status === 409);
check('too long ago is refused', (await api(owner, 'recordPayment', { customer_id: cust, side: 'pakka', amount: 1, mode: 'Cash', offline_at: new Date(Date.now() - 5 * 86400 * 1000).toISOString() })).status === 400);

console.log('\n5. Supplier GST number');
const g = await ok(owner, 'gstCheck', { gstin: '07AAACR5055K1Z9' });
check('without the service key: says the service is off (or uses a recent check)', g.service === false || !!g.check);
await ok(owner, 'gstMark', { gstin: '07AAACR5055K1Z9', status: 'cancelled', cancel_date: '2026-08-12', note: 'e2e' });
const last = await ok(owner, 'gstCheck', { gstin: '07AAACR5055K1Z9' });
check('a portal check is remembered', last.check?.status === 'cancelled' && last.cached);
await ok(owner, 'gstMark', { gstin: '07AAACR5055K1Z9', status: 'active' });
check('suppliers list answers', Array.isArray((await ok(owner, 'suppliers', {})).suppliers));
check('sales can\'t', (await api(sales, 'suppliers', {})).status === 403);

console.log('\n6. Fingerprint unlock');
const p = await phone({ rpId: 'localhost', origin: 'http://localhost:8173' });
const reg = await ok(owner, 'passkeyBegin', { purpose: 'register' });
const saved = await ok(owner, 'passkeyRegister', { challenge: reg.challenge, ...p.create(reg.challenge), label: 'e2e phone' });
check('switched on (fresh PIN)', !!saved.id);
await call('POST', '/rest/v1/rpc/lock_session', { jwt: owner });
check('locked: the api says enter the PIN', (await api(owner, 'cashBook', {})).data.error === 'pin_required');
const b = await ok(owner, 'passkeyBegin', { purpose: 'unlock' });
check('the phone gets its key', b.credentials.includes(p.credId));
const bad = await api(owner, 'passkeyUnlock', { challenge: b.challenge, credential_id: p.credId, ...(await (await phone()).get(b.challenge)) });
check('another phone\'s answer is refused', bad.status === 401 && bad.data.error === 'passkey_failed');
const b2 = await ok(owner, 'passkeyBegin', { purpose: 'unlock' });
const un = await ok(owner, 'passkeyUnlock', { challenge: b2.challenge, credential_id: p.credId, ...(await p.get(b2.challenge)) });
check('unlocked with the finger', un.ok === true && (await api(owner, 'cashBook', {})).data.ok);
const status = (await call('POST', '/rest/v1/rpc/login_status', { jwt: owner })).data;
check('login says unlocked', status.unlocked === true);
check('switching on again after a fingerprint unlock needs the PIN', (await api(owner, 'passkeyBegin', { purpose: 'register' })).status === 403);
const mine = await ok(owner, 'passkeys', {});
const k = mine.find((x) => x.credential_id === p.credId);
check('listed', !!k);
await ok(owner, 'passkeyRemove', { id: k.id });
const b3 = await ok(owner, 'passkeyBegin', { purpose: 'unlock' });
check('removed: no key any more', !b3.credentials.includes(p.credId));

console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
