// #/ca — For the CA (6 Nov 2026, plan v2 F10). The month's GST slips and GST purchase bills, worked into the sales and
// purchase registers (one row per slip / bill and HSN), with totals, "CA to check" flags, the GST slips still waiting for
// their Tally bill, and an Excel file written on this phone. The app makes no GST invoices — the CA does, in Tally.
import { useEffect, useState } from 'preact/hooks';
import { t, tIn } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go } from '../../lib/router.js';
import { makeXlsx, saveFile } from '../../lib/xlsx.js';
import { toast } from '../../ui/toast.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import '../../ui/gst/gst.css';

const monthOf = (d) => d.toISOString().slice(0, 7);
const monthsBack = (n) => { const now = new Date(Date.now() + 5.5 * 3600e3); return Array.from({ length: n }, (_, i) => monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)))); };
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DELIVERY = { pickup: 'gsw_pickup', ours: 'gsw_ours', direct: 'gsw_direct_short' };
const flagText = (l, f) => (f || []).map((x) => tIn(l, `rf_${x}`)).join('; ');
const num = (v) => (v == null ? '' : Number(v));

function workbook(m) {
  const l = 'en';
  const sales = [['Date', 'Slip no.', 'Tally bill no.', 'Customer', 'GSTIN', 'Place of supply', 'Delivery', 'HSN', 'Description', 'Kg', 'Taxable value',
    'GST rate %', 'CGST', 'SGST', 'IGST', 'GST', 'Total', 'CA to check'],
  ...m.sales.map((r) => [r.date, /^\d+$/.test(String(r.slip_no)) ? Number(r.slip_no) : r.slip_no, r.tally_no, r.customer, r.gstin, r.pos, r.delivery ? tIn(l, DELIVERY[r.delivery]) : '', r.hsn, r.desc, num(r.kg),
    num(r.taxable), num(r.rate), num(r.cgst), num(r.sgst), num(r.igst), num(r.gst), num(r.total), flagText(l, r.flags)]),
  ['', '', '', 'TOTAL', '', '', '', '', '', '', m.sales_totals.taxable, '', m.sales_totals.cgst, m.sales_totals.sgst, m.sales_totals.igst, m.sales_totals.gst, m.sales_totals.total, '']];
  const buys = [['Date', 'Bill no.', 'Supplier', 'GSTIN', 'State', 'HSN', 'Description', 'Kg', 'Taxable value', 'CGST', 'SGST', 'IGST', 'GST', 'Round off', 'Total',
    'Stock effect', 'CA to check'],
  ...m.purchases.map((r) => [r.date, r.bill_no, r.supplier, r.gstin, r.state, r.hsn, r.desc, num(r.kg), num(r.taxable), num(r.cgst), num(r.sgst), num(r.igst),
    num(r.gst), num(r.round_off), num(r.total), tIn(l, `pu_eff_${r.stock_effect}`), flagText(l, r.flags)]),
  ['', '', 'TOTAL', '', '', '', '', '', m.purchase_totals.taxable, m.purchase_totals.cgst, m.purchase_totals.sgst, m.purchase_totals.igst, m.purchase_totals.gst, '',
    m.purchase_totals.total, '', '']];
  const sum = [['For the CA', monthName(m.month)], ['Shop', m.shop?.name || ''], ['Shop GSTIN', m.shop?.gstin || ''], [],
    ['Sales register (GST slips only)', ''], ['GST slips', m.sales_totals.slips], ['Taxable value', m.sales_totals.taxable], ['CGST', m.sales_totals.cgst],
    ['SGST', m.sales_totals.sgst], ['IGST', m.sales_totals.igst], ['GST', m.sales_totals.gst], ['Total', m.sales_totals.total],
    ['Total of the GST slips (Day book)', m.slips_total], ['Rows to check', m.sales_totals.flagged], [],
    ['Purchase register (GST bills)', ''], ['Bills', m.purchase_totals.slips], ['Taxable value', m.purchase_totals.taxable], ['GST', m.purchase_totals.gst],
    ['Total', m.purchase_totals.total], ['Rows to check', m.purchase_totals.flagged], [],
    ['The app makes no GST invoices. CGST / SGST / IGST are worked out from where the steel went, for the CA to confirm; "CA to check" marks rows where something is missing or unusual.', '']];
  return makeXlsx([
    { name: 'Summary', rows: sum, widths: [44, 22] },
    { name: 'Sales register', rows: sales, widths: [11, 8, 16, 24, 17, 15, 14, 9, 22, 10, 13, 8, 11, 11, 11, 11, 13, 40] },
    { name: 'Purchase register', rows: buys, widths: [11, 14, 24, 17, 14, 9, 24, 10, 13, 11, 11, 11, 11, 9, 13, 16, 30] },
  ]);
}

