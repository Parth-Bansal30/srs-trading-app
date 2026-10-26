// Unit tests for the api operations (no network): npm run test:api
// The database is replaced by a fake that records what would be saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../../packages/core/src/index.js';
import { makeOps, stableStringify, mapDbError, ApiError, coreItemFromDb, makeGstLookup, makePasskeyOps, offlineAt, markCancelled } from './ops.js';
import { phone } from '../../../packages/core/test/helpers/phone.js';

const EN8 = '10000000-0000-4000-8000-000000000001';
const EN24 = '10000000-0000-4000-8000-000000000002';
const CUST = '20000000-0000-4000-8000-000000000001';
const ORDER = '30000000-0000-4000-8000-000000000001';
const I1 = '40000000-0000-4000-8000-000000000001', I2 = '40000000-0000-4000-8000-000000000002', I3 = '40000000-0000-4000-8000-000000000003';

const owner = { id: 'p-owner', company_id: 'c1', perms: core.ROLE_PRESETS.owner() };
const sales = { id: 'p-sales', company_id: 'c1', perms: { new: 1, orders: 1, money: 1 } }; // no kacha
const clerk = { id: 'p-clerk', company_id: 'c1', perms: { new: 1, orders: 1 } };           // no money
const weigher = { id: 'p-weigh', company_id: 'c1', perms: core.ROLE_PRESETS.weigher() };

const pricingCtx = {
  settings: { min_inch: 1, gst_pct: 18, kacha_pct: 10, family_density: { carbon: 7850, alloy: 7850, stainless: 7930, tool: 7700 } },
  timezone: 'Asia/Kolkata',
  materials: [
    { id: EN8, code: 'EN8', family: 'carbon', density_override: null, active: true, sell_rate: 75, cut_rate: 3, special_rate: 72 },
    { id: EN24, code: 'EN24', family: 'alloy', density_override: 7900, active: true, sell_rate: 95, cut_rate: 4, special_rate: null },
  ],
};
const dbItem = (id, mat, code, shape, dims, lengths, aw, rate = 75, cut = 3) => ({
  id, material_id: mat, grade_code: code, shape, unit: 'mm', dims, density: 7850, sell_rate: rate, cut_rate: cut,
  actual_weight: aw, lengths: lengths.map(([len, pcs]) => ({ len, pcs, cuts: null })),
});
const weighedItems = [
  dbItem(I1, EN8, 'EN8', 'round', ['32'], [['300', 12]], 22.73),
  dbItem(I2, EN8, 'EN8', 'square', ['50'], [['200', 4]], 18.52),
  dbItem(I3, EN24, 'EN24', 'flat', ['60', '25'], [['250', 5]], 14.9, 95, 4),
];

function fakeDb(extra = {}) {
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'api_pricing_context') return structuredClone(pricingCtx);
    if (fn === 'api_order_context') {
      return { order: { id: ORDER, status: 'weighed', pricing_rules: { min_inch: 1 } }, items: structuredClone(weighedItems),
        paid: { advance: 500, pickup: 0, total: 500 }, settings: pricingCtx.settings, timezone: 'Asia/Kolkata', ...extra.orderContext };
    }
    if (fn === 'api_weighing_list') {
      return [{ id: ORDER, status: 'accepted', min_inch: 1, items: weighedItems.map(({ sell_rate, cut_rate, ...i }) => ({ ...i, actual_weight: null })) }];
    }
    if (fn === 'api_record_weights') {
      const all = [...args.p_weights, ...args.p_batches.flatMap((b) => b.parts)];
      return { order_id: ORDER, status: args.p_submit ? 'weighed' : 'accepted', weights: all.map((w) => ({ item_id: w.item_id, weight: w.weight })) };
    }
    return { ok: true };
  };
  const { ops } = makeOps({ core, rpc, companySettings: async () => ({ weight_warn_pct: 5 }), askModel: extra.askModel ?? null });
  return { ops, calls, last: (fn) => calls.filter((c) => c.fn === fn).at(-1)?.args };
}
const rejects = (p, status, code) => assert.rejects(p, (e) => e instanceof ApiError && e.status === status && (!code || e.code === code));

const newItems = [
  { material_id: EN8, shape: 'round', unit: 'mm', d: ['32'], rows: [{ len: '300', pcs: 12 }] },
  { material_id: EN24, shape: 'flat', unit: 'in', d: ['2 1/2', '1'], rows: [{ len: '10', pcs: 5, cuts: '4' }] },
];

test('createOrder: customer special rate, material density, snapshot of rules — same maths as the prototype', async () => {
  const { ops, last } = fakeDb();
  const res = await ops.createOrder(owner, { customer_id: CUST, items: newItems, accept: true, advance: { amount: '500', mode: 'Cash' } }, 'k', 'h');
  const a = last('api_create_order');
  assert.equal(a.p_items[0].sell_rate, 72);            // special rate wins
  assert.equal(a.p_items[0].special_rate, true);
  assert.equal(a.p_items[0].density, 7850);            // carbon family
  assert.equal(a.p_items[1].density, 7900);            // the grade's own density
  assert.deepEqual(a.p_items[1].dims, ['2 1/2', '1']); // kept as typed
  assert.deepEqual(a.p_items[1].lengths, [{ len: '10', pcs: 5, cuts: 4 }]);
  assert.deepEqual(a.p_rules, { min_inch: 1, family_density: pricingCtx.settings.family_density, timezone: 'Asia/Kolkata' });
  assert.deepEqual(a.p_advance, { amount: 500, mode: 'Cash', note: null });
  const expected = core.orderTotals({ items: [
    { shape: 'round', unit: 'mm', d: ['32'], rows: [{ len: '300', pcs: 12, cuts: '' }], rate: 72, cutRate: 3, density: 7850 },
    { shape: 'flat', unit: 'in', d: ['2 1/2', '1'], rows: [{ len: '10', pcs: 5, cuts: 4 }], rate: 95, cutRate: 4, density: 7900 },
  ] }, 'est', { bill: null, minInch: 1 });
  assert.equal(res.estimate.amount, expected.base);
});

test('createOrder: a typed rate is used only by people who handle money', async () => {
  const typed = [{ ...newItems[0], rate: 80, cut_rate: 2 }];
  let db = fakeDb();
  await db.ops.createOrder(owner, { customer_id: CUST, items: typed }, 'k', 'h');
  assert.equal(db.last('api_create_order').p_items[0].sell_rate, 80);
  assert.equal(db.last('api_create_order').p_items[0].special_rate, false);
  assert.equal(db.last('api_create_order').p_items[0].cut_rate, 2);
  db = fakeDb();
  const r = await db.ops.createOrder(clerk, { customer_id: CUST, items: typed }, 'k', 'h');
  assert.equal(db.last('api_create_order').p_items[0].sell_rate, 72);
  assert.equal(r.estimate, undefined, 'no amounts for someone without money permission');
  await rejects(db.ops.createOrder(clerk, { customer_id: CUST, items: newItems, accept: true, advance: { amount: 100, mode: 'Cash' } }, 'k', 'h'), 403);
});

test('createOrder: incomplete or wrong items are refused with a clear message', async () => {
  const { ops } = fakeDb();
  await rejects(ops.createOrder(owner, { customer_id: CUST, items: [] }, 'k', 'h'), 400);
  await rejects(ops.createOrder(owner, { customer_id: CUST, items: [{ ...newItems[0], d: [''] }] }, 'k', 'h'), 400);
  await rejects(ops.createOrder(owner, { customer_id: CUST, items: [{ ...newItems[0], rows: [{ len: '300', pcs: 0 }] }] }, 'k', 'h'), 400);
  await rejects(ops.createOrder(owner, { customer_id: CUST, items: [{ ...newItems[0], shape: 'triangle' }] }, 'k', 'h'), 400);
  await rejects(ops.createOrder(owner, { customer_id: CUST, items: [{ ...newItems[0], material_id: CUST }] }, 'k', 'h'), 400);
  await rejects(ops.createOrder(owner, { customer_id: 'nope', items: newItems }, 'k', 'h'), 400);
  await rejects(ops.createOrder(weigher, { customer_id: CUST, items: newItems }, 'k', 'h'), 403);
});

test('recordWeights: weigh-together split adds up exactly to the scale reading', async () => {
  const { ops, last } = fakeDb();
  const res = await ops.recordWeights(weigher, { order_id: ORDER, weights: [{ item_id: I3, weight: '14.9' }],
    batches: [{ total_weight: 41.25, item_ids: [I1, I2] }], submit: true }, 'k', 'h');
  const b = last('api_record_weights').p_batches[0];
  assert.equal(Math.round(b.parts.reduce((s, p) => s + p.weight, 0) * 100), 4125);
  const exp = [I1, I2].map((id) => core.calcItem(coreItemFromDb(weighedItems.find((i) => i.id === id)), 'est', { minInch: 1 }).est);
  assert.deepEqual(b.parts.map((p) => p.weight), core.splitBatchWeight(exp, 41.25));
  assert.equal(res.status, 'weighed');
  assert.ok(Array.isArray(res.warnings));
  await rejects(ops.recordWeights(weigher, { order_id: ORDER, batches: [{ total_weight: 40, item_ids: [I1, I3] }] }, 'k', 'h'), 400);
  await rejects(ops.recordWeights(weigher, { order_id: ORDER, weights: [{ item_id: I1, weight: 1 }], batches: [{ total_weight: 40, item_ids: [I1, I2] }] }, 'k', 'h'), 400);
  await rejects(ops.recordWeights(weigher, { order_id: ORDER, weights: [{ item_id: I1, weight: -3 }] }, 'k', 'h'), 400);
  await rejects(ops.recordWeights(sales, { order_id: ORDER, weights: [{ item_id: I1, weight: 3 }] }, 'k', 'h'), 403);
});

test('recordWeights: warns (does not block) when a weight is far from the sizes', async () => {
  const { ops } = fakeDb();
  const res = await ops.recordWeights(weigher, { order_id: ORDER, weights: [{ item_id: I1, weight: 40 }] }, 'k', 'h');
  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0].item_id, I1);
});

test('weighingList: expected weight added, never a rate or amount', async () => {
  const { ops } = fakeDb();
  const list = await ops.weighingList(weigher, {});
  assert.ok(list[0].items.every((i) => i.expected_weight > 0));
  assert.doesNotMatch(JSON.stringify(list), /sell_rate|cut_rate|amount/);
});

