// Things found by walking through a whole shop day as real people (26 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

test('a weight typed 10× too big is caught, and the right one is suggested', () => {
  const r = c.weightCheck(17.76, 180);
  assert.equal(r.level, 'far');
  assert.equal(r.times, 10.1);
  assert.equal(r.suggest, 18);
  assert.equal(c.weightCheck(17.76, 1.8).suggest, 18, 'a dot too early');
  assert.equal(c.weightCheck(2.94, 300).suggest, 3, 'two zeros too many');
});

test('weights close to the size are fine; a bit off is only shown', () => {
  assert.equal(c.weightCheck(17.76, 18).level, 'ok');
  assert.equal(c.weightCheck(19.63, 19.4).level, 'ok');
  assert.equal(c.weightCheck(10, 11.5).level, 'near');
  assert.equal(c.weightCheck(10, 12.5).level, 'near', 'exactly 25% is still near');
  assert.equal(c.weightCheck(10, 12.6).level, 'far');
  assert.equal(c.weightCheck(10, 12.6).suggest, null, 'no dot to move');
  assert.equal(c.weightCheck(10, 11, { warnPct: 10 }).level, 'ok', 'the shop’s own "close enough"');
});

test('nothing to check without both weights', () => {
  assert.equal(c.weightCheck(0, 5), null);
  assert.equal(c.weightCheck(5, ''), null);
  assert.equal(c.weightCheck(null, 5), null);
});
