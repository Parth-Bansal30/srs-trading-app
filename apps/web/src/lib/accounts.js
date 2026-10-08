// Money accounts: where money goes (Shop cash + the shop's own bank / UPI / Paytm accounts).
// Loaded through the api; every change goes through useAction / call.
import { signal } from '@preact/signals';
import { checkSplit, splitMode, maskNumber } from '@srs/core';
import { call } from './api.js';
import { t } from './i18n.js';
import { ACCOUNT_KINDS, ACCOUNT_DRAWER, PAY_METHODS } from '../config/options.js';

/** Accounts this person may choose (shared by every money sheet). */
export const accountsCache = signal(null);
let at = 0;
export async function loadAccounts(force = false) {
  if (!force && accountsCache.value && Date.now() - at < 60000) return accountsCache.value;
  const list = await call('accounts', {});
  accountsCache.value = list; at = Date.now();
  return list;
}
export const forgetAccounts = () => { at = 0; };

export const kindOf = (a) => (a?.is_drawer || a?.kind === 'cash' ? ACCOUNT_DRAWER : ACCOUNT_KINDS.find((k) => k.id === a?.kind) || ACCOUNT_KINDS[4]);
/** The drawer keeps its translated name until the shop renames it. */
export const accName = (a) => (a?.is_drawer && a.name === 'Shop cash' ? t('acc_drawer') : a?.name || '');
export const accSub = (a) => [t(kindOf(a).word), maskNumber(a?.number)].filter(Boolean).join(' · ');
export const isBankLike = (a) => a && (a.kind === 'bank' || a.kind === 'other');

/** "Cash+Bank" → "Cash + Bank" in the person's language. */
export const modeText = (mode) => splitMode(mode).map((m) => t(PAY_METHODS.find((p) => p.id === m)?.word || m)).join(' + ');
export const modeIcon = (mode) => (splitMode(mode).length > 1 ? 'Split' : PAY_METHODS.find((p) => p.id === mode)?.icon || 'RefreshCw');

const LAST = 'srs:lastAccount';
export const lastAccount = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
export const rememberAccount = (id) => { try { localStorage.setItem(LAST, id); } catch { /* private window */ } };

/**
 * Where-the-money-went state used by <MoneyTo>:
 *   { mode }                                   — no accounts set up yet: the old Cash / UPI / Bank / Cheque
 *   { ids: [id], methods }                     — one account gets all of it
 *   { ids: [id, …], amounts: {id: '…'}, methods, split: true } — split across accounts
 */
export function whereArgs(w, amount) {
  if (!w) return {};
  if (!w.ids) return { mode: w.mode };
  if (!w.split || w.ids.length === 1) {
    const id = w.ids[0];
    return id ? { account_id: id, method: w.methods?.[id] || undefined } : {};
  }
  return { parts: w.ids.map((id) => ({ account_id: id, amount: Number(w.amounts?.[id] || 0), method: w.methods?.[id] || undefined })) };
}
/** Is it ready to save? Returns null when fine, else a word key for the problem. */
export function whereProblem(w, amount, accounts) {
  if (!w) return 'acc_pick';
  if (!w.ids) return w.mode ? null : 'acc_pick';
  if (!w.ids.length) return 'acc_pick';
  if (!w.split || w.ids.length === 1) return null;
  const c = checkSplit(amount, w.ids.map((id) => ({ accountId: id, amount: w.amounts?.[id], method: w.methods?.[id] })), (accounts || []).map((a) => ({ id: a.id, kind: a.kind })));
  return c.ok ? null : c.problem === 'over' ? 'acc_over' : c.problem === 'short' ? 'acc_short' : 'acc_each';
}
export const splitState = (w, amount, accounts) => checkSplit(amount, (w?.ids || []).map((id) => ({ accountId: id, amount: w.amounts?.[id], method: w.methods?.[id] })),
  (accounts || []).map((a) => ({ id: a.id, kind: a.kind })));

/** Where the money went, in words: "SBI current · RTGS", "Shop cash + SBI current", or the mode ("UPI"). */
export function whereLabel(w, accounts) {
  if (!w) return '';
  if (!w.ids) return modeText(w.mode);
  const names = w.ids.map((id) => accName((accounts || []).find((a) => a.id === id))).filter(Boolean);
  if (names.length === 1 && w.methods?.[w.ids[0]]) return `${names[0]} · ${w.methods[w.ids[0]]}`;
  return names.join(' + ');
}