test('finalizeOrder: totals and khata flag exactly as @srs/core finishCalc', async () => {
  for (const [bill, pay_mode, paid] of [['pakka', 'now'], ['kacha', 'later'], ['pakka', 'part', 1000]]) {
    const { ops, last } = fakeDb();
    const res = await ops.finalizeOrder(owner, { order_id: ORDER, bill, pay_mode, paid, pay_method: 'UPI' }, 'k', 'h');
    const f = last('api_finalize_order').p_final;
    const ref = core.finishCalc({ order: { items: weighedItems.map(coreItemFromDb) }, advance: 500, bill, payMode: pay_mode, paid, gstPct: 18, kachaPct: 10, minInch: 1 });
    assert.equal(f.totals.total, ref.T.total);
    assert.equal(Math.round((f.totals.material + f.totals.cutting + f.totals.gst) * 100), Math.round(ref.T.total * 100)); // exact in the database (numeric)
    assert.equal(f.paid_now, ref.paidNow);
    assert.equal(f.pay_mode, ref.mode);
    assert.equal(f.in_khata, core.staysInKhata(500 + ref.paidNow, ref.T.total));
    assert.equal(f.basis.advance, 500);
    assert.equal(f.basis.weights[I1], 22.73);
    if (bill === 'kacha') assert.equal(f.totals.gst, 0);
    assert.equal(res.breakdown.total, ref.T.total);
  }
});

test('finalizeOrder: refusals', async () => {
  const { ops } = fakeDb();
  await rejects(ops.finalizeOrder(sales, { order_id: ORDER, bill: 'kacha', pay_mode: 'now', pay_method: 'Cash' }, 'k', 'h'), 403);
  await rejects(ops.finalizeOrder(owner, { order_id: ORDER, bill: null, pay_mode: 'now' }, 'k', 'h'), 400, 'choose_bill');
  await rejects(ops.finalizeOrder(owner, { order_id: ORDER, bill: 'pakka', pay_mode: 'part', paid: 0, pay_method: 'Cash' }, 'k', 'h'), 400, 'need_part');
  await rejects(ops.finalizeOrder(owner, { order_id: ORDER, bill: 'pakka', pay_mode: 'now', pay_method: 'Gold' }, 'k', 'h'), 400);
  await rejects(ops.finalizeOrder(weigher, { order_id: ORDER, bill: 'pakka', pay_mode: 'now' }, 'k', 'h'), 403);
  const done = fakeDb({ orderContext: { order: { id: ORDER, status: 'done', pricing_rules: {} } } });
  await rejects(done.ops.finalizeOrder(owner, { order_id: ORDER, bill: 'pakka', pay_mode: 'now', pay_method: 'Cash' }, 'k', 'h'), 409);
});

test('cancelling a payment and giving money back are the owner\'s (25 Oct 2026)', async () => {
  const accounts = { id: 'p-acc', company_id: 'c1', perms: core.ROLE_PRESETS.accounts() };   // money + khata, not delete
  const { ops, calls } = fakeDb();
  await rejects(ops.reversePayment(accounts, { payment_id: CUST, note: 'typed twice' }, 'k', 'h'), 403);
  await rejects(ops.refundCredit(accounts, { customer_id: CUST, side: 'pakka', amount: 100, mode: 'Cash', note: 'paid twice' }, 'k', 'h'), 403);
  await rejects(ops.adjustAdvance(accounts, { order_id: ORDER, action: 'refund', amount: 100, mode: 'Cash', note: 'cancelled' }, 'k', 'h'), 403);
  assert.equal(calls.length, 0, 'nothing reached the database');
  await ops.reversePayment(owner, { payment_id: CUST, note: 'typed twice' }, 'k', 'h');
  assert.equal(calls.at(-1).fn, 'api_reverse_payment');
});

test('a cancelled payment shows crossed out; its cancellation row is marked to leave out', () => {
  const entries = [
    { t: 'bill', oid: 'o1', amt: 5000 },
    { t: 'pay', pid: 'p1', amt: 1500, kind: 'khata' },
    { t: 'pay', pid: 'p2', amt: -1500, kind: 'khata' },
    { t: 'pay', pid: 'p3', amt: 700, kind: 'khata' },
  ];
  const pays = [{ id: 'p1' }, { id: 'p2', reverses: 'p1', note: 'written twice', by: 'Papa', at: '2026-10-25T10:00:00Z' }, { id: 'p3' }];
  const m = markCancelled(entries, pays);
  assert.deepEqual(m[1].cancelled, { reason: 'written twice', by: 'Papa', at: '2026-10-25T10:00:00Z' });
  assert.equal(m[2].reversal, true);
  assert.equal(m[3].cancelled, undefined); assert.equal(m[3].reversal, undefined);
  assert.equal(m[0], entries[0], 'bills untouched');
  assert.deepEqual(markCancelled(entries, undefined), entries, 'old data without the new fields still works');
});

test('money inputs are checked before anything is saved', async () => {
  const { ops, calls } = fakeDb();
  await rejects(ops.recordPayment(owner, { customer_id: CUST, amount: 0, mode: 'Cash', side: 'pakka' }, 'k', 'h'), 400);
  await rejects(ops.recordPayment(sales, { customer_id: CUST, amount: 10, mode: 'Cash', side: 'pakka' }, 'k', 'h'), 403); // no khata
  await rejects(ops.reversePayment(owner, { payment_id: CUST, note: '   ' }, 'k', 'h'), 400);
  await rejects(ops.saveCashCount(owner, { counted: -1 }, 'k', 'h'), 400);
  await rejects(ops.changeMaterialRate(sales, { material_id: EN8, sell_rate: 1, cut_rate: 1 }, 'k', 'h'), 403);
  await rejects(ops.createMaterial(owner, { code: '??', family: 'carbon', sell_rate: 1, cut_rate: 1 }, 'k', 'h'), 400);
  assert.equal(calls.length, 0);
  await ops.recordPayment(owner, { customer_id: CUST, amount: '1500.456', mode: 'UPI', side: 'kacha', note: ' Paytm ' }, 'k', 'h');
  assert.deepEqual(calls[0].args, { p_caller: 'p-owner', p_key: 'k', p_hash: 'h', p_customer: CUST, p_amount: 1500.46, p_mode: 'UPI', p_side: 'kacha', p_note: 'Paytm' });
});

test('Ask Claude: off until the key is added; prototype instructions', async () => {
  const off = fakeDb();
  await rejects(off.ops.askSteelQuestion(owner, { question: 'EN8 or EN24 for a shaft?' }), 503, 'ai_not_configured');
  let prompt = '';
  const on = fakeDb({ askModel: async (p) => { prompt = p; return 'Use EN24.'; } });
  const origRpc = on.ops;
  const res = await origRpc.askSteelQuestion(owner, { question: 'EN8 or EN24 for a shaft?', lang: 'hi' }).catch((e) => e);
  // fake db returns {ok:true} for api_ai_context/api_ai_take → allowed; stock empty
  assert.equal(res.answer, 'Use EN24.');
  assert.match(prompt, /simple Hindi in Devanagari script/);
  assert.match(prompt, /Never give prices/);
});

test('request fingerprint ignores key order; database errors map to clear answers', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: '1' }));
  assert.equal(mapDbError('42501', 'x').status, 403);
  assert.equal(mapDbError('40001', 'x').code, 'changed');
  assert.equal(mapDbError('23505', 'x').status, 409);
  assert.equal(mapDbError('23514', 'x').status, 400);
  assert.equal(mapDbError('XX000', 'x'), null);
});

// ---------- owner decisions of 26 Sept 2026 ----------
const khataRaw = () => ({
  timezone: 'Asia/Kolkata', shop: 'SRS Trading',
  settings: { reminder_after_days: 25, reminder_repeat_days: 7 },
  customers: [{ id: CUST, name: 'Rana Tools', phone: '98111 22334', active: true }],
  orders: [
    { id: ORDER, slip_no: '1042', customer_id: CUST, status: 'done', bill: 'kacha', in_khata: true, total: 12500, done_at: '2026-08-01T08:00:00Z', created_at: '2026-07-30T08:00:00Z' },
    { id: I1, slip_no: '1080', customer_id: CUST, status: 'done', bill: 'pakka', in_khata: true, total: 9000, done_at: new Date().toISOString(), created_at: new Date().toISOString() },
  ],
  payments: [
    { id: 'p1', customer_id: CUST, order_id: null, amount: 5000, mode: 'UPI', kind: 'khata', side: 'kacha', at: '2026-08-10T08:00:00Z' },
    { id: 'p2', customer_id: CUST, order_id: null, amount: 700, mode: 'Adjust', kind: 'khata', side: 'pakka', at: '2026-08-10T08:00:00Z' },
  ],
  old_dues: [
    { id: 'd1', customer_id: CUST, side: 'kacha', ref: null, date: '2026-06-01', amount: 20000, reverses_id: null },
    { id: 'd2', customer_id: CUST, side: 'kacha', ref: null, date: '2026-06-02', amount: 999, reverses_id: null },
    { id: 'd3', customer_id: CUST, side: 'kacha', ref: null, date: '2026-06-02', amount: -999, reverses_id: 'd2' },
  ],
  last_reminders: [],
});
function fakeKhata(raw = khataRaw()) {
  const calls = [];
  const rpc = async (fn, args) => { calls.push({ fn, args }); return fn === 'api_khata_data' ? structuredClone(raw) : { ok: true, reminder_id: 'r1' }; };
  const { ops } = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null });
  return { ops, calls, last: (fn) => calls.filter((c) => c.fn === fn).at(-1)?.args };
}

test('change rate on a slip needs the "price" permission (money alone is not enough)', async () => {
  const db = fakeDb();
  await db.ops.createOrder(sales, { customer_id: CUST, items: [{ ...newItems[0], rate: 90 }] }, 'k', 'h');
  assert.equal(db.last('api_create_order').p_items[0].sell_rate, 72, 'sales without price: standard rate kept');
  await db.ops.createOrder({ ...sales, perms: { ...sales.perms, price: 1 } }, { customer_id: CUST, items: [{ ...newItems[0], rate: 90 }] }, 'k', 'h');
  assert.equal(db.last('api_create_order').p_items[0].sell_rate, 90, 'once the owner gives price');
});

