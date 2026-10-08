import { r2 } from './round.js';
import { checkGstin, GST_STATES } from './gstin.js';

/**
 * Smart checks on a purchase bill (owner approved 8 Oct 2026). They only WARN — the person can always
 * say "it's correct" and save. Each check has a stable key so a dismissed check stays dismissed.
 *
 *  - billno_gstin   a GST number typed into the bill-number box
 *  - gstin_typo     the supplier's GST number has a typing mistake (pattern / check letter)
 *  - hsn_not_steel  an HSN that isn't an iron & steel code (72 / 73) for a steel grade
 *  - hsn_family     a steel HSN of the wrong kind (e.g. an alloy-steel code on a stainless grade)
 *  - rate_far       a rate far from what the shop usually pays for that grade
 *  - duplicate      same supplier, same weight and total as a recent bill — typed twice?
 */

const GSTIN_LIKE = /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;
/** Does this text look like a GST number (whatever the check letter says)? */
export const looksLikeGstin = (s) => GSTIN_LIKE.test(String(s ?? '').toUpperCase().replace(/[\s-]/g, ''));

/** HSN headings (first 4 digits) of chapter 72 by kind of steel. */
const HEADINGS = {
  carbon: ['7206', '7207', '7208', '7209', '7210', '7211', '7212', '7213', '7214', '7215', '7216', '7217'],
  stainless: ['7218', '7219', '7220', '7221', '7222', '7223'],
  alloy: ['7224', '7225', '7226', '7227', '7228', '7229'],
};
HEADINGS.tool = HEADINGS.alloy;
/** What to suggest for a grade family and shape: [heading, words]. Bars: hot-rolled first, then bright (cold-finished). */
const SUGGEST = {
  carbon: { bar: [['721499', 'hot-rolled bars'], ['721550', 'bright bars']], flat: [['7208', 'plates / sheets']], block: [['7207', 'blocks / billets']] },
  stainless: { bar: [['722211', 'hot-rolled bars'], ['722220', 'bright bars']], flat: [['7219', 'plates / sheets']], block: [['7218', 'blocks']] },
  alloy: { bar: [['722830', 'hot-rolled bars'], ['722850', 'bright bars']], flat: [['7225', 'plates / sheets']], block: [['7224', 'blocks / forgings']] },
};
SUGGEST.tool = SUGGEST.alloy;
const shapeKind = (shape) => (shape === 'plate' ? 'flat' : shape === 'block' ? 'block' : 'bar');

/** Steel HSN suggestions for a grade family + shape: [{ hsn, words }]. */
export function hsnSuggestions(family, shape) {
  const s = SUGGEST[family];
  return s ? s[shapeKind(shape)].map(([hsn, words]) => ({ hsn, words })) : [];
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * bill:    { billNo, supplierId, supplierGstin, isNewSupplier, totalKg, total, lines: [{ hsn, rateKg, family, materialId, code, shape }] }
 * history: { rates: [{ materialId, rate, date, supplier }], bills: [{ supplierId, billNo, date, kg, total }] }
 * ok:      keys the person already said are correct (array or Set)
 * Returns [{ key, type, level: 'warn' | 'bad', line?, ...details }], most serious first.
 */
export function purchaseChecks(bill, history = {}, ok = []) {
  const okSet = ok instanceof Set ? ok : new Set(ok);
  const out = [];
  const add = (c) => { if (!okSet.has(c.key)) out.push(c); };
  const billNo = String(bill.billNo ?? '').trim();

  if (billNo && looksLikeGstin(billNo)) {
    const g = billNo.toUpperCase().replace(/[\s-]/g, '');
    add({ key: `billno_gstin:${g}`, type: 'billno_gstin', level: 'warn', gstin: g, state: GST_STATES[g.slice(0, 2)] || null, stateCode: g.slice(0, 2) });
  }
  const sg = String(bill.supplierGstin ?? '').trim();
  if (bill.isNewSupplier && sg) {
    const c = checkGstin(sg);
    if (!c.ok) add({ key: `gstin_typo:${sg.toUpperCase()}`, type: 'gstin_typo', level: 'warn', reason: c.reason });
  }

  (bill.lines || []).forEach((l, i) => {
    const hsn = String(l.hsn ?? '').replace(/\D/g, '');
    const fam = HEADINGS[l.family] ? l.family : null;
    if (hsn.length >= 4 && fam) {
      const ch = hsn.slice(0, 2);
      if (ch !== '72' && ch !== '73') {
        add({ key: `hsn_not_steel:${l.materialId}:${hsn}`, type: 'hsn_not_steel', level: 'bad', line: i, hsn, code: l.code, suggest: hsnSuggestions(fam, l.shape) });
      } else if (ch === '72' && !HEADINGS[fam].includes(hsn.slice(0, 4))) {
        add({ key: `hsn_family:${l.materialId}:${hsn}`, type: 'hsn_family', level: 'warn', line: i, hsn, code: l.code, family: fam, suggest: hsnSuggestions(fam, l.shape) });
      }
    }
    const past = (history.rates || []).filter((h) => h.materialId === l.materialId && Number(h.rate) > 0);
    const rate = Number(l.rateKg);
    if (l.materialId && rate > 0 && past.length >= 2) {
      const rates = past.map((h) => Number(h.rate));
      const m = median(rates);
      if (rate > m * 1.6 || rate < m * 0.6) {
        const last = [...past].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
        add({ key: `rate_far:${i}:${l.materialId}:${rate}`, type: 'rate_far', level: 'warn', line: i, code: l.code, rate,
          times: r2(rate / m), low: Math.min(...rates), high: Math.max(...rates), n: past.length, last: { rate: Number(last.rate), date: last.date, supplier: last.supplier || null } });
      }
    }
  });

  if (bill.supplierId && Number(bill.total) > 0) {
    const same = (history.bills || []).find((b) => b.supplierId === bill.supplierId && Math.abs(Number(b.total) - Number(bill.total)) <= 1
      && Math.abs(Number(b.kg) - Number(bill.totalKg)) < 0.5 && String(b.billNo || '') !== billNo);
    if (same) add({ key: `duplicate:${same.billNo || same.date}`, type: 'duplicate', level: 'warn', billNo: same.billNo || null, date: same.date });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
}
