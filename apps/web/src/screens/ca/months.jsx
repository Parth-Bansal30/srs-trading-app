// Month chips for the CA's screens: the last three months as buttons, older ones in a list (22 Nov 2026).
import { t } from '../../lib/i18n.js';

const monthOf = (d) => d.toISOString().slice(0, 7);
/** The last n months, newest first ('YYYY-MM'), by the shop's (India) date. */
export const monthsBack = (n) => { const now = new Date(Date.now() + 5.5 * 3600e3); return Array.from({ length: n }, (_, i) => monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)))); };
export const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
/** The month after m, short ("Nov") — for "keep the GST ready by 20 Nov". */
export const nextMonthShort = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 1)).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }); };

export function MonthChips({ months, month, onPick }) {
  return (
    <div class="gw-chips">
      {months.slice(0, 3).map((x) => <button class={month === x ? 'on' : ''} onClick={() => onPick(x)}>{monthName(x)}</button>)}
      <div class="field" style="min-height:42px;padding:0 10px"><select value={months.slice(0, 3).includes(month) ? '' : month} onChange={(e) => e.currentTarget.value && onPick(e.currentTarget.value)}>
        <option value="">{t('ca_earlier')}</option>{[...months.slice(3), ...(months.includes(month) ? [] : [month])].map((x) => <option value={x}>{monthName(x)}</option>)}</select></div>
    </div>
  );
}
