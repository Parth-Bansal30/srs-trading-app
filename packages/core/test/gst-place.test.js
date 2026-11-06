// GST details for the CA (plan v2 F10) — made-up data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeOfSupply, gstSplit, salesRows, registerTotals, stateOfGstin, hsnOk } from '../src/gstPlace.js';
import { orderTotals } from '../src/pricing.js';

test('Delhi shop, Haryana customer, our delivery to Faridabad: Delhi → Haryana · IGST', () => {
  assert.equal(stateOfGstin('06AABCS1429B1ZY'), '06');
  const p = placeOfSupply({ shop: '07', delivery: 'ours', dest: '06' });
  assert.deepEqual(p, { from: '07', to: '06', kind: 'inter', sure: true, reason: null });
  assert.deepEqual(gstSplit(1800, p.kind), { cgst: 0, sgst: 0, igst: 1800 });
});

test('the same customer takes it to their Delhi site: CGST + SGST; to Faridabad: IGST', () => {
  assert.equal(placeOfSupply({ shop: '07', delivery: 'pickup', dest: '07' }).kind, 'local');
  assert.deepEqual(gstSplit(1800.05, 'local'), { cgst: 900.02, sgst: 900.03, igst: 0 }, 'the odd paisa on SGST; adds up');
  assert.equal(placeOfSupply({ shop: '07', delivery: 'pickup', dest: '06' }).kind, 'inter');
});

test('never assumed: no destination, no shop GST number, or straight from the supplier → CA to check', () => {
  assert.deepEqual(placeOfSupply({ shop: '07', delivery: 'pickup', dest: null }), { from: '07', to: null, kind: null, sure: false, reason: 'no_dest' });
  assert.equal(placeOfSupply({ shop: null, dest: '07' }).reason, 'no_shop');
  const d = placeOfSupply({ shop: '07', delivery: 'direct', dest: '06' });
  assert.deepEqual([d.from, d.to, d.sure, d.reason], ['07', '06', false, 'direct'], 'both states shown, CA to check');
  assert.equal(gstSplit(100, null), null);
});

test('the register: one row per HSN, the rows add up to the slip, flags marked', () => {
  const items = [{ hsn: '7214', desc: 'EN8 round', kg: 500, taxable: 37000, gst_rate: 18, hsn_checked: true },
    { hsn: '7214', desc: 'EN8 round', kg: 120.5, taxable: 8917, gst_rate: 18, hsn_checked: true },
    { hsn: '', desc: 'EN24 flat', kg: 33.3, taxable: 3333.33, gst_rate: null, hsn_checked: false }];
  const t = orderTotals({ items: [] }, 'final', { bill: 'pakka', gstPct: 18 });
  assert.equal(t.total, 0);
  const taxable = 37000 + 8917 + 3333.33; const gst = Math.round(taxable * 18) / 100;
  const rows = salesRows({ date: '2026-10-12', slip_no: 512, tally_no: 'SRS/26-27/0142', customer: 'Laxmi Tools', gstin: '06AABCS1429B1ZY',
    pos: { from: '07', to: '06', kind: 'inter', sure: true }, delivery: 'ours', gst_pct: 18, gst, total: taxable + gst, items });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].hsn, rows[0].kg, rows[0].taxable, rows[0].flags], ['7214', 620.5, 45917, []]);
  assert.deepEqual(rows[1].flags, ['hsn_missing']);
  const tot = registerTotals(rows);
  assert.equal(tot.gst, Math.round(gst * 100) / 100, 'the rows add up to the slip\'s GST exactly');
  assert.equal(tot.igst, tot.gst); assert.equal(tot.cgst, 0);
  assert.equal(tot.flagged, 1); assert.equal(tot.slips, 1);
  const r2 = salesRows({ slip_no: 513, pos: { kind: null, sure: false, reason: 'no_dest' }, gst_pct: 18, gst: 180, items: [{ hsn: '7214', kg: 10, taxable: 1000, hsn_checked: true }] });
  assert.deepEqual(r2[0].flags, ['pos_no_dest', 'no_tally']);
  assert.equal(r2[0].cgst, null, 'no split until the CA knows where it went');
  assert.ok(hsnOk('7214') && hsnOk('72142090') && !hsnOk('72'));
});

test('the purchase register: one row per HSN + charges, the supplier\'s state decides the split, rows add up to the bill', async () => {
  const { purchaseRows } = await import('../src/gstPlace.js');
  const bill = { date: '2026-10-05', bill_no: 'PKT/316', supplier: 'P K Steel Traders', gstin: '07AABCS1429B1ZW', gst: 205560, freight: 0, other: 0, round_off: 0,
    total: 1347560, stock_effect: 'direct', lines: [{ hsn: '7214', description: 'MS ROUND 40MM', kg: 2000, amount: 1142000 }] };
  const [row] = purchaseRows(bill, '07');
  assert.deepEqual([row.cgst, row.sgst, row.igst, row.total, row.state, row.stock_effect, row.flags], [102780, 102780, 0, 1347560, 'Delhi', 'direct', []]);
  const two = purchaseRows({ ...bill, gstin: '06AABCS1429B1ZY', freight: 1000, total: 1348740, gst: 205740, round_off: -0.4 }, '07');
  assert.equal(two.length, 2); assert.equal(two[1].desc, 'Freight / other charges');
  assert.equal(two[0].igst + two[1].igst, 205740);
  assert.equal(Math.round((two[0].total + two[1].total) * 100) / 100, 1348739.6, 'with the round-off');
  assert.deepEqual(purchaseRows({ ...bill, gstin: '' }, '07')[0].flags, ['no_gstin']);
});
