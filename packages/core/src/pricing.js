import { r2 } from './round.js';
import { SHAPES } from './shapes.js';
import { unitOf, toMm, inchOf } from './units.js';

/**
 * Price one order item.
 * item: { shape, unit, d:[sizes], rows:[{len,pcs,cuts}], rate, cutRate, density, aw }
 * mode: 'est' uses weight from size; 'final' uses the actual weighed weight (aw) when present.
 * Returns null when the item is incomplete.
 */
export function calcItem(item, mode, { minInch = 0 } = {}) {
  const sh = SHAPES[item.shape];
  if (!sh) return null;
  const u = unitOf(item);
  const d = (item.d || []).map((v) => toMm(v, u));
  if (d.length < sh.dims.length || d.slice(0, sh.dims.length).some((v) => !(v > 0))) return null;
  const den = Number(item.density);
  if (!(den > 0)) return null;
  const rowsIn = item.rows && item.rows.length ? item.rows : [{ len: item.len, pcs: item.pcs, cuts: item.cuts }];
  const rows = [];
  for (const r of rowsIn) {
    const L = sh.len ? toMm(r.len, u) : 0;
    if (sh.len && !(L > 0)) return null;
    const pcs = Math.floor(Number(r.pcs));
    if (!(pcs > 0)) return null;
    const perPc = (sh.vol(d, L) * den) / 1e9;
    const auto = !(r.cuts != null && r.cuts !== '');
    const cuts = auto ? pcs : Math.max(0, Math.floor(Number(r.cuts)));
    rows.push({ len: r.len, L, pcs, perPc, est: perPc * pcs, cuts, auto });
  }
  const est = rows.reduce((a, r) => a + r.est, 0);
  const pcs = rows.reduce((a, r) => a + r.pcs, 0);
  const totalCuts = rows.reduce((a, r) => a + r.cuts, 0);
  const useAct = mode === 'final' && Number(item.aw) > 0;
  const weight = useAct ? Number(item.aw) : est;
  const rate = Number(item.rate) || 0;
  const cr = Number(item.cutRate) || 0;
  const mat = r2(weight * rate);
  const sides = sh.sides(d).map((mm) => ({ mm, raw: mm / 25.4, inch: inchOf(mm, minInch) }));
  const area = sh.face(sides.map((s) => s.inch));
  const cut = r2(area * cr * totalCuts);
  return { rows, est, weight, useAct, mat, cut, total: r2(mat + cut), sides, area, cuts: totalCuts, pcs, rate, cr, L: rows[0] ? rows[0].L : 0 };
}

/**
 * Order totals. bill: 'pakka' adds GST on the whole amount; 'kacha' adds the local %
 * spread into material and cutting; null = plain amount (bill not chosen yet).
 * Pass opts.bill to override the order's own bill type (for "what if" quotes).
 * The order's own gstPct/kachaPct (snapshotted at finish) win over the defaults.
 */
export function orderTotals(order, mode, { bill, gstPct = 18, kachaPct = 10, minInch = 0 } = {}) {
  let mat = 0, cut = 0, wt = 0, ok = false;
  (order.items || []).forEach((it) => {
    const c = calcItem(it, mode, { minInch });
    if (c) { mat += c.mat; cut += c.cut; wt += c.weight; ok = true; }
  });
  mat = r2(mat); cut = r2(cut);
  const base = r2(mat + cut);
  const b = bill !== undefined ? bill : order.bill;
  let matK = mat, cutK = cut, gst = 0, pct = 0;
  if (b === 'kacha') {
    pct = order.kachaPct ?? kachaPct;
    const f = 1 + pct / 100;
    matK = r2(mat * f); cutK = r2(cut * f);
  } else if (b === 'pakka') {
    pct = order.gstPct ?? gstPct;
    gst = r2((base * pct) / 100);
  }
  const total = r2(matK + cutK + gst);
  return { mat, cut, base, matK, cutK, gst, total, adj: r2(total - base), pct, wt, ok, bill: b };
}

/** Estimated sizes until weighed; actual weights from 'weighed' onwards. */
export const pricingModeFor = (status) => (status === 'estimate' || status === 'accepted' ? 'est' : 'final');

export const finalTotal = (order, opts) => orderTotals(order, pricingModeFor(order.status), opts);