test('adjusting an advance: each choice checked before the database', async () => {
  const { ops, calls, last } = fakeDb();
  await rejects(ops.adjustAdvance(owner, { order_id: ORDER, action: 'refund', amount: 1000, mode: 'UPI' }, 'k', 'h'), 400); // no reason
  await rejects(ops.adjustAdvance(owner, { order_id: ORDER, action: 'refund', amount: 1000, mode: 'Adjust', note: 'x' }, 'k', 'h'), 400);
  await rejects(ops.adjustAdvance(owner, { order_id: ORDER, action: 'move', amount: 1000 }, 'k', 'h'), 400);
  await rejects(ops.adjustAdvance(sales, { order_id: ORDER, action: 'credit', amount: 1000, side: 'kacha' }, 'k', 'h'), 403);
  await rejects(ops.adjustAdvance(owner, { order_id: ORDER, action: 'delete', amount: 1000 }, 'k', 'h'), 400);
  await rejects(ops.adjustAdvance(weigher, { order_id: ORDER, action: 'refund', amount: 1000, mode: 'Cash', note: 'x' }, 'k', 'h'), 403);
  assert.equal(calls.length, 0);
  await ops.adjustAdvance(owner, { order_id: ORDER, action: 'refund', amount: '10000', mode: 'UPI', note: 'customer will pay by bank transfer' }, 'k', 'h');
  assert.deepEqual(last('api_adjust_advance'), { p_caller: 'p-owner', p_key: 'k', p_hash: 'h', p_order: ORDER, p_action: 'refund', p_amount: 10000,
    p_mode: 'UPI', p_target: null, p_side: null, p_note: 'customer will pay by bank transfer' });
  await rejects(ops.cancelOrder(owner, { order_id: ORDER, reason: '  ' }, 'k', 'h'), 400);
});

test('old balances and credit refunds', async () => {
  const raw = khataRaw(); raw.orders = raw.orders.filter((o) => o.bill !== 'pakka'); // no pakka bill to use the credit up
  const k = fakeKhata(raw);
  await rejects(k.ops.addOldDue(owner, { customer_id: CUST, side: 'kacha', date: '1 June', amount: 100 }, 'k', 'h'), 400);
  await rejects(k.ops.addOldDue(sales, { customer_id: CUST, side: 'pakka', date: '2026-06-01', amount: 100 }, 'k', 'h'), 403);
  await k.ops.addOldDue(owner, { customer_id: CUST, side: 'kacha', ref: ' 553 ', date: '2026-06-01', amount: '5000' }, 'k', 'h');
  assert.equal(k.last('api_add_old_due').p_ref, '553');
  await k.ops.refundCredit(owner, { customer_id: CUST, side: 'pakka', amount: 500, mode: 'Cash', note: 'returned extra' }, 'k', 'h');
  assert.equal(k.last('api_refund_credit').p_available, 700, 'credit available worked out by the ledger');
});

test('khata: old balances counted, corrections netted out', async () => {
  const k = fakeKhata();
  const [row] = await k.ops.khata(owner, {});
  assert.equal(row.by_side.kacha.due, 20000 + 12500 - 5000);
  assert.equal(row.by_side.pakka.due, 9000 - 700);
  const [acc] = await k.ops.khata({ ...owner, perms: { money: 1, khata: 1 } }, {});
  assert.equal(acc.by_side.kacha, undefined, 'no kacha for someone without the permission');
});

test('reminders: only old dues are proposed, message rebuilt on the server, never mentions the bill type', async () => {
  const k = fakeKhata();
  const list = await k.ops.reminderList(owner, { lang: 'en' });
  assert.equal(list.length, 1, 'kacha side is old; the pakka bill is from today');
  assert.equal(list[0].side, 'kacha');
  assert.equal(list[0].due, 27500);
  assert.doesNotMatch(list[0].preview, /kacha|pakka/i);
  const sent = await k.ops.sendReminder(owner, { customer_id: CUST, side: 'kacha', lang: 'hn' }, 'k', 'h');
  assert.ok(sent.whatsapp_link.startsWith('https://wa.me/919811122334?text='));
  assert.equal(k.last('api_record_reminder').p_total_due, 27500);
  assert.equal(k.last('api_record_reminder').p_message, sent.message);
  const snoozed = khataRaw(); snoozed.last_reminders = [{ customer_id: CUST, side: 'kacha', at: new Date().toISOString() }];
  assert.equal((await fakeKhata(snoozed).ops.reminderList(owner, {})).length, 0, 'not asked again right after a reminder');
  const noPhone = khataRaw(); noPhone.customers[0].phone = null;
  await rejects(fakeKhata(noPhone).ops.sendReminder(owner, { customer_id: CUST, side: 'kacha' }, 'k', 'h'), 400, 'no_phone');
  await rejects(k.ops.reminderList(sales, {}), 403);
});

// ---------- slips and statements for the customer ----------
function docDb({ bill = 'pakka', upi = { id: 'srs.sample@upi', name: 'SRS Trading' }, showWeight = true, paidSlip = false } = {}) {
  const calls = [];
  const header = {
    shop: { name: 'SRS Trading', address: 'Shop 12, Steel Market, New Delhi 110001', phone: '90000 00100', gstin: '07AAACE1234F1Z8', city: 'New Delhi' },
    upi, show_weight: showWeight, timezone: 'Asia/Kolkata',
    customer: { id: CUST, name: 'Rana Tools', phone: '9814022113', gstin: '03AAKFR5521L1Z4', address: 'Focal Point' },
  };
  const khata = {
    timezone: 'Asia/Kolkata', shop: 'SRS Trading', settings: { reminder_after_days: 25, reminder_repeat_days: 7 },
    customers: [{ id: CUST, name: 'Rana Tools', phone: '9814022113', active: true }],
    orders: [
      { id: 'o1', slip_no: '1034', customer_id: CUST, status: 'done', bill: 'pakka', in_khata: true, total: 12450.6, done_at: '2026-09-05T06:00:00Z' },
      { id: 'o2', slip_no: '1047', customer_id: CUST, status: 'done', bill: 'kacha', in_khata: true, total: 4388, done_at: '2026-09-18T06:00:00Z' },
    ],
    payments: [{ id: 'p1', customer_id: CUST, order_id: null, amount: 15000, mode: 'UPI', kind: 'khata', side: 'pakka', note: 'Paytm - Dad', at: '2026-09-12T08:00:00Z' }],
    old_dues: [{ id: 'd1', customer_id: CUST, side: 'kacha', ref: null, date: '2026-08-20', amount: 8500, reverses_id: null, note: 'from the red book' }],
    last_reminders: [],
  };
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'api_slip_data') {
      return { ...header, order: { id: ORDER, slip_no: '1061', done_at: '2026-09-28T06:12:00Z', bill, gst_pct: 18, total_weight: 37.2,
        material: 3018, cutting: 133.7, gst: bill === 'pakka' ? 567.31 : 0, total: bill === 'pakka' ? 3719.01 : 3151.7 },
        items: [{ grade: 'EN8', shape: 'round', unit: 'mm', dims: ['32'], weight: 25.8, hsn: '722830', lengths: [{ len: '300', pcs: 12 }, { len: '150', pcs: 4 }] }],
        payments: [{ at: '2026-09-26T08:00:00Z', amount: 2000, mode: 'UPI', kind: 'advance' }] };
    }
    if (fn === 'api_doc_header') return structuredClone(header);
    if (fn === 'api_khata_data') {
      const kk = structuredClone(khata);
      if (paidSlip) {
        kk.orders.push({ id: 'o3', slip_no: '1050', customer_id: CUST, status: 'done', bill: 'pakka', in_khata: false, total: 2000, done_at: '2026-09-20T06:00:00Z' });
        kk.payments.push({ id: 'p9', customer_id: CUST, order_id: 'o3', amount: 2000, mode: 'Cash', kind: 'pickup', side: 'pakka', note: null, at: '2026-09-20T06:00:00Z' });
      }
      return kk;
    }
    if (fn === 'api_save_doc') return { id: 'd1', token: 'tok-12345678901234567890', sent_at: args.p_send ? 'now' : null, send_count: args.p_send ? 1 : 0 };
    return { ok: true };
  };
  const { ops } = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null, newKey: () => '99999999-0000-4000-8000-000000000001' });
  return { ops, calls, last: (fn) => calls.filter((c) => c.fn === fn).at(-1)?.args };
}

test('slipDoc: the customer copy has totals, paid and balance — never rates, notes or the word kacha', async () => {
  const { ops, last } = docDb();
  const r = await ops.slipDoc(owner, { order_id: ORDER, lang: 'hi', send: true }, 'k', 'h');
  assert.equal(r.token, 'tok-12345678901234567890');
  const d = r.doc;
  assert.equal(d.slip.gst, true);
  assert.equal(d.slip.total, 3719.01);
  assert.equal(d.slip.paid, 2000);
  assert.equal(d.slip.balance, 1719.01);
  assert.deepEqual(d.upi, { id: 'srs.sample@upi', name: 'SRS Trading', amount: 1719.01, note: 'Slip 1061' });
  assert.equal(d.shop.gstin, '07AAACE1234F1Z8');
  assert.equal(d.customer.gstin, '03AAKFR5521L1Z4');
  assert.equal(d.slip.items[0].pcs, 16);
  assert.equal(d.slip.items[0].hsn, '722830'); // GST slip: HSN from the stock it came from
  const text = JSON.stringify(d);
  assert.ok(!/kacha|sell_rate|cut_rate|rate/i.test(text), text);
  const s = last('api_save_doc');
  assert.equal(s.p_kind, 'slip'); assert.equal(s.p_send, true); assert.equal(s.p_no_bill, false); assert.equal(s.p_lang, 'hi');
});

test('slipDoc: no-bill slip has no GST numbers; paid in full → no QR; weight hidden when the setting is off', async () => {
  const { ops, last } = docDb({ bill: 'kacha', showWeight: false });
  const r = await ops.slipDoc(owner, { order_id: ORDER }, 'k', 'h');
  assert.equal(r.doc.slip.gst, false);
  assert.equal(r.doc.shop.gstin, null);
  assert.equal(r.doc.customer.gstin, null);
  assert.equal(r.doc.slip.items[0].weight, null);
  assert.equal(r.doc.slip.items[0].hsn, null); // no HSN on a no-bill slip
  assert.equal(r.doc.slip.total_weight, null);
  assert.equal(last('api_save_doc').p_no_bill, true);
  assert.ok(!/kacha/i.test(JSON.stringify(r.doc)));
  const { ops: o2 } = docDb({ upi: null });
  assert.equal((await o2.slipDoc(owner, { order_id: ORDER }, 'k', 'h')).doc.upi, null);
  await rejects(docDb().ops.slipDoc(weigher, { order_id: ORDER }, 'k', 'h'), 403);
});

