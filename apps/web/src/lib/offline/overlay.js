// What the screens show for entries made without internet (still waiting to be sent): a slip made on this
// phone, its weights, its pickup, money received. Plain functions over the waiting entries — no screen code,
// so they are tested on their own (overlay.test.mjs).
//
// An entry: { id, op, args, at, meta, status }. meta carries what the screen knew when it was made:
//   createOrder   meta.order  = the slip as the screens show it (loadOrder's shape), meta.localNo = "Phone-3"
//   recordWeights meta.patch  = { weights: { itemId: kg }, submit }
//   finalizeOrder meta.patch  = { status: 'done', bill_type, totals: {…}, in_khata, payment: { amount, mode } }
//   addAdvance    meta.patch  = { payment: { amount, mode } }      acceptOrder meta.patch = { status: 'accepted', payment? }
//   recordPayment meta.payment = { customer_id, amount, side, mode }
//   createCustomer meta.customer = { id, name, phone }

const r2 = (n) => Math.round(n * 100) / 100;
const live = (entries) => (entries || []).filter((e) => e && e.status !== 'done');
const forOrder = (entries, id) => live(entries).filter((e) => e.args?.order_id === id && e.op !== 'createOrder');

function addPayment(o, p, e) {
  o.payments = [...(o.payments || []), { id: `local-${e.id}`, amount: r2(Number(p.amount)), mode: p.mode || 'Cash', kind: p.kind || 'advance',
    received_at: e.args?.offline_at || e.at, pending: true, reverses_payment_id: null, payment_parts: [] }];
}
function totalsOf(o) {
  const sum = (f) => r2((o.payments || []).filter(f).reduce((a, p) => a + Number(p.amount), 0));
  o.paid = sum(() => true);
  o.advance = sum((p) => ['advance', 'refund', 'transfer'].includes(p.kind));
  return o;
}

/** A slip (server's or this phone's) with the waiting changes on top. Marks it `pending` when anything is waiting. */
export function patchOrder(order, entries) {
  if (!order) return order;
  const mine = forOrder(entries, order.id);
  if (!mine.length) return order;
  const o = { ...order, order_items: (order.order_items || []).map((i) => ({ ...i })), payments: [...(order.payments || [])], pending: true };
  for (const e of mine) {
    const p = e.meta?.patch || {};
    if (e.op === 'acceptOrder' && o.status === 'estimate') { o.status = 'accepted'; o.accepted_at = e.args?.offline_at || e.at; }
    if (e.op === 'recordWeights') {
      for (const it of o.order_items) if (p.weights && p.weights[it.id] != null) it.actual_weight = Number(p.weights[it.id]);
      if (p.submit && o.status === 'accepted') { o.status = 'weighed'; o.weighed_at = e.args?.offline_at || e.at; }
    }
    if (e.op === 'finalizeOrder' && o.status === 'weighed') {
      Object.assign(o, p.totals || {}, { status: 'done', bill_type: p.bill_type || e.args?.bill, done_at: e.args?.offline_at || e.at, in_khata: !!p.in_khata });
      if (p.payment && Number(p.payment.amount) > 0) addPayment(o, { ...p.payment, kind: 'pickup' }, e);
    }
    if ((e.op === 'addAdvance' || e.op === 'acceptOrder') && p.payment && Number(p.payment.amount) > 0) addPayment(o, { ...p.payment, kind: 'advance' }, e);
  }
  return totalsOf(o);
}

/** Slips made on this phone that the server doesn't have yet (newest first), with their waiting changes. */
export function localOrders(entries) {
  return live(entries).filter((e) => e.op === 'createOrder' && e.meta?.order)
    .map((e) => patchOrder({ ...e.meta.order, local: true, pending: true, slip_no: e.meta.localNo || e.meta.order.slip_no, entry_id: e.id, entry_status: e.status }, entries))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
export const localOrder = (entries, id) => localOrders(entries).find((o) => o.id === id) || null;

/**
 * The weighing list with waiting entries: this phone's accepted slips are added, slips whose weighing is
 * waiting to be sent go off the list (or show the weights typed so far). expected(item) = expected kg.
 */
export function weighingOverlay(list, entries, expected = () => null) {
  const done = new Set(); const partial = new Map();
  for (const e of live(entries)) {
    if (e.op !== 'recordWeights') continue;
    if (e.meta?.patch?.submit) done.add(e.args.order_id);
    else partial.set(e.args.order_id, { ...(partial.get(e.args.order_id) || {}), ...(e.meta?.patch?.weights || {}) });
  }
  const server = (list || []).filter((o) => !done.has(o.id)).map((o) => (partial.has(o.id)
    ? { ...o, pending: true, items: o.items.map((i) => (partial.get(o.id)[i.id] != null ? { ...i, actual_weight: partial.get(o.id)[i.id] } : i)) } : o));
  const ids = new Set(server.map((o) => o.id));
  const mine = localOrders(entries).filter((o) => o.status === 'accepted' && !ids.has(o.id) && !done.has(o.id)).map((o) => ({
    id: o.id, slip_no: o.slip_no, status: 'accepted', created_at: o.created_at, local: true, pending: true,
    min_inch: Number(o.pricing_rules?.min_inch ?? 0), customer: o.customers?.name || '',
    items: o.order_items.map((i) => ({ id: i.id, material_id: i.material_id, grade_code: i.grade_code, shape: i.shape, unit: i.unit, dims: i.dims,
      density: i.density, actual_weight: i.actual_weight ?? null, weigh_batch_id: null,
      lengths: (i.order_item_lengths || []).map((l) => ({ len: l.len, pcs: l.pcs, cuts: l.cuts })), expected_weight: expected(i, o) })),
  }));
  return [...server, ...mine].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

/** Money received for a customer that is waiting to be sent: [{ amount, side, mode, at, id }]. */
export function pendingPayments(entries, customerId) {
  return live(entries).filter((e) => e.op === 'recordPayment' && (!customerId || e.args?.customer_id === customerId))
    .map((e) => ({ id: e.id, amount: r2(Number(e.args.amount)), side: e.args.side, mode: e.meta?.payment?.mode || e.args.mode || 'Cash', at: e.args?.offline_at || e.at, status: e.status }));
}

/** Customers made on this phone, not sent yet. */
export const localCustomers = (entries) => live(entries).filter((e) => e.op === 'createCustomer' && e.meta?.customer).map((e) => ({ ...e.meta.customer, local: true }));

/** Which waiting entries can't be sent until another one is (it makes the slip / customer they use). */
export function blockedBy(entries) {
  const list = live(entries);
  const makers = new Map();
  for (const e of list) for (const id of e.meta?.creates || []) makers.set(id, e);
  const out = new Map();
  for (const e of list) {
    const deps = (e.meta?.uses || []).map((id) => makers.get(id)).filter((m) => m && m.id !== e.id);
    if (deps.length) out.set(e.id, deps.map((d) => d.id));
  }
  return out;
}
