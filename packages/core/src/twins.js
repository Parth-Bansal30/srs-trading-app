/**
 * Possible double payments (4 Nov 2026, plan v2 F2). Two real payments can have the same amount, so this never decides:
 * it only finds the entries the person saving should look at — same customer (the caller passes that customer's
 * entries), the same amount, within `days` of each other, not cancelled. The server raises the same check as a review
 * card (also for two phones offline); this is the phone's copy so the warning shows before saving, even offline.
 */
const DAY = 86400000;

/** entries: [{ pid, amt, date (ISO), kind, mode, note, cancelled, reversal }] → the twins of a new payment, closest first. */
export function paymentTwins(entries, amount, at = new Date().toISOString(), days = 3) {
  const a = Math.round(Number(amount) * 100);
  const t = Date.parse(at);
  if (!(a > 0) || Number.isNaN(t)) return [];
  return (entries || [])
    .filter((e) => e && e.pid && !e.cancelled && !e.reversal && Math.round(Number(e.amt) * 100) === a && Math.abs(Date.parse(e.date) - t) <= days * DAY)
    .sort((x, y) => Math.abs(Date.parse(x.date) - t) - Math.abs(Date.parse(y.date) - t));
}
