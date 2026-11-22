// The CA's monthly file, worked out by the GST rules (22 Nov 2026). The app makes no GST invoices — the CA does, in
// Tally — so this module only arranges what the app knows the way the returns ask for it, and lists everything that
// would make the app's numbers and Tally's numbers differ:
//   GSTR-1  Table 4 (B2B: customers with a GST no.), Table 5 (B2C large: another state, bill over ₹1 lakh), Table 7
//           (B2C others), Table 9 (credit notes), Table 12 (HSN summary, B2B and B2C apart), Table 13 (bill numbers)
//   GSTR-3B Table 3.1 (sales and tax), 3.2 (to people without a GST no. in other states, by state), 4 (GST on our bills)
// Nothing here is the CA's final word: "GST to pay" is rough, and every doubt becomes a check, never a guess.
import { r2 } from './round.js';
import { checkGstin } from './gstin.js';
import { stateOfGstin, stateName, gstSplit } from './gstPlace.js';

const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
const n = (x) => Number(x) || 0;

/** Inter-state bills to people without a GST no. above this are reported one by one (GSTR-1 Table 5, from Aug 2024). */
export const B2CL_LIMIT = 100000;
/** A bill to someone without a GST no. from this value needs their name, address, delivery address and state (Rule 46). */
export const B2C_DETAILS_LIMIT = 50000;
/** GST credit is paid back when the supplier is not paid within this many days of the bill (Section 16(2)). */
export const UNPAID_DAYS = 180;
/** Expense kinds whose GST usually can't be claimed (food, personal — Section 17(5)); the CA decides. */
export const BLOCKED_EXPENSES = ['tea', 'puja'];
/** Steel HSN headings, as the GST portal names them (for the HSN summary). */
export const HSN_NAMES = {
  7208: 'Flat-rolled iron or non-alloy steel, hot-rolled, 600 mm or more', 7209: 'Flat-rolled iron or non-alloy steel, cold-rolled, 600 mm or more',
  7210: 'Flat-rolled iron or non-alloy steel, clad, plated or coated', 7211: 'Flat-rolled iron or non-alloy steel, under 600 mm',
  7213: 'Bars and rods of iron or non-alloy steel, hot-rolled, in coils', 7214: 'Other bars and rods of iron or non-alloy steel',
  7215: 'Other bars and rods of iron or non-alloy steel (cold-formed)', 7216: 'Angles, shapes and sections of iron or non-alloy steel',
  7217: 'Wire of iron or non-alloy steel', 7219: 'Flat-rolled stainless steel, 600 mm or more', 7220: 'Flat-rolled stainless steel, under 600 mm',
  7221: 'Bars and rods of stainless steel, hot-rolled, in coils', 7222: 'Other bars and rods, angles, shapes of stainless steel',
  7225: 'Flat-rolled other alloy steel, 600 mm or more', 7226: 'Flat-rolled other alloy steel, under 600 mm',
  7227: 'Bars and rods of other alloy steel, hot-rolled, in coils', 7228: 'Other bars and rods of other alloy steel; hollow drill bars',
  7304: 'Tubes, pipes and hollow profiles, seamless', 7306: 'Other tubes, pipes and hollow profiles', 7326: 'Other articles of iron or steel',
};
export const hsnName = (hsn) => HSN_NAMES[String(hsn || '').slice(0, 4)] || '';

/**
 * Which GSTR-1 table a bill goes in: 'b2b' (a valid GST no.), 'b2cl' (no GST no., another state, bill over ₹1 lakh),
 * else 'b2cs'. value = the bill's full value with GST.
 */
export function gstr1Table({ gstin, posKind, value }) {
  if (gstin && checkGstin(gstin).ok) return 'b2b';
  if (posKind === 'inter' && n(value) > B2CL_LIMIT) return 'b2cl';
  return 'b2cs';
}

