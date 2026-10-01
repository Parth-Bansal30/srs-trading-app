// Stock and purchase bills (owner decisions 30 Sept 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

test('bill lines in MT / quintal / kg become kg and ₹ per kg; the amount is checked', () => {
  assert.deepEqual(c.billLine({ qty: 5.02, qtyUnit: 'MT', rate: 52500, rateUnit: 'per MT', amount: 263550 }),
    { kg: 5020, rateKg: 52.5, amount: 263550, expected: 263550, ok: true });
  const q = c.billLine({ qty: 12.5, qtyUnit: 'Qtl', rate: 7800, rateUnit: 'Rs/Qtl', amount: '97,500.00' });
  assert.equal(q.kg, 1250); assert.equal(q.rateKg, 78); assert.ok(q.ok);
  const wrong = c.billLine({ qty: 1000, rate: 75, amount: 70000 });
  assert.equal(wrong.ok, false, 'amount far from kg × rate is flagged');
  assert.equal(c.billLine({ qty: 2000, rate: 75 }).amount, 150000, 'no amount → worked out');
  assert.equal(c.billLine({ qty: 1, qtyUnit: 'MT', rate: 52345, rateUnit: 'MT' }).rateKg, 52.345, 'per-MT rates keep 3 decimals');
});

test('the bill adds up: items + freight + other + GST + round-off = total', () => {
  const t = c.billTotals({ lines: [{ amount: 150000 }, { amount: 117000 }, { amount: 52500 }], gst: 57510, total: 377010 });
  assert.equal(t.items, 319500); assert.equal(t.computed, 377010); assert.ok(t.ok);
  const off = c.billTotals({ lines: [{ amount: 263550 }, { amount: 55650 }], freight: 6000, gst: 58536, total: 383836 });
  assert.equal(off.diff, 100); assert.equal(off.ok, false);
  assert.ok(c.billTotals({ lines: [{ amount: 100 }], gst: 18, roundOff: 0.4, total: 118.4 }).ok);
});

test('freight is shared by weight → real cost per kg', () => {
  const lc = c.landedCosts([{ kg: 5020, rateKg: 52.5 }, { kg: 1050, rateKg: 53 }], 6000);
  assert.deepEqual(lc, [{ share: 0.99, cost: 53.49 }, { share: 0.99, cost: 53.99 }]);
  assert.deepEqual(c.landedCosts([{ kg: 100, rateKg: 75 }], 0), [{ share: 0, cost: 75 }]);
});

test('stock item = grade + shape + HSN + rate: a different rate or HSN is a separate item', () => {
  const items = [{ id: 's1', materialId: 'EN19', shape: 'round', hsn: '7228 30', rate: 75 }];
  assert.equal(c.matchStockItem({ materialId: 'EN19', shape: 'round', hsn: '722830', rateKg: 75 }, items)?.id, 's1', 'same four → adds to it');
  assert.equal(c.matchStockItem({ materialId: 'EN19', shape: 'round', hsn: '722830', rateKg: 78 }, items), null, 'other rate → new');
  assert.equal(c.matchStockItem({ materialId: 'EN19', shape: 'round', hsn: '722840', rateKg: 75 }, items), null, 'other HSN → new');
  assert.equal(c.matchStockItem({ materialId: 'EN19', shape: 'square', hsn: '722830', rateKg: 75 }, items), null, 'other shape → new');
  assert.equal(c.cleanHsn(' 7228.30 '), '722830');
});

test('grade and shape are guessed from the bill description', () => {
  const mats = [{ id: 1, code: 'EN8' }, { id: 2, code: 'EN19' }, { id: 3, code: 'MS' }, { id: 4, code: 'SS304' }, { id: 5, code: 'D2' }, { id: 6, code: 'EN1A' }];
  const g = (d) => c.guessGrade(d, mats)?.code;
  assert.equal(g('Alloy Steel EN-19 Round Bars'), 'EN19');
  assert.equal(g('M.S. Round Bars'), 'MS');
  assert.equal(g('MILD STEEL FLAT 50x6'), 'MS');
  assert.equal(g('SS 304 Bright Bar'), 'SS304');
  assert.equal(g('D2 Block'), 'D2');
  assert.equal(g('EN1A free cutting'), 'EN1A');
  assert.equal(g('EN190 special'), undefined, 'EN19 is not inside EN190');
  assert.equal(g('Alloy Steel Round Bars'), undefined, 'no grade on the bill → you choose');
  assert.equal(c.guessShape('M.S. Round Bars'), 'round');
  assert.equal(c.guessShape('MS SQ 20'), 'square');
  assert.equal(c.guessShape('M.S. Flat 50x6'), 'flat');
  assert.equal(c.guessShape('HR Plate 10mm'), 'plate');
  assert.equal(c.guessShape('Hex bar 24 AF'), 'hex');
  assert.equal(c.guessShape('Alloy steel'), null);
});

test('selling: same grade only, oldest stock with enough first, otherwise the biggest (flagged short)', () => {
  const items = [
    { id: 'new', materialId: 'EN19', shape: 'round', onHand: 2000, booked: 0, firstIn: '2026-09-30' },
    { id: 'old', materialId: 'EN19', shape: 'round', onHand: 300, booked: 100, firstIn: '2026-09-10' },
    { id: 'any', materialId: 'EN19', shape: null, onHand: 900, booked: 0, firstIn: '2026-08-01' },
    { id: 'sq', materialId: 'EN19', shape: 'square', onHand: 5000, booked: 0, firstIn: '2026-07-01' },
    { id: 'en8', materialId: 'EN8', shape: 'round', onHand: 9000, booked: 0, firstIn: '2026-07-01' },
    { id: 'shut', materialId: 'EN19', shape: 'round', onHand: 0, booked: 0, firstIn: '2026-06-01', closed: true },
  ];
  let r = c.stockChoices(items, { materialId: 'EN19', shape: 'round', kg: 150 });
  assert.deepEqual(r.list.map((x) => x.id), ['old', 'new', 'any'], 'only EN19, round or shapeless; exact shape first, oldest first');
  assert.equal(r.pick, 'old'); assert.equal(r.short, false);
  assert.equal(r.list[0].free, 200, 'free = on hand − booked on open orders');
  r = c.stockChoices(items, { materialId: 'EN19', shape: 'round', kg: 250 });
  assert.equal(r.pick, 'new', 'old has only 200 free → next oldest with enough');
  r = c.stockChoices(items, { materialId: 'EN19', shape: 'round', kg: 2500 });
  assert.equal(r.pick, 'new'); assert.equal(r.short, true, 'nothing has enough → the biggest, flagged');
  r = c.stockChoices(items, { materialId: 'EN24', shape: 'round', kg: 10 });
  assert.equal(r.pick, null); assert.equal(r.list.length, 0, 'no stock of that grade → sold without stock');
});
