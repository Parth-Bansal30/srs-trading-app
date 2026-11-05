// Supplier khata (plan v2 F6) — all names and numbers made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supplierLedger, suggestSupplierAllocation, allocationProblem } from '../src/supplierLedger.js';

const sup = { id: 's1', credit_days: 30 };

test('a bill with 30 days: due date, part paid, overdue the day after', () => {
  const raw = { supplier: sup, bills: [{ id: 'b1', bill_no: 'SBM/1184', date: '2026-10-28', side: 'pakka', total: 125670 }],
    payments: [{ id: 'p1', amount: 80000, day: '2026-11-04' }], allocations: [{ expense_id: 'p1', purchase_id: 'b1', amount: 80000 }] };
  const a = supplierLedger(raw, '2026-11-27');
  assert.equal(a.bills[0].due_date, '2026-11-27');
  assert.equal(a.bills[0].left, 45670); assert.equal(a.bills[0].status, 'part');
  assert.equal(a.due, 45670); assert.equal(a.overdue, 0, 'not overdue on its due date');
  const b = supplierLedger(raw, '2026-11-28');
  assert.equal(b.overdue, 45670); assert.equal(b.overdue_n, 1); assert.equal(b.bills[0].overdue_days, 1);
});

test('oldest first is only a suggestion; the person\'s split is what counts', () => {
  const open = [{ kind: 'bill', id: 'new', date: '2026-10-20', left: 82400 }, { kind: 'bill', id: 'old', date: '2026-10-01', left: 60000 }];
  assert.deepEqual(suggestSupplierAllocation(100000, open), { parts: [{ purchase_id: 'old', amount: 60000 }, { purchase_id: 'new', amount: 40000 }], advance: 0 });
  assert.equal(allocationProblem(100000, [{ purchase_id: 'new', amount: 100000 }], open), 'sa_over_bill');
  assert.equal(allocationProblem(100000, [{ purchase_id: 'new', amount: 82400 }], open), null, 'the rest is an advance');
  assert.equal(allocationProblem(100000, [{ purchase_id: 'new', amount: 82400 }, { purchase_id: 'old', amount: 30000 }], open), 'sa_over_payment');
  const raw = { supplier: sup, bills: [{ id: 'old', date: '2026-10-01', total: 60000 }, { id: 'new', date: '2026-10-20', total: 82400 }],
    payments: [{ id: 'p', amount: 100000, day: '2026-10-25' }], allocations: [{ expense_id: 'p', purchase_id: 'new', amount: 82400 }] };
  const l = supplierLedger(raw, '2026-10-26');
  assert.equal(l.bills.find((b) => b.id === 'new').status, 'paid');
  assert.equal(l.bills.find((b) => b.id === 'old').left, 60000);
  assert.equal(l.free, 17600); assert.equal(l.due, 42400);
});

test('an advance with no bill, then a bill: the due is the difference', () => {
  const raw = { supplier: sup, payments: [{ id: 'p', amount: 50000, day: '2026-10-01' }], bills: [] };
  assert.deepEqual([supplierLedger(raw, '2026-10-02').due, supplierLedger(raw, '2026-10-02').advance], [0, 50000]);
  raw.bills = [{ id: 'b', date: '2026-10-05', total: 82400 }];
  assert.equal(supplierLedger(raw, '2026-10-06').due, 32400);
});

test('a credit note (goods returned) lowers the due; an opening balance is cleared first', () => {
  const raw = { supplier: sup, openings: [{ id: 'o', side: 'pakka', direction: 'owe', amount: 240000, date: '2026-09-26' }],
    bills: [{ id: 'b', date: '2026-10-05', total: 100000 }], notes: [{ id: 'n', kind: 'return', purchase_id: 'b', amount: 14200, date: '2026-10-10' }] };
  const l = supplierLedger(raw, '2026-10-11');
  assert.equal(l.due, 240000 + 100000 - 14200);
  assert.equal(l.bills[0].left, 85800);
  const s = suggestSupplierAllocation(250000, [{ kind: 'bill', id: 'b', date: '2026-10-05', left: 85800 }, { kind: 'opening', id: 'o', date: '2026-09-26', left: 240000 }]);
  assert.deepEqual(s.parts[0], { opening_id: 'o', amount: 240000 });
  assert.deepEqual(s.parts[1], { purchase_id: 'b', amount: 10000 });
});

test('the old "Paid" tick: out of the due; money set against such a bill never lowers the due twice', () => {
  const raw = { supplier: sup, bills: [{ id: 'b', date: '2026-02-27', total: 1347560, settled: 'outside' }, { id: 'c', date: '2026-10-01', total: 5000 }],
    payments: [{ id: 'p', amount: 1347560, day: '2026-03-02' }], allocations: [{ expense_id: 'p', purchase_id: 'b', amount: 1347560 }] };
  const l = supplierLedger(raw, '2026-10-02');
  assert.equal(l.bills[0].status, 'outside');
  // (the app links such a payment by taking the mark off; if both stayed, the payment counts as not set: an advance)
  assert.equal(l.due, 0); assert.equal(l.advance, 1347560 - 5000);
  assert.equal(l.check, 0, 'the statement agrees');
});

test('the supplier total = opening + bills − payments − notes, line by line', () => {
  const raw = { supplier: sup, openings: [{ id: 'o', direction: 'credit', amount: 5000, date: '2026-09-26' }],
    bills: [{ id: 'b1', date: '2026-10-01', total: 60000 }, { id: 'b2', date: '2026-10-09', total: 30000 }],
    payments: [{ id: 'p1', amount: 40000, day: '2026-10-03' }, { id: 'p2', amount: 10000, day: '2026-10-12' }],
    allocations: [{ expense_id: 'p1', purchase_id: 'b1', amount: 40000 }],
    notes: [{ id: 'n', kind: 'rate', amount: 1500, date: '2026-10-15' }] };
  const l = supplierLedger(raw, '2026-10-20');
  assert.equal(l.due, -5000 + 60000 + 30000 - 50000 - 1500);
  assert.equal(l.lines.at(-1).balance, l.net);
  assert.equal(l.check, 0);
  assert.deepEqual(l.lines.map((x) => x.kind), ['opening', 'bill', 'payment', 'bill', 'payment', 'note_rate']);
});

test('an item sold by the weight on the bill (direct delivery): weight × rate, no cutting, same with sizes or not', async () => {
  const { calcItem, orderTotals } = await import('../src/pricing.js');
  const c = calcItem({ byWeight: true, shape: 'round', d: ['40'], rows: [], rate: 74, cutRate: 4, density: 7850, aw: 1985.5 }, 'est');
  assert.equal(c.weight, 1985.5); assert.equal(c.mat, 146927); assert.equal(c.cut, 0);
  assert.equal(calcItem({ byWeight: true, rate: 74, aw: null }, 'final'), null, 'no weight, no price');
  const t = orderTotals({ items: [{ byWeight: true, rate: 74, aw: 1000 }] }, 'final', { bill: 'pakka', gstPct: 18 });
  assert.equal(t.base, 74000); assert.equal(t.gst, 13320); assert.equal(t.total, 87320);
});
