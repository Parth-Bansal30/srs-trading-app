// Building what the screens show for an entry made without internet (23 Oct 2026), and which waiting
// entries an entry needs first (a slip's weighing needs the slip; a slip needs its new customer).
// The server always checks everything again when the entry arrives.
import { partMode, joinModes, r2 } from '@srs/core';
import { outbox } from './outbox.js';

export const isLocalOrder = (id) => !!id && outbox.value.some((e) => e.op === 'createOrder' && e.args?.order_id === id);
export const isLocalCustomer = (id) => !!id && outbox.value.some((e) => e.op === 'createCustomer' && e.args?.id === id);
/** The waiting slips / customers among these ids (the new entry is sent after them). */
export const usesOf = (...ids) => ids.filter((id) => isLocalOrder(id) || isLocalCustomer(id));

/** "Cash", "UPI", "Cash+Bank" for money placed by whereArgs (accounts: the list from loadAccounts). */
export function modeOfArgs(w, accounts = []) {
  if (!w) return 'Cash';
  if (w.mode) return w.mode;
  const kindOf = (id) => accounts.find((a) => a.id === id)?.kind || (accounts.find((a) => a.id === id)?.is_drawer ? 'cash' : 'other');
  if (w.account_id) return partMode(kindOf(w.account_id), w.method || null);
  if (Array.isArray(w.parts)) return joinModes(w.parts.map((p) => partMode(kindOf(p.account_id), p.method || null))) || 'Cash';
  return 'Cash';
}

/**
 * A slip made on this phone, in the shape the slip screens read (like lib/orders.js loadOrder).
 * items: [{ id, material, code, shape, unit, d, rows, rate, cutRate, density, special, stockItemId }]
 */
export function localOrderShape({ id, localNo, customer, items, accepted, advance, settings, at = new Date().toISOString() }) {
  const payments = advance && Number(advance.amount) > 0
    ? [{ id: `local-adv-${id}`, amount: r2(Number(advance.amount)), mode: advance.mode || 'Cash', kind: 'advance', note: advance.note || null, received_at: at,
      pending: true, reverses_payment_id: null, from_payment_id: null, payment_parts: [] }] : [];
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  return {
    id, slip_no: localNo, internal_no: null, status: accepted ? 'accepted' : 'estimate', bill_type: null, customer_id: customer?.id || null,
    created_at: at, accepted_at: accepted ? at : null, weighed_at: null, done_at: null, local: true, pending: true,
    customers: customer ? { id: customer.id, name: customer.name, phone: customer.phone || null } : null,
    pricing_rules: { min_inch: settings?.min_inch ?? 1 }, gst_pct: settings?.gst_pct ?? 18, kacha_pct: settings?.kacha_pct ?? 10,
    total_weight: null, total_amount: null, material_amount: null, cutting_amount: null, gst_amount: null, in_khata: false,
    order_items: items.map((it, i) => ({
      id: it.id, position: i + 1, material_id: it.material, grade_code: it.code, shape: it.shape, unit: it.unit, dims: it.d,
      sell_rate: it.rate, cut_rate: it.cutRate, density: it.density, special_rate: !!it.special, actual_weight: null, weigh_batch_id: null,
      stock_item_id: it.stockItemId || null,
      order_item_lengths: it.rows.map((r, k) => ({ position: k + 1, len: r.len === '' || r.len == null ? null : Number(r.len), pcs: Number(r.pcs), cuts: r.cuts === '' || r.cuts == null ? null : Number(r.cuts) })),
    })),
    payments, paid: r2(paid), advance: r2(paid),
  };
}

/** The money taken now, for a slip's patch: { amount, mode }. */
export const payPatch = (amount, w, accounts) => (Number(amount) > 0 ? { amount: r2(Number(amount)), mode: modeOfArgs(w, accounts) } : null);
