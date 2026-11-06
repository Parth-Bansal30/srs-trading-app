// GST details for the CA's Tally bills (6 Nov 2026, plan v2 F10). The app does not make GST invoices — the CA does, in
// Tally. It collects the facts (where the steel is going, how it goes, HSN and rate per grade), works out the place of
// supply and the CGST + SGST / IGST split for the CA to confirm, and says "CA to check" whenever something is missing or
// unusual. It never assumes a state.
import { r2 } from './round.js';

const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
import { GST_STATES, checkGstin } from './gstin.js';

/** State code ('07') from a GSTIN, or null. */
export const stateOfGstin = (g) => { const c = g ? checkGstin(g) : null; return c?.ok ? c.stateCode : null; };
/** Real states and union territories a slip can go to (not "Other Territory" / "Centre Jurisdiction"). */
export const SUPPLY_STATES = Object.entries(GST_STATES).filter(([k]) => !['97', '99'].includes(k)).map(([code, name]) => ({ code, name }));
export const stateName = (code) => GST_STATES[code] || '';

/**
 * Place of supply for one GST slip.
 *   shop: the shop's state code (from its GSTIN) · delivery: 'pickup' (customer takes it from the shop) | 'ours' (our
 *   delivery) | 'direct' (sent straight from the supplier) · dest: the state the steel is going to (null = not known)
 * Returns { from, to, kind: 'local' | 'inter' | null, sure, reason } — reason when not sure: 'no_shop' | 'no_dest' | 'direct'.
 */
export function placeOfSupply({ shop = null, delivery = null, dest = null } = {}) {
  const from = GST_STATES[shop] ? shop : null;
  const to = GST_STATES[dest] ? dest : null;
  const kind = from && to ? (from === to ? 'local' : 'inter') : null;
  if (!from) return { from, to, kind, sure: false, reason: 'no_shop' };
  if (delivery === 'direct') return { from, to, kind, sure: false, reason: 'direct' };   // bill-to / ship-to: the CA decides
  if (!to) return { from, to, kind, sure: false, reason: 'no_dest' };
  return { from, to, kind, sure: true, reason: null };
}

/** The GST split: CGST + SGST (half each, the odd paisa on SGST) inside the state, IGST across states; unknown → null. */
export function gstSplit(gst, kind) {
  const g = r2(Number(gst) || 0);
  if (kind === 'local') { const c = r2(Math.floor((g / 2) * 100 + 1e-9) / 100); return { cgst: c, sgst: r2(g - c), igst: 0 }; }
  if (kind === 'inter') return { cgst: 0, sgst: 0, igst: g };
  return null;
}

/** HSN as the CA enters it: 4, 6 or 8 digits. */
export const hsnOk = (h) => /^(\d{4}|\d{6}|\d{8})$/.test(String(h || '').trim());

/**
 * One GST slip → its rows for the sales register (one per HSN). Each row's GST is its share of the slip's GST, the
 * last row taking the paise left, so the rows add up to the slip exactly.
 *   slip: { date, slip_no, tally_no, customer, gstin, pos: {from,to,kind,sure,reason}, delivery, gst_pct, gst, total,
 *           items: [{ hsn, desc, kg, taxable, gst_rate, hsn_checked }] }
 * Returns [{ …, hsn, desc, kg, taxable, rate, cgst, sgst, igst, total, flags: [] }].
 */
