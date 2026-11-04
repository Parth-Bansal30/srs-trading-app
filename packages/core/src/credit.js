/**
 * Overdraft (OD) and cash credit (CC) bank accounts (4 Nov 2026, plan v2 F3). The balance is usually below zero: that
 * is money used from the sanctioned limit. Everything here is an ESTIMATE until the bank's own statement says otherwise:
 * it is the last balance point (a statement / passbook figure) plus every entry in the app since — the screens say so.
 */
import { r2 } from './round.js';

/** a: { balance, credit_kind, credit_limit, known, since, source, entries } → null for a normal account. */
export function creditStatus(a) {
  if (!a || !a.credit_kind || !(Number(a.credit_limit) > 0)) return null;
  const bal = Number(a.balance) || 0;
  const limit = r2(Number(a.credit_limit));
  const used = bal < 0 ? r2(-bal) : 0;
  const inCredit = bal > 0 ? r2(bal) : 0;
  const available = r2(limit - used);
  return { kind: a.credit_kind, limit, used, inCredit, available, over: available < 0 ? r2(-available) : 0,
    pct: Math.min(100, Math.round((used / limit) * 100)), known: !!a.known, since: a.since || null, source: a.source || null,
    entries: Number(a.entries) || 0 };
}

/** How far paying `amount` out of this account would go past its limit (estimate); 0 when it stays inside. */
export function creditOver(a, amount) {
  const s = creditStatus(a);
  if (!s) return 0;
  const left = r2(s.available - (Number(amount) || 0));
  return left < 0 ? r2(-left) : 0;
}