test('statementDoc: period, running balance and closing match the khata; notes never included', async () => {
  const { ops, last } = docDb();
  const r = await ops.statementDoc(owner, { customer_id: CUST, from: '2026-09-01', to: '2026-09-30', which: 'both', send: true }, 'k', 'h');
  const d = r.doc;
  assert.equal(d.opening, 8500);
  assert.equal(d.bought, 16838.6);
  assert.equal(d.paid, 15000);
  assert.equal(d.closing, 10338.6);
  assert.deepEqual(d.rows.map((x) => [x.type, x.slip, x.bal]), [['slip', '1034', 20950.6], ['pay', null, 5950.6], ['slip', '1047', 10338.6]]);
  assert.equal(d.rows[2].gst, false);
  assert.equal(d.upi.amount, 10338.6);
  assert.ok(!/Paytm|red book|kacha/i.test(JSON.stringify(d)));
  assert.equal(last('api_save_doc').p_no_bill, true);
  // GST bills only
  const g = await ops.statementDoc(owner, { customer_id: CUST, from: '2026-09-01', to: '2026-09-30', which: 'pakka' }, 'k2', 'h');
  assert.equal(g.doc.gst_only, true);
  assert.equal(g.doc.closing, -2549.4); // paid more than the GST slip: money held for them
  assert.equal(g.doc.upi, null);
  assert.equal(last('api_save_doc').p_no_bill, false);
  // someone without no-bill permission can't ask for it
  await rejects(ops.statementDoc({ ...sales, perms: { ...sales.perms, khata: 1 } }, { customer_id: CUST, from: '2026-09-01', to: '2026-09-30', which: 'kacha' }, 'k', 'h'), 403);
  await rejects(ops.statementDoc(owner, { customer_id: CUST, from: '2026-09-30', to: '2026-09-01' }, 'k', 'h'), 400);
  // a slip paid in full at pickup (not in the khata) still shows, and the balance doesn't change
  const q = docDb({ paidSlip: true });
  const w = (await q.ops.statementDoc(owner, { customer_id: CUST, from: '2026-09-01', to: '2026-09-30', preview: true }, 'k4', 'h')).doc;
  assert.equal(w.closing, 10338.6);
  assert.deepEqual(w.rows.filter((x) => x.slip === '1050').map((x) => [x.type, x.amount, x.kind ?? null]), [['slip', 2000, null], ['pay', 2000, 'settled']]);
  // just looking (the send sheet shows the totals first): nothing saved, no link
  const p = docDb();
  const pv = await p.ops.statementDoc(owner, { customer_id: CUST, from: '2026-09-01', to: '2026-09-30', preview: true }, 'k3', 'h');
  assert.equal(pv.token, undefined);
  assert.equal(pv.doc.closing, 10338.6);
  assert.equal(p.calls.filter((c) => c.fn === 'api_save_doc').length, 0);
});

test('customers: GST number checked; UPI ID checked', async () => {
  const { ops, last } = docDb();
  await ops.updateCustomer(owner, { customer_id: CUST, changes: { gstin: '03aakfr5521l1z4', address: ' Focal Point ' } }, 'k', 'h');
  assert.deepEqual(last('api_update_customer').p_changes, { gstin: '03AAKFR5521L1Z4', address: 'Focal Point' });
  await rejects(ops.updateCustomer(owner, { customer_id: CUST, changes: { gstin: '03AAKFR5521L1Z5' } }, 'k', 'h'), 400);
  await rejects(ops.changeSettings(owner, { changes: { upi_id: 'not an id' } }, 'k', 'h'), 400);
  await ops.changeSettings(owner, { changes: { upi_id: 'srs.sample@upi' } }, 'k', 'h');
  assert.equal(last('api_change_settings').p_changes.upi_id, 'srs.sample@upi');
});

// ---------- evening summary ----------
function eveDb() {
  const calls = [];
  const day = {
    timezone: 'Asia/Kolkata', day: '2026-09-28', today: '2026-09-29', shop: 'SRS Trading', settings: { weight_warn_pct: 5, min_inch: 1 },
    orders: [{ id: 'o1', slip_no: '1061', customer: 'Rana Tools', bill: 'pakka', total: 3719.01, weight: 37.2, in_khata: true, by: 'Ramesh',
      items: [{ grade: 'EN24', rate: 88, special: false, std_rate: 95 }], payments: [{ amount: 2000, kind: 'advance', rev: false, mode: 'UPI' }] }],
    payments: [{ amount: 12000, kind: 'khata', rev: false, mode: 'Cash', customer: 'Gupta', order_id: null }],
    cash_close: { expected: 12000, counted: 11500, by: 'Ramesh' },
    weighed: [{ slip_no: '1061', grade: 'EN8', shape: 'round', unit: 'mm', dims: ['32'], density: 7850, actual: 30, min_inch: 1, lengths: [{ len: '300', pcs: 12, cuts: null }] }],
    waiting: [], cancelled: [], last_week: { total: 3000, n: 1 },
  };
  // (reminders after 10 years, so the test doesn't change as the real calendar moves on)
  const khata = { timezone: 'Asia/Kolkata', shop: 'SRS Trading', settings: { reminder_after_days: 3650, reminder_repeat_days: 7 },
    customers: [{ id: 'cu1', name: 'Rana Tools', phone: '9814022113', active: true }],
    orders: [{ id: 'o1', slip_no: '1061', customer_id: 'cu1', status: 'done', bill: 'pakka', in_khata: true, total: 3719.01, done_at: '2026-09-28T06:00:00Z' }],
    payments: [{ id: 'p1', customer_id: 'cu1', order_id: 'o1', amount: 2000, mode: 'UPI', kind: 'advance', side: null, at: '2026-09-26T06:00:00Z' }],
    old_dues: [], last_reminders: [] };
  const sent = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'api_day_data') return structuredClone(day);
    if (fn === 'api_khata_data') return structuredClone(khata);
    if (fn === 'api_evening_due') return [{ company_id: 'c1', day: '2026-09-28', recipients: [{ person_id: 'p-owner', lang: 'hi', perms: owner.perms, subs: [{ endpoint: 'https://push.example/1', keys: {} }, { endpoint: 'https://push.example/2', keys: {} }] }] }];
    return null;
  };
  const push = { vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'x' }, sendPush: async (s, msg) => { sent.push({ s, msg }); return s.endpoint.endsWith('2') ? { ok: false, gone: true } : { ok: true, gone: false }; } };
  const made = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null, push });
  return { ...made, calls, sent };
}

test('daySummary: numbers from the day data, khata total, below-rate and weight flags', async () => {
  const { ops } = eveDb();
  const d = await ops.daySummary(owner, { day: '2026-09-28' });
  const s = d.summary;
  assert.equal(s.sales.total, 3719.01);
  assert.equal(s.sales.toKhata, 1719.01);
  assert.equal(s.money.byMode.Cash, 12000);
  assert.equal(s.cash.diff, -500);
  assert.equal(s.khata.toReceive, 1719.01);
  assert.deepEqual(s.look.map((x) => x.type), ['cash_short', 'rate', 'weight']);
  await rejects(ops.daySummary(weigher, {}), 403);
});

test('evening job: sends each phone its note in the person\'s language; an unsubscribed phone is removed', async () => {
  const { runEvening, calls, sent } = eveDb();
  const r = await runEvening('2026-09-28T14:40:00Z');
  assert.deepEqual(r, { companies: 1, sent: 1 });
  assert.equal(sent.length, 2);
  assert.match(sent[0].msg.title, /शाम का हिसाब · 28 Sep/);
  assert.match(sent[0].msg.body, /बिक्री ₹3,719/);
  assert.equal(sent[0].msg.url, '#/evening?day=2026-09-28');
  const results = calls.filter((c) => c.fn === 'api_push_result').map((c) => [c.args.p_ok, c.args.p_gone]);
  assert.deepEqual(results, [[true, false], [false, true]]);
  assert.deepEqual(calls.find((c) => c.fn === 'api_evening_sent').args, { p_company: 'c1', p_day: '2026-09-28', p_sent: 1 });
});

test('evening settings: time and days checked; no push keys → job does nothing', async () => {
  const { ops } = eveDb();
  await rejects(ops.eveningSet(owner, { changes: { time: '25:00' } }, 'k', 'h'), 400);
  await rejects(ops.eveningSet(owner, { changes: { days: [0] } }, 'k', 'h'), 400);
  await rejects(ops.eveningSet(sales, { changes: { on: true } }, 'k', 'h'), 403);
  const none = makeOps({ core, rpc: async () => [], companySettings: async () => ({}), askModel: null });
  assert.deepEqual(await none.runEvening(), { skipped: 'no_vapid_keys' });
});

// ---------- deleting slips (30 Sept 2026) ----------
function delDb({ codeOk = true, answered = null } = {}) {
  const calls = []; const sent = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'api_delete_check') return { phone: '+919000000002', orders: args.p_orders.map((id) => ({ id, slip_no: '1072', paid: 1000 })) };
    if (fn === 'api_idem_answer') return answered;
    if (fn === 'api_delete_orders') return { deleted: args.p_orders.map((id) => ({ id })), money: args.p_money };
    if (fn === 'api_request_delete') return { request_id: 'r1', order_id: ORDER, slip_no: '1072', asked_by: 'Ramesh', reason: args.p_reason,
      owners: [{ lang: 'hi', subs: [{ endpoint: 'https://push.example/1', keys: {} }] }, { lang: 'en', subs: [] }] };
    return null;
  };
  const otp = { sends: 0, send: async () => { otp.sends++; return { phone: '+919000000002' }; }, verify: async (_c, code) => codeOk && code === '123456' };
  const push = { vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'x' }, sendPush: async (s, msg) => { sent.push(msg); return { ok: true, gone: false }; } };
  const made = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null, push, otp });
  return { ...made, calls, sent, otp, last: (fn) => calls.filter((c) => c.fn === fn).at(-1)?.args };
}

test('delete slip: only with the delete permission; code goes to the owner\'s own number (last digits only)', async () => {
  const d = delDb();
  await rejects(d.ops.deleteCode(sales, { order_ids: [ORDER] }), 403);
  await rejects(d.ops.deleteCode(owner, { order_ids: [] }), 400);
  await rejects(d.ops.deleteCode(owner, { order_ids: ['nope'] }), 400);
  const r = await d.ops.deleteCode(owner, { order_ids: [ORDER, ORDER] });
  assert.equal(r.to, '+91 ••••• ••002');
  assert.equal(d.otp.sends, 1);
  assert.deepEqual(d.last('api_delete_check').p_orders, [ORDER]); // the same slip twice counts once
});

