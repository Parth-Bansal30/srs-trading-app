// The CA's monthly Excel file (22 Nov 2026), laid out the way the GST returns ask for it — written on this phone from
// what the server worked out (gstMonth). English, plain numbers (so the CA can add them up), bold section and total rows.
//   Summary · Checks · Sales register · HSN summary (Table 12) · Tally bill numbers (Table 13) · Purchase register ·
//   GST expenses · Supplier credit notes · Deleted after Tally bill · GSTR-3B (rough) · Unpaid 180 days
import { makeXlsx } from '../../lib/xlsx.js';

const ck = (w, c) => (c.n === 1 && w(`ck_${c.id}_1`) !== `ck_${c.id}_1` ? w(`ck_${c.id}_1`, c.n) : w(`ck_${c.id}`, c.n));
const num = (v) => (v == null || v === '' ? '' : Number(v));
const TABLE = { b2b: 'B2B (Table 4)', b2cl: 'B2C large (Table 5)', b2cs: 'B2C (Table 7)' };
const DELIVERY = { pickup: 'Customer took it', ours: 'Our delivery', direct: 'Straight from supplier' };
const EFFECT = { stock: 'Into stock', direct: 'Direct to customer', opening: 'Opening stock', accounted: 'Accounted only', reference: 'Reference only' };
const KIND = { return: 'Return', rate: 'Rate difference', discount: 'Discount', other: 'Other' };
const SUP = { active: 'Active', cancelled: 'CANCELLED', suspended: 'SUSPENDED', inactive: 'Not active', not_found: 'Not found' };

/** A sheet built row by row, remembering which rows are bold (sections, totals). */
function sheet(name, header, widths) {
  const rows = [header]; const bold = [];
  return {
    add(r, strong = false) { if (strong) bold.push(rows.length); rows.push(r); return this; },
    gap() { rows.push([]); return this; },
    done() { return { name, rows, widths, head: 0, bold }; },
    get length() { return rows.length; },
  };
}

/**
 * m: the gstMonth answer · w(key, ...args): English words (tIn('en', …)) · flagText(flags) · names: { month, shop }
 * Returns the .xlsx bytes.
 */
