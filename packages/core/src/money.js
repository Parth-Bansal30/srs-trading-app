import { r2 } from './round.js';

/**
 * Money accounts (owner decisions 30 Sept 2026, design v2).
 *
 * - The shop lists every place money comes in: the cash drawer ("Shop cash", always there),
 *   firm bank accounts, UPI IDs, Paytm numbers, personal / family accounts — named its own way,
 *   each marked firm or personal.
 * - When money is taken, the person picks where it went. One payment can be SPLIT across several
 *   accounts; the parts must add up exactly to the amount.
 * - Each part has a mode (Cash / UPI / Bank / Cheque) that follows from the account and how it was
 *   paid (RTGS / IMPS / NEFT = Bank). A payment's mode is its parts' modes, e.g. "Cash+Bank".
 * - Customers only ever see the mode ("Paid · UPI"), never an account name.
 */

/** 'safe' (23 Oct 2026) = cash kept outside the shop: at home, in a locker. */
export const ACCOUNT_KINDS = Object.freeze(['cash', 'bank', 'upi', 'paytm', 'wallet', 'safe', 'other']);
export const ACCOUNT_OWNERS = Object.freeze(['firm', 'personal']);
export const MODES = Object.freeze(['Cash', 'UPI', 'Bank', 'Cheque']);
/** How money reached a bank account (or "other"). */
export const BANK_METHODS = Object.freeze(['UPI', 'IMPS', 'NEFT', 'RTGS', 'Cheque']);

/** The mode of one part: cash drawer / cash at home = Cash; UPI / Paytm / wallet = UPI; bank / other: by method (default Bank). */
export function partMode(kind, method) {
  if (kind === 'cash' || kind === 'safe') return 'Cash';
  if (kind === 'upi' || kind === 'paytm' || kind === 'wallet') return 'UPI';
  if (method === 'UPI') return 'UPI';
  if (method === 'Cheque') return 'Cheque';
  return 'Bank';
}

/** A payment's mode from its parts' modes: one mode, or several joined in a fixed order ("Cash+UPI"). */
export function joinModes(modes) {
  const set = new Set(modes.filter((m) => MODES.includes(m)));
  return MODES.filter((m) => set.has(m)).join('+') || null;
}

/** "Cash+Bank" → ['Cash','Bank']; 'Adjust' → []. */
export const splitMode = (mode) => String(mode || '').split('+').filter((m) => MODES.includes(m));

/**
 * Check a split before saving. parts: [{ accountId, amount, method }], accounts: [{ id, kind }].
 * Returns { ok, placed, left, mode, parts: [{ accountId, amount, method, mode }], problem }.
 * problem: 'none' (no account picked) | 'zero' (a part with no amount) | 'twice' (same account twice) | 'over' | 'short'.
 */
export function checkSplit(total, parts, accounts) {
  const T = r2(Number(total) || 0);
  const byId = new Map((accounts || []).map((a) => [a.id, a]));
  const list = (parts || []).filter((p) => p && byId.has(p.accountId)).map((p) => {
    const kind = byId.get(p.accountId).kind;
    const method = kind === 'bank' || kind === 'other' ? (BANK_METHODS.includes(p.method) ? p.method : null) : null;
    return { accountId: p.accountId, amount: r2(Number(p.amount) || 0), method, mode: partMode(kind, method) };
  });
  const placed = r2(list.reduce((s, p) => s + p.amount, 0));
  const left = r2(T - placed);
  let problem = null;
  if (!list.length) problem = 'none';
  else if (list.some((p) => !(p.amount > 0))) problem = 'zero';
  else if (new Set(list.map((p) => p.accountId)).size !== list.length) problem = 'twice';
  else if (left < 0) problem = 'over';
  else if (left > 0) problem = 'short';
  return { ok: !problem, placed, left, mode: joinModes(list.map((p) => p.mode)), parts: list, problem };
}

/**
 * How much of one payment went in each mode. A payment with parts uses its parts; an older payment
 * (no parts) uses its own mode. 'Adjust' (money moved inside the khata) is no money at all.
 * p: { amount, mode, parts?: [{ mode, amount }] }
 */
export function modeAmounts(p) {
  if (!p || p.mode === 'Adjust') return [];
  if (Array.isArray(p.parts) && p.parts.length) return p.parts.map((x) => ({ mode: x.mode, amount: r2(Number(x.amount)) }));
  return MODES.includes(p.mode) ? [{ mode: p.mode, amount: r2(Number(p.amount)) }] : [];
}

/** Cash part of a payment (what the drawer should hold). */
export const cashOf = (p) => r2(modeAmounts(p).filter((x) => x.mode === 'Cash').reduce((s, x) => s + x.amount, 0));

/**
 * The evening tally: each account's money for the day.
 * accounts: [{ id, name, kind, owner, isDrawer, hidden }]
 * parts: [{ accountId, amount, paymentId, customer, kind, at }]   (amount < 0 = money out)
 * payments: that day's payments [{ id, amount, mode, parts? }] — to find money not placed in any account
 * checks: account ids ticked for that day
 * Returns { rows: [{ id, name, kind, owner, isDrawer, in, out, net, n, checked }], firm, personal, total, notPlaced, unchecked }.
 */
export function accountTally({ accounts = [], parts = [], payments = [], checks = [] }) {
  const ticked = new Set(checks);
  const rows = accounts.map((a) => {
    const mine = parts.filter((p) => p.accountId === a.id);
    const inn = r2(mine.filter((p) => p.amount > 0).reduce((s, p) => s + Number(p.amount), 0));
    const out = r2(-mine.filter((p) => p.amount < 0).reduce((s, p) => s + Number(p.amount), 0));
    return { id: a.id, name: a.name, kind: a.kind, owner: a.owner, isDrawer: !!a.isDrawer, in: inn, out, net: r2(inn - out), n: mine.length, checked: ticked.has(a.id) };
  }).filter((r) => r.n > 0 || !accounts.find((a) => a.id === r.id)?.hidden);
  const sumOf = (f) => r2(rows.filter(f).reduce((s, r) => s + r.net, 0));
  const notPlaced = r2(payments.filter((p) => p.mode !== 'Adjust' && !(Array.isArray(p.parts) && p.parts.length))
    .reduce((s, p) => s + Number(p.amount), 0));
  return {
    rows, firm: sumOf((r) => r.owner === 'firm'), personal: sumOf((r) => r.owner === 'personal'),
    total: r2(sumOf(() => true) + notPlaced), notPlaced,
    unchecked: rows.filter((r) => r.n > 0 && !r.checked).length,
  };
}

/** "98765 43210" / "srs98@okicici" / "50100012347730" → shown as "••7730" (numbers) or kept (UPI IDs). */
export function maskNumber(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  const d = s.replace(/\D/g, '');
  return d.length > 4 ? `••${d.slice(-4)}` : s;
}
