// Money out (23 Oct 2026): shop expenses, money moved between accounts, the cash drawer as a cash book.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

const exp = [
  { kind: 'expense', category: 'tea', amount: 120, accountId: 'drawer', isDrawer: true },
  { kind: 'expense', category: 'labour', amount: 800, accountId: 'drawer', isDrawer: true },
  { kind: 'expense', category: 'tea', amount: 60.5, accountId: 'drawer', isDrawer: true },
  { kind: 'expense', category: 'blade', amount: 4720, accountId: 'sbi', gstAmount: 720 },
  { kind: 'supplier', category: 'supplier', amount: 150000, accountId: 'sbi' },
  { kind: 'owner', category: 'home', amount: 5000, accountId: 'drawer', isDrawer: true },
  { kind: 'expense', category: 'tea', amount: 999, accountId: 'drawer', isDrawer: true, status: 'cancelled' },
  { kind: 'expense', category: 'Weird Key!', amount: 10, accountId: 'drawer', isDrawer: true },
];

test('expense totals: by kind, by category (largest first), GST for the CA, from the drawer; cancelled left out', () => {
  const t = c.expenseTotals(exp);
  assert.equal(t.n, 7);
  assert.equal(t.total, 160710.5);
  assert.deepEqual(t.byKind, { expense: 5710.5, supplier: 150000, owner: 5000 });
  assert.deepEqual(t.byCategory.map((x) => [x.category, x.amount, x.n]), [
    ['supplier', 150000, 1], ['home', 5000, 1], ['blade', 4720, 1], ['labour', 800, 1], ['tea', 180.5, 2], ['other', 10, 1]]);
  assert.equal(t.gst, 720);
  assert.equal(t.fromDrawer, 5990.5);
  assert.deepEqual(t.byAccount.map((x) => [x.accountId, x.amount]), [['sbi', 154720], ['drawer', 5990.5]]);
  assert.deepEqual(c.expenseTotals([]), { total: 0, n: 0, byKind: { expense: 0, supplier: 0, owner: 0 }, byCategory: [], gst: 0, fromDrawer: 0, byAccount: [] });
});

test('expense form: what stops saving', () => {
  const ok = { kind: 'expense', category: 'tea', amount: '120', accountId: 'a' };
  assert.equal(c.expenseProblem(ok), null);
  assert.equal(c.expenseProblem({ ...ok, amount: '' }), 'exp_p_amount');
  assert.equal(c.expenseProblem({ ...ok, amount: '-5' }), 'exp_p_amount');
  assert.equal(c.expenseProblem({ ...ok, accountId: null }), 'exp_p_account');
  assert.equal(c.expenseProblem({ ...ok, category: '' }), 'exp_p_category');
  assert.equal(c.expenseProblem({ ...ok, kind: 'supplier', category: '' }), 'exp_p_supplier');
  assert.equal(c.expenseProblem({ ...ok, kind: 'supplier', supplierId: 's1' }), null);
  assert.equal(c.expenseProblem({ ...ok, kind: 'owner', category: '' }), null);
  assert.equal(c.expenseProblem({ ...ok, gstBill: true, gstAmount: '120' }), 'exp_p_gst', 'GST can not be the whole amount');
  assert.equal(c.expenseProblem({ ...ok, gstBill: true, gstAmount: '18' }), null);
  assert.equal(c.expenseProblem({ ...ok, gstBill: true, sellerGstin: '07AAACR5055K1Z4' }), 'exp_p_gstin', 'typing mistake in the seller GSTIN');
  assert.equal(c.expenseProblem({ ...ok, gstBill: true, sellerGstin: '07AAACR5055K1Z9' }), null);
  assert.equal(c.expenseProblem({ ...ok, kind: 'gift' }), 'exp_p_kind');
});

test('GST inside an amount, and moving money', () => {
  assert.equal(c.gstInside(1180), 180);
  assert.equal(c.gstInside(4720, 18), 720);
  assert.equal(c.gstInside(1050, 5), 50);
  assert.equal(c.transferProblem({ from: 'a', to: 'b', amount: 50000 }), null);
  assert.equal(c.transferProblem({ from: 'a', to: 'a', amount: 50000 }), 'tr_p_same');
  assert.equal(c.transferProblem({ from: 'a', amount: 50000 }), 'tr_p_accounts');
  assert.equal(c.transferProblem({ from: 'a', to: 'b', amount: 0 }), 'tr_p_amount');
});

