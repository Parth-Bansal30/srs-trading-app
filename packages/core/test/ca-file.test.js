// The CA's monthly file by the GST rules (22 Nov 2026). Made-up data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBillNo, gstr1Table, withTables, hsnSummary, splitBillNo, tallySeries, expenseRows, creditNoteRows, cancelledRow, gst3b, caChecks, hsnName, salesRows, purchaseRows } from '../src/index.js';

const DL = '07AABCS1429B1ZW';   // a valid made-up Delhi GST no.
const HR = '06AABCS1429B1ZY';   // Haryana

test('GSTR-1 table: B2B with a valid GST no.; B2C large only across states above ₹1 lakh', () => {
  assert.equal(gstr1Table({ gstin: HR, posKind: 'inter', value: 500 }), 'b2b');
  assert.equal(gstr1Table({ gstin: '06AABCS1429B1ZZ', posKind: 'inter', value: 150000 }), 'b2cl', 'a GST no. that fails its check is not B2B');
  assert.equal(gstr1Table({ gstin: null, posKind: 'inter', value: 100000 }), 'b2cs', 'exactly ₹1 lakh is not "more than"');
  assert.equal(gstr1Table({ gstin: null, posKind: 'inter', value: 100000.01 }), 'b2cl');
  assert.equal(gstr1Table({ gstin: null, posKind: 'local', value: 900000 }), 'b2cs', 'inside the state is never B2C large');
  assert.equal(gstr1Table({ gstin: null, posKind: null, value: 900000 }), 'b2cs');
});

test('HSN summary keeps B2B and B2C apart, adds up to the register, counts rows with no split yet', () => {
  const slip = (no, gstin, kind, items, gst) => salesRows({ date: '2026-10-05', slip_no: no, customer: 'X', gstin, gst_pct: 18, gst,
    pos: kind ? { from: '07', to: kind === 'local' ? '07' : '06', kind, sure: true } : { from: '07', to: null, kind: null, sure: false, reason: 'no_dest' }, items }, 18);
  const rows = withTables([
    ...slip(1, HR, 'inter', [{ hsn: '7214', desc: 'EN8 round', kg: 1000, taxable: 70000, hsn_checked: true }], 12600),
    ...slip(2, null, 'local', [{ hsn: '7214', desc: 'EN8 round', kg: 100, taxable: 7000, hsn_checked: true }, { hsn: '7228', desc: 'EN24', kg: 50, taxable: 5000, hsn_checked: true }], 2160),
    ...slip(3, null, null, [{ hsn: '7228', desc: 'EN24', kg: 10, taxable: 1000, hsn_checked: true }], 180),
  ]);
  assert.deepEqual(rows.map((r) => r.table), ['b2b', 'b2cs', 'b2cs', 'b2cs']);
  const h = hsnSummary(rows);
  assert.equal(h.b2b.length, 1);
  assert.deepEqual([h.b2b[0].hsn, h.b2b[0].qty, h.b2b[0].igst, h.b2b[0].uqc, h.b2b[0].desc], ['7214', 1000, 12600, 'KGS', hsnName('7214')]);
  assert.deepEqual(h.b2c.map((g) => [g.hsn, g.qty, g.taxable]), [['7214', 100, 7000], ['7228', 60, 6000]]);
  assert.equal(h.b2c[1].unsplit, 180, 'slip 3 has no CGST / SGST / IGST split yet');
  const reg = rows.reduce((t, r) => ({ taxable: t.taxable + r.taxable, gst: t.gst + r.gst }), { taxable: 0, gst: 0 });
  assert.equal(h.totals.all.taxable, reg.taxable);
  assert.equal(h.totals.all.tax, Math.round(reg.gst * 100) / 100, 'the HSN summary adds up to the sales register');
});

