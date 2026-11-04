import { money } from './format.js';
import { fmtDay } from './docs.js';
// Money accounts: where money goes (Shop cash + the shop's own bank / UPI / Paytm accounts).
// Loaded through the api; every change goes through useAction / call.
import { signal } from '@preact/signals';
import { checkSplit, splitMode, maskNumber, creditOver } from '@srs/core';
import { useEffect, useState } from 'preact/hooks';
import { can, company } from './session.js';
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
// Money going OUT remembers its own account per kind of expense (26 Oct 2026: after a cheque went into the bank,
// the next tea was quietly written as paid from the bank). Tea stays with the drawer; rent can stay with the bank.
const OUT = 'srs:outAccount';
const outMap = () => { try { return JSON.parse(localStorage.getItem(OUT) || '{}') || {}; } catch { return {}; } };
export const lastOutAccount = (what) => outMap()[what || '_'] || null;
export const rememberOutAccount = (what, id) => { try { localStorage.setItem(OUT, JSON.stringify({ ...outMap(), [what || '_']: id })); } catch { /* private window */ } };

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

// ---------- overdraft / cash credit accounts (4 Nov 2026) ----------
/** A balance in words: for an OD / CC account "₹11,23,088 used" or "₹79,572 in credit"; otherwise the amount. */
export const balWords = (a, balance, paise = false) => {
  const b = Number(balance) || 0;
  if (!a?.credit_kind) return money(b, paise);
  return b < 0 ? t('cr_used_amt', money(-b, paise)) : t('cr_in_credit_amt', money(b, paise));
};
/** "Estimate: statement of 31 Oct + 3 entries since" — what an OD / CC figure is based on. */
export const creditBasis = (s) => (!s?.known ? t('cr_est_none')
  : t(s.source === 'passbook' || s.source === 'start' ? 'cr_est_point' : 'cr_est_count', fmtDay(shopDayOf(s.since), false), s.entries));
/** The shop's own date of a moment (not the UTC date: 12:48 am in India is still yesterday in UTC). */
export const shopDayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: company.value?.timezone || 'Asia/Kolkata' });

/** Owners: "This goes ₹24,000 over the HDFC CC limit (estimate)" while paying out of an OD / CC account (never a block). */
let balCache = { at: 0, list: null };
export function useCreditWarn(accountId, amount) {
  const [list, setList] = useState(balCache.list);
  const acc = (accountsCache.value || []).find((a) => a.id === accountId);
  const isCredit = !!acc?.credit_kind && can('settings');
  useEffect(() => {
    if (!isCredit || Date.now() - balCache.at < 60000) return;
    call('accountBalances', {}).then((l) => { balCache = { at: Date.now(), list: l }; setList(l); }).catch(() => {});
  }, [accountId, isCredit]);
  if (!isCredit || !(Number(amount) > 0)) return null;
  const b = (list || balCache.list || []).find((a) => a.id === accountId);
  if (!b?.known) return null;
  const over = creditOver(b, amount);
  return over > 0 ? t('cr_warn', money(over, false), accName(acc)) : null;
}
