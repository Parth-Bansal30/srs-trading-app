// Supplier khata (4 Nov 2026, plan v2 F6): what we owe each supplier, worked out from the records — never a tick.
//   due = opening (we owe) − opening (they owe us) + bills − payments − credit notes
// A bill marked "paid outside the app" (the old Paid tick) is out of the due, as it was.
// Payments are set against bills by the person (oldest first is only a suggestion); what is not set against any bill is
// money with the supplier (an advance) — it lowers the due, and can be set against the next bill.
import { r2 } from './round.js';

const dayNo = (d) => Math.round(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86400000);
const addDays = (d, n) => new Date((dayNo(d) + n) * 86400000).toISOString().slice(0, 10);

/**
 * One supplier's khata. raw = { supplier: { id, credit_days }, bills, openings, notes, payments, allocations }
 *   bills       [{ id, bill_no, date, side, total, settled ('outside' | null), created_at }]
 *   openings    [{ id, side, direction ('owe' = we owe them | 'credit' = they owe us), amount, date }]
 *   notes       [{ id, kind (return | rate | discount | other), side, purchase_id, amount, date, note_no }]
 *   payments    [{ id, amount, day, at, method, account }]          (supplier payments that are not cancelled)
 *   allocations [{ expense_id, purchase_id | opening_id, amount }]  (only live ones)
 * today: the shop's date. Returns { due, advance, free, overdue, overdue_n, bills, openings, payments, lines, … }.
 */
export function supplierLedger(raw, today) {
  const sup = raw.supplier || {};
  const credit = Number(sup.credit_days) >= 0 && sup.credit_days != null ? Number(sup.credit_days) : null;
  const allocs = raw.allocations || [];
  const sumBy = (list, key, id) => r2(list.filter((x) => x[key] === id).reduce((s, x) => s + Number(x.amount), 0));
  const notesOn = (id) => r2((raw.notes || []).filter((n) => n.purchase_id === id).reduce((s, n) => s + Number(n.amount), 0));

  const openings = (raw.openings || []).map((o) => {
    const paid = o.direction === 'owe' ? sumBy(allocs, 'opening_id', o.id) : 0;
    return { ...o, amount: Number(o.amount), paid, left: o.direction === 'owe' ? r2(Number(o.amount) - paid) : 0 };
  });
  const bills = (raw.bills || []).map((b) => {
    const paid = sumBy(allocs, 'purchase_id', b.id);
    const noted = notesOn(b.id);
    const total = Number(b.total);
    const outside = b.settled === 'outside';
    const left = outside ? 0 : r2(total - paid - noted);
    const due_date = credit != null ? addDays(b.date, credit) : null;
    return { ...b, total, paid, noted, left, outside, due_date,
      status: outside ? 'outside' : left <= 0.5 ? 'paid' : paid + noted > 0.5 ? 'part' : 'to_pay' };
  }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.created_at || '').localeCompare(String(b.created_at || ''))));

  const outsideIds = new Set(bills.filter((b) => b.outside).map((b) => b.id));
  const payments = (raw.payments || []).map((p) => {
    // (money set against a bill that is marked "paid outside the app" counts as not set: it never lowers a due twice)
    const set = sumBy(allocs.filter((a) => !outsideIds.has(a.purchase_id)), 'expense_id', p.id);
    return { ...p, amount: Number(p.amount), set, free: r2(Math.max(0, Number(p.amount) - set)) };
  });
  // money not set against anything: unset payments + what they owe us from before + notes not on a bill
  const free = r2(payments.reduce((s, p) => s + p.free, 0)
    + openings.filter((o) => o.direction === 'credit').reduce((s, o) => s + o.amount, 0)
    + (raw.notes || []).filter((n) => !n.purchase_id).reduce((s, n) => s + Number(n.amount), 0));
  const owed = r2(openings.reduce((s, o) => s + o.left, 0) + bills.reduce((s, b) => s + Math.max(0, b.left), 0));
  // a bill paid MORE than its total (rare: typed wrong) gives the extra back to the due as credit
  const over = r2(bills.reduce((s, b) => s + Math.max(0, -b.left), 0));
  const due = r2(owed - free - over);

  // overdue: the free money is applied oldest first (for showing only), then what is past its due date
  let rest = r2(free + over);
  const items = [...openings.filter((o) => o.left > 0.5).map((o) => ({ kind: 'opening', ref: o, date: o.date, left: o.left, due_date: o.date })),
    ...bills.filter((b) => b.left > 0.5).map((b) => ({ kind: 'bill', ref: b, date: b.date, left: b.left, due_date: b.due_date }))]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let overdue = 0; let overdueN = 0;
  for (const it of items) {
    const use = Math.min(rest, it.left); rest = r2(rest - use);
    const after = r2(it.left - use);
    it.ref.after_credit = after;
    if (after > 0.5 && it.due_date && today && it.due_date < today) {
      overdue = r2(overdue + after); overdueN++;
      it.ref.overdue_days = dayNo(today) - dayNo(it.due_date);
    }
  }

  // the statement: every entry by date with the running balance (+ we owe more, − we owe less)
  const lines = [
    ...openings.map((o) => ({ date: o.date, kind: 'opening', id: o.id, ref: null, plus: o.direction === 'owe' ? o.amount : 0, minus: o.direction === 'credit' ? o.amount : 0 })),
    ...bills.map((b) => ({ date: b.date, kind: b.outside ? 'bill_outside' : 'bill', id: b.id, ref: b.bill_no, plus: b.outside ? 0 : b.total, minus: 0, side: b.side })),
    ...payments.map((p) => ({ date: p.day, kind: 'payment', id: p.id, ref: p.method || null, plus: 0, minus: p.amount })),
    ...(raw.notes || []).map((n) => ({ date: n.date, kind: `note_${n.kind}`, id: n.id, ref: n.note_no || null, plus: 0, minus: Number(n.amount), side: n.side })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.plus > 0 && b.plus === 0 ? -1 : a.plus === 0 && b.plus > 0 ? 1 : 0));
  let bal = 0;
  for (const l of lines) { bal = r2(bal + l.plus - l.minus); l.balance = bal; }

  return {
    supplier_id: sup.id, credit_days: credit, due: Math.max(0, due), advance: Math.max(0, -due), net: due, free, overdue, overdue_n: overdueN,
    open_n: items.length, bills, openings, payments, lines, check: r2(bal - due),   // check: the statement and the due agree (0)
  };
}