/**
 * Mark each sales register row with its GSTR-1 table, using the whole slip's value (rows of one slip share it).
 * rows: salesRows output (with slip_no, gstin, pos_kind, total). Returns new rows with `table` and `bill_value`.
 */
export function withTables(rows) {
  const value = new Map();
  for (const r of rows) value.set(r.slip_no, r2((value.get(r.slip_no) || 0) + n(r.total)));
  return rows.map((r) => ({ ...r, bill_value: value.get(r.slip_no), table: gstr1Table({ gstin: r.gstin, posKind: r.pos_kind, value: value.get(r.slip_no) }) }));
}

/**
 * GSTR-1 Table 12: the HSN summary, B2B and B2C kept apart (since May 2025). One line per HSN and rate; quantity in
 * kilograms (UQC KGS). Rows with no CGST / SGST / IGST split yet (place of supply to check) are counted in `unsplit`.
 */
export function hsnSummary(rows) {
  const parts = { b2b: new Map(), b2c: new Map() };
  for (const r of rows) {
    if (r.excluded) continue;
    const part = r.table === 'b2b' ? 'b2b' : 'b2c';
    const key = `${r.hsn || ''}|${n(r.rate)}`;
    const g = parts[part].get(key) || { hsn: r.hsn || '', desc: hsnName(r.hsn) || r.desc || '', uqc: 'KGS', qty: 0, taxable: 0, rate: n(r.rate),
      igst: 0, cgst: 0, sgst: 0, tax: 0, value: 0, unsplit: 0, bills: new Set() };
    g.qty = r3(g.qty + n(r.kg)); g.taxable = r2(g.taxable + n(r.taxable));
    if (r.cgst == null) g.unsplit = r2(g.unsplit + n(r.gst));
    else { g.igst = r2(g.igst + n(r.igst)); g.cgst = r2(g.cgst + n(r.cgst)); g.sgst = r2(g.sgst + n(r.sgst)); }
    g.tax = r2(g.tax + n(r.gst)); g.value = r2(g.value + n(r.total)); g.bills.add(r.slip_no);
    parts[part].set(key, g);
  }
  const sum = (list) => list.reduce((t, g) => ({ qty: r3(t.qty + g.qty), taxable: r2(t.taxable + g.taxable), igst: r2(t.igst + g.igst), cgst: r2(t.cgst + g.cgst),
    sgst: r2(t.sgst + g.sgst), tax: r2(t.tax + g.tax), value: r2(t.value + g.value), unsplit: r2(t.unsplit + g.unsplit) }),
  { qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, tax: 0, value: 0, unsplit: 0 });
  const out = (m) => [...m.values()].map(({ bills, ...g }) => ({ ...g, bills: bills.size })).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
  const b2b = out(parts.b2b), b2c = out(parts.b2c);
  const tb = sum(b2b), tc = sum(b2c);
  const all = Object.fromEntries(Object.keys(tb).map((k) => [k, k === 'qty' ? r3(tb[k] + tc[k]) : r2(tb[k] + tc[k])]));
  return { b2b, b2c, totals: { b2b: tb, b2c: tc, all } };
}

/** "SRS/26-27/0142" → { series: 'SRS/26-27/…', num: 142, width: 4 }; no number at the end → null. */
export function splitBillNo(no) {
  const m = /^(.*?)(\d+)(\D*)$/.exec(String(no || '').trim());
  if (!m) return null;
  return { prefix: m[1], suffix: m[3], series: `${m[1]}…${m[3]}`, num: Number(m[2]), width: m[2].length, text: String(no).trim() };
}

/** The Tally no. after this one, kept in the same style: "SRS/26-27/0142" → "SRS/26-27/0143"; none without a number. */
export function nextBillNo(no) {
  const s = splitBillNo(no);
  return s ? `${s.prefix}${String(s.num + 1).padStart(s.width, '0')}${s.suffix}` : null;
}

