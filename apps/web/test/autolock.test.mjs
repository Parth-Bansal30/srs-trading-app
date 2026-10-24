// "Lock the app after…" rules (lib/autolock.js) — plain functions, no browser.
// Run: node --test apps/web/test/autolock.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

// the phone's storage, for the "left on purpose" note
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const { LOCK_CHOICES, LOCK_DEFAULT, lockAfterOf, shouldLock, markLeaving, noteHidden, takeLeaving, clearLeaving, BLINK_MS, ON_PURPOSE_MS, TAP_TO_LEAVE_MS } = await import('../src/lib/autolock.js');

const MIN = 60000;

test('the choices and the default (instantly)', () => {
  assert.deepEqual(LOCK_CHOICES, [0, 5, 30, 60, 720]);
  assert.equal(LOCK_DEFAULT, 0);
  assert.equal(lockAfterOf(null), 0, 'nobody chose yet → instantly');
  assert.equal(lockAfterOf({}), 0);
  assert.equal(lockAfterOf({ lockAfter: 30 }), 30);
  assert.equal(lockAfterOf({ lockAfter: 720 }), 720);
  assert.equal(lockAfterOf({ lockAfter: 7 }), 0, 'an unknown value is not trusted');
  assert.equal(lockAfterOf({ lockAfter: '30' }), 0);
});

test('instantly: any real time away locks, a blink does not', () => {
  assert.equal(shouldLock(0, BLINK_MS - 1), false, 'a flicker / system sheet');
  assert.equal(shouldLock(0, BLINK_MS), true);
  assert.equal(shouldLock(0, 10 * 1000), true);
  assert.equal(shouldLock(0, 12 * 3600 * 1000), true);
});

test('closed from recent apps and opened again: instantly locks even after a second', () => {
  assert.equal(shouldLock(0, 1000, false, true), true);
  assert.equal(shouldLock(0, 0, false, true), true);
  assert.equal(shouldLock(5, 1000, false, true), false, 'a longer choice still counts its minutes');
  assert.equal(shouldLock(0, 1000, true, true), false, 'the app reloaded itself (update) — on purpose');
});

test('5 / 30 minutes, 1 hour, 12 hours', () => {
  assert.equal(shouldLock(5, 4 * MIN), false);
  assert.equal(shouldLock(5, 5 * MIN), true);
  assert.equal(shouldLock(30, 29 * MIN), false);
  assert.equal(shouldLock(30, 31 * MIN), true);
  assert.equal(shouldLock(60, 59 * MIN), false);
  assert.equal(shouldLock(60, 61 * MIN), true);
  assert.equal(shouldLock(720, 11 * 60 * MIN), false);
  assert.equal(shouldLock(720, 12 * 60 * MIN), true);
});

test('unknown time away (first open after the update, closed long ago) locks', () => {
  assert.equal(shouldLock(720, null), true);
  assert.equal(shouldLock(30, undefined), true);
  assert.equal(shouldLock(0, NaN), true);
});

test('left on purpose (WhatsApp, bill photo, call) and back in time → no lock', () => {
  assert.equal(shouldLock(0, 2 * MIN, true), false);
  assert.equal(shouldLock(0, null, true), false);
});

test('a tap that sends the person out, then the app leaves the screen → a trip on purpose for 5 minutes', () => {
  clearLeaving();
  const t0 = 1_000_000;
  markLeaving(t0);
  assert.equal(noteHidden(t0 + 2000), true);
  assert.equal(takeLeaving(t0 + 2000 + ON_PURPOSE_MS - 1), true, 'back within 5 minutes');
  assert.equal(takeLeaving(t0 + 3000), false, 'used once, then forgotten');
});

test('back after more than 5 minutes → the trip does not count', () => {
  clearLeaving();
  const t0 = 2_000_000;
  markLeaving(t0);
  noteHidden(t0 + 1000);
  assert.equal(takeLeaving(t0 + 1000 + ON_PURPOSE_MS + 1), false);
});

test('a tap that did NOT leave the app (cancelled photo, Face ID sheet) does not excuse a later leave', () => {
  clearLeaving();
  const t0 = 3_000_000;
  markLeaving(t0);
  assert.equal(noteHidden(t0 + TAP_TO_LEAVE_MS + 1), false, 'the app left much later — an ordinary leave');
  assert.equal(takeLeaving(t0 + TAP_TO_LEAVE_MS + 5000), false);
});

test('an ordinary leave with no tap before it is not on purpose', () => {
  clearLeaving();
  assert.equal(noteHidden(4_000_000), false);
  assert.equal(takeLeaving(4_000_500), false);
});

test('unlocking / locking forgets any trip on purpose', () => {
  const t0 = 5_000_000;
  markLeaving(t0); noteHidden(t0 + 500);
  clearLeaving();
  assert.equal(takeLeaving(t0 + 1000), false);
});
