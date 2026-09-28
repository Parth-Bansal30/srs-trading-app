// Account statement for a period (built from the khata ledger) and the period picker.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

const TZ = 'Asia/Kolkata';
const order = (id, slipNo, bill, total, doneAt) => ({ id, slipNo, cust: 'c1', status: 'done', inKhata: true, bill, billTotal: total, doneAt });
const pay = (id, amt, at, extra = {}) => ({ id, cust: 'c1', at, amt, mode: 'UPI', side: null, oid: null, kind: 'khata', ...extra });

test('statement: opening balance, entries in the period, running balance and closing add up', () => {
  const orders = [
    order('o1', '1034', 'pakka', 12450.6, '2026-09-05T06:00:00Z'),
    order('o2', '1047', 'kacha', 4388, '2026-09-18T06:00:00Z'),
    order('o3', '1061', 'pakka', 3719.01, '2026-09-28T06:12:00Z'),
  ];
  const payments = [
    pay('p1', 15000, '2026-09-12T08:00:00Z', { side: 'pakka' }),
    pay('p2', 5000, '2026-09-22T08:00:00Z', { side: 'kacha', mode: 'Cash' }),
    pay('p3', 2000, '2026-09-26T08:00:00Z', { oid: 'o3', kind: 'advance', side: null }),
  ];
  const oldDues = [{ id: 'd1', cust: 'c1', side: 'kacha', date: '2026-08-20', amt: 8500, ref: null }];
  const l = c.customerLedger({ custId: 'c1', orders, payments, oldDues, sides: ['pakka', 'kacha'] });
  const s = c.statementFor({ entries: l.entries, from: '2026-09-01', to: '2026-09-28', timeZone: TZ });
  assert.equal(s.opening, 8500);
  assert.equal(s.bought, 20557.61);
  assert.equal(s.paid, 22000);
  assert.equal(s.closing, 7057.61);
  assert.equal(s.check, true);
  assert.equal(s.closing, l.due - l.adv + 0, 'same as the khata');
  assert.deepEqual(s.rows.map((r) => r.day), ['2026-09-05', '2026-09-12', '2026-09-18', '2026-09-22', '2026-09-26', '2026-09-28']);
  // only the second half of the month
  const half = c.statementFor({ entries: l.entries, from: '2026-09-15', to: '2026-09-30', timeZone: TZ });
  assert.equal(half.opening, 5950.6);
  assert.equal(half.closing, 7057.61);
  assert.equal(half.check, true);
});

test('statement: a payment at 2 am India time is filed on the shop date', () => {
  const orders = [order('o1', '1', 'pakka', 1000, '2026-08-31T10:00:00Z')];
  const payments = [pay('p1', 400, '2026-08-31T20:45:00Z', { side: 'pakka' })]; // 1 Sep 2:15 am IST
  const l = c.customerLedger({ custId: 'c1', orders, payments, sides: ['pakka'] });
  const s = c.statementFor({ entries: l.entries, from: '2026-09-01', to: '2026-09-30', timeZone: TZ });
  assert.equal(s.opening, 1000);
  assert.equal(s.rows.length, 1);
  assert.equal(s.closing, 600);
});

test('period picker uses the shop calendar and the Indian financial year', () => {
  const now = '2026-09-28T10:00:00Z';
  assert.deepEqual(c.periodDates('this_month', now, TZ), { from: '2026-09-01', to: '2026-09-28' });
  assert.deepEqual(c.periodDates('last_month', now, TZ), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(c.periodDates('last_3_months', now, TZ), { from: '2026-07-01', to: '2026-09-28' });
  assert.deepEqual(c.periodDates('this_fy', now, TZ), { from: '2026-04-01', to: '2026-09-28' });
  assert.deepEqual(c.periodDates('this_fy', '2027-02-10T10:00:00Z', TZ), { from: '2026-04-01', to: '2027-02-10' });
  assert.deepEqual(c.periodDates('last_month', '2027-01-15T10:00:00Z', TZ), { from: '2026-12-01', to: '2026-12-31' });
});

test('statement: slips paid in full at pickup are listed too, and the balances stay the khata\'s', () => {
  const orders = [
    { id: 'a', cust: 'C', status: 'done', bill: 'pakka', inKhata: true, billTotal: 1000, doneAt: '2026-09-05T06:00:00Z' },
    { id: 'b', cust: 'C', status: 'done', bill: 'pakka', inKhata: false, billTotal: 500, doneAt: '2026-09-10T06:00:00Z' },
    { id: 'k', cust: 'C', status: 'done', bill: 'kacha', inKhata: false, billTotal: 300, doneAt: '2026-09-11T06:00:00Z' },
  ];
  const payments = [
    { id: 'p1', cust: 'C', oid: 'b', amt: 200, mode: 'UPI', kind: 'advance', side: 'pakka', at: '2026-09-08T06:00:00Z' },
    { id: 'p2', cust: 'C', oid: 'b', amt: 300, mode: 'Cash', kind: 'pickup', side: 'pakka', at: '2026-09-10T06:00:00Z' },
    { id: 'p3', cust: 'C', oid: 'k', amt: 300, mode: 'Cash', kind: 'pickup', side: 'kacha', at: '2026-09-11T06:00:00Z' },
  ];
  const l = c.customerLedger({ custId: 'C', orders, payments, sides: ['pakka'], allSides: ['pakka', 'kacha'] });
  const extra = c.paidSlipEntries({ custId: 'C', orders, payments, sides: ['pakka'] });
  assert.equal(extra.length, 2, 'only the GST slip (no-bill side not asked for)');
  assert.deepEqual(extra.map((e) => [e.t, e.amt, e.mode ?? null]), [['bill', 500, null], ['pay', 500, 'Cash']]);
  const all = c.withPaidSlips(l.entries, extra);
  const st = c.statementFor({ entries: all, from: '2026-09-01', to: '2026-09-30' });
  assert.equal(st.rows.length, 3);
  assert.equal(st.closing, l.due, 'closing = what the khata says is due');
  assert.equal(st.bought, 1500);
  assert.equal(st.paid, 500);
  assert.ok(st.check);
});
