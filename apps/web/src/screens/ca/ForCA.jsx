// #/ca — For the CA (6 Nov 2026, F10; remade 22 Nov 2026). A month's GST papers worked out by the GST rules: first
// what would make the app, Tally and the returns differ ("Check before sending", most serious first), then a rough
// "GST to pay" so the money is ready by the 20th, then what goes in the one Excel file — sent on WhatsApp (or any app)
// or downloaded, and noted. The app makes no GST invoices — the CA does, in Tally.
import { useEffect, useState } from 'preact/hooks';
import { t, tIn } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money, shortDate } from '../../lib/format.js';
import { go, route } from '../../lib/router.js';
import { saveFile } from '../../lib/xlsx.js';
import { toast } from '../../ui/toast.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { caWorkbook } from './caWorkbook.js';
import { monthsBack, monthName, nextMonthShort, MonthChips } from './months.jsx';
import '../../ui/gst/gst.css';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const flagText = (f) => (f || []).map((x) => tIn('en', `rf_${x}`)).join('; ');
const ICON = { tally_cancel: 'FileX', tally_twin: 'Copy', tally_differs: 'TriangleAlert', sup_gst: 'ShieldAlert', unpaid180: 'CalendarClock', pending_before: 'FileClock',
  no_tally: 'FileClock', tally_gap: 'ListChecks', tally_month: 'Calendar', pos_check: 'MapPin', hsn_check: 'Tag', b2c_details: 'Contact', exp_check: 'Receipt',
  cn_check: 'ReceiptText', daybook: 'CircleCheck' };
/** A check's title, in the singular for one. */
export const ckKey = (c, has) => (c.n === 1 && has(`ck_${c.id}_1`) ? `ck_${c.id}_1` : `ck_${c.id}`);
const firstSlips = (items, k = 3) => items.slice(0, k).map((x) => (typeof x === 'object' ? `#${x.slip_no}${x.customer ? ` ${x.customer}` : ''}` : `#${x}`)).join(' · ') + (items.length > k ? ' …' : '');

/** One check: its words and where tapping it goes. */
function checkView(c, month) {
  const bills = (tab, m = month) => `/gst-bills?month=${m}&tab=${tab}`;
  switch (c.id) {
    case 'tally_cancel': return { s: t('ck_tally_cancel_s', money(c.amount, true)), to: bills('deleted') };
    case 'tally_twin': return { s: c.items.map((x) => `${x.tally_no}: #${x.slips.join(', #')}`).join(' · '), to: bills('done') };
    case 'tally_differs': return { s: firstSlips(c.items), to: bills('check') };
    case 'sup_gst': return { s: t('ck_sup_gst_s', money(c.amount, true)), to: '/suppliers' };
    case 'unpaid180': return { s: t('ck_unpaid180_s', money(c.amount, true)), to: '/purchases' };
    case 'pending_before': return { s: firstSlips(c.items), to: bills('waiting', String(c.items[0]?.date || month).slice(0, 7)) };
    case 'no_tally': return { s: `${money(c.amount, true)} · ${firstSlips(c.items)}`, to: bills('waiting') };
    case 'tally_gap': return { s: t('ck_tally_gap_s', c.items.slice(0, 4).join(', ') + (c.items.length > 4 ? ' …' : '')), to: bills('done') };
    case 'tally_month': return { s: t('ck_tally_month_s'), to: bills('done') };
    case 'pos_check': return { s: `${t('ck_pos_check_s')} · ${firstSlips(c.items)}`, to: bills('check') };
    case 'hsn_check': return { s: `${t('ck_hsn_check_s')} · ${firstSlips(c.items)}`, to: '/rates' };
    case 'b2c_details': return { s: `${t('ck_b2c_details_s')} · ${firstSlips(c.items)}`, to: bills('check') };
    case 'exp_check': return { s: c.items.slice(0, 3).map((x) => x.paid_to || x.bill_no).join(' · '), to: '/expenses' };
    case 'cn_check': return { s: c.items.slice(0, 3).map((x) => `${x.supplier}${x.note_no ? ` ${x.note_no}` : ''}`).join(' · '), to: '/suppliers' };
    default: return { s: t('ck_daybook_s', c.n, money(c.amount, true)), to: null };
  }
}

