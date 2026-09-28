// GST number check used when a new business registers (works offline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGstin, gstinCheckChar } from '../src/index.js';

test('a real-format GSTIN passes and tells the state and PAN', () => {
  const r = checkGstin(' 27aapfu0939f1zv ');
  assert.deepEqual(r, { ok: true, gstin: '27AAPFU0939F1ZV', stateCode: '27', state: 'Maharashtra', pan: 'AAPFU0939F' });
  const pb = checkGstin('03ABCDE1234F1ZA');
  assert.equal(pb.ok, true);
  assert.equal(pb.state, 'Punjab');
});

test('typing mistakes are caught by the check character', () => {
  assert.equal(checkGstin('27AAPFU0939F1ZW').reason, 'check');
  assert.equal(checkGstin('27AAPFU0939F2ZV').reason, 'check');
  assert.equal(checkGstin('72AAPFU0939F1ZV').reason, 'state');
});

test('wrong length / shape / empty are told apart', () => {
  assert.equal(checkGstin('').reason, 'empty');
  assert.equal(checkGstin('27AAPFU0939F1Z').reason, 'length');
  assert.equal(checkGstin('27AAPF10939F1ZV').reason, 'format');
  assert.equal(checkGstin('27AAPFU0939F1YV').reason, 'format');
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
});
