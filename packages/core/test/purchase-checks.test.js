import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purchaseChecks, looksLikeGstin, hsnSuggestions } from '../src/index.js';

const SS = 'm-ss316', EN31 = 'm-en31';
const history = {
  rates: [
    { materialId: EN31, rate: 76, date: '2026-08-02', supplier: 'A' }, { materialId: EN31, rate: 80, date: '2026-08-20', supplier: 'B' },
    { materialId: EN31, rate: 78, date: '2026-09-18', supplier: 'Mahavir' }, { materialId: EN31, rate: 77, date: '2026-07-01', supplier: 'A' },
  ],
  bills: [{ supplierId: 'sup1', billNo: '0398', date: '2026-09-18', kg: 1500, total: 138060 }],
};
const types = (r) => r.map((c) => c.type);

test('a GST number in the bill-number box is spotted (Delhi 07)', () => {
  assert.equal(looksLikeGstin('07MWUPK7838J1ZB'), true);
  assert.equal(looksLikeGstin('0412'), false);
  assert.equal(looksLikeGstin('MS/2026/118'), false);
  const r = purchaseChecks({ billNo: '07mwupk7838j1zb', lines: [] });
  assert.deepEqual(types(r), ['billno_gstin']);
  assert.equal(r[0].gstin, '07MWUPK7838J1ZB');
  assert.equal(r[0].state, 'Delhi');
});

test('HSN: silicon code on stainless is "not steel"; alloy code on stainless is "wrong kind"; right code passes', () => {
  const bad = purchaseChecks({ lines: [{ hsn: '28046900', family: 'stainless', materialId: SS, code: 'SS316', shape: 'round' }] });
  assert.equal(bad[0].type, 'hsn_not_steel');
  assert.equal(bad[0].level, 'bad');
  assert.deepEqual(bad[0].suggest.map((s) => s.hsn), ['722211', '722220']);
  assert.equal(purchaseChecks({ lines: [{ hsn: '722830', family: 'stainless', materialId: SS, shape: 'round' }] })[0].type, 'hsn_family');
  assert.equal(purchaseChecks({ lines: [{ hsn: '7222 11', family: 'stainless', materialId: SS, shape: 'round' }] }).length, 0);
  assert.equal(purchaseChecks({ lines: [{ hsn: '730640', family: 'stainless', materialId: SS }] }).length, 0, 'chapter 73 (pipes) is fine');
  assert.equal(purchaseChecks({ lines: [{ hsn: '', family: 'stainless', materialId: SS }] }).length, 0, 'no HSN: nothing to check');
  assert.deepEqual(hsnSuggestions('carbon', 'plate').map((s) => s.hsn), ['7208']);
  assert.deepEqual(hsnSuggestions('tool', 'block').map((s) => s.hsn), ['7224']);
});

test('rate far from usual: EN31 at ₹240/kg vs ₹76–₹80 history', () => {
  const r = purchaseChecks({ lines: [{ rateKg: 240, materialId: EN31, family: 'alloy', code: 'EN31', hsn: '722830' }] }, history);
  assert.deepEqual(types(r), ['rate_far']);
  assert.equal(r[0].low, 76);
  assert.equal(r[0].high, 80);
  assert.equal(r[0].last.supplier, 'Mahavir');
  assert.equal(r[0].times, 3.1);
  assert.equal(purchaseChecks({ lines: [{ rateKg: 84, materialId: EN31 }] }, history).length, 0, '₹84 is close enough');
  assert.equal(purchaseChecks({ lines: [{ rateKg: 240, materialId: 'new-grade' }] }, history).length, 0, 'no history: no warning');
});

test('typed twice: same supplier, weight and total as a recent bill', () => {
  const r = purchaseChecks({ billNo: '0401', supplierId: 'sup1', totalKg: 1500, total: 138060.4, lines: [] }, history);
  assert.deepEqual(types(r), ['duplicate']);
  assert.equal(r[0].billNo, '0398');
  assert.equal(purchaseChecks({ billNo: '0401', supplierId: 'sup2', totalKg: 1500, total: 138060, lines: [] }, history).length, 0);
});

test('"it\'s correct" is remembered by key; serious ones come first; GST number typos', () => {
  const bill = { billNo: '07MWUPK7838J1ZB', lines: [{ hsn: '28046900', family: 'stainless', materialId: SS }] };
  const all = purchaseChecks(bill);
  assert.deepEqual(types(all), ['hsn_not_steel', 'billno_gstin']);
  assert.deepEqual(types(purchaseChecks(bill, {}, [all[0].key])), ['billno_gstin']);
  assert.equal(purchaseChecks({ isNewSupplier: true, supplierGstin: '07ABCDE1234F1Z9', lines: [] })[0]?.type, 'gstin_typo');
  assert.equal(purchaseChecks({ isNewSupplier: false, supplierGstin: '07ABCDE1234F1Z9', lines: [] }).length, 0, 'known supplier: not re-checked');
});
