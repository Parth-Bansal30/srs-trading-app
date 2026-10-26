// What this shop usually does (26 Oct 2026) — learned from its own slips, read the same way the slip screens read them
// (so kacha slips only count for people who may see them). The maths is in lib/habitsMath.js.
// - lastOrder(customer): their last real order (accepted / weighed / done) with its items → "Same as last time"
// - regulars(): the customers with the most slips in the last 90 days → first in the customer list
// - recentItems(): the items of the last 150 slips → each grade's usual sizes and cut lengths
import { db } from './backend.js';
import { can } from './session.js';

const rows = async (q) => { const { data, error } = await q; if (error) throw error; return data || []; };
const ITEMS = 'position,material_id,shape,unit,dims,order_item_lengths(position,len,pcs,cuts)';

export async function lastOrder(customerId) {
  if (!customerId || !can('money')) return null;
  const list = await rows(db.from('orders').select(`id,slip_no,status,created_at,order_items(${ITEMS})`).eq('customer_id', customerId)
    .in('status', ['accepted', 'weighed', 'done']).order('created_at', { ascending: false }).limit(1)).catch(() => []);
  return list[0]?.order_items?.length ? list[0] : null;
}

let reg = null; let regAt = 0;
export async function regularRows() {
  if (!can('money')) return [];
  if (reg && Date.now() - regAt < 300000) return reg;
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  reg = await rows(db.from('orders').select('customer_id').gte('created_at', since).in('status', ['accepted', 'weighed', 'done']).limit(3000)).catch(() => reg || []);
  regAt = Date.now();
  return reg;
}

let items = null; let itemsAt = 0;
export async function recentItems() {
  if (!can('money')) return [];
  if (items && Date.now() - itemsAt < 300000) return items;
  const list = await rows(db.from('orders').select(`created_at,order_items(${ITEMS})`).neq('status', 'deleted').neq('status', 'estimate')
    .order('created_at', { ascending: false }).limit(150)).catch(() => null);
  if (list) { items = list.flatMap((o) => o.order_items || []); itemsAt = Date.now(); }
  return items || [];
}
/** After a new slip: learn from it next time. */
export const forgetHabits = () => { regAt = 0; itemsAt = 0; };