test('delete slip: wrong code → nothing deleted; right code → deleted with reason and money choice', async () => {
  const d = delDb();
  await rejects(d.ops.deleteSlips(owner, { order_ids: [ORDER], reason: 'Test entry', money: 'never', code: '111111' }, 'k1', 'h'), 400, 'wrong_code');
  assert.equal(d.calls.filter((c) => c.fn === 'api_delete_orders').length, 0);
  await rejects(d.ops.deleteSlips(owner, { order_ids: [ORDER], reason: '', money: 'never', code: '123456' }, 'k1', 'h'), 400);
  await rejects(d.ops.deleteSlips(owner, { order_ids: [ORDER], reason: 'x', money: 'lost', code: '123456' }, 'k1', 'h'), 400);
  await rejects(d.ops.deleteSlips(owner, { order_ids: [ORDER], reason: 'x', money: 'refund', mode: 'Adjust', code: '123456' }, 'k1', 'h'), 400);
  const r = await d.ops.deleteSlips(owner, { order_ids: [ORDER], reason: ' Test entry ', money: 'refund', mode: 'Cash', code: '123 456' }, 'k1', 'h');
  assert.equal(r.money, 'refund');
  assert.deepEqual(d.last('api_delete_orders'), { p_caller: 'p-owner', p_key: 'k1', p_hash: 'h', p_orders: [ORDER], p_reason: 'Test entry', p_money: 'refund', p_mode: 'Cash' });
  await rejects(d.ops.deleteSlips(sales, { order_ids: [ORDER], reason: 'x', money: 'none', code: '123456' }, 'k1', 'h'), 403);
});

test('delete slip: a retry after the code was used gets the first answer (no second SMS check)', async () => {
  const d = delDb({ codeOk: false, answered: { deleted: [{ id: ORDER }], replayed: true } });
  const r = await d.ops.deleteSlips(owner, { order_ids: [ORDER], reason: 'Test entry', money: 'never', code: '123456' }, 'k1', 'h');
  assert.equal(r.replayed, true);
  assert.equal(d.calls.filter((c) => c.fn === 'api_delete_orders').length, 0);
});

test('ask owner to delete: owners get a notification in their language; phone details never come back', async () => {
  const d = delDb();
  await rejects(d.ops.requestDelete(weigher, { order_id: ORDER, reason: '' }, 'k', 'h'), 400);
  const r = await d.ops.requestDelete(clerk, { order_id: ORDER, reason: 'Entered twice' }, 'k', 'h');
  assert.deepEqual(r, { request_id: 'r1', order_id: ORDER, slip_no: '1072', notified: 1, replayed: undefined });
  assert.equal(d.sent.length, 1);
  assert.match(d.sent[0].title, /डिलीट करने की मांग · #1072/);
  assert.equal(d.sent[0].body, 'Ramesh: Entered twice');
  assert.equal(d.sent[0].url, `#/slip/${ORDER}`);
});

test('evening summary lists slips deleted that day', async () => {
  const { ops } = eveDb();
  const d = await ops.daySummary(owner, { day: '2026-09-28' });
  assert.ok(!d.summary.look.some((x) => x.type === 'deleted'));
});

test('delete preview: owners only, shows the money, never sends a code or the phone number', async () => {
  const d = delDb();
  await rejects(d.ops.deletePreview(clerk, { order_ids: [ORDER] }), 403);
  const r = await d.ops.deletePreview(owner, { order_ids: [ORDER] });
  assert.equal(r.orders[0].paid, 1000);
  assert.equal(r.phone, undefined);
  assert.equal(d.otp.sends, 0);
});

// ---------- stock and purchases (30 Sept 2026) ----------
import { parseBillJson, normalizeBill } from './ops.js';
const MAT = '50000000-0000-4000-8000-000000000001';
function stockDb({ reader = null, quota = true } = {}) {
  const calls = []; const saved = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'api_ai_take') return quota;
    if (fn === 'api_save_purchase') return { purchase_id: 'p1', lines: args.p.lines.map((l, i) => ({ stock_item_id: `s${i}`, new: true })) };
    if (fn === 'api_stock_data') return { can_cost: false, materials: [], items: [{ id: 's1', material_id: MAT, code: 'EN8', shape: 'round', on_hand: 500, rate: null }],
      booked: [{ stock_item_id: 's1', slip_no: '1072', shape: 'round', unit: 'mm', dims: ['32'], density: 7850, min_inch: 1, lengths: [{ len: '1000', pcs: 12, cuts: null }] }] };
    return null;
  };
  const files = { save: async (c, data, mime) => { saved.push({ c: c.id, mime, n: data.length }); return `${c.company_id}/f1.pdf`; }, url: async (k) => `https://signed/${k}` };
  const made = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null, files, readBill: reader });
  return { ...made, calls, saved, last: (fn) => calls.filter((c) => c.fn === fn).at(-1)?.args };
}
const goodBill = (over = {}) => ({ kind: 'bill', bill_type: 'pakka', bill_no: '1187', bill_date: '2026-09-30', supplier: { name: 'Ludhiana Steel Rolling Mills', gstin: '03aakfr5521l1z4' },
  freight: 6000, gst: 58536, total: 383736, pay_status: 'to_pay',
  lines: [{ description: 'M.S. Round Bars', hsn: '7214 99', qty_kg: 5020, rate: 52.5, amount: 263550, material_id: MAT, shape: 'round' },
    { description: 'MS Square Bars 20 mm', hsn: '721499', qty_kg: 1050, rate: 53, amount: 55650, material_id: MAT, shape: 'square' }], ...over });

test('purchase bill: totals must add up (or be accepted), freight shared per kg, only "stock" people', async () => {
  const d = stockDb();
  await rejects(d.ops.savePurchase(sales, { bill: goodBill() }, 'k', 'h'), 403);
  await rejects(d.ops.savePurchase(owner, { bill: goodBill({ total: 383836 }) }, 'k', 'h'), 400, 'totals_differ');
  const r = await d.ops.savePurchase(owner, { bill: goodBill() }, 'k', 'h');
  assert.equal(r.purchase_id, 'p1');
  const p = d.last('api_save_purchase').p;
  assert.equal(p.total, 383736);
  assert.deepEqual(p.lines.map((l) => [l.hsn, l.freight_share, l.desc_key]), [['721499', 0.99, 'M S ROUND BARS'], ['721499', 0.99, 'MS SQUARE BARS 20 MM']]);
  assert.equal(p.supplier.gstin, '03AAKFR5521L1Z4');
  await d.ops.savePurchase(owner, { bill: goodBill({ total: 383836 }), accept_diff: true }, 'k2', 'h');
  assert.equal(d.last('api_save_purchase').p.total, 383836, 'accepted as on the bill');
  await rejects(d.ops.savePurchase(owner, { bill: goodBill({ lines: [{ qty_kg: 10, rate: 5, material_id: 'x' }] }) }, 'k', 'h'), 400);
  await rejects(d.ops.savePurchase(owner, { bill: goodBill({ bill_date: '30/09/2026' }) }, 'k', 'h'), 400);
  await d.ops.savePurchase(owner, { bill: { kind: 'opening', bill_date: '2026-09-30', lines: [{ description: 'Old stock', qty_kg: 300, rate: 70, material_id: MAT }] } }, 'k3', 'h');
  const o = d.last('api_save_purchase').p;
  assert.equal(o.bill_type, 'kacha'); assert.equal(o.supplier, null); assert.equal(o.gst, 0); assert.equal(o.total, 21000, 'opening stock: no supplier, no GST');
  await rejects(d.ops.savePurchase(sales, { bill: { ...goodBill(), bill_type: 'kacha', gst: 0, total: 325200 } }, 'k', 'h'), 403);
});

test('reading a bill: file kept; without the AI the person types it; with it, the reading comes back in kg and ₹/kg', async () => {
  let d = stockDb();
  await rejects(d.ops.readPurchaseBill(owner, { mime: 'text/html', data: 'aGVsbG8=' }), 400);
  let r = await d.ops.readPurchaseBill(owner, { mime: 'application/pdf', data: 'JVBERi0xLjQ=' });
  assert.deepEqual(r, { file_key: 'c1/f1.pdf', ai: false });
  assert.equal(d.saved.length, 1);
  const answer = '```json\n' + JSON.stringify({ supplier: { name: 'Ludhiana Steel Rolling Mills', gstin: '03AAKFR5521L1Z4' }, bill_no: '1187', bill_date: '2026-09-30', has_gst: true,
    lines: [{ description: 'MS Round Bars', hsn: '7214', qty: 5.02, qty_unit: 'mt', rate: 52500, rate_unit: 'mt', amount: 263550 },
      { description: 'MS Square Bars 20mm', hsn: '7214', qty: 1050, qty_unit: 'kg', rate: 53, rate_unit: 'kg', amount: 55650 }],
    freight: 6000, cgst: null, sgst: null, igst: 58536, round_off: 0, total: 383736, unsure: ['lines.1.qty'] }) + '\n```';
  d = stockDb({ reader: async () => answer });
  r = await d.ops.readPurchaseBill(owner, { mime: 'image/jpeg', data: 'aGVsbG8=' });
  assert.equal(r.ai, true);
  assert.deepEqual(r.bill.lines.map((l) => [l.qty_kg, l.rate, l.amount, l.line_ok]), [[5020, 52.5, 263550, true], [1050, 53, 55650, true]]);
  assert.deepEqual(r.bill.lines[1].unsure, ['qty']);
  assert.equal(r.bill.gst, 58536); assert.equal(r.bill.bill_type, 'pakka'); assert.ok(r.bill.totals.ok);
  d = stockDb({ reader: async () => 'sorry, I cannot read this' });
  assert.deepEqual(await d.ops.readPurchaseBill(owner, { mime: 'image/png', data: 'aGVsbG8=' }), { file_key: 'c1/f1.pdf', ai: false, reason: 'unreadable' });
  d = stockDb({ reader: async () => answer, quota: false });
  assert.equal((await d.ops.readPurchaseBill(owner, { mime: 'image/png', data: 'aGVsbG8=' })).reason, 'daily_limit');
  await rejects(stockDb().ops.readPurchaseBill(weigher, { mime: 'image/png', data: 'aGVsbG8=' }), 403);
});

test('bill reading helpers', () => {
  assert.deepEqual(parseBillJson('Here it is: {"a":1} thanks'), { a: 1 });
  assert.throws(() => parseBillJson('nothing'));
  const b = normalizeBill(core, { lines: [{ description: 'X', qty: 12.5, qty_unit: 'qtl', rate: 7800, rate_unit: 'qtl', amount: 97500 }], has_gst: false, total: 97500 });
  assert.equal(b.bill_type, 'kacha'); assert.equal(b.lines[0].qty_kg, 1250); assert.equal(b.lines[0].rate, 78); assert.ok(b.totals.ok);
  assert.equal(core.descKey(' M.S.  Round-Bars '), 'M S ROUND BARS');
});

test('stock data: what is already booked on open orders is worked out from the sizes', async () => {
  const d = stockDb();
  const r = await d.ops.stockData(weigher);
  const it = r.items[0];
  assert.ok(it.booked > 75 && it.booked < 76.5, `12 × 1 m of 32 mm round ≈ 75.8 kg (got ${it.booked})`);
  assert.equal(it.free, Math.round((500 - it.booked) * 1000) / 1000);
  assert.deepEqual(it.booked_slips, ['1072']);
});