test('Tally bill numbers: series, ranges, cancelled, numbers missing from the app, the same number twice', () => {
  assert.deepEqual(splitBillNo('SRS/26-27/0142'), { prefix: 'SRS/26-27/', suffix: '', series: 'SRS/26-27/…', num: 142, width: 4, text: 'SRS/26-27/0142' });
  assert.equal(splitBillNo('CASH'), null);
  assert.deepEqual([nextBillNo('SRS/26-27/0142'), nextBillNo('A-9'), nextBillNo('0999'), nextBillNo('CASH')], ['SRS/26-27/0143', 'A-10', '1000', null]);
  const s = tallySeries([
    { tally_no: 'SRS/26-27/0131', slip_no: 1 }, { tally_no: 'SRS/26-27/0132', slip_no: 2 }, { tally_no: 'SRS/26-27/0135', slip_no: 3, cancelled: true },
    { tally_no: 'srs/26-27/0132', slip_no: 9 }, { tally_no: 'CASH-A', slip_no: 4 }, { tally_no: 'B-7', slip_no: 5 }, { tally_no: '', slip_no: 6 },
  ]);
  const main = s.series.find((x) => x.series === 'SRS/26-27/…');
  assert.deepEqual([main.from, main.to, main.total, main.in_app, main.cancelled, main.net], ['SRS/26-27/0131', 'SRS/26-27/0135', 5, 3, 1, 4]);
  assert.deepEqual(main.missing, ['SRS/26-27/0133', 'SRS/26-27/0134'], 'bills in the range that no slip has: the CA says what they are');
  assert.deepEqual(s.other, ['CASH-A'], 'a number without digits at the end');
  assert.deepEqual(s.series.map((x) => x.series), ['B-…', 'SRS/26-27/…']);
  assert.deepEqual(s.twins, [{ tally_no: 'srs/26-27/0132', slips: [2, 9] }], 'the same Tally bill on two slips');
});

test('expenses with a GST bill: split by the seller\'s state; food / personal and missing GST no. are not claimed', () => {
  const rows = expenseRows([
    { date: '2026-10-03', bill_no: 'T-9', paid_to: 'Blade shop', seller_gstin: DL, category: 'blade', amount: 1180, gst_amount: 180 },
    { date: '2026-10-04', bill_no: 'F-2', paid_to: 'Transport', seller_gstin: HR, category: 'freight', amount: 1050, gst_amount: 50 },
    { date: '2026-10-05', bill_no: null, paid_to: 'Dhaba', seller_gstin: DL, category: 'tea', amount: 525, gst_amount: 25 },
    { date: '2026-10-06', bill_no: 'R1', paid_to: 'Repair', seller_gstin: null, category: 'repair', amount: 2360, gst_amount: 360 },
  ], '07');
  assert.deepEqual([rows[0].cgst, rows[0].sgst, rows[0].taxable, rows[0].claim], [90, 90, 1000, true]);
  assert.deepEqual([rows[1].igst, rows[1].claim], [50, true]);
  assert.deepEqual([rows[2].claim, rows[2].flags], [false, ['exp_no_bill_no', 'exp_blocked']]);
  assert.deepEqual([rows[3].claim, rows[3].cgst, rows[3].flags], [false, null, ['exp_no_gstin']]);
});

test('supplier credit notes: a bill\'s own GST share, otherwise worked out and marked', () => {
  const rows = creditNoteRows([
    { date: '2026-10-09', note_no: 'CN-4', kind: 'return', supplier: 'P K Steel', gstin: DL, amount: 11800, bill: { bill_no: 'PKT/316', gst: 18000, total: 118000 } },
    { date: '2026-10-10', note_no: null, kind: 'discount', supplier: 'Mehta', gstin: HR, amount: 1180, bill: null },
  ], '07');
  assert.deepEqual([rows[0].gst, rows[0].cgst, rows[0].taxable, rows[0].flags], [1800, 900, 10000, []]);
  assert.deepEqual([rows[1].gst, rows[1].igst, rows[1].flags], [180, 180, ['cn_estimated', 'cn_no_number', 'cn_discount']]);
});