export function caWorkbook(m, { w, flagText, monthName }) {
  const live = m.sales.filter((r) => !r.excluded);
  const sum = (list, k) => Math.round(list.reduce((t, r) => t + (Number(r[k]) || 0), 0) * 100) / 100;
  const byTable = (tb) => live.filter((r) => r.table === tb);
  const g = m.gst3b;

  // ---------- Summary ----------
  const S = sheet('Summary', ['For the CA — GST papers', monthName(m.month)], [62, 24]);
  S.add(['Shop', m.shop?.name || '']).add(['Shop GSTIN', m.shop?.gstin || ''])
    .add(['Made by', "the shop's app from its GST slips and bills — the GST invoices themselves are the CA's, in Tally"]).gap();
  S.add(['SALES (GSTR-1)', ''], true)
    .add(['GST slips', new Set(live.map((r) => r.slip_no)).size])
    .add(['To customers with a GST no. — B2B, Table 4 (taxable value)', sum(byTable('b2b'), 'taxable')])
    .add(['To others in another state, bill over ₹1 lakh — B2C large, Table 5', sum(byTable('b2cl'), 'taxable')])
    .add(['To others — B2C, Table 7', sum(byTable('b2cs'), 'taxable')])
    .add(['Taxable value', m.sales_totals.taxable]).add(['CGST', m.sales_totals.cgst]).add(['SGST', m.sales_totals.sgst]).add(['IGST', m.sales_totals.igst])
    .add(['Total with GST', m.sales_totals.total], true)
    .add(['The same as the Day book (GST slips) + slips deleted in a later month', m.matches_day_book ? 'Yes' : 'NO — tell the app\'s maker'])
    .add(['GST slips deleted after their Tally bill (see that sheet)', m.cancelled.length]).gap();
  S.add(['PURCHASES AND EXPENSES (GSTR-3B Table 4)', ''], true)
    .add(['GST purchase bills', m.purchase_bills.length]).add(['Their GST', m.purchase_totals.gst])
    .add(['Expense bills with GST', (m.expenses || []).length]).add(['Their GST that can be claimed', sum((m.expenses || []).filter((e) => e.claim), 'gst')])
    .add(['Supplier credit notes', m.credit_notes.length]).add(['Their GST (lowers the credit)', sum(m.credit_notes, 'gst')]).gap();
  S.add(['ROUGH GST TO PAY — the CA files the real return', ''], true)
    .add(['Tax on sales, after credit notes', g.out_net.tax]).add(['GST on our bills, after supplier credit notes', g.itc_net.tax])
    .add([g.to_pay > 0 ? 'To pay (rough)' : 'Credit left over (rough)', g.to_pay > 0 ? g.to_pay : g.carry], true).gap();
  S.add(['THINGS TO CHECK', ''], true);
  for (const c of m.checks) S.add([c.id === 'daybook' ? w(c.tone === 'ok' ? 'ck_daybook_ok' : 'ck_daybook_bad') : ck(w, c), c.amount == null ? '' : c.amount]);
  S.gap().add(['CGST / SGST / IGST are worked out from where the steel went; "CA to check" marks rows where something is missing or unusual. No-bill slips are never in this file.', '']);

  // ---------- Checks (each item) ----------
  const C = sheet('Checks', ['What to check', 'Slip / bill', 'Detail', 'Amount'], [46, 22, 52, 14]);
  const detail = (c, x) => {
    if (c.id === 'tally_gap') return [x, 'Is this Tally bill cancelled, or made without a slip?', ''];
    if (c.id === 'tally_twin') return [x.tally_no, `on slips #${x.slips.join(', #')}`, ''];
    if (['tally_differs', 'tally_month', 'no_tally'].includes(c.id)) return [`#${x.slip_no}`, `${x.tally_no || 'no Tally no.'}${x.tally_total != null ? ` · Tally ${x.tally_total}` : ''}${x.tally_date ? ` · dated ${x.tally_date}` : ''}`, num(x.total)];
    if (c.id === 'tally_cancel') return [`#${x.slip_no}`, `${x.tally_no} · deleted ${x.deleted_on} · ${x.need === 'cancel_bill' ? 'cancel the Tally bill' : 'make a credit note'}`, num(x.total)];
    if (c.id === 'pending_before') return [`#${x.slip_no}`, `${x.date} · ${x.customer}`, num(x.total)];
    if (c.id === 'sup_gst') return [x.bill_no, `${x.supplier} · GST no. ${SUP[x.gst_status] || x.gst_status}`, num(x.gst)];
    if (c.id === 'unpaid180') return [x.bill_no, `${x.supplier} · ${x.date} · ${x.days} days`, num(x.left)];
    if (c.id === 'exp_check') return [x.bill_no || '(no bill no.)', `${x.paid_to} · ${flagText(x.flags)}`, num(x.gst)];
    if (c.id === 'cn_check') return [x.note_no || '(no note no.)', `${x.supplier} · ${flagText(x.flags)}`, num(x.gst)];
    if (typeof x === 'object' && x) return [`#${x.slip_no ?? ''}`, '', ''];
    return [`#${x}`, '', ''];
  };
  for (const c of m.checks.filter((x) => x.id !== 'daybook')) {
    C.add([ck(w, c), '', '', c.amount == null ? '' : c.amount], true);
    for (const x of (c.items || []).slice(0, 300)) C.add(['', ...detail(c, x)]);
  }
  if (C.length === 1) C.add(['Nothing to check this month', '', '', '']);

  // ---------- Sales register ----------
  const R = sheet('Sales register', ['Date', 'Slip no.', 'Tally bill no.', 'Tally date', 'Tally total', 'Customer', 'GSTIN', 'GSTR-1 table', 'Place of supply', 'Delivery',
    'HSN', 'Description', 'Kg', 'Taxable value', 'GST rate %', 'CGST', 'SGST', 'IGST', 'GST', 'Total', 'Status', 'CA to check'],
  [11, 8, 16, 11, 12, 24, 17, 18, 15, 18, 9, 22, 10, 13, 8, 11, 11, 11, 11, 13, 22, 40]);
  for (const r of live) {
    R.add([r.date, /^\d+$/.test(String(r.slip_no)) ? Number(r.slip_no) : r.slip_no, r.tally_no, r.tally_date || '', num(r.tally_total), r.customer, r.gstin, TABLE[r.table] || '',
      r.pos, DELIVERY[r.delivery] || '', r.hsn, r.desc, num(r.kg), num(r.taxable), num(r.rate), num(r.cgst), num(r.sgst), num(r.igst), num(r.gst), num(r.total),
      r.status === 'deleted' ? 'Deleted later — credit note' : '', flagText(r.flags.filter((f) => f !== 'cancelled_later'))]);
  }
  R.add(['', '', '', '', '', 'TOTAL', '', '', '', '', '', '', sum(live, 'kg'), m.sales_totals.taxable, '', m.sales_totals.cgst, m.sales_totals.sgst, m.sales_totals.igst,
    m.sales_totals.gst, m.sales_totals.total, '', ''], true);

  // ---------- HSN summary (GSTR-1 Table 12) ----------
  const H = sheet('HSN summary', ['HSN', 'Description', 'UQC', 'Total quantity', 'Taxable value', 'Rate %', 'IGST', 'CGST', 'SGST', 'Total tax', 'Total value', 'Not split yet (CA to check)'],
    [9, 44, 6, 14, 14, 8, 12, 12, 12, 12, 14, 14]);
  const hsnPart = (title, list, t) => {
    H.add([title], true);
    for (const x of list) H.add([x.hsn || '(missing)', x.desc, x.uqc, x.qty, x.taxable, x.rate, x.igst, x.cgst, x.sgst, x.tax, x.value, x.unsplit || '']);
    if (!list.length) H.add(['', 'None this month']);
    H.add(['', `${title.split(' —')[0]} total`, '', t.qty, t.taxable, '', t.igst, t.cgst, t.sgst, t.tax, t.value, t.unsplit || ''], true).gap();
  };
  hsnPart('B2B — customers with a GST no.', m.hsn.b2b, m.hsn.totals.b2b);
  hsnPart('B2C — customers without a GST no.', m.hsn.b2c, m.hsn.totals.b2c);
  const ta = m.hsn.totals.all;
  H.add(['', 'All GST sales', '', ta.qty, ta.taxable, '', ta.igst, ta.cgst, ta.sgst, ta.tax, ta.value, ta.unsplit || ''], true);
  H.add(['', Math.abs(ta.taxable - m.sales_totals.taxable) < 0.01 ? 'Matches the sales register ✓' : 'Does NOT match the sales register — tell the app\'s maker']);

  // ---------- Tally bill numbers (GSTR-1 Table 13) ----------
  const T = sheet('Tally bill numbers', ['Nature of document', 'Sr. no. from', 'Sr. no. to', 'Total number', 'Cancelled', 'Net issued', 'In the app', 'Not in the app'],
    [30, 18, 18, 12, 10, 10, 10, 12]);
  for (const s of m.series.series) T.add(['Invoices for outward supply', s.from, s.to, s.total, s.cancelled, s.net, s.in_app, s.missing_count]);
  if (!m.series.series.length) T.add(['No Tally bill numbers yet', '', '', '', '', '', '', '']);
  const miss = m.series.series.flatMap((s) => s.missing);
  if (miss.length) { T.gap().add(['Tally numbers not in the app — cancelled in Tally, or a bill made without a slip? The CA says which.'], true); for (const x of miss) T.add(['', x]); }
  if (m.series.twins.length) { T.gap().add(['The same Tally no. on two slips'], true); for (const x of m.series.twins) T.add(['', x.tally_no, `#${x.slips.join(', #')}`]); }
  if (m.series.other.length) { T.gap().add(['Tally numbers the app could not read as a series'], true); for (const x of m.series.other) T.add(['', x]); }

  // ---------- Purchase register ----------
  const P = sheet('Purchase register', ['Date', 'Bill no.', 'Supplier', 'GSTIN', 'Supplier GST status', 'State', 'HSN', 'Description', 'Kg', 'Taxable value', 'CGST', 'SGST', 'IGST',
    'GST', 'Round off', 'Total', 'Stock effect', 'CA to check'], [11, 14, 24, 17, 14, 14, 9, 24, 10, 13, 11, 11, 11, 11, 9, 13, 16, 30]);
  const status = new Map(m.purchase_bills.map((b) => [`${b.bill_no}|${b.supplier}`, b.gst_status]));
  for (const r of m.purchases) {
    P.add([r.date, r.bill_no, r.supplier, r.gstin, SUP[status.get(`${r.bill_no}|${r.supplier}`)] || 'Not checked', r.state, r.hsn, r.desc, num(r.kg), num(r.taxable), num(r.cgst),
      num(r.sgst), num(r.igst), num(r.gst), num(r.round_off), num(r.total), EFFECT[r.stock_effect] || r.stock_effect, flagText(r.flags)]);
  }
  P.add(['', '', 'TOTAL', '', '', '', '', '', '', m.purchase_totals.taxable, m.purchase_totals.cgst, m.purchase_totals.sgst, m.purchase_totals.igst, m.purchase_totals.gst, '',
    m.purchase_totals.total, '', ''], true);

  // ---------- GST expenses ----------
  const E = sheet('GST expenses', ['Date paid', 'Bill no.', 'Paid to', 'Seller GSTIN', 'State', 'Kind', 'Taxable value', 'CGST', 'SGST', 'IGST', 'GST', 'Total', 'Can be claimed', 'CA to check'],
    [11, 12, 22, 17, 14, 12, 13, 10, 10, 10, 10, 12, 12, 36]);
  for (const e of m.expenses || []) {
    E.add([e.date, e.bill_no, e.paid_to, e.gstin, e.state, e.category, num(e.taxable), num(e.cgst), num(e.sgst), num(e.igst), num(e.gst), num(e.total), e.claim ? 'Yes' : 'No', flagText(e.flags)]);
  }
  if (m.expenses == null) E.add(['Expenses are not shown to this person']);
  else if (!m.expenses.length) E.add(['No expense bills with GST this month']);
  else E.add(['', '', 'TOTAL (claimable)', '', '', '', sum(m.expenses.filter((e) => e.claim), 'taxable'), sum(m.expenses.filter((e) => e.claim), 'cgst'),
    sum(m.expenses.filter((e) => e.claim), 'sgst'), sum(m.expenses.filter((e) => e.claim), 'igst'), sum(m.expenses.filter((e) => e.claim), 'gst'), sum(m.expenses.filter((e) => e.claim), 'total'), '', ''], true);

  // ---------- Supplier credit notes ----------
  const N = sheet('Supplier credit notes', ['Date', 'Note no.', 'Supplier', 'GSTIN', 'State', 'Kind', 'Against bill', 'Taxable value', 'CGST', 'SGST', 'IGST', 'GST', 'Total', 'CA to check'],
    [11, 12, 22, 17, 14, 14, 14, 13, 10, 10, 10, 10, 12, 40]);
  for (const x of m.credit_notes) {
    N.add([x.date, x.note_no, x.supplier, x.gstin, x.state, KIND[x.kind] || x.kind, x.bill_no, num(x.taxable), num(x.cgst), num(x.sgst), num(x.igst), num(x.gst), num(x.total), flagText(x.flags)]);
  }
  if (!m.credit_notes.length) N.add(['No supplier credit notes this month']);
  else N.add(['', '', 'TOTAL', '', '', '', '', sum(m.credit_notes, 'taxable'), sum(m.credit_notes, 'cgst'), sum(m.credit_notes, 'sgst'), sum(m.credit_notes, 'igst'),
    sum(m.credit_notes, 'gst'), sum(m.credit_notes, 'total'), ''], true);

  // ---------- GST slips deleted after their Tally bill ----------
  const D = sheet('Deleted after Tally bill', ['Slip no.', 'Customer', 'GSTIN', 'Slip date', 'Tally bill no.', 'Tally date', 'Deleted on', 'Reason', 'Taxable value', 'CGST', 'SGST',
    'IGST', 'GST', 'Total', 'What the CA does', 'Done'], [8, 22, 17, 11, 16, 11, 11, 26, 13, 10, 10, 10, 10, 12, 34, 22]);
  for (const x of m.cancelled) {
    D.add([x.slip_no, x.customer, x.gstin || '', x.date, x.tally_no, x.tally_date || '', x.deleted_on, x.reason || '', num(x.taxable), num(x.cgst), num(x.sgst), num(x.igst), num(x.gst),
      num(x.total), x.need === 'cancel_bill' ? 'Cancel the Tally bill (same month)' : 'Make a credit note this month (GSTR-1 Table 9)',
      x.how === 'bill_cancelled' ? 'Tally bill cancelled' : x.cn_no ? `Credit note ${x.cn_no}${x.cn_date ? ` · ${x.cn_date}` : ''}` : 'Not yet']);
  }
  if (!m.cancelled.length) D.add(['', 'No GST slip was deleted after its Tally bill this month']);

  // ---------- GSTR-3B (rough) ----------
  const B = sheet('GSTR-3B (rough)', ['', 'Taxable value', 'IGST', 'CGST', 'SGST', 'Total tax'], [58, 14, 12, 12, 12, 12]);
  const line = (label, x, strong) => B.add([label, x.taxable, x.igst, x.cgst, x.sgst, x.tax], strong);
  B.add(['3.1 (a) Sales and tax'], true);
  line('Tax on the GST slips', g.out);
  line('Less: credit notes (GST slips deleted this month after an earlier month\'s bill)', g.credit_notes_out);
  line('Net', g.out_net, true);
  B.gap().add(['3.2 Inter-state sales to people without a GST no., by state', 'Taxable value', 'IGST'], true);
  for (const x of g.inter_b2c) B.add([x.state, x.taxable, x.igst]);
  if (!g.inter_b2c.length) B.add(['None this month']);
  B.gap().add(['4 GST on our bills (the CA claims what GSTR-2B shows)'], true);
  line('GST purchase bills (suppliers whose GST no. is fine) and expense bills that can be claimed', g.itc);
  line('Less: supplier credit notes', g.supplier_notes);
  line('Net', g.itc_net, true);
  line('Left out: bills from suppliers whose GST no. is cancelled or suspended', g.itc_left_out);
  B.gap().add([g.to_pay > 0 ? 'To pay (rough)' : 'Credit left over (rough)', '', '', '', '', g.to_pay > 0 ? g.to_pay : g.carry], true);
  B.add(['Rough only: the CA sets IGST / CGST / SGST off by the rules, uses GSTR-2B for the credit and files the real return.']);

  // ---------- Unpaid 180 days ----------
  const U = sheet('Unpaid 180 days', ['Bill date', 'Bill no.', 'Supplier', 'Bill total', 'Still to pay', 'Days', 'GST on the bill'], [11, 14, 24, 13, 13, 8, 13]);
  for (const x of m.unpaid180 || []) U.add([x.date, x.bill_no, x.supplier, num(x.total), num(x.left), x.days, num(x.gst)]);
  if (!(m.unpaid180 || []).length) U.add(['', 'No GST bill is unpaid for 180 days']);
  U.add(['A GST bill not paid within 180 days: its GST credit is paid back until the supplier is paid (Section 16).']);

  return makeXlsx([S, C, R, H, T, P, E, N, D, B, U].map((x) => x.done()));
}
