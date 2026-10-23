// Shop expenses (kharcha) and money moved between accounts — words, icons and dates for the screens.
// Every change goes through the api (saveExpense, cancelExpense, saveTransfer); the totals come from @srs/core.
import { businessDate } from '@srs/core';
import { t } from './i18n.js';
import { company } from './session.js';
import { EXPENSE_CATEGORIES, EXPENSE_SPECIAL } from '../config/options.js';
import { addDays } from './evening.js';

const OTHER = EXPENSE_CATEGORIES.find((c) => c.id === 'other');
/** The look of an expense (or a category key): { word, icon, tone }. */
export function catOf(e) {
  if (!e) return OTHER;
  const kind = typeof e === 'string' ? null : e.kind;
  const key = typeof e === 'string' ? e : e.category;
  if (kind === 'supplier' || key === 'supplier') return EXPENSE_SPECIAL.supplier;
  if (kind === 'owner' || key === 'home') return EXPENSE_SPECIAL.home;
  return EXPENSE_CATEGORIES.find((c) => c.id === key) || OTHER;
}
export const catWord = (e) => t(catOf(e).word);

/** Today in the shop's calendar ('YYYY-MM-DD'). */
export const shopToday = () => businessDate(new Date().toISOString(), company.value?.timezone || 'Asia/Kolkata');
/** First and last day of the month that `day` is in. */
export function monthOf(day) {
  const [y, m] = day.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: first, to: addDays(next, -1) };
}
export const prevMonth = (day) => monthOf(addDays(monthOf(day).from, -1));

/** What kind of move it is, from the two accounts: deposit (cash → bank), withdraw (bank → cash), home (→ cash at home), move. */
export function moveReason(from, to) {
  const cashy = (a) => a && (a.is_drawer || a.kind === 'cash');
  if (cashy(from) && to?.kind === 'bank') return 'deposit';
  if (from?.kind === 'bank' && cashy(to)) return 'withdraw';
  if (cashy(from) && to?.kind === 'safe') return 'home';
  return 'move';
}
export const moveWord = (reason) => t({ deposit: 'tr_deposit', withdraw: 'tr_withdraw', home: 'tr_home', close: 'tr_close' }[reason] || 'tr_move');