export function salesRows(slip, defaultPct = 18) {
  const groups = new Map();
  for (const it of slip.items || []) {
    const key = String(it.hsn || '').trim() || '—';
    const g = groups.get(key) || { hsn: key === '—' ? '' : key, desc: [], kg: 0, taxable: 0, checked: true, rates: new Set() };
    if (it.desc && !g.desc.includes(it.desc)) g.desc.push(it.desc);
    g.kg = r3(g.kg + (Number(it.kg) || 0)); g.taxable = r2(g.taxable + (Number(it.taxable) || 0));
    g.checked = g.checked && !!it.hsn_checked;
    if (it.gst_rate != null) g.rates.add(Number(it.gst_rate));
    groups.set(key, g);
  }
  const pct = Number(slip.gst_pct ?? defaultPct);
  const list = [...groups.values()];
  const gstAll = r2(Number(slip.gst) || 0);
  let left = gstAll;
  const taxAll = r2(list.reduce((s, g) => s + g.taxable, 0));
  return list.map((g, i) => {
    const gst = i === list.length - 1 ? left : r2(taxAll > 0 ? (gstAll * g.taxable) / taxAll : 0);
    left = r2(left - gst);
    const split = gstSplit(gst, slip.pos?.kind);
    const flags = [];
    if (!g.hsn) flags.push('hsn_missing'); else if (!hsnOk(g.hsn)) flags.push('hsn_bad'); else if (!g.checked) flags.push('hsn_unchecked');
    if ([...g.rates].some((r) => r !== pct)) flags.push('rate_differs');
    if (!slip.pos?.sure) flags.push(`pos_${slip.pos?.reason || 'no_dest'}`);
    if (!slip.tally_no) flags.push('no_tally');
    return {
      date: slip.date, slip_no: slip.slip_no, tally_no: slip.tally_no || '', customer: slip.customer, gstin: slip.gstin || '',
      pos: slip.pos?.to ? stateName(slip.pos.to) : '', pos_kind: slip.pos?.kind || null, delivery: slip.delivery || '',
      hsn: g.hsn, desc: g.desc.join(', '), kg: g.kg, taxable: g.taxable, rate: pct,
      cgst: split ? split.cgst : null, sgst: split ? split.sgst : null, igst: split ? split.igst : null, gst, total: r2(g.taxable + gst), flags,
    };
  });
}

/** A month's totals from register rows (they must equal the Day book's GST bills). */
export function registerTotals(rows) {
  const t = { taxable: 0, cgst: 0, sgst: 0, igst: 0, gst: 0, total: 0, flagged: 0, slips: new Set() };
  for (const r of rows) {
    t.taxable = r2(t.taxable + r.taxable); t.gst = r2(t.gst + r.gst); t.total = r2(t.total + r.total);
    t.cgst = r2(t.cgst + (r.cgst || 0)); t.sgst = r2(t.sgst + (r.sgst || 0)); t.igst = r2(t.igst + (r.igst || 0));
    if (r.flags?.length) t.flagged += 1;
    if (r.slip_no != null) t.slips.add(r.slip_no);
  }
  return { ...t, slips: t.slips.size };
}

/**
 * One GST purchase bill → its rows for the purchase register (one per HSN; freight / other charges as their own row).
 * The supplier's state comes from its GST number: inside the shop's state → CGST + SGST, else IGST, unknown → no split.
 *   bill: { date, bill_no, supplier, gstin, gst, freight, other, round_off, total, stock_effect, lines: [{ hsn, description, kg, amount }] }
 */
export function purchaseRows(bill, shopState) {
  const sup = stateOfGstin(bill.gstin);
  const kind = sup && GST_STATES[shopState] ? (sup === shopState ? 'local' : 'inter') : null;
  const groups = new Map();
  for (const l of bill.lines || []) {
    const key = String(l.hsn || '').trim();
    const g = groups.get(key) || { hsn: key, desc: [], kg: 0, taxable: 0 };
    if (l.description && !g.desc.includes(l.description)) g.desc.push(l.description);
    g.kg = r3(g.kg + (Number(l.kg) || 0)); g.taxable = r2(g.taxable + (Number(l.amount) || 0));
    groups.set(key, g);
  }
  const extra = r2((Number(bill.freight) || 0) + (Number(bill.other) || 0));
  const list = [...groups.values()];
  if (extra > 0) list.push({ hsn: '', desc: ['Freight / other charges'], kg: 0, taxable: extra, charges: true });
  const gstAll = r2(Number(bill.gst) || 0);
  const taxAll = r2(list.reduce((s, g) => s + g.taxable, 0));
  let left = gstAll;
  return list.map((g, i) => {
    const gst = i === list.length - 1 ? left : r2(taxAll > 0 ? (gstAll * g.taxable) / taxAll : 0);
    left = r2(left - gst);
    const split = gstSplit(gst, kind);
    const ro = i === 0 ? r2(Number(bill.round_off) || 0) : 0;
    const flags = [];
    if (!g.charges && !g.hsn) flags.push('hsn_missing');
    if (!sup) flags.push('no_gstin');
    return {
      date: bill.date, bill_no: bill.bill_no || '', supplier: bill.supplier || '', gstin: bill.gstin || '', state: sup ? stateName(sup) : '',
      hsn: g.hsn, desc: g.desc.join(', '), kg: g.kg, taxable: g.taxable, cgst: split ? split.cgst : null, sgst: split ? split.sgst : null,
      igst: split ? split.igst : null, gst, round_off: ro, total: r2(g.taxable + gst + ro), stock_effect: bill.stock_effect || 'stock', flags,
    };
  });
}