test('orders carry the stock each item comes from', async () => {
  const { ops, last } = fakeDb();
  await ops.createOrder(owner, { customer_id: CUST, items: [{ material_id: EN8, shape: 'round', unit: 'mm', d: ['32'], rows: [{ len: '300', pcs: 12 }], stock_item_id: '60000000-0000-4000-8000-000000000001' }] }, 'k', 'h');
  assert.equal(last('api_create_order').p_items[0].stock_item_id, '60000000-0000-4000-8000-000000000001');
  await ops.createOrder(owner, { customer_id: CUST, items: [{ material_id: EN8, shape: 'round', unit: 'mm', d: ['32'], rows: [{ len: '300', pcs: 12 }], stock_item_id: 'nope' }] }, 'k2', 'h');
  assert.equal(last('api_create_order').p_items[0].stock_item_id, null, 'not a real id → no stock');
});

test('evening summary: low stock, below zero and sold without stock need a look', () => {
  const s = core.daySummary({ stock: { groups: [{ code: 'EN8', shape: 'round', kg: 390, lowKg: 500 }, { code: 'EN24', shape: null, kg: -12, lowKg: null, negative: true }, { code: 'MS', kg: 900, lowKg: 500 }], noStock: ['1080', '1081'] } });
  assert.deepEqual(s.look.map((x) => x.type), ['stock_negative', 'stock_low', 'no_stock']);
  assert.equal(s.look[2].n, 2);
});

// ---------- money accounts (6 Oct 2026) ----------
const SBI = '50000000-0000-4000-8000-000000000001', PTM = '50000000-0000-4000-8000-000000000002', CASH = '50000000-0000-4000-8000-000000000003';
test('money accounts: a split goes through api_pay in one go and must add up', async () => {
  const { ops, calls, last } = fakeDb();
  await rejects(ops.recordPayment(owner, { customer_id: CUST, amount: 3000, side: 'pakka',
    parts: [{ account_id: CASH, amount: 1000 }, { account_id: SBI, amount: 1500 }] }, 'k', 'h'), 400, 'split_differs');
  await rejects(ops.recordPayment(owner, { customer_id: CUST, amount: 3000, side: 'pakka',
    parts: [{ account_id: SBI, amount: 1500 }, { account_id: SBI, amount: 1500 }] }, 'k', 'h'), 400);
  await rejects(ops.recordPayment(owner, { customer_id: CUST, amount: 3000, side: 'pakka', parts: [{ account_id: 'x', amount: 3000 }] }, 'k', 'h'), 400);
  assert.equal(calls.length, 0);
  await ops.recordPayment(owner, { customer_id: CUST, amount: '3000', side: 'pakka',
    parts: [{ account_id: CASH, amount: 1000 }, { account_id: SBI, amount: '1500', method: 'RTGS' }, { account_id: PTM, amount: 500, method: 'Gold' }] }, 'k', 'h');
  const p = last('api_pay');
  assert.equal(p.p_op, 'api_record_payment');
  assert.deepEqual(p.p_parts, [{ account_id: CASH, amount: 1000 }, { account_id: SBI, amount: 1500, method: 'RTGS' }, { account_id: PTM, amount: 500 }]);
  assert.equal(p.p_account, null);
  assert.deepEqual(p.p_args, { p_caller: 'p-owner', p_key: 'k', p_hash: 'h', p_customer: CUST, p_amount: 3000, p_mode: 'Cash', p_side: 'pakka', p_note: null });
  // one account for the whole amount
  await ops.addAdvance(owner, { order_id: ORDER, amount: 2000, account_id: SBI, method: 'UPI' }, 'k2', 'h');
  assert.deepEqual(last('api_pay').p_account, { account_id: SBI, method: 'UPI' });
  assert.equal(last('api_pay').p_op, 'api_add_advance');
  // the old way still works (no account chosen)
  await ops.recordPayment(owner, { customer_id: CUST, amount: 10, mode: 'UPI', side: 'pakka' }, 'k3', 'h');
  assert.equal(calls.at(-1).fn, 'api_record_payment');
  await rejects(ops.recordPayment(owner, { customer_id: CUST, amount: 10, side: 'pakka' }, 'k4', 'h'), 400); // neither mode nor account
});

test('money accounts: pickup, advance on a new order, refunds and deletes take accounts too', async () => {
  const { ops, last } = fakeDb();
  await ops.finalizeOrder(owner, { order_id: ORDER, bill: 'pakka', pay_mode: 'part', paid: 1000,
    parts: [{ account_id: CASH, amount: 400 }, { account_id: PTM, amount: 600 }] }, 'k', 'h');
  assert.equal(last('api_pay').p_op, 'api_finalize_order');
  assert.equal(last('api_pay').p_args.p_final.paid_now, 1000);
  await rejects(ops.finalizeOrder(owner, { order_id: ORDER, bill: 'pakka', pay_mode: 'part', paid: 1000,
    parts: [{ account_id: CASH, amount: 400 }] }, 'k', 'h'), 400, 'split_differs');
  await ops.createOrder(owner, { customer_id: CUST, items: newItems, accept: true, advance: { amount: 500, account_id: PTM } }, 'k', 'h');
  assert.equal(last('api_pay').p_op, 'api_create_order');
  assert.equal(last('api_pay').p_args.p_advance.amount, 500);
  await ops.adjustAdvance(owner, { order_id: ORDER, action: 'refund', amount: 100, account_id: SBI, method: 'IMPS', note: 'asked' }, 'k', 'h');
  assert.deepEqual(last('api_pay').p_account, { account_id: SBI, method: 'IMPS' });
  await ops.adjustAdvance(owner, { order_id: ORDER, action: 'move', amount: 100, target_order_id: ORDER, account_id: SBI }, 'k5', 'h');
  assert.equal(last('api_adjust_advance').p_target, ORDER, 'moving money inside the khata takes no account');
});

test('money accounts: settings list, saving, order and ticks are for owners', async () => {
  const { ops, last } = fakeDb();
  await rejects(ops.accounts(sales, { all: true }), 403);
  await rejects(ops.accounts(clerk, {}), 403);
  await ops.accounts(sales, {});
  assert.deepEqual(last('api_accounts'), { p_caller: 'p-sales', p_all: false });
  await rejects(ops.saveAccount(sales, { account: { name: 'SBI', kind: 'bank' } }, 'k', 'h'), 403);
  await rejects(ops.saveAccount(owner, { account: { name: '  ', kind: 'bank' } }, 'k', 'h'), 400);
  await rejects(ops.saveAccount(owner, { account: { name: 'X', kind: 'gold' } }, 'k', 'h'), 400);
  await ops.saveAccount(owner, { account: { name: ' SBI current ', kind: 'bank', owner: 'firm', number: ' 50100012347730 ', staff_can: false } }, 'k', 'h');
  assert.deepEqual(last('api_save_account').p_account, { id: null, name: 'SBI current', kind: 'bank', owner: 'firm', number: '50100012347730', staff_can: false });
  await rejects(ops.checkAccount(owner, { account_id: SBI, day: 'today' }, 'k', 'h'), 400);
  await ops.checkAccount(owner, { account_id: SBI, day: '2026-10-06', checked: false }, 'k', 'h');
  assert.equal(last('api_check_account').p_checked, false);
  await rejects(ops.orderAccounts(owner, { ids: ['x'] }, 'k', 'h'), 400);
});

test('money accounts: the evening tally comes from the parts; the drawer expects only cash', async () => {
  const day = { timezone: 'Asia/Kolkata', day: '2026-10-06', today: '2026-10-06', shop: 'S', settings: { weight_warn_pct: 5, min_inch: 1 },
    orders: [], weighed: [], waiting: [], cancelled: [], cash_close: null, last_week: null,
    payments: [{ id: 'p1', amount: 25000, kind: 'pickup', rev: false, mode: 'Cash+UPI+Bank', customer: 'Gupta', at: '2026-10-06T06:00:00Z',
      parts: [{ mode: 'Cash', amount: 10000, account_id: CASH }, { mode: 'Bank', amount: 12000, account_id: SBI }, { mode: 'UPI', amount: 3000, account_id: PTM }] },
    { id: 'p2', amount: 700, kind: 'khata', rev: false, mode: 'UPI', customer: 'Rana', at: '2026-10-06T07:00:00Z', parts: null }] };
  const acc = { day: '2026-10-06', checks: [SBI],
    accounts: [{ id: CASH, name: 'Shop cash', kind: 'cash', owner: 'firm', is_drawer: true, hidden: false },
      { id: SBI, name: 'SBI current', kind: 'bank', owner: 'firm', is_drawer: false, hidden: false },
      { id: PTM, name: 'Paytm', kind: 'paytm', owner: 'personal', is_drawer: false, hidden: false }],
    parts: [{ account_id: CASH, amount: 10000, payment_id: 'p1', customer: 'Gupta' }, { account_id: SBI, amount: 12000, payment_id: 'p1', customer: 'Gupta' },
      { account_id: PTM, amount: 3000, payment_id: 'p1', customer: 'Gupta' }] };
  const rpc = async (fn) => (fn === 'api_day_data' ? structuredClone(day) : fn === 'api_day_accounts' ? structuredClone(acc) : fn === 'api_day_stock' ? null : fn === 'api_khata_data' ? { customers: [], orders: [], payments: [], old_dues: [], timezone: 'Asia/Kolkata', settings: {} } : []);
  const { ops } = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null });
  const d = await ops.daySummary(owner, {});
  assert.equal(d.summary.cash.expected, 10000);
  assert.deepEqual(d.summary.money.byMode, { Cash: 10000, UPI: 3700, Bank: 12000, Cheque: 0 });
  const t = d.summary.accounts;
  assert.equal(t.firm, 22000);
  assert.equal(t.personal, 3000);
  assert.equal(t.notPlaced, 700);
  assert.equal(t.rows.find((r) => r.id === SBI).checked, true);
  assert.equal(d.account_parts.length, 3);
  const s = await ops.daySummary(sales, {});
  assert.equal(s.summary.accounts, null, 'the tally is for owners');
  assert.equal(s.account_parts, undefined);
});

