// Evening summary: loading a day, the "needs a look" lines, and the WhatsApp text for the owner.
// All the numbers come from the backend (op daySummary, worked out with @srs/core).
import { call } from './api.js';
import { tIn } from './i18n.js';
import { money, kg } from './format.js';
import { fmtDay } from './docs.js';

export const loadDay = (day) => call('daySummary', day ? { day } : {});

/** 'YYYY-MM-DD' ± n days. */
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const weekdayName = (day, l) => tIn(l, `day_${((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1}`);

const m0 = (v) => money(v, false);

/** One "needs a look" item as [title, sub-line, icon, tone, link]. */
export function lookLine(x, l) {
  switch (x.type) {
    case 'cash_short': return [tIn(l, 'look_cash_short', money(x.amount, true)), '', 'Banknote', 'bad', '/reports'];
    case 'cash_over': return [tIn(l, 'look_cash_over', money(x.amount, true)), '', 'Banknote', 'warn', '/reports'];
    case 'cash_not_counted': return [tIn(l, 'look_cash_nc', m0(x.amount)), '', 'Banknote', 'warn', '/reports'];
    case 'rate': return [tIn(l, 'look_rate', x.slipNo, x.grade, money(x.rate)), tIn(l, 'look_rate_s', money(x.std), [x.customer, x.by].filter(Boolean).join(' · ')), 'BadgeIndianRupee', 'warn', x.orderId ? `/slip/${x.orderId}` : null];
    case 'weight': return [tIn(l, 'look_weight', x.slipNo, x.grade, Math.abs(x.pct), tIn(l, x.pct > 0 ? 'look_more' : 'look_less')), tIn(l, 'look_weight_s', kg(x.actual), kg(x.expected)), 'Scale', 'warn', null];
    case 'cancelled': return [tIn(l, 'look_cancel', x.slipNo, x.customer), x.reason || '', 'X', 'neutral', null];
    case 'money_out': return [tIn(l, 'look_out', m0(x.amount), x.customer), x.mode || '', 'RefreshCw', 'neutral', null];
    case 'overdue': return [tIn(l, 'look_overdue', x.customer, m0(x.amount)), tIn(l, 'look_overdue_s', x.days), 'Clock', 'bad', '/reminders'];
    case 'waiting': return [tIn(l, 'look_waiting', x.n), tIn(l, 'look_waiting_s', x.customers.join(', ')), 'PackageCheck', 'neutral', '/slips?stage=weighed'];
    default: return [x.type, '', 'Info', 'neutral', null];
  }
}

/** The summary as a WhatsApp message (for the owner / family, not for customers). */
export function eveningText(d, l, url) {
  const s = d.summary;
  const lines = [
    `*🌙 ${tIn(l, 'eve_title_day', `${weekdayName(d.day, l)} ${fmtDay(d.day, false)}`)}*`,
    d.shop,
    '',
    `*${tIn(l, 'eve_sales')} ${m0(s.sales.total)}* · ${tIn(l, 'eve_slips_kg', s.sales.n, kg(s.sales.kg, 0))}`,
    d.kacha ? `${tIn(l, 'bill_gst_short')} ${m0(s.sales.pakka.total)} (${s.sales.pakka.n}) · ${tIn(l, 'bill_none_short')} ${m0(s.sales.kacha.total)} (${s.sales.kacha.n})` : null,
    s.sales.vsLastWeek != null ? tIn(l, 'eve_vs_last', `${s.sales.vsLastWeek >= 0 ? '↑' : '↓'} ${Math.abs(s.sales.vsLastWeek)}%`, weekdayName(d.day, l)) : null,
    '',
    `*${tIn(l, 'eve_money_in')} ${m0(s.money.total)}*`,
    ['Cash', 'UPI', 'Bank', 'Cheque'].filter((k) => s.money.byMode[k]).map((k) => `${tIn(l, `pm_${k.toLowerCase()}`)} ${m0(s.money.byMode[k])}`).join(' · ') || null,
    '',
    s.cash.counted != null
      ? `*${tIn(l, 'eve_cash')}* ${tIn(l, 'eve_expected', m0(s.cash.expected))} · ${tIn(l, 'eve_counted', m0(s.cash.counted))}${s.cash.diff ? `\n⚠️ *${tIn(l, s.cash.diff < 0 ? 'eve_short' : 'eve_over', m0(Math.abs(s.cash.diff)))}*` : ' ✓'}`
      : `*${tIn(l, 'eve_cash')}* ${tIn(l, 'eve_expected', m0(s.cash.expected))} · ${tIn(l, 'eve_not_counted')}`,
    '',
    d.khata ? `*${tIn(l, 'nav_khata')}* +${m0(s.khata.newDues)} · ${tIn(l, 'eve_old_dues')} ${m0(s.khata.collected)}\n${tIn(l, 'eve_to_receive')}: ${m0(s.khata.toReceive)}` : null,
    '',
    s.look.length ? `*${tIn(l, 'eve_look', s.look.length)}*` : `✓ ${tIn(l, 'eve_all_good')}`,
    ...s.look.map((x) => `• ${lookLine(x, l)[0]}`),
    url ? `\n${tIn(l, 'eve_open_full', url)}` : null,
  ];
  return lines.filter((x) => x !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}
