// Reading customers for the Customers list and the customer page. Changes go through api.js
// (createCustomer / updateCustomer), which checks the GST number and cleans the details.
import { db } from './backend.js';
import { AVATAR_COLOURS } from '../config/options.js';
import { loadCatalog, customerRates } from './catalog.js';

const q = async (p) => { const { data, error } = await p; if (error) throw error; return data; };
const COLS = 'id,name,phone,gstin,address,notes,active';

/** Every customer with their last finished slip (for "Last slip 17 Aug"). */
export async function loadCustomers() {
  const [cs, done] = await Promise.all([
    q(db.from('customers').select(COLS).order('name')),
    q(db.from('orders').select('customer_id,slip_no,done_at').eq('status', 'done').order('done_at', { ascending: false }).limit(3000)).catch(() => []),
  ]);
  const last = new Map();
  for (const o of done) if (!last.has(o.customer_id)) last.set(o.customer_id, o);
  return cs.map((c) => ({ ...c, last: last.get(c.id) || null }));
}

export const loadCustomer = (id) => q(db.from('customers').select(COLS).eq('id', id).maybeSingle());

/** What they bought since a date (slips, kg, amount) — only the bills this person may see. */
export async function boughtSince(customerId, sinceISO) {
  const rows = await q(db.from('orders').select('total_amount,total_weight').eq('customer_id', customerId).eq('status', 'done').gte('done_at', sinceISO)).catch(() => []);
  return { n: rows.length, kg: rows.reduce((a, r) => a + Number(r.total_weight || 0), 0), amount: rows.reduce((a, r) => a + Number(r.total_amount || 0), 0) };
}

/** Special rates set for this customer: [{ code, rate }]. */
export async function specialRates(customerId) {
  const [rates, cat] = await Promise.all([customerRates(customerId), loadCatalog()]);
  const code = new Map(cat.materials.map((m) => [m.id, m.code]));
  return [...rates].map(([id, rate]) => ({ code: code.get(id) || '?', rate }));
}

/** Slips already sent to this customer (order ids). */
export async function sentSlips(customerId) {
  const rows = await q(db.from('shared_docs').select('order_id').eq('kind', 'slip').eq('customer_id', customerId).not('sent_at', 'is', null)).catch(() => []);
  return new Set(rows.map((r) => r.order_id));
}

/** The same colour for a customer every time. */
export function avatarColour(id = '') {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLOURS[h % AVATAR_COLOURS.length];
}
export const firstLetter = (name) => (name || '?').trim().charAt(0).toUpperCase();
