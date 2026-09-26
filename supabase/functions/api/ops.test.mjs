// Unit tests for the api operations (no network): npm run test:api
// The database is replaced by a fake that records what would be saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../../packages/core/src/index.js';
import { makeOps, stableStringify, mapDbError, ApiError, coreItemFromDb } from './ops.js';

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
