// What the screens show for entries made without internet (lib/offline/overlay.js) — plain functions, no browser.
// Run: node --test apps/web/test/overlay.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { patchOrder, localOrders, localOrder, weighingOverlay, pendingPayments, localCustomers, blockedBy } from '../src/lib/offline/overlay.js';

const AT = '2026-10-23T10:00:00.000Z';
const item = (id, extra = {}) => ({ id, position: 1, material_id: 'm1', grade_code: 'EN8', shape: 'round', unit: 'mm', dims: ['32'], sell_rate: 95, cut_rate: 2,
  density: 7.85, actual_weight: null, weigh_batch_id: null, order_item_lengths: [{ position: 1, len: 500, pcs: 4, cuts: null }], ...extra });
const order = (id, status = 'accepted', extra = {}) => ({ id, slip_no: '101', status, created_at: AT, customers: { id: 'c1', name: 'Gupta Engg' },
  order_items: [item(`${id}-i1`)], payments: [], pricing_rules: { min_inch: 1 }, ...extra });
const entry = (id, op, args, meta = {}, status = 'waiting') => ({ id, op, args: { offline_at: AT, ...args }, at: AT, meta, status });

test('a server slip shows its waiting weights and pickup', () => {
  const o = order('o1');
  const es = [
    entry('e1', 'recordWeights', { order_id: 'o1' }, { patch: { weights: { 'o1-i1': 12.6 }, submit: true } }),
    entry('e2', 'finalizeOrder', { order_id: 'o1', bill: 'pakka' }, { patch: { bill_type: 'pakka', totals: { total_amount: 1430.66 }, payment: { amount: 1430.66, mode: 'Cash' } } }),
  ];
  const p = patchOrder(o, es);
  assert.equal(p.status, 'done');
  assert.equal(p.order_items[0].actual_weight, 12.6);
  assert.equal(p.total_amount, 1430.66);
  assert.equal(p.bill_type, 'pakka');
  assert.equal(p.paid, 1430.66);
  assert.equal(p.pending, true);
  assert.equal(o.status, 'accepted', 'the server copy is not changed');
});

test('nothing waiting: the slip is returned as it is', () => {
  const o = order('o1');
  assert.equal(patchOrder(o, [entry('e1', 'recordPayment', { customer_id: 'c1', amount: 5 })]), o);
  assert.equal(patchOrder(null, []), null);
});

test('pickup only applies after weighing (order of entries)', () => {
  const p = patchOrder(order('o1'), [entry('e2', 'finalizeOrder', { order_id: 'o1' }, { patch: { totals: { total_amount: 10 } } })]);
  assert.equal(p.status, 'accepted');
});

test('advance on accept and a later advance count as advance', () => {
  const o = order('o2', 'estimate');
  const p = patchOrder(o, [
    entry('a', 'acceptOrder', { order_id: 'o2' }, { patch: { status: 'accepted', payment: { amount: 500, mode: 'UPI' } } }),
    entry('b', 'addAdvance', { order_id: 'o2' }, { patch: { payment: { amount: 250, mode: 'Cash' } } }),
  ]);
  assert.equal(p.status, 'accepted');
  assert.equal(p.advance, 750);
  assert.equal(p.payments.length, 2);
  assert.ok(p.payments.every((x) => x.pending));
});

test('slips made on this phone: listed newest first, with their own waiting changes', () => {
  const mk = (id, at, no) => entry(`c-${id}`, 'createOrder', { order_id: id }, { order: order(id, 'accepted', { created_at: at }), localNo: no });
  const es = [mk('L1', '2026-10-23T09:00:00Z', 'P1'), mk('L2', '2026-10-23T09:30:00Z', 'P2'),
    entry('w', 'recordWeights', { order_id: 'L1' }, { patch: { weights: { 'L1-i1': 3 }, submit: true } })];
  const list = localOrders(es);
  assert.deepEqual(list.map((o) => o.slip_no), ['P2', 'P1']);
  assert.equal(list[1].status, 'weighed');
  assert.equal(list[1].local, true);
  assert.equal(localOrder(es, 'L2').slip_no, 'P2');
  assert.equal(localOrder(es, 'nope'), null);
});

test('weighing list: a submitted weighing leaves the list; partial weights show; phone slips join', () => {
  const server = [
    { id: 's1', slip_no: '7', status: 'accepted', created_at: '2026-10-23T08:00:00Z', items: [{ id: 's1-i', actual_weight: null }] },
    { id: 's2', slip_no: '8', status: 'accepted', created_at: '2026-10-23T08:10:00Z', items: [{ id: 's2-i', actual_weight: null }] },
  ];
  const es = [
    entry('w1', 'recordWeights', { order_id: 's1' }, { patch: { weights: { 's1-i': 5 }, submit: true } }),
    entry('w2', 'recordWeights', { order_id: 's2' }, { patch: { weights: { 's2-i': 2.5 }, submit: false } }),
    entry('n1', 'createOrder', { order_id: 'L9' }, { order: order('L9', 'accepted', { created_at: '2026-10-23T09:00:00Z' }), localNo: 'P9' }),
  ];
  const w = weighingOverlay(server, es, () => 12.4);
  assert.deepEqual(w.map((o) => o.id), ['s2', 'L9']);
  assert.equal(w[0].items[0].actual_weight, 2.5);
  assert.equal(w[1].items[0].expected_weight, 12.4);
  assert.equal(w[1].slip_no, 'P9');
});

test('money received and customers made offline', () => {
  const es = [entry('p1', 'recordPayment', { customer_id: 'c1', amount: '5000', side: 'pakka' }, { payment: { mode: 'UPI' } }),
    entry('p2', 'recordPayment', { customer_id: 'c2', amount: 10, side: 'pakka' }),
    entry('k1', 'createCustomer', { id: 'c9', name: 'New Co' }, { customer: { id: 'c9', name: 'New Co' } })];
  assert.deepEqual(pendingPayments(es, 'c1').map((p) => [p.amount, p.mode]), [[5000, 'UPI']]);
  assert.equal(pendingPayments(es).length, 2);
  assert.deepEqual(localCustomers(es).map((c) => c.id), ['c9']);
});

test('an entry waits for the slip / customer it uses', () => {
  const es = [
    entry('k1', 'createCustomer', { id: 'c9' }, { creates: ['c9'] }),
    entry('o1', 'createOrder', { order_id: 'L1' }, { creates: ['L1'], uses: ['c9'] }),
    entry('w1', 'recordWeights', { order_id: 'L1' }, { uses: ['L1'] }),
    entry('x1', 'saveExpense', {}, {}),
  ];
  const deps = blockedBy(es);
  assert.deepEqual(deps.get('o1'), ['k1']);
  assert.deepEqual(deps.get('w1'), ['o1']);
  assert.equal(deps.has('x1'), false);
  assert.equal(deps.has('k1'), false);
});
