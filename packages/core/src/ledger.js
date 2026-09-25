import { r2 } from './round.js';
import { orderTotals } from './pricing.js';

const byDate = (a, b) => new Date(a.date) - new Date(b.date);
const sum = (a) => r2(a.reduce((x, y) => x + y.amt, 0));

/**
 * A customer's khata (account book), exactly as the prototype computes it.
 * - Bills: finished orders of this customer that went into the khata, on the given sides.
 * - Payments linked to those bills pay them first; loose payments (from the Khata screen)
 *   and any overpayment then clear the OLDEST unpaid bills first, per side.
 * - Advances on orders not yet finished show as "pending" (only on a full, all-sides view).
 *
 * payments: [{ id, cust, at, amt, mode, side, oid, kind, note }]
 * sides: the sides being shown; allSides: every side this viewer may see.
 */
export function customerLedger({ custId, orders, payments, sides, allSides = sides, totals = {} }) {
  const full = sides.length === allSides.length;
  const billed = orders.filter((o) => o.cust === custId && o.status === 'done' && o.inKhata && sides.includes(o.bill));
  const ids = new Set(billed.map((o) => o.id));
  const bills = billed.map((o) => ({ t: 'bill', date: o.doneAt || o.at, side: o.bill, amt: orderTotals(o, 'final', totals).total, oid: o.id }));
  const pay = (p) => ({ t: 'pay', date: p.at, side: p.side, amt: p.amt, mode: p.mode, note: p.note, kind: p.kind, oid: p.oid, pid: p.id });
  const linked = payments.filter((p) => p.cust === custId && p.oid && ids.has(p.oid)).map(pay);
  const loose = payments.filter((p) => p.cust === custId && !p.oid && sides.includes(p.side)).map(pay);
  const pend = full
    ? payments
        .filter((p) => {
          if (p.cust !== custId || !p.oid || p.kind !== 'advance') return false;
          const o = orders.find((x) => x.id === p.oid);
          return o && o.status !== 'done';
        })
        .map((p) => ({ ...pay(p), pending: true }))
    : [];
  const out = { bills, pays: [...linked, ...loose, ...pend], oldest: null, bySide: {}, due: 0, adv: 0, pend: 0 };
  sides.forEach((sd) => {
    const bs = bills.filter((b) => b.side === sd).sort(byDate);
    let pool = 0;
    bs.forEach((b) => {
      const lk = sum(linked.filter((p) => p.oid === b.oid));
      b.rem = r2(Math.max(0, b.amt - lk));
      pool = r2(pool + Math.max(0, lk - b.amt));
    });
    pool = r2(pool + sum(loose.filter((p) => p.side === sd)));
    let dueSide = 0;
    bs.forEach((b) => {
      if (b.rem > 0) { const use = Math.min(pool, b.rem); pool = r2(pool - use); b.rem = r2(b.rem - use); }
      b.paid = r2(b.amt - b.rem);
      dueSide += b.rem;
      if (b.rem > 0 && (!out.oldest || new Date(b.date) < new Date(out.oldest))) out.oldest = b.date;
    });
    out.bySide[sd] = { due: r2(dueSide), adv: pool };
  });
  out.pend = sum(pend);
  out.due = r2(Object.values(out.bySide).reduce((a, x) => a + x.due, 0));
  out.adv = r2(Object.values(out.bySide).reduce((a, x) => a + x.adv, 0) + out.pend);
  const entries = [...bills, ...out.pays].sort(byDate);
  let run = 0;
  entries.forEach((e) => { run = r2(run + (e.t === 'bill' ? e.amt : -e.amt)); e.bal = run; });
  out.entries = entries;
  return out;
}

/** Customers who owe money or hold an advance. */
export function khataList({ customers, orders, payments, sides, allSides = sides, totals = {} }) {
  return customers
    .map((c) => ({ c, l: customerLedger({ custId: c.id, orders, payments, sides, allSides, totals }) }))
    .filter((x) => x.l.due > 0 || x.l.adv > 0);
}

/** Total advance paid on one order. */
export const advanceOf = (orderId, payments) => r2(payments.filter((p) => p.oid === orderId && p.kind === 'advance').reduce((a, p) => a + p.amt, 0));

/** Everything paid on one order (advances + pickup payments). */
export const paidOf = (orderId, payments) => r2(payments.filter((p) => p.oid === orderId).reduce((a, p) => a + p.amt, 0));
