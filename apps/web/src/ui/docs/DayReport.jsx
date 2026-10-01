// The evening summary as an A4 page (PDF / print) with everything in detail — for the shop, not for customers.
import { t } from '../../lib/i18n.js';
import { money, time } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { lookLine, weekdayName } from '../../lib/evening.js';
import { lang } from '../../lib/i18n.js';
import { ShopBadge } from './Paper.jsx';
import './docs.css';

const n2 = (v) => money(v, true).replace('₹', '');
const KIND = { pickup: 'kind_pick', advance: 'kind_adv', khata: 'kind_old_dues', refund: 'kind_refund', transfer: 'kind_transfer' };

export function DayReport({ d, madeAt = new Date().toISOString() }) {
  const s = d.summary; const tz = d.timezone; const l = lang.value;
  const cashTxt = s.cash.counted == null ? t('eve_not_counted') : s.cash.diff === 0 ? t('eve_matches') : t(s.cash.diff < 0 ? 'eve_short' : 'eve_over', money(Math.abs(s.cash.diff), true));
  return (
    <div class="pp pp-page pp-a4 rep">
      <div class="pp-head">
        <div class="pp-shop"><ShopBadge name={d.shop} /><div><div class="pp-shopname">{d.shop}</div><div class="pp-mute pp-small">{t('rep_internal')}</div></div></div>
        <div class="pp-right">
          <div class="pp-cap pp-kind">{t('rep_title')}</div>
          <div style="font-weight:800;font-size:16px;margin-top:2px">{weekdayName(d.day, l)}, {fmtDay(d.day)}</div>
          <div class="pp-mute pp-small">{t('stmt_made', `${fmtDay(new Date(madeAt).toLocaleDateString('en-CA', { timeZone: tz }), false)}, ${time(madeAt, tz)}`)}</div>
        </div>
      </div>

      <div class="pp-boxes">
        <div class="pp-box"><div class="pp-cap">{t('eve_sales')}</div><div class="pp-num">{money(s.sales.total, true)}</div><div class="pp-small pp-mute">{t('eve_slips_kg', s.sales.n, `${n2(s.sales.kg)} kg`)}</div></div>
        <div class="pp-box"><div class="pp-cap">{t('eve_money_in')}</div><div class="pp-num">{money(s.money.total, true)}</div></div>
        <div class={`pp-box ${s.cash.diff ? 'due' : s.cash.counted != null ? 'ok' : ''}`}><div class="pp-cap">{t('eve_cash')}</div><div class="pp-num" style="font-size:13px">{cashTxt}</div></div>
        {d.khata && <div class="pp-box sum"><div class="pp-cap">{t('eve_to_receive')}</div><div class="pp-num">{money(s.khata.toReceive, true)}</div></div>}
      </div>
      {d.kacha && s.sales.n > 0 && (
        <div class="pp-small pp-mute" style="margin-top:8px">{t('bill_gst_short')} {money(s.sales.pakka.total, true)} ({s.sales.pakka.n}) · {t('bill_none_short')} {money(s.sales.kacha.total, true)} ({s.sales.kacha.n}){s.sales.vsLastWeek != null ? ` · ${t('eve_vs_last', `${s.sales.vsLastWeek >= 0 ? '+' : ''}${s.sales.vsLastWeek}%`, weekdayName(d.day, l))}` : ''}</div>
      )}

      <div class="rep-h">{t('eve_sales')}</div>
      <table class="pp-table pp-stmt">
        <thead><tr><th>{t('rep_h_slip')}</th><th>{t('customer')}</th>{d.kacha && <th>{t('rep_h_bill')}</th>}<th class="r">kg</th><th class="r">{t('total')}</th><th class="r">{t('kind_adv')}</th><th class="r">{t('eve_pickup')}</th><th class="r">{t('nav_khata')}</th></tr></thead>
        <tbody>
          {s.slips.map((x) => (
            <tr><td class="pp-num">#{x.no}</td><td>{x.customer}</td>{d.kacha && <td>{t(x.bill === 'pakka' ? 'bill_gst_short' : 'bill_none_short')}</td>}
              <td class="pp-num r">{n2(x.weight)}</td><td class="pp-num r" style="font-weight:700">{n2(x.total)}</td><td class="pp-num r">{x.advance ? n2(x.advance) : ''}</td>
              <td class="pp-num r">{x.pickup ? n2(x.pickup) : ''}</td><td class="pp-num r">{x.toKhata ? n2(x.toKhata) : ''}</td></tr>
          ))}
          {s.slips.length === 0 && <tr><td colSpan={8} class="pp-mute">{t('eve_empty')}</td></tr>}
          {s.slips.length > 0 && <tr class="rep-tot"><td colSpan={d.kacha ? 3 : 2}>{t('total')}</td><td class="pp-num r">{n2(s.sales.kg)}</td><td class="pp-num r">{n2(s.sales.total)}</td>
            <td class="pp-num r">{n2(s.sales.advance)}</td><td class="pp-num r">{n2(s.sales.pickup)}</td><td class="pp-num r">{n2(s.sales.toKhata)}</td></tr>}
        </tbody>
      </table>

      <div class="rep-h">{t('rep_money_title')}</div>
      <table class="pp-table pp-stmt">
        <thead><tr><th>{t('rep_h_time')}</th><th>{t('customer')}</th><th>{t('rep_h_what')}</th><th>{t('rep_h_how')}</th><th class="r">{t('amount')}</th></tr></thead>
        <tbody>
          {s.money.list.map((p) => (
            <tr><td class="pp-num">{p.at ? time(p.at, tz) : ''}</td><td>{p.customer}</td><td>{t(KIND[p.kind] || 'payment')}{p.rev ? ' ↺' : ''}</td><td>{p.mode}</td>
              <td class="pp-num r" style={p.amount < 0 ? 'color:#B0413E' : ''}>{p.amount < 0 ? `− ${n2(-p.amount)}` : n2(p.amount)}</td></tr>
          ))}
          <tr class="rep-tot"><td colSpan={4}>{['Cash', 'UPI', 'Bank', 'Cheque'].filter((k) => s.money.byMode[k]).map((k) => `${k} ${n2(s.money.byMode[k])}`).join(' · ')}</td><td class="pp-num r">{n2(s.money.total)}</td></tr>
        </tbody>
      </table>

      <div class="rep-cols">
        <div>
          <div class="rep-h">{t('eve_cash')}</div>
          <div class="pp-lr"><span class="pp-mute">{t('eve_expected', '')}</span><span class="pp-num">{money(s.cash.expected, true)}</span></div>
          <div class="pp-lr"><span class="pp-mute">{t('eve_counted', '')}</span><span class="pp-num">{s.cash.counted == null ? '—' : money(s.cash.counted, true)}</span></div>
          <div class="pp-lr" style="font-weight:800"><span>{cashTxt}</span><span class="pp-small pp-mute">{s.cash.by || ''}</span></div>
        </div>
        {d.khata && <div>
          <div class="rep-h">{t('nav_khata')}</div>
          <div class="pp-lr"><span class="pp-mute">{t('eve_to_khata')}</span><span class="pp-num">{money(s.khata.newDues, true)}</span></div>
          <div class="pp-lr"><span class="pp-mute">{t('eve_old_dues')}</span><span class="pp-num">{money(s.khata.collected, true)}</span></div>
          <div class="pp-lr" style="font-weight:800"><span>{t('eve_to_receive')}</span><span class="pp-num">{money(s.khata.toReceive, true)}</span></div>
        </div>}
      </div>

      {s.stock?.groups.length > 0 && <>
        <div class="rep-h">{t('eve_stock')}</div>
        <div class="pp-small pp-mute" style="margin-top:4px">{t('eve_bought')}: {n2(s.stock.bought.kg)} kg ({t('eve_bills_n', s.stock.bought.n)}{s.stock.bought.amount != null ? `, ${money(s.stock.bought.amount, true)}` : ''}) · {t('eve_sold_kg')}: {n2(s.stock.soldKg)} kg</div>
        <table class="pp-table pp-stmt">
          <thead><tr><th>{t('pu_grade')}</th><th class="r">kg</th>{s.stock.value != null && <th class="r">{t('st_value')}</th>}</tr></thead>
          <tbody>
            {[...s.stock.groups].sort((a, b) => b.kg - a.kg).map((g) => <tr><td>{g.code} · {g.shape ? t(`sh_${g.shape}`) : t('st_any_shape')}{g.lowKg != null && g.kg < g.lowKg ? ` (${t('st_low')})` : ''}</td>
              <td class="pp-num r">{n2(g.kg)}</td>{s.stock.value != null && <td class="pp-num r">{g.value != null ? n2(g.value) : ''}</td>}</tr>)}
            <tr class="rep-tot"><td>{t('eve_in_stock')}</td><td class="pp-num r">{n2(s.stock.onHandKg)}</td>{s.stock.value != null && <td class="pp-num r">{n2(s.stock.value)}</td>}</tr>
          </tbody>
        </table>
      </>}

      <div class="rep-h">{s.look.length ? t('eve_look', s.look.length) : t('eve_all_good')}</div>
      {s.look.map((x) => { const [a, b] = lookLine(x, l); return <div class="rep-look">• <b>{a}</b>{b ? <span class="pp-mute"> — {b}</span> : null}</div>; })}

      <div class="pp-grow" />
      <div class="pp-bottom"><span>{t('rep_internal')}</span></div>
    </div>
  );
}