export function ForCA() {
  const months = monthsBack(12);
  const [month, setMonth] = useState(months[1] && new Date().getUTCDate() < 11 ? months[1] : months[0]);
  const [m, setM] = useState(null);
  const [err, setErr] = useState(null);
  const [pend, setPend] = useState(null);
  const [allPend, setAllPend] = useState(false);
  useEffect(() => { if (!can('khata')) go('/'); call('tallyPending').then(setPend).catch(() => setPend({ count: 0, slips: [] })); }, []);
  useEffect(() => { setM(null); setErr(null); call('gstMonth', { month }).then(setM).catch((e) => setErr(e.message || t('err_generic'))); }, [month]);
  const flagged = m ? m.sales.filter((r) => r.flags.length) : [];
  const ok = m && Math.abs(m.sales_totals.total - m.slips_total) < 0.01;
  const download = () => {
    const name = `${(company.value?.name || 'shop').replace(/[^A-Za-z0-9]+/g, '-')}-GST-${month}.xlsx`;
    saveFile(workbook(m), name);
    toast(t('ca_saved', name));
  };
  return (
    <>
      <TopBar title={t('ca_title')} sub={t('ca_sub')} />
      <div class="page" style="padding-bottom:120px">
        <div class="gw-chips">
          {months.slice(0, 3).map((x) => <button class={month === x ? 'on' : ''} onClick={() => setMonth(x)}>{monthName(x)}</button>)}
          <div class="field" style="min-height:42px;padding:0 10px"><select value={months.slice(0, 3).includes(month) ? '' : month} onChange={(e) => e.currentTarget.value && setMonth(e.currentTarget.value)}>
            <option value="">{t('ca_earlier')}</option>{months.slice(3).map((x) => <option value={x}>{monthName(x)}</option>)}</select></div>
        </div>

        {err && <div class="error">{err}</div>}
        {!m && !err && <Skeleton h={220} style="margin-top:16px" />}
        {m && <>
          <div class="sec"><h3>{t('ca_sales')}</h3><span class="faint" style="font-size:12.5px;font-weight:700">{t('ca_slips_n', m.sales_totals.slips)}</span></div>
          <div class="card pad">
            <div class="ca-tot">
              <div><span>{t('ca_taxable')}</span><b class="num">{money(m.sales_totals.taxable, true)}</b></div>
              <div><span>GST</span><b class="num">{money(m.sales_totals.gst, true)}</b></div>
              <div><span>CGST + SGST</span><b class="num">{money(m.sales_totals.cgst + m.sales_totals.sgst, true)}</b></div>
              <div><span>IGST</span><b class="num">{money(m.sales_totals.igst, true)}</b></div>
            </div>
            <div class="row" style="margin-top:10px"><span class="grow" style="font-weight:800">{t('total')}</span><b class="num">{money(m.sales_totals.total, true)}</b></div>
            <div class={`pos-line ${ok ? 'ok' : 'check'}`}><Icon name={ok ? 'CircleCheck' : 'TriangleAlert'} size={16} />
              <span class="grow">{ok ? t('ca_matches', money(m.slips_total, true)) : t('ca_differs', money(m.slips_total, true))}</span></div>
            {flagged.length > 0 && <div class="faint" style="font-size:12.5px;font-weight:700;margin-top:8px">{t('ca_flagged', flagged.length)}</div>}
            {flagged.slice(0, 3).map((r) => <div style="margin-top:6px;font-size:13px"><b>#{r.slip_no}</b> {r.customer} {r.flags.map((f) => <span class="gst-flag">{t(`rf_${f}`)}</span>)}</div>)}
          </div>

          <div class="sec"><h3>{t('ca_buys')}</h3><span class="faint" style="font-size:12.5px;font-weight:700">{t('ca_bills_n', m.purchase_totals.slips)}</span></div>
          <div class="card pad">
            <div class="ca-tot">
              <div><span>{t('ca_taxable')}</span><b class="num">{money(m.purchase_totals.taxable, true)}</b></div>
              <div><span>GST</span><b class="num">{money(m.purchase_totals.gst, true)}</b></div>
            </div>
            <div class="row" style="margin-top:10px"><span class="grow" style="font-weight:800">{t('total')}</span><b class="num">{money(m.purchase_totals.total, true)}</b></div>
            {m.purchase_totals.flagged > 0 && <div class="faint" style="font-size:12.5px;font-weight:700;margin-top:8px">{t('ca_flagged', m.purchase_totals.flagged)}</div>}
          </div>
          <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:12px">{t('ca_s')}</div>
        </>}

        <div class="sec"><h3>{t('ca_pending')}</h3>{pend && <span class={`chip ${pend.count ? 'tone-warn' : 'tone-ok'}`}>{pend.count}</span>}</div>
        <div class="card">
          {!pend ? <div class="pad"><Skeleton h={40} /></div> : pend.slips.length === 0 ? <div class="li muted">{t('ca_pending_none')}</div>
            : pend.slips.slice(0, allPend ? 60 : 5).map((s) => (
              <button class="li" onClick={() => go(`/slip/${s.id}`)}><div class="iconbox tone-warn"><Icon name="FileClock" size={18} /></div>
                <div class="grow"><div class="t">#{s.slip_no} · {s.customer}</div><div class="s">{fmtDay(String(s.done_at).slice(0, 10), false)}{s.pos?.sure === false || !s.pos ? ` · ${t('pos_check')}` : ''}</div></div>
                <b class="num">{money(s.total, false)}</b><Icon name="ChevronRight" size={16} /></button>))}
          {pend && !allPend && pend.slips.length > 5 && <button class="li" onClick={() => setAllPend(true)}><span class="grow link" style="min-height:0">{t('ca_pending_all', pend.count)}</span><Icon name="ChevronDown" size={16} /></button>}
          {pend && allPend && pend.count > 60 && <div class="li faint" style="font-size:12.5px">{t('ca_pending_more', pend.count - 60)}</div>}
        </div>

      </div>
      {m && <div class="quotebar"><button class="btn btn-accent btn-block" onClick={download}><Icon name="Download" size={19} />{t('ca_download', monthName(month))}</button></div>}
    </>
  );
}
