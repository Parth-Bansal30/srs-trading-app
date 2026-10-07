import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partMode, joinModes, splitMode, checkSplit, modeAmounts, cashOf, accountTally, maskNumber, daySummary, reminderMessage } from '../src/index.js';

const ACC = [
  { id: 'cash', kind: 'cash', name: 'Shop cash', owner: 'firm', isDrawer: true },
  { id: 'sbi', kind: 'bank', name: 'SBI current', owner: 'firm' },
  { id: 'ptm', kind: 'paytm', name: 'Paytm 99•••876', owner: 'personal' },
  { id: 'old', kind: 'upi', name: 'Old UPI', owner: 'personal', hidden: true },
];

test('part mode follows the account and how it was paid', () => {
  assert.equal(partMode('cash'), 'Cash');
  assert.equal(partMode('paytm', 'RTGS'), 'UPI');
  assert.equal(partMode('upi'), 'UPI');
  assert.equal(partMode('bank'), 'Bank');
  assert.equal(partMode('bank', 'RTGS'), 'Bank');
  assert.equal(partMode('bank', 'UPI'), 'UPI');
  assert.equal(partMode('other', 'Cheque'), 'Cheque');
  assert.equal(joinModes(['Bank', 'Cash', 'UPI', 'Cash']), 'Cash+UPI+Bank');
  assert.equal(joinModes([]), null);
  assert.deepEqual(splitMode('Cash+Bank'), ['Cash', 'Bank']);
  assert.deepEqual(splitMode('Adjust'), []);
});

test('a split must add up exactly — ₹25,000 = 10,000 cash + 12,000 SBI RTGS + 3,000 Paytm', () => {
  const ok = checkSplit(25000, [{ accountId: 'cash', amount: 10000 }, { accountId: 'sbi', amount: 12000, method: 'RTGS' }, { accountId: 'ptm', amount: '3000' }], ACC);
  assert.equal(ok.ok, true);
  assert.equal(ok.mode, 'Cash+UPI+Bank');
  assert.deepEqual(ok.parts.map((p) => [p.accountId, p.mode, p.method]), [['cash', 'Cash', null], ['sbi', 'Bank', 'RTGS'], ['ptm', 'UPI', null]]);
  assert.equal(checkSplit(25000, [{ accountId: 'cash', amount: 20000 }], ACC).problem, 'short');
  assert.equal(checkSplit(25000, [{ accountId: 'cash', amount: 20000 }], ACC).left, 5000);
  assert.equal(checkSplit(100, [{ accountId: 'cash', amount: 60 }, { accountId: 'sbi', amount: 50 }], ACC).problem, 'over');
  assert.equal(checkSplit(100, [{ accountId: 'cash', amount: 100 }, { accountId: 'sbi', amount: 0 }], ACC).problem, 'zero');
  assert.equal(checkSplit(100, [{ accountId: 'cash', amount: 50 }, { accountId: 'cash', amount: 50 }], ACC).problem, 'twice');
  assert.equal(checkSplit(100, [{ accountId: 'nope', amount: 100 }], ACC).problem, 'none');
  // paise add up without floating-point drift
  assert.equal(checkSplit(0.3, [{ accountId: 'cash', amount: 0.1 }, { accountId: 'sbi', amount: 0.2 }], ACC).ok, true);
  // one account = the whole amount, mode of that account
  const one = checkSplit(5000, [{ accountId: 'sbi', amount: 5000, method: 'UPI' }], ACC);
  assert.equal(one.mode, 'UPI');
});

test('older payments without parts keep their own mode; Adjust is no money', () => {
  assert.deepEqual(modeAmounts({ amount: 500, mode: 'Cash' }), [{ mode: 'Cash', amount: 500 }]);
  assert.deepEqual(modeAmounts({ amount: 500, mode: 'Adjust' }), []);
  assert.equal(cashOf({ amount: 25000, mode: 'Cash+Bank', parts: [{ mode: 'Cash', amount: 10000 }, { mode: 'Bank', amount: 15000 }] }), 10000);
  assert.equal(cashOf({ amount: -2000, mode: 'Cash', parts: [{ mode: 'Cash', amount: -2000 }] }), -2000);
});

test('evening tally per account: firm and personal apart, money not placed, ticks', () => {
  const t = accountTally({
    accounts: ACC,
    parts: [
      { accountId: 'cash', amount: 10000 }, { accountId: 'sbi', amount: 12000 }, { accountId: 'ptm', amount: 3000 },
      { accountId: 'cash', amount: 41200 }, { accountId: 'cash', amount: -2000 },
    ],
    payments: [{ amount: 25000, mode: 'Cash+UPI+Bank', parts: [{}] }, { amount: 41200, mode: 'Cash', parts: [{}] }, { amount: -2000, mode: 'Cash', parts: [{}] },
      { amount: 700, mode: 'UPI' }, { amount: 5000, mode: 'Adjust' }],
    checks: ['sbi'],
  });
  const row = (id) => t.rows.find((r) => r.id === id);
  assert.deepEqual([row('cash').in, row('cash').out, row('cash').net, row('cash').n], [51200, 2000, 49200, 3]);
  assert.equal(row('sbi').checked, true);
  assert.equal(t.firm, 61200);
  assert.equal(t.personal, 3000);
  assert.equal(t.notPlaced, 700);
  assert.equal(t.total, 64900);
  assert.equal(t.unchecked, 2);
  assert.equal(row('old'), undefined, 'a hidden account with nothing today is left out');
});

test('day summary: a split payment counts in each mode, the drawer only expects the cash part', () => {
  const s = daySummary({
    payments: [
      { amount: 25000, kind: 'pickup', mode: 'Cash+UPI+Bank', parts: [{ mode: 'Cash', amount: 10000 }, { mode: 'Bank', amount: 12000 }, { mode: 'UPI', amount: 3000 }] },
      { amount: 500, kind: 'khata', mode: 'Cash' },
    ],
    accounts: { list: ACC, parts: [{ accountId: 'cash', amount: 10000 }, { accountId: 'sbi', amount: 12000 }, { accountId: 'ptm', amount: 3000 }], checks: [] },
  });
  assert.deepEqual(s.money.byMode, { Cash: 10500, UPI: 3000, Bank: 12000, Cheque: 0 });
  assert.equal(s.money.total, 25500);
  assert.equal(s.cash.expected, 10500);
  assert.equal(s.accounts.notPlaced, 500);
  assert.ok(s.look.some((l) => l.type === 'not_placed' && l.amount === 500));
  assert.equal(daySummary({ payments: [] }).accounts, null);
});

test('reminder lists a split payment as "Cash + Bank"; numbers are masked', () => {
  const msg = reminderMessage({ lang: 'en', shop: 'S', customer: 'C', due: { due: 100, slips: [], recentPayments: [{ amount: 500, mode: 'Cash+Bank', date: '2026-10-01' }] } });
  assert.match(msg, /Cash \+ Bank/);
  assert.equal(maskNumber('50100012347730'), '••7730');
  assert.equal(maskNumber('srs98@okicici'), 'srs98@okicici');
  assert.equal(maskNumber('1234'), '1234');
});