export function ForCA() {
  const months = monthsBack(12);
  // #/ca?month=2026-10 (from the Day book / GST bills) opens on that month; before the 11th, last month (GSTR-1 is due then)
  const asked = /^\d{4}-\d{2}$/.test(route.value.query.month || '') && route.value.query.month <= months[0] ? route.value.query.month : null;
  const [month, setMonth] = useState(asked || (months[1] && new Date(Date.now() + 5.5 * 3600e3).getUTCDate() < 11 ? months[1] : months[0]));
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);
  const sent = useAction('caSent');
  const load = () => call('gstMonth', { month }).then(setM).catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!can('khata') || !can('money')) { go('/'); return; } setM(null); setErr(null); load(); }, [month]);

  const name = `${(company.value?.name || 'shop').replace(/[^A-Za-z0-9]+/g, '-')}-GST-${month}.xlsx`;
  const bytes = () => caWorkbook(m, { w: (k, ...a) => tIn('en', k, ...a), flagText, monthName });
  const note = (how) => sent.run({ month, how, slips: new Set(m.sales.filter((r) => !r.excluded).map((r) => r.slip_no)).size, total: m.sales_totals.total })
    .then(load).catch(() => {});
  const download = () => { saveFile(bytes(), name); toast(t('ca_saved', name)); note('download'); };
  const share = async () => {
    const file = new File([bytes()], name, { type: XLSX });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name, text: t('ca_share_text', monthName(month), company.value?.name || '') }); note('share'); }
      catch (e) { if (e?.name !== 'AbortError') download(); }
    } else download();
  };

  const toFix = m ? m.checks.filter((c) => c.tone !== 'ok') : [];
  const g = m?.gst3b;
  const live = m ? m.sales.filter((r) => !r.excluded) : [];
  const slipsOf = (pred) => new Set(live.filter(pred).map((r) => r.slip_no)).size;
  const last = m?.sent?.[0];
  const files = m ? [
    ['FileSpreadsheet', t('sh_sales'), t('sh_sales_s', slipsOf(() => true))],
    ['FileSpreadsheet', t('sh_hsn'), t('sh_hsn_s')],
    ['FileSpreadsheet', t('sh_tally'), m.series.series.length ? m.series.series.slice(0, 2).map((s) => `${s.from} – ${s.to}`).join(' · ') + (m.series.series.length > 2 ? ` · ${t('ck_more', m.series.series.length - 2)}` : '') : t('sh_tally_none')],
    ['FileSpreadsheet', t('ca_buys'), t('sh_buys_s', m.purchase_bills.length)],
    ...(m.expenses ? [['Receipt', t('sh_exp'), t('sh_exp_s', m.expenses.length, money(m.expenses.filter((e) => e.claim).reduce((s, e) => s + e.gst, 0), true))]] : []),
    ['ReceiptText', t('sh_cn'), t('sh_cn_s', m.credit_notes.length, money(m.credit_notes.reduce((s, x) => s + x.gst, 0), true))],
    ['FileX', t('sh_cancel'), t('sh_cancel_s', m.cancelled.length)],
    ['Percent', t('sh_3b'), t('sh_3b_s')],
    ...(m.unpaid180?.length ? [['CalendarClock', t('sh_unpaid'), t('sh_n', m.unpaid180.length)]] : []),
  ] : [];
  const empty = m && !live.length && !m.purchases.length && !m.cancelled.length && !(m.expenses || []).length;

  return (
    <>
      <TopBar title={t('ca_title')} sub={t('ca_sub2')} />
      <div class="page" style="padding-bottom:150px">
        <MonthChips months={months} month={month} onPick={setMonth} />
        {err && <div class="error" style="margin-top:12px">{err}</div>}
        {!m && !err && <Skeleton h={320} style="margin-top:16px" />}
        {m && <>
          <button class="card li" style="margin-top:12px;width:100%" onClick={() => go(`/gst-bills?month=${month}`)}>
            <div class="iconbox tone-brand-soft"><Icon name="ReceiptText" size={18} /></div>
            <div class="grow"><div class="t">{t('nav_gstbills')}</div><div class="s">{t('gbl_sub')}</div></div><Icon name="ChevronRight" size={16} /></button>

          <div class="sec"><h3>{t('ca_checks')}</h3><span class={`chip ${toFix.length ? 'tone-warn' : 'tone-ok'}`}>{toFix.length ? t('ca_to_fix', toFix.length) : t('ca_all_clear')}</span></div>
          <div class="card" style="padding:0">
            {m.checks.map((c) => {
              const v = checkView(c, month);
              const title = c.id === 'daybook' ? t(c.tone === 'ok' ? 'ck_daybook_ok' : 'ck_daybook_bad') : t(ckKey(c, (k) => t(k) !== k), c.n);
              return (
                <button class="ca-ck" disabled={!v.to} onClick={() => v.to && go(v.to)}>
                  <div class={`iconbox tone-${c.tone}`}><Icon name={ICON[c.id] || 'CircleHelp'} size={17} /></div>
                  <div class="grow" style="min-width:0"><div class="t">{title}</div>{v.s && <div class="s">{v.s}</div>}</div>
                  {v.to && <Icon name="ChevronRight" size={16} />}
                </button>);
            })}
          </div>

          {empty ? <div class="card li muted" style="margin-top:14px">{t('ca_none_month')}</div> : <>
            <div class="sec"><h3>{t('ca_gst_month')}</h3><span class="faint" style="font-size:12px;font-weight:700">{t('ca_rough')}</span></div>
            <div class="ca-tiles">
              <div class="ca-tile"><div class="k">{t('ca_gst_sales')}</div><div class="v num">{money(g.out_net.tax, false)}</div>
                <div class="s">IGST {money(g.out_net.igst, false)} · CGST+SGST {money(g.out_net.cgst + g.out_net.sgst, false)}</div></div>
              <div class="ca-tile"><div class="k">{t('ca_gst_bills')}</div><div class="v num">{money(g.itc_net.tax, false)}</div>
                <div class="s">{t('ca_bills_sub', m.purchase_bills.length, (m.expenses || []).filter((e) => e.claim).length, m.credit_notes.length)}</div></div>
              <div class="ca-tile big"><div class="k">{g.to_pay > 0 ? t('ca_to_pay') : t('ca_carry')}</div><div class="v num">{money(g.to_pay > 0 ? g.to_pay : g.carry, false)}</div>
                <div class="s">{g.to_pay > 0 ? t('ca_to_pay_s', nextMonthShort(month)) : t('ca_carry_s')}</div></div>
              <div class="ca-tile"><div class="k">{t('ca_b2b')}</div><div class="v num" style="font-size:16px">{money(m.hsn.totals.b2b.taxable, false)}</div>
                <div class="s">{t('ca_b2b_s', slipsOf((r) => r.table === 'b2b'))}</div></div>
              <div class="ca-tile"><div class="k">{t('ca_b2c')}</div><div class="v num" style="font-size:16px">{money(m.hsn.totals.b2c.taxable, false)}</div>
                <div class="s">{t('ca_b2c_s', slipsOf((r) => r.table !== 'b2b'))}</div></div>
            </div>
          </>}

          <div class="sec"><h3>{t('ca_goes')}</h3><span class="faint" style="font-size:12px;font-weight:700">{t('ca_one_file')}</span></div>
          <div class="card" style="padding:0">
            {files.map(([icon, ti, s]) => <div class="ca-file"><div class="iconbox tone-ok"><Icon name={icon} size={16} /></div><div class="grow"><div class="t">{ti}</div><div class="s">{s}</div></div></div>)}
          </div>
          <div class="faint" style="font-size:12.5px;font-weight:600;margin:10px 2px 0">
            {last ? t('ca_last_sent', shortDate(last.at, company.value?.timezone), t(last.how === 'share' ? 'ca_how_share' : 'ca_how_download')) + (last.by ? ` · ${last.by}` : '') : t('ca_never_sent')}</div>
          <div class="faint" style="font-size:12.5px;font-weight:600;margin:8px 2px 0">{t('ca_s')}</div>
        </>}
      </div>
      {m && <div class="quotebar" style="display:grid;gap:8px;grid-template-columns:1fr">
        <button class="btn btn-accent btn-block" onClick={share}><Icon name="Send" size={19} />{t('ca_send')}</button>
        <button class="btn btn-ghost btn-block" style="min-height:46px" onClick={download}><Icon name="Download" size={18} />{t('ca_download2')}</button>
      </div>}
    </>
  );
}
