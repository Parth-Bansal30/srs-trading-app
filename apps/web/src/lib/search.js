// Search everything from one box (26 Oct 2026). What the words mean: lib/searchWords.js. Each part is read the way its
// own screen reads it, so nobody finds what they may not see (kacha slips, buying rates, other shops): customers and grades
// from the phone's copy (works without internet), slips / payments / bills through the database's own rules, stock and
// expenses through the api. A part that fails (no internet) just shows nothing.
import { db } from './backend.js';
import { call } from './api.js';
import { can } from './session.js';
import { loadCatalog } from './catalog.js';
import { parseSearch, customerFits, rankCustomers } from './searchWords.js';

const SLIP = 'id,slip_no,status,bill_type,created_at,total_amount,customer_id';
const rows = async (q) => { const { data, error } = await q; if (error) throw error; return data || []; };
const safe = (p) => p.catch(() => null);
const DAY_MS = 86400000;
const isoDay = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);

let expCache = null; let expAt = 0;
async function recentExpenses() {
  if (expCache && Date.now() - expAt < 120000) return expCache;
  const r = await call('expenses', { from: isoDay(Date.now() - 120 * DAY_MS), to: isoDay(Date.now()) });
  expCache = (r.items || []).filter((e) => e.status !== 'cancelled'); expAt = Date.now();
  return expCache;
}

/**
 * Search: → { p, customers, grades, slips, payments, purchases, expenses, partial } (each list best first, short).
 * partial: some parts could not be read (no internet).
 */
export async function runSearch(q) {
  const cat = await loadCatalog().catch(() => null);
  const p = parseSearch(q, cat?.materials || []);
  if (!p) return null;
  const custById = new Map((cat?.customers || []).map((c) => [c.id, c]));
  const customers = rankCustomers((cat?.customers || []).filter((c) => customerFits(c, p)), p).slice(0, 8);
  const grade = p.grade ? (cat?.materials || []).find((m) => m.id === p.grade) : null;
  const money = can('money');
  const jobs = {};
  if (money) {
    if (p.slip) jobs.bySlip = rows(db.from('orders').select(SLIP).eq('slip_no', p.slip).limit(3));
    if (customers.length) jobs.byCust = rows(db.from('orders').select(SLIP).in('customer_id', customers.slice(0, 5).map((c) => c.id)).neq('status', 'deleted').order('created_at', { ascending: false }).limit(8));
    if (grade) {
      let qi = db.from('order_items').select(`order_id,dims,shape,orders!inner(${SLIP})`).eq('material_id', grade.id);
      if (p.dims.length) qi = qi.contains('dims', p.dims);
      jobs.byGrade = rows(qi.limit(40));
    }
    if (p.amount != null && p.amount > 0) {
      jobs.byTotal = rows(db.from('orders').select(SLIP).eq('total_amount', p.amount).neq('status', 'deleted').order('created_at', { ascending: false }).limit(5));
      jobs.pays = rows(db.from('payments').select('id,amount,mode,kind,received_at,customer_id,order_id,reverses_payment_id')
        .eq('amount', p.amount).is('reverses_payment_id', null).order('received_at', { ascending: false }).limit(8));
    }
  }
  if (can('stock')) {
    const tok = p.slip || p.words.join(' ');
    if (tok) jobs.billNo = rows(db.from('purchases').select('id,bill_no,bill_date,total_amount,status,supplier_id,suppliers(name)').ilike('bill_no', `%${tok}%`).limit(5));
    if (p.amount != null && p.amount > 0) jobs.billAmt = rows(db.from('purchases').select('id,bill_no,bill_date,total_amount,status,supplier_id,suppliers(name)').eq('total_amount', p.amount).limit(5));
    if (p.words.length) jobs.bySupplier = rows(db.from('purchases').select('id,bill_no,bill_date,total_amount,status,supplier_id,suppliers!inner(name)').ilike('suppliers.name', `%${p.words[0]}%`).order('bill_date', { ascending: false }).limit(5));
  }
  if (grade) jobs.stock = call('stockData', {});
  if ((can('expenses') || can('settings')) && (p.amount != null || p.words.length)) jobs.exp = recentExpenses();
  const keys = Object.keys(jobs);
  const got = await Promise.all(keys.map((k) => safe(jobs[k])));
  const r = Object.fromEntries(keys.map((k, i) => [k, got[i]]));
  const partial = got.some((x) => x === null);

  // slips: the number first, then by grade, by amount, then the customers' recent ones — each once
  const seen = new Set();
  const slipRow = (o, why) => ({ ...o, customer: custById.get(o.customer_id)?.name || '', why });
  const slips = [];
  const add = (list, why) => { for (const o of list || []) { if (!o || seen.has(o.id) || o.status === 'deleted') continue; seen.add(o.id); slips.push(slipRow(o, why)); } };
  add(r.bySlip, 'number');
  add((r.byGrade || []).map((x) => x.orders).filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), 'grade');
  add(r.byTotal, 'amount');
  add(r.byCust, 'customer');

  const payments = (r.pays || []).filter((x) => Number(x.amount) > 0).map((x) => ({ ...x, customer: custById.get(x.customer_id)?.name || '' }));
  const bills = []; const billSeen = new Set();
  for (const b of [...(r.billNo || []), ...(r.billAmt || []), ...(r.bySupplier || [])]) { if (!billSeen.has(b.id) && b.status !== 'cancelled') { billSeen.add(b.id); bills.push(b); } }
  const words = p.words;
  const expenses = (r.exp || []).filter((e) => (p.amount != null && Math.abs(Number(e.amount) - p.amount) < 0.01)
    || (words.length && words.every((w) => `${e.paid_to || ''} ${e.note || ''} ${e.category || ''}`.toLowerCase().includes(w)))).slice(0, 6);
  let grades = [];
  if (grade) {
    const items = (r.stock?.items || []).filter((s) => s.material_id === grade.id && !s.closed);
    grades = [{ ...grade, on_hand: items.length ? items.reduce((s, x) => s + Number(x.on_hand || 0), 0) : null, stock_id: items[0]?.id || null }];
  }
  return { p, customers, grades, slips: slips.slice(0, 10), payments, purchases: bills.slice(0, 6), expenses, partial };
}
