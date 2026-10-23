// Suppliers (mills) with their GST number status (23 Oct 2026). Fake GST bills are a known trap in steel:
// GST on a bill from a cancelled or suspended GST number does not come back to you. Cancelled / suspended
// ones are listed first. A GST data service checks them again every 30 days by itself when its key is added;
// otherwise check on the free GST portal and note what it said.
// Address: #/suppliers
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { money, shortDate } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go } from '../../lib/router.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { GstBadge, GstCheckPanel, GST_TONE, setGstService } from '../../ui/stock/GstStatus.jsx';
import './stock.css';

export function Suppliers() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState('');
  const load = () => call('suppliers', {}).then((x) => { setGstService(x.service); setD(x); setErr(null); if (open) setOpen(x.suppliers.find((s) => s.id === open.id) || null); })
    .catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!can('stock')) { go('/'); return; } load(); }, []);
  const list = (d?.suppliers || []).filter((s) => !q.trim() || `${s.name} ${s.gstin || ''} ${s.city || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const bad = (d?.suppliers || []).filter((s) => s.gst_status && s.gst_status !== 'active');
  const unchecked = (d?.suppliers || []).filter((s) => s.gstin && !s.gst_status);
  return (
    <>
      <TopBar title={t('nav_suppliers')} sub={t('sup_title_s')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        {err && <div class="error">{err}</div>}
        {!d ? <><Skeleton h={90} /><Skeleton h={240} style="margin-top:12px" /></> : <>
          <div class={`notice ${bad.length ? 'tone-bad' : 'tone-ok'} row`} style="gap:10px;align-items:flex-start">
            <Icon name={bad.length ? 'ShieldAlert' : 'ShieldCheck'} size={20} />
            <span class="grow">{bad.length ? t('sup_bad_n', bad.length) : t('sup_all_ok')}
              <span style="display:block;font-weight:500;font-size:12.5px;margin-top:2px">{d.service ? t('sup_service_on') : t('gst_service_off')}</span></span>
          </div>
          {unchecked.length > 0 && <div class="notice tone-warn" style="margin-top:8px;font-size:13.5px">{t('sup_unchecked_n', unchecked.length)}</div>}
          {(d.suppliers || []).length > 6 && <div class="field" style="margin-top:12px"><Icon name="Search" size={18} /><input value={q} placeholder={t('sup_search')} onInput={(e) => setQ(e.currentTarget.value)} /></div>}
          {!list.length ? <div class="card pad" style="margin-top:12px"><div class="muted">{t('sup_none')}</div></div> : (
            <div class="card" style="margin-top:12px">{list.map((s) => (
              <button class="li" onClick={() => setOpen(s)}>
                <div class={`iconbox tone-${s.gst_status ? GST_TONE[s.gst_status] : 'neutral'}`}><Icon name={!s.gst_status ? 'Truck' : s.gst_status === 'active' ? 'ShieldCheck' : 'ShieldX'} size={18} /></div>
                <div class="grow" style="min-width:0">
                  <div class="t ellip">{s.name}</div>
                  <div class="s ellip num">{[s.gstin || t('sup_no_gstin'), s.city].filter(Boolean).join(' · ')}</div>
                  <div class="s">{s.gst_checked_at ? t('gst_checked_on', shortDate(s.gst_checked_at), t(s.gst_source === 'service' ? 'gst_by_service' : 'gst_by_portal')) : ''}</div>
                </div>
                {s.gstin ? <GstBadge status={s.gst_status} small /> : null}
              </button>
            ))}</div>
          )}
        </>}
      </div>
      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.name || ''}>
        {open && <>
          <div class="row" style="gap:8px;flex-wrap:wrap">{open.gstin && <GstBadge status={open.gst_status} />}<span class="num muted" style="font-weight:700">{open.gstin || t('sup_no_gstin')}</span></div>
          {open.gst_status && open.gst_status !== 'active' && <div class="notice tone-bad" style="margin-top:12px;font-size:13.5px">
            {open.gst_cancel_date ? `${t('gst_since', fmtDay(open.gst_cancel_date))}. ` : ''}{t('gst_bad_s')}</div>}
          <div style="margin-top:12px">
            {(open.gst_legal_name || open.gst_trade_name) && <Line a={t('gst_legal_name')} b={[open.gst_legal_name, open.gst_trade_name].filter(Boolean).join(' / ')} />}
            {open.gst_reg_date && <Line a={t('gst_reg_date')} b={fmtDay(open.gst_reg_date)} />}
            {open.gst_checked_at && <Line a={t('gst_last_check')} b={`${shortDate(open.gst_checked_at)} · ${t(open.gst_source === 'service' ? 'gst_by_service' : 'gst_by_portal')}`} />}
            <Line a={t('sup_bills_6m')} b={String(open.bills_6m || 0)} />
            {Number(open.gst_6m) > 0 && <Line a={t('sup_gst_6m')} b={money(Number(open.gst_6m), false)} />}
            {Number(open.to_pay) > 0 && <Line a={t('sup_to_pay')} b={money(Number(open.to_pay), false)} />}
            {open.last_bill && <Line a={t('sup_last_bill')} b={fmtDay(open.last_bill)} />}
          </div>
          {open.gstin ? <GstCheckPanel gstin={open.gstin} onDone={() => load()} /> : <div class="faint" style="font-size:13px;margin-top:10px">{t('sup_no_gstin_s')}</div>}
        </>}
      </Sheet>
    </>
  );
}

const Line = ({ a, b }) => <div class="row" style="justify-content:space-between;padding:9px 0;border-top:1px solid var(--line);gap:12px"><span class="muted">{a}</span><span style="font-weight:600;text-align:right">{b}</span></div>;
