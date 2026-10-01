// Reading orders (slips) for the screens. Changes go through api.js.
import { db } from './backend.js';
import { SHAPES } from '@srs/core';
import { t } from './i18n.js';
import { SHAPE_LOOK } from '../config/options.js';
import { money, kg, shortDate } from './format.js';

const q = async (p) => { const { data, error } = await p; if (error) throw error; return data; };
const ORDER = 'id,slip_no,internal_no,status,bill_type,customer_id,created_at,accepted_at,weighed_at,done_at,cancelled_at,cancel_reason,deleted_at,deleted_by,delete_reason,deleted_from,pay_mode,in_khata,gst_pct,kacha_pct,total_weight,base_amount,material_amount,cutting_amount,gst_amount,total_amount,pricing_rules';

export async function loadOrder(id) {
  const o = await q(db.from('orders').select(`${ORDER},customers(id,name,phone),order_items(id,position,material_id,grade_code,shape,unit,dims,sell_rate,cut_rate,density,special_rate,actual_weight,weigh_batch_id,stock_item_id,order_item_lengths(position,len,pcs,cuts)),payments(id,amount,mode,kind,note,received_at,reverses_payment_id,from_payment_id)`).eq('id', id).maybeSingle());
  if (!o) return null;
  o.order_items.sort((a, b) => a.position - b.position).forEach((i) => i.order_item_lengths.sort((a, b) => a.position - b.position));
  o.payments.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
  const reversed = new Set(o.payments.filter((p) => p.reverses_payment_id).map((p) => p.reverses_payment_id));
  o.payments.forEach((p) => { p.reversed = reversed.has(p.id); });
  const sum = (f) => Math.round(o.payments.filter(f).reduce((a, p) => a + Number(p.amount), 0) * 100) / 100;
  o.paid = sum(() => true);
  o.advance = sum((p) => ['advance', 'refund', 'transfer'].includes(p.kind) || (p.kind === 'reversal' && o.payments.find((x) => x.id === p.reverses_payment_id)?.kind === 'advance'));
  return o;
}

export async function listOrders({ stage, search, limit = 60 } = {}) {
  let r = db.from('orders').select('id,slip_no,status,bill_type,total_amount,created_at,done_at,in_khata,customers(name),order_items(count)').order('created_at', { ascending: false }).limit(limit);
  if (stage === 'open') r = r.in('status', ['estimate', 'accepted', 'weighed']);
  else if (stage && stage !== 'all') r = r.eq('status', stage);
  else r = r.neq('status', 'deleted'); // deleted slips have their own list (owners)
  if (search) r = r.or(`slip_no.ilike.%${search}%`);
  return q(r);
}

// ---------- how an item is written ----------
export const shapeName = (s) => t(SHAPE_LOOK[s]?.word || s);
export const unitTxt = (u) => (u === 'in' ? '"' : ' mm');
export const dimText = (it) => `${(it.dims || it.d || []).slice(0, SHAPES[it.shape]?.dims.length || 1).join(' × ')}${unitTxt(it.unit)}`;
export const lengthsText = (it) => {
  const rows = it.order_item_lengths || it.lengths || [];
  if (!SHAPES[it.shape]?.len) return `${rows.reduce((a, r) => a + Number(r.pcs), 0)} ${t('pcs')}`;
  return rows.map((r) => `${r.len}${unitTxt(it.unit).trim()} × ${r.pcs}`).join(', ');
};
export const totalPcs = (it) => (it.order_item_lengths || it.lengths || []).reduce((a, r) => a + Number(r.pcs), 0);

/** The customer slip as WhatsApp text (no rates, no per-kg — same as the prototype). */
export function slipText(o, { shop, showWeight = true, tz }) {
  const c = o.customers || {};
  let s = `*${shop}* — ${t('order_slip')} #${o.slip_no}\n${t('date')}: ${shortDate(o.done_at || o.created_at, tz)}\n${t('customer')}: ${c.name}${c.phone ? ` (${c.phone})` : ''}\n\n`;
  o.order_items.forEach((it, i) => {
    s += `${i + 1}. ${it.grade_code} ${shapeName(it.shape)} ${dimText(it)} — ${lengthsText(it)} — ${totalPcs(it)} ${t('pcs')}${showWeight && it.actual_weight ? ` — ${kg(it.actual_weight)}` : ''}\n`;
  });
  if (o.status === 'done') {
    s += `\n${t('material')}: ${money(o.material_amount, true)}\n${t('cutting')}: ${money(o.cutting_amount, true)}`;
    if (o.bill_type === 'pakka') s += `\n${t('gst_line', Number(o.gst_pct))}: ${money(o.gst_amount, true)}`;
    s += `\n*${t('total')}: ${money(o.total_amount, true)}*`;
    const bal = Math.max(0, Number(o.total_amount) - o.paid);
    if (bal <= 0) s += `\n${t('paid_full')}`;
    else if (o.paid > 0) s += `\n${t('paid_so_far')}: ${money(o.paid, true)}\n*${t('bal_to_pay')}: ${money(bal, true)}*`;
    if (o.bill_type === 'pakka') s += `\n(${t('slip_gst')})`;
  }
  return `${s}\n\n${t('thanks')}`;
}
