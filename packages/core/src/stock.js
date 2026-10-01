import { r2 } from './round.js';
import { SHAPE_IDS } from './shapes.js';

/**
 * Stock and purchase bills (owner decisions 30 Sept 2026).
 *
 * - Every line of a purchase bill becomes stock. A STOCK ITEM is: grade + shape + HSN + rate per kg.
 *   A different rate or HSN is ALWAYS a separate stock item, even for the same grade and shape;
 *   when all four match an item the shop already has, the weight is added to it.
 * - The HSN and rate come from the bill; the person only picks the grade (and shape).
 * - When selling, only stock of the same grade (and shape) is offered; the oldest stock that has
 *   enough is picked for you. Stock goes down when the slip is weighed.
 */

/** How many kg one unit is. Bills use kg, MT (tonne) or quintal. */
export const KG_PER = Object.freeze({ kg: 1, mt: 1000, t: 1000, tonne: 1000, ton: 1000, qtl: 100, quintal: 100, q: 100 });

export const unitKey = (u) => {
  const s = String(u || 'kg').toLowerCase().replace(/per|rs|₹|\//g, '').replace(/[^a-z]/g, '');
  if (['mt', 'mts', 'tonne', 'tonnes', 'ton', 'tons', 't', 'metricton'].includes(s)) return 'mt';
  if (['qtl', 'qtls', 'quintal', 'quintals', 'q'].includes(s)) return 'qtl';
  return 'kg';
};

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * One bill line in kg and ₹/kg. qty in qtyUnit, rate per rateUnit (both kg / mt / qtl).
 * Returns { kg, rateKg, amount, expected, ok } — ok = the bill's amount matches kg × rate (within 0.5% or ₹2).
 */
export function billLine({ qty, qtyUnit = 'kg', rate, rateUnit = 'kg', amount }) {
  const q = num(qty); const r = num(rate); const a = num(amount);
  const kgRaw = q == null ? null : q * KG_PER[unitKey(qtyUnit)];
  const rateRaw = r == null ? null : r / KG_PER[unitKey(rateUnit)];
  const expected = kgRaw != null && rateRaw != null ? r2(kgRaw * rateRaw) : null;
  const amt = a != null ? r2(a) : expected;
  const ok = expected != null && amt != null && Math.abs(amt - expected) <= Math.max(2, Math.abs(expected) * 0.005);
  return { kg: kgRaw == null ? null : r3(kgRaw), rateKg: rateRaw == null ? null : r3(rateRaw), amount: amt, expected, ok };
}
const r3 = (x) => Math.round((x + Number.EPSILON) * 1000) / 1000;

/**
 * The whole bill: do the lines + freight + other charges + GST + round-off add up to the bill total?
 * lines: [{ amount }]. Returns { items, extra, beforeTax, computed, diff, ok }.
 */
export function billTotals({ lines = [], freight = 0, other = 0, gst = 0, roundOff = 0, total = null }) {
  const items = r2(lines.reduce((s, l) => s + (num(l.amount) || 0), 0));
  const extra = r2((num(freight) || 0) + (num(other) || 0));
  const beforeTax = r2(items + extra);
  const computed = r2(beforeTax + (num(gst) || 0) + (num(roundOff) || 0));
  const t = num(total);
  const diff = t == null ? 0 : r2(t - computed);
  return { items, extra, beforeTax, computed, total: t == null ? computed : r2(t), diff, ok: Math.abs(diff) <= 1 };
}

/**
 * Freight / loading on the bill shared by weight, so each stock item knows what it really cost.
 * lines: [{ kg, rateKg }]. Returns per line { share (₹/kg), cost (₹/kg) }.
 */
export function landedCosts(lines, extra = 0) {
  const kgAll = lines.reduce((s, l) => s + (Number(l.kg) || 0), 0);
  const per = kgAll > 0 ? (Number(extra) || 0) / kgAll : 0;
  return lines.map((l) => ({ share: r2(per), cost: r2((Number(l.rateKg) || 0) + per) }));
}

export const cleanHsn = (h) => String(h ?? '').replace(/\D/g, '').slice(0, 8);

/** How a bill line's description is remembered ("M.S. Round Bars" → "M S ROUND BARS"), to suggest the same grade next time. */
export const descKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/** The key that makes two lines the same stock item: grade + shape + HSN + rate per kg. */
export const stockKey = ({ materialId, shape = null, hsn = '', rateKg }) =>
  `${materialId}|${shape || 'any'}|${cleanHsn(hsn)}|${(Math.round((Number(rateKg) || 0) * 1000) / 1000).toFixed(3)}`;

/** Which existing stock item (if any) a bill line adds to. items: [{ id, materialId, shape, hsn, rate }]. */
export function matchStockItem(line, items) {
  const k = stockKey(line);
  return items.find((s) => stockKey({ materialId: s.materialId, shape: s.shape, hsn: s.hsn, rateKg: s.rate }) === k) || null;
}

// ---------- reading a bill line: which grade and shape is it? ----------
const squash = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Guess the grade from the bill's description, among the shop's grades (by code, e.g. EN8, SS304).
 * "Alloy Steel EN-19 Round" → EN19. "M.S. Round Bars" / "Mild steel" → MS. Longest code wins.
 */
export function guessGrade(description, materials) {
  const words = String(description || '').toUpperCase();
  let best = null;
  for (const m of materials || []) {
    const code = squash(m.code);
    if (!code) continue;
    // EN19 also matches "EN-19", "EN 19", "E.N.19" — but never "EN190" or "EN1" inside "EN19"
    const re = new RegExp(`(^|[^A-Z0-9])${code.split('').join('[\\s.\\-]*')}($|[^A-Z0-9])`);
    const hit = re.test(words) || (code === 'MS' && /MILD\s*STEEL|\bM\.\s?S\./.test(words));
    if (hit && (!best || code.length > squash(best.code).length)) best = m;
  }
  return best;
}

const SHAPE_WORDS = [
  ['hex', /\bHEX|HEXAGON/],
  ['square', /\bSQ(UARE)?\b|SQUARE/],
  ['flat', /\bFLAT|PATTI|PATTA/],
  ['plate', /\bPLATE|SHEET/],
  ['block', /\bBLOCK/],
  ['round', /\bROUND|\bRD\b|\bROD|GOL\b|BRIGHT\s*BAR/],
];
/** Guess the shape from the description; null when the bill doesn't say. */
export function guessShape(description) {
  const s = String(description || '').toUpperCase();
  for (const [id, re] of SHAPE_WORDS) if (re.test(s)) return id;
  return null;
}
export const isShape = (s) => s == null || SHAPE_IDS.includes(s);

// ---------- selling: which stock should this item come from? ----------
/**
 * Stock offered for one order item, best first, and the one to pick.
 * items: [{ id, materialId, shape, onHand, booked, firstIn, closed }]  (booked = already on open orders)
 * need: { materialId, shape, kg (expected weight) }
 * Rules: same grade only; same shape, or stock with no shape; oldest first among those with
 * enough; if none has enough, the one with the most. Returns { list, pick, short } —
 * short = the picked stock has less than needed (it can still be sold; stock goes below 0 and is flagged).
 */
export function stockChoices(items, need) {
  const kg = Number(need.kg) || 0;
  const list = (items || [])
    .filter((s) => s.materialId === need.materialId && !s.closed && (!s.shape || !need.shape || s.shape === need.shape))
    .map((s) => {
      const free = r2(Number(s.onHand || 0) - Number(s.booked || 0));
      return { ...s, free, enough: free >= kg && free > 0, exactShape: !!s.shape && s.shape === need.shape };
    })
    .sort((a, b) => (b.exactShape - a.exactShape) || (new Date(a.firstIn) - new Date(b.firstIn)));
  const withStock = list.filter((s) => s.free > 0);
  const pick = list.find((s) => s.enough) || [...withStock].sort((a, b) => b.free - a.free)[0] || null;
  return { list, pick: pick ? pick.id : null, short: !!pick && !pick.enough };
}