test('cash drawer day from the cash book: last count, what was left for tomorrow', () => {
  const cb = { opening: 2000, in: 45000, out: 920.5, expected: 46079.5, counts: [
    { at: '2026-10-23T13:00:00Z', expected: 30000, counted: 30000, taken_out: 0, left: 30000, by: 'Anil' },
    { at: '2026-10-23T14:30:00Z', expected: 46079.5, counted: 45979.5, taken_out: 43979.5, left: 2000, by: 'Papa' }] };
  const d = c.cashDay(cb);
  assert.deepEqual(d, { opening: 2000, in: 45000, out: 920.5, expected: 46079.5, counted: 45979.5, countExpected: 46079.5, takenOut: 43979.5,
    by: 'Papa', at: '2026-10-23T14:30:00Z', nCounts: 2, diff: -100, left: 2000 });
  const none = c.cashDay({ opening: 2000, in: 500, out: 0, expected: 2500, counts: [] });
  assert.equal(none.counted, null); assert.equal(none.diff, null); assert.equal(none.left, null); assert.equal(none.expected, 2500);
  assert.equal(c.cashDay(null), null);
  assert.equal(c.suggestKeep(45979.5, 2000), 2000);
  assert.equal(c.suggestKeep(1500, 2000), 1500, 'never more than counted');
  assert.equal(c.suggestKeep(1500, null), 1500, 'first time: everything stays');
});

test('running balance of an account', () => {
  assert.deepEqual(c.runningBalance(1000, [{ amount: 500 }, { amount: -200.25 }]).map((m) => m.balance), [1500, 1299.75]);
  assert.deepEqual(c.runningBalance(null, [{ amount: 500 }]).map((m) => m.balance), [null]);
});

test('day summary with money out and the cash book', () => {
  const payments = [{ amount: 45000, kind: 'pickup', mode: 'Cash', customer: 'Gupta', parts: [{ mode: 'Cash', amount: 45000 }] }];
  const cashBook = { opening: 2000, in: 45000, out: 920.5, expected: 46079.5, counts: [{ expected: 46079.5, counted: 45979.5, taken_out: 43979.5, by: 'Papa' }] };
  const d = c.daySummary({ payments, expenses: exp, transfers: [{ amount: 43979.5, reason: 'close', from: 'Shop cash', to: 'Cash at home' }, { amount: 1, status: 'cancelled' }], cashBook });
  assert.equal(d.cash.book, true);
  assert.equal(d.cash.opening, 2000);
  assert.equal(d.cash.expected, 46079.5);
  assert.equal(d.cash.diff, -100);
  assert.equal(d.cash.left, 2000);
  assert.deepEqual(d.look[0], { type: 'cash_short', amount: 100 });
  assert.equal(d.out.total, 160710.5);
  assert.equal(d.out.list.length, 7);
  assert.equal(d.moved.length, 1);
  // a past day with cash moves and no count is flagged; a quiet day isn't
  const past = c.daySummary({ cashBook: { opening: 2000, in: 0, out: 120, expected: 1880, counts: [] } });
  assert.deepEqual(past.look.find((x) => x.type === 'cash_not_counted'), { type: 'cash_not_counted', amount: 1880 });
  const quiet = c.daySummary({ cashBook: { opening: 2000, in: 0, out: 0, expected: 2000, counts: [] } });
  assert.equal(quiet.look.length, 0);
  // without a cash book: the old way (cash in only)
  const old = c.daySummary({ payments, cashClose: { counted: 44000 } });
  assert.equal(old.cash.book, false); assert.equal(old.cash.expected, 45000); assert.equal(old.cash.diff, -1000);
  assert.equal(old.out.total, 0);
});

test('a "safe" account (cash at home) takes money as Cash; the expenses permission', () => {
  assert.ok(c.ACCOUNT_KINDS.includes('safe'));
  assert.equal(c.partMode('safe'), 'Cash');
  assert.ok(c.PERMS.includes('expenses'));
  assert.ok(c.can(c.ROLE_PRESETS.owner(), 'expenses'));
  assert.ok(c.can(c.ROLE_PRESETS.accounts(), 'expenses'));
  for (const r of ['sales', 'weigher']) assert.ok(!c.can(c.ROLE_PRESETS[r](), 'expenses'), r);
});