// ---------- money out: expenses, money moved, the cash book (23 Oct 2026) ----------
const ACC = '50000000-0000-4000-8000-000000000001', ACC2 = '50000000-0000-4000-8000-000000000002', SUP = '60000000-0000-4000-8000-000000000001';
const BILL1 = '70000000-0000-4000-8000-000000000001';
const accountsPerson = { id: 'p-acc', company_id: 'c1', perms: core.ROLE_PRESETS.accounts() };
function moneyDb(extra = {}) {
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'api_expenses') return { items: [{ kind: 'expense', category: 'tea', amount: '120', account_id: ACC, is_drawer: true, status: 'ok' },
      { kind: 'expense', category: 'tea', amount: '50', account_id: ACC, is_drawer: true, status: 'cancelled' }], transfers: [], suppliers: [] };
    if (fn === 'api_account_book') return extra.book;
    if (fn === 'api_expense_file') return extra.fileKey ?? null;
    return { ok: true };
  };
  const files = { save: async () => 'c1/2026-10/x.jpg', url: async (k) => `https://signed/${k}` };
  const { ops } = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null, files });
  return { ops, calls, last: (fn) => calls.filter((c) => c.fn === fn).at(-1)?.args };
}

test('saveExpense: who may save which kind; the amount, GST and the seller\'s GST number are checked', async () => {
  const { ops, last } = moneyDb();
  await ops.saveExpense(accountsPerson, { category: 'tea', amount: '120.456', account_id: ACC }, 'k', 'h');
  let p = last('api_save_expense').p;
  assert.equal(p.kind, 'expense'); assert.equal(p.category, 'tea'); assert.equal(p.amount, 120.46); assert.equal(p.at, null); assert.equal(p.offline, false);
  await ops.saveExpense(accountsPerson, { category: 'Not A Key', amount: 10, account_id: ACC, file_key: 'other-company/x.jpg' }, 'k', 'h');
  p = last('api_save_expense').p;
  assert.equal(p.category, 'other', 'unknown category = other');
  assert.equal(p.file_key, null, 'a file of another company is never linked');
  await rejects(ops.saveExpense(sales, { category: 'tea', amount: 10, account_id: ACC }, 'k', 'h'), 403);
  await rejects(ops.saveExpense(accountsPerson, { kind: 'owner', amount: 10, account_id: ACC }, 'k', 'h'), 403, 'not_allowed');
  await rejects(ops.saveExpense(accountsPerson, { kind: 'supplier', supplier_id: SUP, amount: 10, account_id: ACC }, 'k', 'h'), 403);
  await rejects(ops.saveExpense(accountsPerson, { category: 'tea', amount: 0, account_id: ACC }, 'k', 'h'), 400);
  await rejects(ops.saveExpense(accountsPerson, { category: 'tea', amount: 10 }, 'k', 'h'), 400);
  await rejects(ops.saveExpense(accountsPerson, { category: 'blade', amount: 1180, account_id: ACC, gst_bill: true, gst_amount: 1180 }, 'k', 'h'), 400);
  await rejects(ops.saveExpense(accountsPerson, { category: 'blade', amount: 1180, account_id: ACC, gst_bill: true, seller_gstin: '07AAACR5055K1Z4' }, 'k', 'h'), 400);
  await ops.saveExpense(accountsPerson, { category: 'blade', amount: 1180, account_id: ACC2, method: 'NEFT', gst_bill: true, gst_amount: '180', bill_no: ' B-77 ',
    seller_gstin: '07aaacr5055k1z9', day: '2026-10-20' }, 'k', 'h');
  p = last('api_save_expense').p;
  assert.deepEqual([p.gst_bill, p.gst_amount, p.bill_no, p.seller_gstin, p.method, p.at], [true, 180, 'B-77', '07AAACR5055K1Z9', 'NEFT', '2026-10-20T12:00:00+05:30']);
  // no GST bill: GST details are dropped
  await ops.saveExpense(accountsPerson, { category: 'tea', amount: 100, account_id: ACC, gst_amount: 18, seller_gstin: 'x' }, 'k', 'h');
  p = last('api_save_expense').p;
  assert.deepEqual([p.gst_bill, p.gst_amount, p.seller_gstin], [false, null, null]);
  // the owner: paid a supplier (and his bills), or took money for home
  await ops.saveExpense(owner, { kind: 'supplier', supplier_id: SUP, purchase_ids: [BILL1, BILL1], amount: 150000, account_id: ACC2, method: 'RTGS' }, 'k', 'h');
  p = last('api_save_expense').p;
  assert.deepEqual([p.kind, p.category, p.supplier_id, p.purchase_ids], ['supplier', 'supplier', SUP, [BILL1]]);
  await ops.saveExpense(owner, { kind: 'owner', amount: 5000, account_id: ACC, offline_at: '2026-10-23T08:15:00.000Z' }, 'k', 'h');
  p = last('api_save_expense').p;
  assert.deepEqual([p.kind, p.category, p.at, p.offline], ['owner', 'home', '2026-10-23T08:15:00.000Z', true]);
  await rejects(ops.saveExpense(owner, { kind: 'owner', amount: 5000, account_id: ACC, offline_at: 'yesterday' }, 'k', 'h'), 400);
  await rejects(ops.saveExpense(owner, { kind: 'gift', amount: 5000, account_id: ACC }, 'k', 'h'), 400);
});

test('expenses list: totals leave out cancelled ones; cancelling needs a reason', async () => {
  const { ops } = moneyDb();
  const r = await ops.expenses(accountsPerson, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(r.totals.total, 120); assert.equal(r.totals.n, 1);
  await rejects(ops.expenses(accountsPerson, { from: 'x', to: '2026-10-31' }), 400);
  await rejects(ops.expenses(weigher, { from: '2026-10-01', to: '2026-10-31' }), 403);
  await rejects(ops.cancelExpense(accountsPerson, { id: ACC, reason: ' ' }, 'k', 'h'), 400);
});

test('receipts: photo saved with the company, link only for that company', async () => {
  const { ops } = moneyDb({ fileKey: 'c1/2026-10/x.jpg' });
  assert.deepEqual(await ops.uploadReceipt(accountsPerson, { mime: 'image/jpeg', data: 'aGVsbG8=' }), { file_key: 'c1/2026-10/x.jpg' });
  await rejects(ops.uploadReceipt(accountsPerson, { mime: 'text/plain', data: 'aGVsbG8=' }), 400);
  assert.deepEqual(await ops.expenseFile(accountsPerson, { id: ACC }), { url: 'https://signed/c1/2026-10/x.jpg' });
  const other = moneyDb({ fileKey: 'c2/2026-10/y.jpg' });
  assert.deepEqual(await other.ops.expenseFile(accountsPerson, { id: ACC }), { url: null });
});

test('moving money: two different accounts, an amount; kind of move kept', async () => {
  const { ops, last } = moneyDb();
  await ops.saveTransfer(accountsPerson, { from_account: ACC, to_account: ACC2, amount: '50000', reason: 'deposit', method: 'Cheque' }, 'k', 'h');
  assert.deepEqual(last('api_save_transfer').p, { from_account: ACC, to_account: ACC2, amount: 50000, reason: 'deposit', method: 'Cheque', note: null, at: null, offline: false });
  await ops.saveTransfer(accountsPerson, { from_account: ACC, to_account: ACC2, amount: 1, reason: 'close' }, 'k', 'h');
  assert.equal(last('api_save_transfer').p.reason, 'move', 'closing moves are made by the cash count only');
  await rejects(ops.saveTransfer(accountsPerson, { from_account: ACC, to_account: ACC, amount: 1 }, 'k', 'h'), 400);
  await rejects(ops.saveTransfer(sales, { from_account: ACC, to_account: ACC2, amount: 1 }, 'k', 'h'), 403);
});

test('cash count: what is taken home is checked and goes with the count', async () => {
  const { ops, last } = moneyDb();
  await ops.saveCashCount(accountsPerson, { counted: '45979.5', take: '43979.5', take_to: ACC2, note: ' ok ' }, 'k', 'h');
  assert.deepEqual(last('api_close_cash'), { p_caller: 'p-acc', p_key: 'k', p_hash: 'h', p_counted: 45979.5, p_note: 'ok', p_take: 43979.5, p_take_to: ACC2, p_at: null });
  await ops.saveCashCount(accountsPerson, { counted: 1000 }, 'k', 'h');
  assert.deepEqual([last('api_close_cash').p_take, last('api_close_cash').p_take_to], [0, null]);
  await rejects(ops.saveCashCount(accountsPerson, { counted: 1000, take: 1000.01 }, 'k', 'h'), 400);
  await rejects(ops.saveCashCount(sales, { counted: 1000 }, 'k', 'h'), 403);
});

test('account book: running balance from the opening, reset at each balance point', async () => {
  const book = { account: { id: ACC2, is_drawer: false }, opening: { known: true, balance: 10000 },
    moves: [{ at: '2026-10-21T05:00:00Z', amount: '5000' }, { at: '2026-10-22T05:00:00Z', amount: '-1200' }, { at: '2026-10-23T05:00:00Z', amount: '300' }],
    points: [{ at: '2026-10-22T12:00:00Z', balance: '13500', expected: '13800', source: 'passbook' }] };
  const { ops } = moneyDb({ book });
  const r = await ops.accountBook(owner, { id: ACC2, from: '2026-10-21', to: '2026-10-23' });
  assert.deepEqual(r.rows.map((x) => x.balance), [15000, 13800, 13500, 13800]);
  assert.equal(r.rows[2].before, 13800);
  const unknown = moneyDb({ book: { ...book, opening: { known: false, balance: 999 }, points: [] } });
  assert.deepEqual((await unknown.ops.accountBook(owner, { id: ACC2, from: '2026-10-21', to: '2026-10-23' })).rows.map((x) => x.balance), [null, null, null]);
  await rejects(ops.accountBook(accountsPerson, { id: ACC2, from: '2026-10-21', to: '2026-10-23' }), 403);
});

test('daySummary: money out and the drawer\'s cash book come in', async () => {
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push(fn);
    if (fn === 'api_day_data') return { timezone: 'Asia/Kolkata', day: '2026-10-23', today: '2026-10-23', shop: 'S', settings: { weight_warn_pct: 5, min_inch: 1 },
      orders: [], payments: [{ amount: 45000, kind: 'pickup', mode: 'Cash', customer: 'Gupta', parts: [{ mode: 'Cash', amount: 45000, account_id: ACC }] }], weighed: [], waiting: [], cancelled: [] };
    if (fn === 'api_day_money') return { expenses: [{ kind: 'expense', category: 'tea', amount: '120', account_id: ACC, is_drawer: true, mode: 'Cash' }],
      transfers: [{ amount: '40000', from: 'Shop cash', to: 'Cash at home', from_account: ACC, to_account: ACC2, reason: 'close' }],
      cash_book: { opening: 2000, in: 45000, out: 40120, expected: 6880, counts: [{ expected: 46880, counted: 46880, taken_out: 40000 }] } };
    if (fn === 'api_day_accounts') return { accounts: [{ id: ACC, name: 'Shop cash', is_drawer: true }, { id: ACC2, name: 'Cash at home', kind: 'safe' }],
      parts: [{ account_id: ACC, amount: 45000, mode: 'Cash' }], checks: [] };
    if (fn === 'api_khata_data') return { timezone: 'Asia/Kolkata', customers: [], orders: [], payments: [], old_dues: [], settings: { reminder_after_days: 25 }, last_reminders: [] };
    return [];
  };
  const { ops } = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null });
  const s = (await ops.daySummary(owner, { day: '2026-10-23' })).summary;
  assert.deepEqual([s.cash.book, s.cash.opening, s.cash.expected, s.cash.diff, s.cash.left], [true, 2000, 46880, 0, 6880]);
  assert.equal(s.out.total, 120);
  assert.equal(s.moved.length, 1);
  assert.deepEqual(s.accounts.rows.map((r) => [r.name, r.in, r.out]), [['Shop cash', 45000, 40120], ['Cash at home', 40000, 0]]);
});


