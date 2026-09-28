import { r2 } from './round.js';
import { businessDate, DEFAULT_TIMEZONE } from './slips.js';

const dayOf = (date, timeZone) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : businessDate(date, timeZone));

/**
 * A customer's account statement for a period, from the khata ledger (customerLedger().entries).
 * from / to: shop calendar dates 'YYYY-MM-DD', both included.
 * Returns the balance before the period, every entry inside it with the running balance,
 * what was bought and paid in the period, and the balance at the end — the same numbers as the khata.
 */
export function statementFor({ entries, from, to, timeZone = DEFAULT_TIMEZONE }) {
  let opening = 0;
  const rows = [];
  for (const e of entries) {
    const day = dayOf(e.date, timeZone);
    if (from && day < from) { opening = e.bal; continue; }
    if (to && day > to) continue;
    rows.push({ ...e, day });
  }
  const bought = r2(rows.filter((e) => e.t === 'bill').reduce((a, e) => a + e.amt, 0));
  const paid = r2(rows.filter((e) => e.t === 'pay').reduce((a, e) => a + e.amt, 0));
  const closing = rows.length ? rows[rows.length - 1].bal : opening;
  return { opening: r2(opening), rows, bought, paid, closing: r2(closing), check: r2(opening + bought - paid) === r2(closing) };
}

/** First and last shop date of common periods: this_month | last_month | last_3_months | this_fy (April–March). */
export function periodDates(which, now = new Date().toISOString(), timeZone = DEFAULT_TIMEZONE) {
  const [y, m] = businessDate(now, timeZone).split('-').map(Number);
  const iso = (yy, mm, dd) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  const last = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const today = businessDate(now, timeZone);
  const back = (n) => { const d = new Date(Date.UTC(y, m - 1 - n, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; };
  if (which === 'last_month') { const [yy, mm] = back(1); return { from: iso(yy, mm, 1), to: iso(yy, mm, last(yy, mm)) }; }
  if (which === 'last_3_months') { const [yy, mm] = back(2); return { from: iso(yy, mm, 1), to: today }; }
  if (which === 'this_fy') { const fy = m >= 4 ? y : y - 1; return { from: iso(fy, 4, 1), to: today }; }
  return { from: iso(y, m, 1), to: today };
}

const byDate = (a, b) => new Date(a.date) - new Date(b.date);

/**
 * Slips paid in full at pickup never go into the khata. A statement still lists them, so the
 * customer sees every slip: the slip, then "paid for slip #…" for the same amount. They add and
 * take away the same money, so every balance stays exactly the khata's.
 * orders / payments: the khata data in @srs/core's shape (see customerLedger).
 */
export function paidSlipEntries({ custId, orders, payments, sides }) {
  const out = [];
  for (const o of orders) {
    if (o.cust !== custId || o.status !== 'done' || o.inKhata || !sides.includes(o.bill) || o.billTotal == null) continue;
    const ps = payments.filter((p) => p.oid === o.id);
    const amt = r2(Number(o.billTotal));
    const paid = r2(ps.reduce((a, p) => a + p.amt, 0));
    const main = ps.filter((p) => p.amt > 0).sort((a, b) => b.amt - a.amt)[0];
    const date = o.doneAt || o.at;
    out.push({ t: 'bill', date, side: o.bill, amt, oid: o.id, settled: true });
    out.push({ t: 'pay', date, side: o.bill, amt: Math.min(amt, paid), mode: main?.mode || null, kind: 'settled', oid: o.id, settled: true });
  }
  return out;
}

/** Ledger entries + paid slips in date order, with the running balance worked out again. */
export function withPaidSlips(entries, extra) {
  const all = [...entries, ...extra].map((e, i) => ({ ...e, i })).sort((a, b) => byDate(a, b) || a.i - b.i);
  let run = 0;
  return all.map(({ i, ...e }) => { run = r2(run + (e.t === 'bill' ? e.amt : -e.amt)); return { ...e, bal: run }; });
}
