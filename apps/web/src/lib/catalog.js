// Grades, current rates, customers and shop settings — loaded once and kept for a minute.
// What each person sees is decided by the database (rates only for money/rates people).
import { db } from './backend.js';
import { outbox } from './offline/outbox.js';
import { localCustomers } from './offline/overlay.js';

let cache = null; let at = 0;
const q = async (p) => { const { data, error } = await p; if (error) throw error; return data; };

export async function loadCatalog(force = false) {
  if (!force && cache && Date.now() - at < 60000) return cache;
  const [materials, rates, customers, settings] = await Promise.all([
    q(db.from('materials').select('id,code,family,density_override,active,info').order('code')),
    q(db.from('current_material_rates').select('material_id,sell_rate,cut_rate')).catch(() => []),
    q(db.from('customers').select('id,name,phone,notes,active').order('name')),
    q(db.from('company_settings').select('*').maybeSingle()),
  ]);
  const rateOf = new Map(rates.map((r) => [r.material_id, r]));
  cache = {
    materials: materials.map((m) => ({ ...m, sell_rate: rateOf.get(m.id)?.sell_rate ?? null, cut_rate: rateOf.get(m.id)?.cut_rate ?? null })),
    // customers made on this phone without internet are there too (until they are sent)
    customers: [...localCustomers(outbox.value).filter((c) => !customers.some((x) => x.id === c.id)).map((c) => ({ ...c, active: true, notes: null })), ...customers], settings,
  };
  at = Date.now();
  return cache;
}
export const forgetCatalog = () => { cache = null; };

/**
 * Special rates for one customer: Map(material_id → rate). All customers' special rates are read in one go
 * (a short list) and kept a minute — the same copy is kept on the phone, so the new-order screen prices a
 * slip made without internet the same way the server will.
 */
let specials = null; let specialsAt = 0;
export async function allSpecialRates(force = false) {
  if (!force && specials && Date.now() - specialsAt < 60000) return specials;
  specials = await q(db.from('current_customer_rates').select('customer_id,material_id,rate')).catch(() => specials || []);
  specialsAt = Date.now();
  return specials;
}
export async function customerRates(customerId) {
  if (!customerId) return new Map();
  const rows = (await allSpecialRates()).filter((r) => r.customer_id === customerId);
  return new Map(rows.filter((r) => r.rate != null).map((r) => [r.material_id, Number(r.rate)]));
}

/** "Last sold" hint: this customer's last price for the grade, else anyone's. */
export async function lastSold(customerId, materialId, skipOrderId) {
  const rows = await q(db.from('order_items')
    .select('sell_rate,cut_rate,orders!inner(id,slip_no,done_at,status,customer_id,customers(name))')
    .eq('material_id', materialId).eq('orders.status', 'done').limit(200)).catch(() => []);
  const sorted = rows.filter((r) => r.orders.id !== skipOrderId).sort((a, b) => new Date(b.orders.done_at) - new Date(a.orders.done_at));
  const mine = sorted.find((r) => r.orders.customer_id === customerId);
  const any = sorted[0];
  const pack = (r) => r && { rate: Number(r.sell_rate), cut: Number(r.cut_rate), at: r.orders.done_at, slip: r.orders.slip_no, name: r.orders.customers?.name };
  return { mine: pack(mine), any: pack(any) };
}
