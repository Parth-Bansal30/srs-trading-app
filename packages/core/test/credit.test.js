import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditStatus, creditOver } from '../src/credit.js';

test('OD / CC: used, in credit, available (estimate), over the limit', () => {
  const cc = { credit_kind: 'cc', credit_limit: 1500000, balance: -1123088, known: true, since: '2026-10-31T18:29:59Z', entries: 3 };
  const s = creditStatus(cc);
  assert.equal(s.used, 1123088); assert.equal(s.available, 376912); assert.equal(s.inCredit, 0); assert.equal(s.over, 0); assert.equal(s.pct, 75); assert.equal(s.entries, 3);
  assert.equal(creditOver(cc, 200000), 0);
  assert.equal(creditOver(cc, 400000), 23088);
  const plus = creditStatus({ ...cc, balance: 79571.86 });
  assert.equal(plus.used, 0); assert.equal(plus.inCredit, 79571.86); assert.equal(plus.available, 1500000);
  const over = creditStatus({ ...cc, balance: -1520000 });
  assert.equal(over.over, 20000); assert.equal(over.pct, 100);
  assert.equal(creditStatus({ balance: -5 }), null);
  assert.equal(creditOver({ balance: -5 }, 10), 0);
});