/**
 * GSTR-1 Table 13 from the Tally bill numbers of a month, plus what doesn't add up.
 *   bills: [{ tally_no, slip_no, cancelled: boolean }]   (a bill cancelled in Tally counts as cancelled)
 * Returns { series: [{ series, from, to, total, in_app, cancelled, net, missing: [text], missing_count }],
 *           other: [tally_no], twins: [{ tally_no, slips: [slip_no] }] }
 * `missing` are numbers inside a series' range that no slip has: a Tally bill made without a slip, or one cancelled in
 * Tally — the CA says which.
 */
export function tallySeries(bills) {
  const groups = new Map(); const other = []; const seen = new Map();
  for (const b of bills || []) {
    const no = String(b.tally_no || '').trim();
    if (!no) continue;
    const key = no.toLowerCase();
    seen.set(key, [...(seen.get(key) || []), b.slip_no]);
    if ((seen.get(key) || []).length > 1) continue;
    const s = splitBillNo(no);
    if (!s) { other.push(no); continue; }
    const g = groups.get(s.series) || { s, nums: new Map() };
    g.nums.set(s.num, { text: s.text, cancelled: !!b.cancelled, width: s.width });
    groups.set(s.series, g);
  }
  const pad = (s, num, width) => `${s.prefix}${String(num).padStart(width, '0')}${s.suffix}`;
  const series = [...groups.values()].map(({ s, nums }) => {
    const list = [...nums.keys()].sort((a, b) => a - b);
    const lo = list[0], hi = list[list.length - 1];
    const width = Math.max(...[...nums.values()].map((x) => x.width));
    const missing = [];
    let missingCount = 0;
    for (let k = lo; k <= hi && hi - lo < 100000; k += 1) if (!nums.has(k)) { missingCount += 1; if (missing.length < 50) missing.push(pad(s, k, width)); }
    const cancelled = [...nums.values()].filter((x) => x.cancelled).length;
    const total = hi - lo + 1;
    return { series: s.series, from: nums.get(lo).text, to: nums.get(hi).text, total, in_app: nums.size, cancelled, net: total - cancelled,
      missing, missing_count: missingCount };
  }).sort((a, b) => a.from.localeCompare(b.from));
  const twins = [...seen.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ tally_no: k, slips: v }));
  return { series, other, twins };
}

/**
 * Shop expenses with a GST bill → rows for the CA (GST on our bills, besides steel). The seller's state from its GST
 * no.: inside the shop's state → CGST + SGST, else IGST. Food / personal kinds are marked: their GST usually can't be
 * claimed. expense: { date, bill_no, paid_to, seller_gstin, category, amount (with GST), gst_amount }
 */
export function expenseRows(expenses, shopState) {
  return (expenses || []).map((e) => {
    const gst = r2(n(e.gst_amount));
    const sup = stateOfGstin(e.seller_gstin);
    const kind = sup && shopState ? (sup === shopState ? 'local' : 'inter') : null;
    const split = gstSplit(gst, kind);
    const flags = [];
    if (!sup) flags.push('exp_no_gstin');
    if (!e.bill_no) flags.push('exp_no_bill_no');
    if (BLOCKED_EXPENSES.includes(e.category)) flags.push('exp_blocked');
    if (!(gst > 0)) flags.push('exp_no_gst');
    return { date: e.date, bill_no: e.bill_no || '', paid_to: e.paid_to || '', gstin: e.seller_gstin || '', state: sup ? stateName(sup) : '',
      category: e.category, taxable: r2(n(e.amount) - gst), cgst: split ? split.cgst : null, sgst: split ? split.sgst : null, igst: split ? split.igst : null,
      gst, total: r2(n(e.amount)), claim: !flags.includes('exp_no_gstin') && !flags.includes('exp_blocked') && gst > 0, flags };
  });
}

