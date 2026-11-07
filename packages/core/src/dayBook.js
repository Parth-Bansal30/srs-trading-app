// The Day book (7 Nov 2026, plan v2 step 11): the sums behind one day, a week or a month — sales (GST bill / no bill),
// money in and out, bought, a rough profit, GST for the CA, the most sold steel. Pure: the server gathers the rows.
import { r2 } from './round.js';

const r3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;
const n = (x) => Number(x) || 0;
const iso = (d) => d.toISOString().slice(0, 10);
const day = (s) => new Date(`${s}T00:00:00Z`);
const add = (s, k) => { const d = day(s); d.setUTCDate(d.getUTCDate() + k); return iso(d); };
const monthStart = (s) => `${s.slice(0, 7)}-01`;
const monthEnd = (s) => { const d = day(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); };
const addMonths = (s, k) => { const d = day(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + k); return iso(d); };
const min = (a, b) => (a < b ? a : b);

/**
 * A period of the Day book. kind: 'day' | 'week' | 'month'; at: any day inside it; today: the shop's today.
 * Returns { kind, from, to, prevFrom, prevTo } — a month still running is compared with the same days of the month before.
 */
export function dayBookPeriod(kind, at, today) {
  if (kind === 'week') {
    const dow = (day(at).getUTCDay() + 6) % 7;   // Monday first
    const from = add(at, -dow); const to = min(add(from, 6), today);
    return { kind, from, to, prevFrom: add(from, -7), prevTo: add(to, -7) };
  }
  if (kind === 'month') {
    const from = monthStart(at); const to = min(monthEnd(at), today);
    const pf = addMonths(from, -1);
    const span = Number(to.slice(8, 10));
    return { kind, from, to, prevFrom: pf, prevTo: min(monthEnd(pf), `${pf.slice(0, 8)}${String(span).padStart(2, '0')}`) };
  }
  const d = min(at, today);
  return { kind: 'day', from: d, to: d, prevFrom: add(d, -1), prevTo: add(d, -1) };
}

/** The period before / after (‹ ›). Never past today. */
export function dayBookShift(p, step, today) {
  if (p.kind === 'month') { const at = addMonths(p.from, step); return at > today ? null : dayBookPeriod('month', at, today); }
  const at = add(p.from, p.kind === 'week' ? 7 * step : step);
  return at > today ? null : dayBookPeriod(p.kind, at, today);
}

/** "EN8 round 40mm" — the key the most-sold list groups by. */
export const steelKey = (it) => `${it.g} ${it.sh} ${(it.d || []).filter((x) => x !== '' && x != null).join('×')}${it.u === 'in' ? '"' : 'mm'}`;

