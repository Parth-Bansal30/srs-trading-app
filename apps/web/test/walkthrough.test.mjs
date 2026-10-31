// Small things found walking through a whole shop day (26 Oct 2026). Run: node --test apps/web/test/walkthrough.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { one, phoneText } from '../src/lib/words-fix.js';

test('"1 items" reads "1 item"; other numbers keep their -s', () => {
  assert.equal(one('1 items · 9:54 am'), '1 item · 9:54 am');
  assert.equal(one('1 estimates not accepted yet'), '1 estimate not accepted yet');
  assert.equal(one('Bought (1 slips)'), 'Bought (1 slip)');
  assert.equal(one('42 days · 1 slips'), '42 days · 1 slip');
  assert.equal(one('21 items'), '21 items');
  assert.equal(one('11 slips'), '11 slips');
  assert.equal(one('0.1 slips'), '0.1 slips');
  assert.equal(one('1 people'), '1 person');
  assert.equal(one('1 customers'), '1 customer');
  assert.equal(one('1 payment reminders to approve'), '1 payment reminder to approve');
  assert.equal(one('3 payment reminders to approve'), '3 payment reminders to approve');
});

test('mobiles are shown the way people say them', () => {
  assert.equal(phoneText('+919000000013'), '90000 00013');
  assert.equal(phoneText('9000000013'), '90000 00013');
  assert.equal(phoneText('90000 00013'), '90000 00013');
  assert.equal(phoneText('09000000013'), '90000 00013');
  assert.equal(phoneText(''), '');
  assert.equal(phoneText(null), '');
  assert.equal(phoneText('+44 20 7946 0958'), '+44 20 7946 0958', 'not Indian: as written');
});