// ---------- offline entries, GST check, fingerprint (23 Oct 2026) ----------
test('offline: the real time goes with the entry (api_run), ids chosen on the phone are kept', async () => {
  const { ops, calls } = fakeDb();
  const OID = '80000000-0000-4000-8000-000000000001', IID = '80000000-0000-4000-8000-000000000002';
  await ops.createOrder(owner, { customer_id: CUST, order_id: OID, items: [{ ...newItems[0], id: IID }, newItems[1]], accept: true,
    offline_at: '2026-10-23T05:30:00+05:30' }, 'k', 'h');
  const run = calls.filter((c) => c.fn === 'api_run').at(-1).args;
  assert.equal(run.p_op, 'api_create_order');
  assert.equal(run.p_at, '2026-10-23T00:00:00.000Z');
  assert.equal(run.p_args.p_order_id, OID);
  assert.equal(run.p_args.p_items[0].id, IID);
  assert.equal(run.p_args.p_items[1].id, undefined, 'only ids the phone chose');
  await ops.recordPayment(owner, { customer_id: CUST, side: 'pakka', amount: 500, mode: 'Cash', offline_at: '2026-10-23T06:00:00Z' }, 'k', 'h');
  assert.equal(calls.filter((c) => c.fn === 'api_run').at(-1).args.p_op, 'api_record_payment');
  await ops.recordPayment(owner, { customer_id: CUST, side: 'pakka', amount: 500, mode: 'Cash' }, 'k', 'h');
  assert.equal(calls.at(-1).fn, 'api_record_payment', 'online: straight to the database as before');
  await ops.createCustomer(owner, { name: 'Walk-in Ram', id: OID, offline_at: '2026-10-23T06:00:00Z' }, 'k', 'h');
  const cc = calls.filter((c) => c.fn === 'api_run').at(-1).args;
  assert.deepEqual([cc.p_op, cc.p_args.p_id], ['api_create_customer', OID]);
  assert.throws(() => offlineAt('23/10/2026'), (e) => e.status === 400);
  assert.equal(offlineAt(null), null);
});

test('GST check: a recent check is used again; without the service it says so; a portal check is saved', async () => {
  const calls = [];
  let last = null;
  const rpc = async (fn, args) => { calls.push({ fn, args }); if (fn === 'api_gst_last') return last; if (fn === 'api_gst_save') return { ...args.p, id: 'g1' }; if (fn === 'api_suppliers') return []; return null; };
  const answers = { '07AAACR5055K1Z9': { data: { data: { sts: 'Cancelled', lgnm: 'RAJ STEELS', cxdt: '12/08/2026' } } } };
  const lookups = [];
  const gstLookup = async (g) => { lookups.push(g); return answers[g] || { message: 'GSTIN not found' }; };
  const on = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null, gstLookup }).ops;
  const off = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null }).ops;
  assert.deepEqual(await off.gstCheck(owner, { gstin: '07aaacr5055k1z9' }, 'k', 'h'), { service: false, check: null });
  let r = await on.gstCheck(owner, { gstin: '07AAACR5055K1Z9' }, 'k', 'h');
  assert.deepEqual([r.service, r.check.status, r.check.cancel_date, r.check.legal_name, r.check.source], [true, 'cancelled', '2026-08-12', 'RAJ STEELS', 'service']);
  last = { status: 'active', checked_at: '2026-10-22T00:00:00Z' };
  r = await on.gstCheck(owner, { gstin: '07AAACR5055K1Z9' }, 'k', 'h');
  assert.equal(r.cached, true); assert.equal(lookups.length, 1, 'no second paid lookup within 7 days');
  r = await on.gstCheck(owner, { gstin: '07AAACR5055K1Z9', refresh: true }, 'k', 'h');
  assert.equal(lookups.length, 2, 'unless asked again');
  await rejects(on.gstCheck(owner, { gstin: '07AAACR5055K1Z4' }, 'k', 'h'), 400);
  await rejects(on.gstCheck(accountsPerson, { gstin: '07AAACR5055K1Z9' }, 'k', 'h'), 403);
  await on.gstMark(owner, { gstin: '07AAACR5055K1Z9', status: 'active', cancel_date: '2026-08-12', note: 'portal' }, 'k', 'h');
  assert.deepEqual(calls.filter((c) => c.fn === 'api_gst_save').at(-1).args.p, { gstin: '07AAACR5055K1Z9', status: 'active', legal_name: null, cancel_date: null, source: 'portal', note: 'portal' });
  await rejects(on.gstMark(owner, { gstin: '07AAACR5055K1Z9', status: 'fine' }, 'k', 'h'), 400);
  assert.equal((await on.suppliers(owner)).service, true);
});

test('GST service: sandbox signs in once, then searches; a custom service gets the number in its address', async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push([url, init.method, init.headers]); return { status: 200, text: async () => (url.endsWith('/authenticate') ? '{"access_token":"T"}' : '{"data":{"data":{"sts":"Active"}}}') }; };
  const sb = makeGstLookup({ provider: 'sandbox', key: 'K', secret: 'S', fetchFn });
  assert.equal(core.readGstAnswer(await sb('07AAACR5055K1Z9')).status, 'active');
  await sb('07AAACR5055K1Z9');
  assert.deepEqual(seen.map((x) => x[0].split('/').slice(3).join('/')), ['authenticate', 'gst/compliance/public/gstin/search', 'gst/compliance/public/gstin/search']);
  assert.equal(seen[1][2].Authorization, 'T');
  const cu = makeGstLookup({ provider: 'custom', key: 'K', url: 'https://gst.example/{gstin}', headers: '{"apikey":"K"}', fetchFn });
  await cu('07AAACR5055K1Z9');
  assert.deepEqual(seen.at(-1).slice(0, 2), ['https://gst.example/07AAACR5055K1Z9', 'GET']);
  assert.equal(makeGstLookup({ provider: 'sandbox', key: '' }), null, 'no key = switched off');
});

test('GST recheck job: due numbers checked, answers saved for their shop', async () => {
  const calls = [];
  const rpc = async (fn, args) => { calls.push({ fn, args }); if (fn === 'api_gst_due') return [{ company_id: 'c1', gstin: '07AAACR5055K1Z9' }, { company_id: 'c2', gstin: '03AAKFR5521L1Z4' }]; return {}; };
  const { runGstChecks } = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null, gstLookup: async (g) => (g.startsWith('07') ? { sts: 'Suspended' } : { nothing: true }) });
  assert.deepEqual(await runGstChecks(), { due: 2, checked: 1 });
  assert.deepEqual(calls.find((c) => c.fn === 'api_gst_save_job').args.p.status, 'suspended');
  const none = makeOps({ core, rpc, companySettings: async () => ({}), askModel: null });
  assert.deepEqual(await none.runGstChecks(), { skipped: 'no_gst_service' });
});

test('fingerprint: switch on (fresh PIN), unlock with the finger, refused when the answer is wrong', async () => {
  const store = { challenge: null, key: null, unlocked: 0 };
  const calls = [];
  const rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'api_passkey_begin') { store.challenge = core.newChallenge(); return { challenge: store.challenge, person_id: 'p-owner', name: 'Papa', credentials: store.key ? [{ id: store.key.id }] : [] }; }
    if (fn === 'api_passkey_save') { store.key = { id: args.p_credential_id, public_key: args.p_public_key, alg: args.p_alg }; return { id: 'k1' }; }
    if (fn === 'api_passkey_key') return store.key && args.p_credential_id === store.key.id ? { public_key: store.key.public_key, alg: store.key.alg, sign_count: 0 } : null;
    if (fn === 'api_passkey_unlock') { store.unlocked++; return { ok: args.p_challenge === store.challenge }; }
    return null;
  };
  const px = makePasskeyOps({ core, rpc, origins: ['http://localhost:8173'] });
  const who = { user: 'u1', session: 's1', unlocked: true, phone: '+919000000001' };
  const p = await phone();
  const reg = await px.passkeyBegin(who, { purpose: 'register' });
  assert.equal(reg.user.displayName, 'Papa'); assert.equal(reg.user.name, '+919000000001');
  await px.passkeyRegister(who, { challenge: reg.challenge, ...p.create(reg.challenge), label: 'Papa phone' });
  assert.equal(store.key.id, p.credId);
  await rejects(px.passkeyBegin({ ...who, unlocked: false }, { purpose: 'register' }), 401, 'pin_required');
  const locked = { ...who, unlocked: false };
  const b = await px.passkeyBegin(locked, { purpose: 'unlock' });
  assert.deepEqual(b.credentials, [p.credId]);
  const ans = await p.get(b.challenge);
  assert.deepEqual(await px.passkeyUnlock(locked, { challenge: b.challenge, credential_id: p.credId, ...ans }), { ok: true, credential_id: p.credId, jwk: store.key.public_key, alg: store.key.alg }, 'the public key comes back (a phone that forgot it keeps it again)');
  assert.equal(calls.filter((c) => c.fn === 'api_passkey_unlock').at(-1).args.p_sign_count, 1);
  // someone else's phone answering, an unknown key, a wrong challenge
  const other = await phone();
  const b2 = await px.passkeyBegin(locked, { purpose: 'unlock' });
  await rejects(px.passkeyUnlock(locked, { challenge: b2.challenge, credential_id: p.credId, ...(await other.get(b2.challenge)) }), 401, 'passkey_failed');
  await rejects(px.passkeyUnlock(locked, { challenge: b2.challenge, credential_id: other.credId, ...(await other.get(b2.challenge)) }), 401, 'passkey_failed');
  await rejects(px.passkeyUnlock(locked, { challenge: 'x', credential_id: p.credId, ...ans }), 401, 'passkey_failed');
  await rejects(px.passkeyUnlock(locked, { challenge: 'not base64!', credential_id: p.credId, ...ans }), 400);
  assert.equal(store.unlocked, 1, 'only the good answer unlocked');
});