/**
 * How to set a payment against what is open, oldest first (opening balance, then bills by date): [{ purchase_id |
 * opening_id, amount }] and what is left over (an advance). A suggestion — the person can change every amount.
 * open: [{ kind: 'opening' | 'bill', id, date, left }]
 */
export function suggestSupplierAllocation(amount, open = []) {
  let rest = r2(Number(amount) || 0);
  const parts = [];
  for (const it of [...open].filter((x) => x.left > 0.5).sort((a, b) => (a.kind === 'opening' && b.kind !== 'opening' ? -1 : b.kind === 'opening' && a.kind !== 'opening' ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    if (rest <= 0.005) break;
    const use = r2(Math.min(rest, it.left));
    parts.push(it.kind === 'opening' ? { opening_id: it.id, amount: use } : { purchase_id: it.id, amount: use });
    rest = r2(rest - use);
  }
  return { parts, advance: rest };
}

/** Is a split of a payment fine? → null, or a word key: more than the payment, more than a bill's left, not a number. */
export function allocationProblem(amount, parts = [], open = []) {
  const left = new Map(open.map((x) => [x.id, x.left]));
  let sum = 0;
  for (const p of parts) {
    const a = Number(p.amount);
    if (!(a > 0)) return 'sa_bad_amount';
    const id = p.purchase_id || p.opening_id;
    if (!p.outside && left.has(id) && a > left.get(id) + 0.5) return 'sa_over_bill';
    sum = r2(sum + a);
  }
  if (sum > r2(Number(amount) || 0) + 0.005) return 'sa_over_payment';
  return null;
}
