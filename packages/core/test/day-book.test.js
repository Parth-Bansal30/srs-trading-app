// The Day book (plan v2 step 11) — made-up numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayBookPeriod, dayBookShift, dayBookSummary, heatStep, stockOnSummary, steelKey } from '../src/dayBook.js';

test('periods: a day, the week from Monday, the month so far compared with the same days before', () => {
  assert.deepEqual(dayBookPeriod('day', '2026-11-04', '2026-11-04'), { kind: 'day', from: '2026-11-04', to: '2026-11-04', prevFrom: '2026-11-03', prevTo: '2026-11-03' });
  assert.deepEqual(dayBookPeriod('week', '2026-11-04', '2026-11-04'), { kind: 'week', from: '2026-11-02', to: '2026-11-04', prevFrom: '2026-10-26', prevTo: '2026-10-28' });
  assert.deepEqual(dayBookPeriod('month', '2026-11-04', '2026-11-04'), { kind: 'month', from: '2026-11-01', to: '2026-11-04', prevFrom: '2026-10-01', prevTo: '2026-10-04' });
  assert.deepEqual(dayBookPeriod('month', '2026-10-15', '2026-11-04'), { kind: 'month', from: '2026-10-01', to: '2026-10-31', prevFrom: '2026-09-01', prevTo: '2026-09-30' });
  assert.equal(dayBookPeriod('month', '2026-03-10', '2026-11-04').prevTo, '2026-02-28', 'February is shorter');
  assert.equal(dayBookShift(dayBookPeriod('day', '2026-11-04', '2026-11-04'), 1, '2026-11-04'), null, 'never past today');
  assert.equal(dayBookShift(dayBookPeriod('month', '2026-11-04', '2026-11-04'), -1, '2026-11-04').from, '2026-10-01');
});

test('the sums: sales by bill, left in khata, money in / out, bought, rough profit, GST, most sold', () => {
  const raw = {
    slips: [
      { id: 'a', day: '2026-11-04', bill: 'pakka', total: 30450, gst: 4645, kg: 420, paid: 30450, cost: 22000, items: [{ g: 'MS', sh: 'round', d: ['12'], u: 'mm', kg: 420 }] },
      { id: 'b', day: '2026-11-04', bill: 'kacha', total: 2410, gst: 0, kg: 36, paid: 2410, cost: null, items: [{ g: 'MS', sh: 'flat', d: ['50', '6'], u: 'mm', kg: 36 }] },
      { id: 'c', day: '2026-11-03', bill: 'pakka', total: 28830, gst: 4398, kg: 310, paid: 18830, cost: 20000, items: [{ g: 'MS', sh: 'round', d: ['12'], u: 'mm', kg: 300 }, { g: 'EN8', sh: 'round', d: ['40'], u: 'mm', kg: 10 }] },
    ],
    prev: { total: 50000, slips: 4 },
    money_in: [{ mode: 'Cash', amount: 48000 }, { mode: 'UPI', amount: 4300 }, { mode: 'NEFT', amount: 100000 }],
    money_out: [{ kind: 'supplier', category: 'supplier', amount: 80000, cash: false, gst: 0 }, { kind: 'expense', category: 'labour', amount: 12000, cash: true, gst: 0 },
      { kind: 'expense', category: 'tea', amount: 450, cash: true, gst: 0 }, { kind: 'owner', category: 'home', amount: 5000, cash: true, gst: 0 }],
    bought: [{ total: 125670, kg: 1850, bill: 'pakka', gst: 19170 }],
  };
  const s = dayBookSummary(raw);
  assert.deepEqual([s.sales.total, s.sales.slips, s.sales.kg, s.sales.gst_bills, s.sales.no_bill, s.sales.left, s.sales.left_slips], [61690, 3, 766, 59280, 2410, 10000, 1]);
  assert.deepEqual([s.money_in.total, s.money_in.cash, s.money_in.bank], [152300, 48000, 104300]);
  assert.deepEqual([s.money_out.total, s.money_out.supplier, s.money_out.other, s.money_out.home], [92450, 80000, 12450, 5000], 'money taken home is not a shop expense');
  assert.deepEqual(s.money_out.by_category[0], { category: 'labour', amount: 12000 });
  assert.deepEqual([s.bought.total, s.bought.kg], [125670, 1850]);
  assert.deepEqual([s.profit.amount, s.profit.known, s.profit.unknown], [30450 - 4645 - 22000 + 28830 - 4398 - 20000, 2, 1], 'slips with no known cost are left out');
  assert.equal(s.gst.to_pay, 4645 + 4398 - 19170, 'GST on sales − GST on purchases (rough; the CA confirms)');
  assert.equal(s.change, 23, '+23% on the period before');
  assert.deepEqual([s.top[0].key, s.top[0].g, s.top[0].sh, s.top[0].kg, s.top[0].slips], ['MS round 12mm', 'MS', 'round', 720, 2]);
  assert.equal(s.best.day, '2026-11-04');
  assert.equal(steelKey({ g: 'MS', sh: 'flat', d: ['2 1/2', '1'], u: 'in' }), 'MS flat 2 1/2×1"');
});

test('the calendar colours and the stock as on a day', () => {
  assert.deepEqual([heatStep(0, 100), heatStep(10, 100), heatStep(60, 100), heatStep(100, 100)], [0, 1, 3, 4]);
  const st = stockOnSummary([
    { material_id: 'm1', code: 'MS', shape: 'round', then: 4860, in: 6000, out: 5140, now: 3420, cost: 52 },
    { material_id: 'm1', code: 'MS', shape: 'round', then: 100, in: 0, out: 0, now: 100, cost: 50 },
    { material_id: 'm2', code: 'MS', shape: 'square', then: 180, in: 0, out: 960, now: -40, cost: 55 },
  ]);
  assert.deepEqual(st.items.map((x) => [x.code, x.shape, x.then, x.now]), [['MS', 'round', 4960, 3520], ['MS', 'square', 180, -40]]);
  assert.equal(st.kg, 5140); assert.equal(st.worth, 4860 * 52 + 100 * 50 + 180 * 55); assert.equal(st.low, 1);
  const blind = stockOnSummary([{ material_id: 'm1', code: 'EN8', shape: 'round', then: 500, in: 0, out: 0, now: 500, cost: null }]);
  assert.equal(blind.worth, null); assert.equal(blind.items[0].worth, null); assert.equal(blind.kg, 500);
});