test('a slip deleted after its Tally bill: same month → cancel the bill; later month → credit note', () => {
  const same = cancelledRow({ slip_no: 7, date: '2026-10-05', deleted_on: '2026-10-20', tally_no: 'A/1', total: 1180, gst: 180, taxable: 1000, pos_kind: 'local' });
  assert.deepEqual([same.need, same.done, same.cgst], ['cancel_bill', false, 90]);
  const later = cancelledRow({ slip_no: 8, date: '2026-10-28', deleted_on: '2026-11-02', tally_no: 'A/2', total: 1180, gst: 180, pos_kind: 'inter', how: 'credit_note', cn_no: null });
  assert.deepEqual([later.need, later.done, later.igst], ['credit_note', false, 180], 'a credit note without its number is not done');
  assert.equal(cancelledRow({ ...later, cn_no: 'CN/3' }).done, true);
  assert.equal(cancelledRow({ ...same, how: 'bill_cancelled' }).done, true);
});

test('rough GSTR-3B: tax on sales less credit notes, GST on bills less supplier notes, cancelled suppliers left out, 3.2 by state', () => {
  const sales = withTables(salesRows({ date: '2026-10-05', slip_no: 1, customer: 'Y', gstin: null, gst_pct: 18, gst: 1800,
    pos: { from: '07', to: '06', kind: 'inter', sure: true }, items: [{ hsn: '7214', kg: 100, taxable: 10000, hsn_checked: true }] }, 18));
  const purchases = [
    ...purchaseRows({ date: '2026-10-02', bill_no: 'P1', supplier: 'A', gstin: DL, gst: 900, total: 5900, lines: [{ hsn: '7214', kg: 70, amount: 5000 }] }, '07'),
    ...purchaseRows({ date: '2026-10-03', bill_no: 'P2', supplier: 'B', gstin: HR, gst: 180, total: 1180, gst_status: 'cancelled', lines: [{ hsn: '7214', kg: 10, amount: 1000 }] }, '07'),
  ];
  assert.deepEqual(purchases[1].flags, ['sup_cancelled']);
  const r = gst3b({ sales, purchases, expenses: [{ claim: true, taxable: 100, cgst: 9, sgst: 9, igst: 0, gst: 18 }, { claim: false, gst: 50 }],
    creditNotes: [{ taxable: 100, cgst: 9, sgst: 9, igst: 0, gst: 18 }],
    cancelled: [{ need: 'credit_note', taxable: 1000, igst: 180, cgst: 0, sgst: 0, gst: 180 }, { need: 'cancel_bill', gst: 999 }] });
  assert.equal(r.out_net.tax, 1620);
  assert.equal(r.itc_net.tax, 900, '900 + 18 − 18; the cancelled supplier\'s 180 is left out');
  assert.equal(r.itc_left_out.tax, 180);
  assert.deepEqual([r.to_pay, r.carry], [720, 0]);
  assert.deepEqual(r.inter_b2c, [{ state: 'Haryana', taxable: 10000, igst: 1800 }]);
});

test('checks before sending: most serious first, only what applies, the Day book match always', () => {
  const c = caChecks({
    bills: [{ slip_no: 1, total: 1180, tally_no: 'A/1', tally_total: 1190, date: '2026-10-02', tally_date: '2026-11-01' }, { slip_no: 2, total: 500, tally_no: null }],
    cancelled: [{ done: false, total: 2360 }], series: { series: [{ missing: ['A/3'] }], twins: [] }, sales: [{ slip_no: 2, flags: ['pos_no_dest'] }],
    unpaid180: [{ left: 5000 }], matchesDayBook: true, slipCount: 2, dayBookTotal: 1680,
  });
  assert.deepEqual(c.map((x) => x.id), ['tally_cancel', 'tally_differs', 'unpaid180', 'no_tally', 'tally_gap', 'tally_month', 'pos_check', 'daybook']);
  assert.deepEqual([c[0].amount, c[3].amount, c.at(-1).tone], [2360, 500, 'ok']);
});