/**
 * Supplier credit notes (returns, rate differences, discounts) on GST bills → rows for the CA: they lower the GST we
 * may claim. A note against one bill takes that bill's share of GST; any other note is worked out at the shop's rate
 * and marked "worked out — CA to check". note: { date, note_no, kind, supplier, gstin, amount (with GST),
 * bill: { bill_no, gst, total } | null }
 */
export function creditNoteRows(notes, shopState, pct = 18) {
  return (notes || []).map((x) => {
    const amt = r2(n(x.amount));
    const billed = x.bill && n(x.bill.total) > 0;
    const gst = billed ? r2((amt * n(x.bill.gst)) / n(x.bill.total)) : r2((amt * pct) / (100 + pct));
    const sup = stateOfGstin(x.gstin);
    const kind = sup && shopState ? (sup === shopState ? 'local' : 'inter') : null;
    const split = gstSplit(gst, kind);
    const flags = [];
    if (!billed) flags.push('cn_estimated');
    if (!x.note_no) flags.push('cn_no_number');
    if (x.kind === 'discount' || x.kind === 'other') flags.push('cn_discount');
    if (!sup) flags.push('no_gstin');
    return { date: x.date, note_no: x.note_no || '', kind: x.kind, supplier: x.supplier || '', gstin: x.gstin || '', state: sup ? stateName(sup) : '',
      bill_no: x.bill?.bill_no || '', taxable: r2(amt - gst), cgst: split ? split.cgst : null, sgst: split ? split.sgst : null, igst: split ? split.igst : null,
      gst, total: amt, flags };
  });
}

const monthOfDay = (d) => String(d || '').slice(0, 7);

/**
 * GST slips deleted after their Tally bill was made. Deleted in the same month as the bill → the CA cancels the Tally
 * bill (it counts as cancelled in Table 13); deleted in a later month → the bill stays in its month and the CA makes a
 * credit note (GSTR-1 Table 9) in the month it was deleted.
 *   x: { slip_no, customer, gstin, date (finished), deleted_on, reason, tally_no, tally_date, total, gst, taxable,
 *        pos_kind, how: null | 'bill_cancelled' | 'credit_note', cn_no, cn_date }
 */
export function cancelledRow(x) {
  const same = monthOfDay(x.date) === monthOfDay(x.deleted_on);
  const need = same ? 'cancel_bill' : 'credit_note';
  const done = x.how === 'bill_cancelled' || (x.how === 'credit_note' && !!x.cn_no);
  const split = gstSplit(n(x.gst), x.pos_kind);
  return { ...x, need, done, cgst: split ? split.cgst : null, sgst: split ? split.sgst : null, igst: split ? split.igst : null };
}

/**
 * A rough GSTR-3B for the month (the CA files the real one): tax on sales (less credit notes for slips deleted this
 * month after an earlier month's bill), GST on our bills (purchases + claimable expenses − supplier credit notes; bills
 * from suppliers whose GST no. is cancelled are left out), and what may be left to pay. Also Table 3.2: inter-state
 * sales to people without a GST no., by state.
 */