/** Everything the Day book shows, from the server's rows (api_day_book). */
export function dayBookSummary(raw) {
  const slips = raw?.slips || [];
  const s = { total: 0, slips: slips.length, kg: 0, gst_bills: 0, no_bill: 0, gst: 0, left: 0, left_slips: 0 };
  const profit = { amount: 0, sales: 0, known: 0, unknown: 0 };
  const top = new Map();
  const byDay = new Map();
  for (const o of slips) {
    const total = n(o.total);
    s.total = r2(s.total + total); s.kg = r3(s.kg + n(o.kg)); s.gst = r2(s.gst + n(o.gst));
    if (o.bill === 'pakka') s.gst_bills = r2(s.gst_bills + total); else s.no_bill = r2(s.no_bill + total);
    const left = r2(Math.max(0, total - n(o.paid)));
    if (left > 0) { s.left = r2(s.left + left); s.left_slips += 1; }
    // rough profit: what the slip sold for before GST, minus what its steel cost (slips with no known cost are left out)
    if (o.cost != null) { profit.known += 1; profit.sales = r2(profit.sales + total - n(o.gst)); profit.amount = r2(profit.amount + total - n(o.gst) - n(o.cost)); }
    else profit.unknown += 1;
    const d = byDay.get(o.day) || { day: o.day, total: 0, slips: 0 };
    d.total = r2(d.total + total); d.slips += 1; byDay.set(o.day, d);
    for (const it of o.items || []) {
      const k = steelKey(it);
      const t = top.get(k) || { key: k, g: it.g, sh: it.sh, d: it.d || [], u: it.u, kg: 0, slips: new Set() };
      t.kg = r3(t.kg + n(it.kg)); t.slips.add(o.id); top.set(k, t);
    }
  }
  const mi = { total: 0, cash: 0, bank: 0, count: (raw?.money_in || []).length };
  for (const p of raw?.money_in || []) {
    const a = n(p.amount); mi.total = r2(mi.total + a);
    if (p.mode === 'Cash') mi.cash = r2(mi.cash + a); else mi.bank = r2(mi.bank + a);
  }
  let mo = null;
  if (raw?.money_out) {
    mo = { total: 0, supplier: 0, supplier_n: 0, home: 0, other: 0, cash: 0, gst: 0, by_category: [] };
    const cat = new Map();
    for (const e of raw.money_out) {
      const a = n(e.amount);
      if (e.kind === 'owner') { mo.home = r2(mo.home + a); continue; }   // taken home: not a shop expense
      mo.total = r2(mo.total + a); mo.gst = r2(mo.gst + n(e.gst));
      if (e.cash) mo.cash = r2(mo.cash + a);
      if (e.kind === 'supplier') { mo.supplier = r2(mo.supplier + a); mo.supplier_n += 1; } else {
        mo.other = r2(mo.other + a);
        cat.set(e.category, r2((cat.get(e.category) || 0) + a));
      }
    }
    mo.by_category = [...cat.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
  }
  let bought = null;
  if (raw?.bought) {
    bought = { total: 0, bills: raw.bought.length, kg: 0, gst: 0 };
    for (const b of raw.bought) { bought.total = r2(bought.total + n(b.total)); bought.kg = r3(bought.kg + n(b.kg)); if (b.bill === 'pakka') bought.gst = r2(bought.gst + n(b.gst)); }
  }
  const gst = { sales: s.gst, purchases: bought ? bought.gst : null, expenses: mo ? mo.gst : null };
  gst.to_pay = gst.purchases == null ? null : r2(gst.sales - gst.purchases - (gst.expenses || 0));
  const prev = raw?.prev ? n(raw.prev.total) : null;
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  return {
    sales: s, profit, money_in: mi, money_out: mo, bought, gst, to_pay: raw?.to_pay || null,
    prev, change: prev ? Math.round(((s.total - prev) / prev) * 100) : null,
    days, best: days.reduce((b, d) => (!b || d.total > b.total ? d : b), null),
    top: [...top.values()].map((t) => ({ key: t.key, g: t.g, sh: t.sh, d: t.d, u: t.u, kg: t.kg, slips: t.slips.size })).sort((a, b) => b.kg - a.kg).slice(0, 5),
  };
}

/** The calendar's colour step for a day's sales (0 = nothing … 4 = the busiest), from the month's own days. */
export function heatStep(total, maxTotal) {
  const t = n(total); const m = n(maxTotal);
  if (!(t > 0) || !(m > 0)) return 0;
  return Math.min(4, Math.max(1, Math.ceil((t / m) * 4)));
}

/** The stock as on a day (api_stock_on rows) grouped by grade + shape: then / bought / sold / now, worth at cost. */
export function stockOnSummary(rows, lowKg = 200) {
  const g = new Map();
  for (const r of rows || []) {
    const k = `${r.material_id}|${r.shape || ''}`;
    const x = g.get(k) || { key: k, code: r.code, shape: r.shape, then: 0, in: 0, out: 0, now: 0, worth: 0 };
    x.then = r3(x.then + n(r.then)); x.in = r3(x.in + n(r.in)); x.out = r3(x.out + n(r.out)); x.now = r3(x.now + n(r.now));
    x.worth = r2(x.worth + Math.max(0, n(r.then)) * n(r.cost));
    g.set(k, x);
  }
  const list = [...g.values()].filter((x) => x.then !== 0 || x.in !== 0 || x.out !== 0).sort((a, b) => b.then - a.then);
  // costs are shown only to people who may see them (the server leaves cost out for the rest): then no worth at all
  const costs = (rows || []).some((r) => r.cost != null);
  if (!costs) list.forEach((x) => { x.worth = null; });
  return { items: list, kg: r3(list.reduce((t, x) => t + Math.max(0, x.then), 0)), worth: costs ? r2(list.reduce((t, x) => t + x.worth, 0)) : null,
    low: list.filter((x) => x.then < lowKg).length, max: list.reduce((m, x) => Math.max(m, x.then), 0) };
}
