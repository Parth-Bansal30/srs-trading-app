// The ₹2 lakh cash rule (5 Nov 2026, plan v2 F8). The law (old section 269ST, carried into the new Income-tax Act —
// the shop's CA confirms the exact section and exceptions) does not allow cash of ₹2,00,000 or more from one person
// in one day, or for one deal (one slip). The database stops it; these helpers let the screens say so BEFORE saving
// and offer the split (the most cash allowed + the rest by UPI / bank). Cash paid out over ₹10,000 to one person in a
// day is only flagged for the CA (it may not count as an expense).
import { r2 } from './round.js';

export const CASH_LIMIT = 200000;
export const CASH_OUT_FLAG = 10000;

/** The most cash that still keeps one person's day and one slip under the limit. */
export const cashRoomLeft = (day = 0, slip = 0, limit = CASH_LIMIT) =>
  Math.max(0, r2(limit - 1 - Math.max(Number(day) || 0, Number(slip) || 0)));

/**
 * Is this much cash allowed? room: from cashRoomLeft (or the server). total: the whole payment.
 * Returns { over, cash, room, keep, other }: keep = the cash that may be taken, other = the rest of the payment by UPI / bank.
 */
export function cashCheck(cash, room, total = cash) {
  const c = r2(Number(cash) || 0);
  const R = Math.max(0, r2(Number(room) || 0));
  const over = c > R;
  const keep = over ? R : c;
  return { over, cash: c, room: R, keep, other: over ? r2((Number(total) || 0) - keep) : r2((Number(total) || 0) - c) };
}
