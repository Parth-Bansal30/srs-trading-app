// What a search means (lib/searchWords.js). Run: node --test apps/web/test/search.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch, customerFits, rankCustomers, squash } from '../src/lib/searchWords.js';

const G = [{ id: 'en8', code: 'EN8' }, { id: 'en24', code: 'EN24' }, { id: 'ms', code: 'MS' }, { id: 'ss304', code: 'SS 304' }];

test('empty → nothing', () => { assert.equal(parseSearch('  ', G), null); });

test('a name', () => {
  const p = parseSearch('Sharma', G);
  assert.deepEqual(p.words, ['sharma']); assert.equal(p.slip, null); assert.equal(p.amount, null);
});

test('#553 and a plain 553', () => {
  assert.equal(parseSearch('#553', G).slip, '553');
  assert.equal(parseSearch('#P12', G).slip, 'P12');
  const p = parseSearch('553', G);
  assert.equal(p.slip, '553'); assert.equal(p.amount, 553, 'a plain number is tried as an amount too');
});

test('amounts: 5000, ₹5,000, 1,25,000', () => {
  const p = parseSearch('5000', G);
  assert.equal(p.amount, 5000); assert.equal(p.slip, '5000'); assert.equal(p.digits, '5000');
  assert.equal(parseSearch('₹5,000', G).amount, 5000);
  assert.equal(parseSearch('₹5,000', G).slip, null, '₹ means money, not a slip');
  assert.equal(parseSearch('1,25,000', G).amount, 125000);
  assert.equal(parseSearch('Rs.450.50', G).amount, 450.5);
});

test('grade and size: "32 EN8", "EN8 32", "en-8 40x20", "SS304"', () => {
  let p = parseSearch('32 EN8', G);
  assert.equal(p.grade, 'en8'); assert.deepEqual(p.dims, ['32']); assert.equal(p.amount, null); assert.equal(p.slip, null);
  p = parseSearch('EN8 32', G);
  assert.equal(p.grade, 'en8'); assert.deepEqual(p.dims, ['32']);
  p = parseSearch('en-8 40x20', G);
  assert.equal(p.grade, 'en8'); assert.deepEqual(p.dims, ['40', '20']);
  assert.equal(parseSearch('ss304', G).grade, 'ss304');
  assert.equal(parseSearch('EN24', G).grade, 'en24', 'EN24 is not EN8');
});

test('a phone number, with or without a space', () => {
  assert.equal(parseSearch('98100 00001', G).phone, '9810000001');
  assert.equal(parseSearch('+919810000001', G).phone, '9810000001');
  assert.equal(parseSearch('00001', G).digits, '00001');
});

test('customers fit by every word, or by phone digits', () => {
  const c = { name: 'Sharma Engineering Works', phone: '98100 00001' };
  assert.ok(customerFits(c, parseSearch('sharma eng', G)));
  assert.ok(!customerFits(c, parseSearch('sharma tools', G)));
  assert.ok(customerFits(c, parseSearch('98100 00001', G)));
  assert.ok(customerFits(c, parseSearch('0000', G)), '4+ digits found in the phone');
  assert.ok(!customerFits({ name: 'X', phone: null }, parseSearch('0000', G)));
});

test('names starting with the word come first', () => {
  const p = parseSearch('ra', G);
  const r = rankCustomers([{ name: 'Jai Rana' }, { name: 'Rana Tools' }, { name: 'Raj Steels' }], p);
  assert.deepEqual(r.map((x) => x.name), ['Raj Steels', 'Rana Tools', 'Jai Rana']);
});

test('squash', () => { assert.equal(squash('SS-304 '), 'ss304'); });
