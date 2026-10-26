// What the shop usually does (lib/habitsMath.js). Run: node --test apps/web/test/habits.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { topCustomers, usualFor, repeatItems, orderSummary } from '../src/lib/habitsMath.js';

test('regulars: most slips first, at least two', () => {
  const rows = ['a', 'b', 'a', 'c', 'a', 'b', 'd'].map((customer_id) => ({ customer_id }));
  assert.deepEqual(topCustomers(rows), [{ id: 'a', n: 3 }, { id: 'b', n: 2 }]);
  assert.deepEqual(topCustomers(rows, { limit: 1 }), [{ id: 'a', n: 3 }]);
  assert.deepEqual(topCustomers([]), []);
});

const L = (...lens) => lens.map((len) => ({ len }));
const items = [
  { material_id: 'en8', shape: 'round', unit: 'mm', dims: ['32'], order_item_lengths: L(500, 1000) },
  { material_id: 'en8', shape: 'round', unit: 'mm', dims: ['32'], order_item_lengths: L(500) },
  { material_id: 'en8', shape: 'round', unit: 'mm', dims: ['32.0'], order_item_lengths: L(250) },
  { material_id: 'en8', shape: 'round', unit: 'mm', dims: ['40'], order_item_lengths: L(1000, 1000) },
  { material_id: 'en8', shape: 'round', unit: 'mm', dims: ['40'], order_item_lengths: L(300) },
  { material_id: 'en8', shape: 'round', unit: 'mm', dims: ['50'], order_item_lengths: L(500) },   // once: not "usual"
  { material_id: 'en8', shape: 'flat', unit: 'mm', dims: ['40', '20'], order_item_lengths: L(500) },
  { material_id: 'ms', shape: 'round', unit: 'mm', dims: ['32'], order_item_lengths: L(500) },
];

test('usual sizes of a grade + shape: used at least twice, most first ("32.0" = "32")', () => {
  const u = usualFor(items, 'en8', 'round', 'mm');
  assert.deepEqual(u.sizes, [['32'], ['40']]);
  assert.deepEqual(u.lengths, ['500', '1000'], 'cut lengths used at least twice');
});

test('with a size chosen: that size\'s lengths, else all', () => {
  assert.deepEqual(usualFor(items, 'en8', 'round', 'mm', { dims: ['40'] }).lengths, ['1000']);
  assert.deepEqual(usualFor(items, 'en8', 'round', 'mm', { dims: ['50'] }).lengths, ['500', '1000'], 'nothing usual for 50 → the grade\'s usual');
});

test('other grade / shape / unit stay apart', () => {
  assert.deepEqual(usualFor(items, 'ms', 'round', 'mm').sizes, []);
  assert.deepEqual(usualFor(items, 'en8', 'round', 'in').sizes, []);
  assert.deepEqual(usualFor([], 'en8', 'round', 'mm'), { sizes: [], lengths: [] });
});

test('same as last time: the items again, at today\'s rates', () => {
  const order = { order_items: [
    { position: 2, material_id: 'ms', shape: 'flat', unit: 'mm', dims: ['40', '20'], sell_rate: 70, order_item_lengths: [{ position: 1, len: 300, pcs: 10, cuts: null }] },
    { position: 1, material_id: 'en8', shape: 'round', unit: 'mm', dims: ['32'], sell_rate: 95, order_item_lengths: [{ position: 2, len: 1000, pcs: 2, cuts: 3 }, { position: 1, len: 500, pcs: 4, cuts: null }] },
  ] };
  let k = 0;
  const r = repeatItems(order, () => `k${++k}`);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { key: 'k1', material_id: 'en8', shape: 'round', unit: 'mm', d: ['32'], rows: [{ len: '500', pcs: '4', cuts: '' }, { len: '1000', pcs: '2', cuts: '3' }], rate: null, cut_rate: null });
  assert.equal(r[1].material_id, 'ms'); assert.equal(r[1].rate, null, 'never the old rate');
  assert.deepEqual(repeatItems(null), []);
  assert.deepEqual(orderSummary(order, (id) => id.toUpperCase()), ['EN8 32 round · 4×500, 2×1000', 'MS 40×20 flat · 10×300']);
});
