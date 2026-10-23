import { r2 } from './round.js';
import { checkGstin } from './gstin.js';

/**
 * Money out (owner decisions 23 Oct 2026).
 *
 * - Shop expenses (kharcha): tea, labour, freight, saw blades, rent, … paid from one money account.
 *   kind 'expense' (the shop's running costs), 'supplier' (paid a supplier / mill), 'owner' (owner took for home).
 *   An expense is never edited: it is cancelled with a reason, or replaced by a corrected one.
 * - Money moved between the shop's own accounts is never a sale and never an expense.
 * - The cash drawer is a cash book: opening (left last night) + cash in − cash out = what should be there.
 */

export const EXPENSE_KINDS = Object.freeze(['expense', 'supplier', 'owner']);
export const TRANSFER_REASONS = Object.freeze(['move', 'deposit', 'withdraw', 'home']);
/** A category key as the app's list names it (tea, labour, freight, …). Unknown keys count as "other". */
export const isCategoryKey = (s) => /^[a-z][a-z_]{1,19}$/.test(String(s || ''));

const live = (x) => x && (x.status == null || x.status === 'ok');

/**
 * Totals for a list of expenses (cancelled ones are left out).
 * items: [{ kind, category, amount, accountId, isDrawer, gstAmount, status }]
 * Returns { total, n, byKind: { expense, supplier, owner }, byCategory: [{ category, amount, n }] (largest first),
 *           gst, fromDrawer, byAccount: [{ accountId, amount, n }] }.
 */
export function expenseTotals(items = []) {
  const list = items.filter(live);
  const byKind = Object.fromEntries(EXPENSE_KINDS.map((k) => [k, 0]));
  const cats = new Map();
  const accs = new Map();
  let total = 0; let gst = 0; let drawer = 0;
  for (const e of list) {
    const a = r2(Number(e.amount) || 0);
    total += a;
    byKind[EXPENSE_KINDS.includes(e.kind) ? e.kind : 'expense'] += a;
    const key = e.kind === 'supplier' ? 'supplier' : e.kind === 'owner' ? 'home' : (isCategoryKey(e.category) ? e.category : 'other');
    const c = cats.get(key) || { category: key, amount: 0, n: 0 };
    c.amount = r2(c.amount + a); c.n += 1; cats.set(key, c);
    if (e.accountId != null) {
      const x = accs.get(e.accountId) || { accountId: e.accountId, amount: 0, n: 0 };
      x.amount = r2(x.amount + a); x.n += 1; accs.set(e.accountId, x);
    }
    if (e.gstAmount != null) gst += Number(e.gstAmount) || 0;
    if (e.isDrawer) drawer += a;
  }
  for (const k of EXPENSE_KINDS) byKind[k] = r2(byKind[k]);
  return {
    total: r2(total), n: list.length, byKind,
    byCategory: [...cats.values()].sort((x, y) => y.amount - x.amount || x.category.localeCompare(y.category)),
    gst: r2(gst), fromDrawer: r2(drawer),
    byAccount: [...accs.values()].sort((x, y) => y.amount - x.amount),
  };
}

/**
 * Is an expense ready to save? Returns null when fine, else a word key for the problem.
 * f: { kind, category, amount, accountId, gstBill, gstAmount, sellerGstin, supplierId }
 */
export function expenseProblem(f) {
  const amt = Number(f?.amount);
  if (!EXPENSE_KINDS.includes(f?.kind || 'expense')) return 'exp_p_kind';
  if ((f.kind || 'expense') === 'expense' && !isCategoryKey(f.category)) return 'exp_p_category';
  if (!(amt > 0) || amt > 1e8) return 'exp_p_amount';
  if (!f.accountId) return 'exp_p_account';
  if (f.kind === 'supplier' && !f.supplierId) return 'exp_p_supplier';
  if (f.gstBill) {
    const g = f.gstAmount === '' || f.gstAmount == null ? null : Number(f.gstAmount);
    if (g != null && (!(g >= 0) || g >= amt)) return 'exp_p_gst';
    if (f.sellerGstin && !checkGstin(f.sellerGstin).ok) return 'exp_p_gstin';
  }
  return null;
}

/** GST inside an amount that INCLUDES GST at pct (e.g. 18): ₹1,180 → ₹180. */
export const gstInside = (amount, pct = 18) => r2((Number(amount) || 0) * Number(pct) / (100 + Number(pct)));

/** A move of money between two accounts: null when fine, else a word key. */
export function transferProblem(t) {
  const amt = Number(t?.amount);
  if (!t?.from || !t?.to) return 'tr_p_accounts';
  if (t.from === t.to) return 'tr_p_same';
  if (!(amt > 0) || amt > 1e8) return 'tr_p_amount';
  return null;
}

/**
 * The cash drawer's day from the cash book (api_cash_book / api_day_money):
 * { opening, in, out, expected, counts: [{ at, expected, counted, takenOut, left, by }] }.
 * Returns { opening, in, out, expected, counted, diff, takenOut, left, by, at, nCounts } — counted/diff from the LAST count of the day.
 */
export function cashDay(cb) {
  if (!cb) return null;
  const counts = cb.counts || [];
  const last = counts[counts.length - 1] || null;
  const out = {
    opening: r2(Number(cb.opening) || 0), in: r2(Number(cb.in) || 0), out: r2(Number(cb.out) || 0), expected: r2(Number(cb.expected) || 0),
    counted: last ? r2(Number(last.counted)) : null, countExpected: last ? r2(Number(last.expected)) : null,
    takenOut: last ? r2(Number(last.taken_out ?? last.takenOut ?? 0)) : 0, by: last?.by || null, at: last?.at || null, nCounts: counts.length,
  };
  out.diff = last ? r2(out.counted - out.countExpected) : null;
  out.left = last ? r2(out.counted - out.takenOut) : null;
  return out;
}

/** What to keep in the drawer for tomorrow by default: the same as was left last time (never more than counted). */
export function suggestKeep(counted, lastLeft) {
  const c = r2(Number(counted) || 0);
  if (lastLeft == null || !(Number(lastLeft) >= 0)) return c;
  return Math.min(c, r2(Number(lastLeft)));
}

/**
 * An account's book with a running balance. start: the balance before the first move (or null when not known).
 * moves: [{ at, amount }] in time order. Returns the same moves with `balance` after each (null when start is null).
 */
export function runningBalance(start, moves = []) {
  let b = start == null ? null : r2(Number(start));
  return moves.map((m) => {
    if (b != null) b = r2(b + Number(m.amount));
    return { ...m, balance: b };
  });
}
