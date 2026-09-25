import { r2 } from './round.js';
import { orderTotals } from './pricing.js';

/**
 * Finishing an order at pickup: bill type chosen, advance taken off, how the rest is paid.
 * advance = total advance already paid on this order.
 * payMode: 'now' | 'later' | 'part' (forced to 'now' when the advance already covers it).
 */
export function finishCalc({ order, advance = 0, bill = null, payMode, paid, gstPct = 18, kachaPct = 10, minInch = 0 }) {
  const b = bill || null;
  const tmp = { ...order, bill: b, kachaPct, gstPct };
  const T = orderTotals(tmp, 'final', { bill: b, gstPct, kachaPct, minInch });
  const A = advance;
  const B = r2(Math.max(0, T.total - A));
  const extra = r2(Math.max(0, A - T.total));
  const mode = B <= 0 ? 'now' : payMode || 'later';
  const paidNow = mode === 'now' ? B : mode === 'part' ? Number(paid) || 0 : 0;
  return { T, A, B, extra, mode, paidNow, due: r2(Math.max(0, B - paidNow)), bill: b };
}

/** Why a finish can't be saved yet, or null when it can. */
export function finishProblem(f) {
  if (!f.bill) return 'choose_bill';
  if (f.mode === 'part' && !(f.paidNow > 0 && f.paidNow < f.B)) return 'need_part';
  return null;
}

/** An order stays in the khata unless what's paid equals the bill exactly. */
export const staysInKhata = (totalPaid, billTotal) => r2(totalPaid) !== billTotal;
