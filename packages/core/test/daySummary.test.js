// Evening summary: every number adds up, and "needs a look" catches what the owner cares about.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

const orders = [
  { id: 'a', slipNo: '1061', customer: 'Rana Tools', bill: 'pakka', total: 3719.01, weight: 37.2, inKhata: true, by: 'Ramesh',
    items: [{ grade: 'EN8', rate: 75, stdRate: 75, special: false }],
    payments: [{ amount: 2000, kind: 'advance', mode: 'UPI' }] },
  { id: 'b', slipNo: '1062', customer: 'Sharma Engineering', bill: 'kacha', total: 1144.44, weight: 14.2, inKhata: false, by: 'Parth',
    items: [{ grade: 'EN24', rate: 88, stdRate: 95, special: false }, { grade: 'EN19', rate: 90, stdRate: 92, special: true }],
    payments: [{ amount: 1144.44, kind: 'pickup', mode: 'Cash' }] },
  { id: 'c', slipNo: '1063', customer: 'Rana Tools', bill: 'pakka', total: 5000, weight: 60, inKhata: true, by: 'Ramesh',
    items: [], payments: [{ amount: 1000, kind: 'advance', mode: 'Cash' }, { amount: -1000, kind: 'advance', rev: true, mode: 'Cash' }, { amount: 3000, kind: 'pickup', mode: 'Bank' }] },
];
const payments = [
  { amount: 1144.44, kind: 'pickup', mode: 'Cash', customer: 'Sharma Engineering' },
  { amount: 3000, kind: 'pickup', mode: 'Bank', customer: 'Rana Tools' },
  { amount: 12000, kind: 'khata', mode: 'UPI', customer: 'Gupta Fabricators' },
  { amount: 6000, kind: 'advance', mode: 'Cash', customer: 'Verma' },
  { amount: -500, kind: 'refund', mode: 'Cash', customer: 'Kumar Machines' },
  { amount: 2000, kind: 'transfer', mode: 'Adjust', customer: 'Kumar Machines' },
];

test('day summary: sales split, where the slips went, money in by mode, cash drawer', () => {
  const d = c.daySummary({ orders, payments, cashClose: { expected: 6644.44, counted: 6144.44, by: 'Ramesh' }, toReceive: 686413,
    lastWeek: { total: 8000, n: 2 }, weighed: [{ slipNo: '1071', grade: 'EN8', expected: 53.8, actual: 58.6 }, { slipNo: '1072', grade: 'EN8', expected: 10, actual: 10.2 }],
    waiting: [{ slipNo: '1055', customer: 'Parth' }], reminders: [{ name: 'Gupta', due: 46030, days: 34 }] });
  assert.equal(d.sales.total, 9863.45);
  assert.equal(d.sales.pakka.total, 8719.01);
  assert.equal(d.sales.kacha.n, 1);
  assert.equal(d.sales.kg, 111.4);
  // 9,863.45 = pickup 4,144.44 + advance 2,000 + khata (1,719.01 + 2,000)
  assert.equal(d.sales.pickup, 4144.44);
  assert.equal(d.sales.advance, 2000);
  assert.equal(d.sales.toKhata, 3719.01);
  assert.equal(d.sales.extra, 0);
  assert.equal(d.sales.vsLastWeek, 23);
  assert.deepEqual(d.money.byMode, { Cash: 6644.44, UPI: 12000, Bank: 3000, Cheque: 0 });
  assert.equal(d.money.total, 21644.44);
  assert.equal(d.money.oldDues, 12000);
  assert.equal(d.money.out, 500);
  assert.equal(d.cash.expected, 6644.44);
  assert.equal(d.cash.diff, -500);
  assert.equal(d.khata.newDues, 3719.01);
  assert.equal(d.top[0].customer, 'Rana Tools');
  assert.equal(d.top[0].n, 2);
  assert.equal(d.money.list.length, 5); // the Adjust move is not money
});

test('day summary: needs a look — cash short, rate below usual (not special), weight off, refund, overdue, waiting', () => {
  const d = c.daySummary({ orders, payments, cashClose: { counted: 6144.44 }, weighed: [{ slipNo: '1071', grade: 'EN8', expected: 53.8, actual: 58.6 }, { slipNo: '1072', grade: 'EN8', expected: 10, actual: 10.2 }],
    waiting: [{ slipNo: '1055', customer: 'Parth' }], reminders: [{ name: 'Gupta', due: 46030, days: 34 }] });
  const types = d.look.map((x) => x.type);
  assert.deepEqual(types, ['cash_short', 'rate', 'weight', 'money_out', 'overdue', 'waiting']);
  assert.deepEqual(d.look[1], { type: 'rate', slipNo: '1062', orderId: 'b', customer: 'Sharma Engineering', grade: 'EN24', rate: 88, std: 95, by: 'Parth' });
  assert.equal(d.look[2].pct, 9);
});

test('day summary: a past day without a cash count is flagged; today is not; empty day is all zero', () => {
  assert.equal(c.daySummary({ payments: [{ amount: 100, kind: 'khata', mode: 'Cash' }] }).look[0].type, 'cash_not_counted');
  assert.equal(c.daySummary({ payments: [{ amount: 100, kind: 'khata', mode: 'Cash' }], isToday: true }).look.length, 0);
  const e = c.daySummary({});
  assert.equal(e.sales.total, 0);
  assert.equal(e.money.total, 0);
  assert.equal(e.look.length, 0);
});
