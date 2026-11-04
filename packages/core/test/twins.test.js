import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentTwins } from '../src/twins.js';

test('possible double payments: same amount within 3 days, not cancelled; closest first; never on other amounts', () => {
  const now = '2026-11-04T10:00:00.000Z';
  const e = [
    { pid: 'a', amt: 5000, date: '2026-11-01T11:00:00.000Z', mode: 'Bank' },
    { pid: 'b', amt: 5000, date: '2026-11-04T08:00:00.000Z', mode: 'Cash' },
    { pid: 'c', amt: 5000, date: '2026-10-30T08:00:00.000Z', mode: 'UPI' },        // 5 days: too old
    { pid: 'd', amt: 5000, date: '2026-11-03T08:00:00.000Z', cancelled: { at: 'x' } },
    { pid: 'e', amt: 4999.99, date: '2026-11-04T09:00:00.000Z' },
    { t: 'bill', amt: 5000, date: '2026-11-04T09:00:00.000Z' },                     // a slip, not a payment
  ];
  assert.deepEqual(paymentTwins(e, 5000, now).map((x) => x.pid), ['b', 'a']);
  assert.deepEqual(paymentTwins(e, '5000.00', now).map((x) => x.pid), ['b', 'a']);
  assert.deepEqual(paymentTwins(e, 2000, now), []);
  assert.deepEqual(paymentTwins(e, 0, now), []);
});
