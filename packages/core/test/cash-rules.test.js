// The ₹2 lakh cash rule (plan v2 F8) — made-up numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASH_LIMIT, cashRoomLeft, cashCheck } from '../src/cashRules.js';

test('room: under ₹2,00,000 for the day and for the slip, whichever is more', () => {
  assert.equal(CASH_LIMIT, 200000);
  assert.equal(cashRoomLeft(150000, 0), 49999);
  assert.equal(cashRoomLeft(20000, 180000), 19999, 'the slip already had ₹1,80,000 in cash over several days');
  assert.equal(cashRoomLeft(250000, 0), 0, 'never below zero');
  assert.equal(cashRoomLeft(), 199999);
});

test('₹1,10,000 cash with ₹49,999 room: take ₹49,999 cash and ₹60,001 by UPI / bank', () => {
  assert.deepEqual(cashCheck(110000, 49999), { over: true, cash: 110000, room: 49999, keep: 49999, other: 60001 });
  assert.equal(cashCheck(49999, 49999).over, false, 'exactly the room is fine');
  const s = cashCheck(150000, 100000, 200000);   // a split: ₹1,50,000 cash + ₹50,000 UPI
  assert.equal(s.keep, 100000); assert.equal(s.other, 100000);
  assert.deepEqual(cashCheck(0, 0, 5000), { over: false, cash: 0, room: 0, keep: 0, other: 5000 }, 'no cash: nothing to stop');
});