export function gst3b({ sales = [], purchases = [], expenses = [], creditNotes = [], cancelled = [] }) {
  const add = (t, r, sign = 1) => ({ taxable: r2(t.taxable + sign * n(r.taxable)), igst: r2(t.igst + sign * n(r.igst)), cgst: r2(t.cgst + sign * n(r.cgst)),
    sgst: r2(t.sgst + sign * n(r.sgst)), tax: r2(t.tax + sign * n(r.gst ?? r.tax)) });
  const zero = { taxable: 0, igst: 0, cgst: 0, sgst: 0, tax: 0 };
  let out = zero;
  for (const r of sales) if (!r.excluded) out = add(out, r);
  let cn = zero;
  for (const c of cancelled) if (c.need === 'credit_note') cn = add(cn, c);
  const outNet = add(out, cn, -1);
  let itc = zero; let left = zero;
  for (const r of purchases) { if (r.sup_bad) left = add(left, r); else itc = add(itc, r); }
  for (const e of expenses) if (e.claim) itc = add(itc, e);
  let notes = zero;
  for (const x of creditNotes) notes = add(notes, x);
  const itcNet = add(itc, notes, -1);
  const byState = new Map();
  for (const r of sales) {
    if (r.excluded || r.table === 'b2b' || r.pos_kind !== 'inter' || !r.pos) continue;
    const g = byState.get(r.pos) || { state: r.pos, taxable: 0, igst: 0 };
    g.taxable = r2(g.taxable + n(r.taxable)); g.igst = r2(g.igst + n(r.igst));
    byState.set(r.pos, g);
  }
  const diff = r2(outNet.tax - itcNet.tax);
  return { out, credit_notes_out: cn, out_net: outNet, itc, supplier_notes: notes, itc_net: itcNet, itc_left_out: left,
    to_pay: diff > 0 ? diff : 0, carry: diff < 0 ? -diff : 0, inter_b2c: [...byState.values()].sort((a, b) => a.state.localeCompare(b.state)) };
}

/**
 * The "check before sending" list: everything that would make the CA's file, Tally and the returns differ, most serious
 * first. Each check: { id, tone: 'bad' | 'warn' | 'ok', n, amount?, items? }. Only checks that apply are returned, plus
 * the Day book match (always).
 */
export function caChecks(d) {
  const c = [];
  const push = (id, tone, items, amount) => { if (items.length) c.push({ id, tone, n: items.length, amount: amount == null ? undefined : r2(amount), items }); };
  const bills = d.bills || [];
  push('tally_cancel', 'bad', (d.cancelled || []).filter((x) => !x.done), (d.cancelled || []).filter((x) => !x.done).reduce((t, x) => t + n(x.total), 0));
  push('tally_twin', 'bad', d.series?.twins || []);
  push('tally_differs', 'bad', bills.filter((b) => b.tally_no && b.tally_total != null && Math.abs(n(b.tally_total) - n(b.total)) > 1));
  push('sup_gst', 'bad', (d.purchaseBills || []).filter((b) => b.sup_bad), (d.purchaseBills || []).filter((b) => b.sup_bad).reduce((t, b) => t + n(b.gst), 0));
  push('unpaid180', 'bad', d.unpaid180 || [], (d.unpaid180 || []).reduce((t, b) => t + n(b.left), 0));
  push('pending_before', 'bad', d.pendingBefore || []);
  push('no_tally', 'warn', bills.filter((b) => !b.tally_no && !b.deleted), bills.filter((b) => !b.tally_no && !b.deleted).reduce((t, b) => t + n(b.total), 0));
  push('tally_gap', 'warn', (d.series?.series || []).flatMap((s) => s.missing));
  push('tally_month', 'warn', bills.filter((b) => b.tally_no && b.tally_date && monthOfDay(b.tally_date) !== monthOfDay(b.date)));
  const slipsWith = (flag) => [...new Set((d.sales || []).filter((r) => r.flags?.some((f) => (Array.isArray(flag) ? flag.includes(f) : f.startsWith(flag)))).map((r) => r.slip_no))];
  push('pos_check', 'warn', slipsWith('pos_'));
  push('hsn_check', 'warn', slipsWith(['hsn_missing', 'hsn_bad', 'hsn_unchecked', 'hsn_not_saved']));
  push('b2c_details', 'warn', slipsWith(['b2c_address']));
  push('exp_check', 'warn', (d.expenses || []).filter((e) => e.flags.includes('exp_no_gstin') || e.flags.includes('exp_no_bill_no')));
  push('cn_check', 'warn', (d.creditNotes || []).filter((x) => x.flags.includes('cn_estimated') || x.flags.includes('cn_no_number')));
  c.push({ id: 'daybook', tone: d.matchesDayBook ? 'ok' : 'bad', n: d.slipCount || 0, amount: d.dayBookTotal });
  return c;
}
