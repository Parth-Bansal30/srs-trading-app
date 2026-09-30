import { r2 } from './round.js';
import { orderTotals } from './pricing.js';

const byDate = (a, b) => new Date(a.date) - new Date(b.date);
const sum = (a) => r2(a.reduce((x, y) => x + y.amt, 0));

/** Payment kinds that belong to an order's advance while the order is open. */
const ADVANCE_KINDS = ['advance', 'refund', 'transfer'];

/**
 * A customer's khata (account book), exactly as the prototype computes it.
 * - Bills: finished orders of this customer that went into the khata, on the given sides.
 *   Old dues from the paper khata (lump sums or old slips) count as bills too — they are
 *   the oldest, so loose payments clear them first.
 * - Payments linked to those bills pay them first; loose payments (from the Khata screen)
 *   and any overpayment then clear the OLDEST unpaid bills first, per side.
 * - Advances on orders not yet finished show as "pending" (only on a full, all-sides view).
 *
 * payments: [{ id, cust, at, amt, mode, side, oid, kind, note }]
 *   kinds: advance, pay/pickup, due/khata, and (real version) refund (money returned, negative)
 *   and transfer (advance moved away from an order, negative, mode 'Adjust').
 *   A reversal is passed as the kind it reverses, with a negative amount.
 * orders: prototype orders, or database orders carrying billTotal and slipNo.
 * oldDues: [{ id, cust, side, date, amt, ref }] — ref = old slip number, or null for a lump sum.
 * sides: the sides being shown; allSides: every side this viewer may see.
 */
export function customerLedger({ custId, orders, payments: allPayments, oldDues = [], sides, allSides = sides, totals = {} }) {
  const full = sides.length === allSides.length;
  // A deleted slip counts nowhere: its bill is gone and so is the money booked on it (which was
  // reversed, given back, or moved to a separate khata credit when it was deleted).
  const deleted = new Set(orders.filter((o) => o.status === 'deleted').map((o) => o.id));
  const payments = deleted.size ? allPayments.filter((p) => !p.oid || !deleted.has(p.oid)) : allPayments;
  const billed = orders.filter((o) => o.cust === custId && o.status === 'done' && o.inKhata && sides.includes(o.bill));
  const ids = new Set(billed.map((o) => o.id));
  const bills = billed.map((o) => ({
    t: 'bill', date: o.doneAt || o.at, side: o.bill,
    amt: o.billTotal != null ? r2(Number(o.billTotal)) : orderTotals(o, 'final', totals).total, oid: o.id,
  })); // (same fields and order as the prototype — the parity test compares them exactly)
  oldDues.filter((d) => d.cust === custId && sides.includes(d.side)).forEach((d) => {
    bills.push({ t: 'bill', old: true, date: d.date, side: d.side, amt: r2(Number(d.amt)), ref: d.ref || null, did: d.id });
  });
  const pay = (p) => ({ t: 'pay', date: p.at, side: p.side, amt: p.amt, mode: p.mode, note: p.note, kind: p.kind, oid: p.oid, pid: p.id });
  const linked = payments.filter((p) => p.cust === custId && p.oid && ids.has(p.oid)).map(pay);
  const loose = payments.filter((p) => p.cust === custId && !p.oid && sides.includes(p.side)).map(pay);
  const pend = full
    ? payments
        .filter((p) => {
          if (p.cust !== custId || !p.oid || !ADVANCE_KINDS.includes(p.kind)) return false;
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
      const lk = b.old ? 0 : sum(linked.filter((p) => p.oid === b.oid));
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
export function khataList({ customers, orders, payments, oldDues = [], sides, allSides = sides, totals = {} }) {
  return customers
    .map((c) => ({ c, l: customerLedger({ custId: c.id, orders, payments, oldDues, sides, allSides, totals }) }))
    .filter((x) => x.l.due > 0 || x.l.adv > 0);
}

/** Advance paid on one order, net of any returned or moved away. */
export const advanceOf = (orderId, payments) =>
  r2(payments.filter((p) => p.oid === orderId && ADVANCE_KINDS.includes(p.kind)).reduce((a, p) => a + p.amt, 0));

/** Everything paid on one order (advances + pickup payments, net of refunds). */
export const paidOf = (orderId, payments) => r2(payments.filter((p) => p.oid === orderId).reduce((a, p) => a + p.amt, 0));
