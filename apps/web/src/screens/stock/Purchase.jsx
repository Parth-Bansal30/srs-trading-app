// One purchase bill: supplier, lines (each into its stock item), totals, the bill file, paid / to pay,
// and cancelling a bill entered by mistake (only while all its stock is still there). Address: #/purchase/:id
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money, shortDate, time } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { fmtDay } from '../../lib/docs.js';
import { forgetStock, shapeWord, kgTxt } from '../../lib/stock.js';
import { shopToday } from '../../lib/expenses.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import './stock.css';

export function Purchase({ id }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [cancel, setCancel] = useState(false);
  const [why, setWhy] = useState('');
  const paid = useAction('purchasePaid');
  const cx = useAction('purchaseCancel');
  const tz = company.value?.timezone;
  const load = () => call('purchase', { id }).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [id]);
  if (err) return <><TopBar title={t('nav_purchases')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!d) return <><TopBar title={t('nav_purchases')} /><div class="page"><Skeleton h={120} /><Skeleton h={200} style="margin-top:12px" /></div></>;
  const p = d.purchase;
  const opening = p.kind === 'opening';
  const R = ({ a, b, top, strong }) => <div class="row" style={`justify-content:space-between;padding:8px 0;${top ? 'border-top:1.5px solid var(--ink);' : ''}${strong ? 'font-weight:800;font-size:16px' : ''}`}><span class={strong ? '' : 'muted'}>{a}</span><span class="num" style="font-weight:700">{b}</span></div>;
  return (
    <>
      <TopBar title={opening ? t('pu_opening') : d.supplier?.name} sub={`${fmtDay(p.bill_date, false)}${p.bill_no ? ` · ${t('pu_bill_no')} ${p.bill_no}` : ''}`}
        right={p.status === 'cancelled' ? <Chip tone="neutral">{t('pu_cancelled')}</Chip> : !opening && <Chip tone={p.bill_type === 'pakka' ? 'pakka' : 'kacha'}>{t(p.bill_type === 'pakka' ? 'bill_gst_short' : 'bill_none_short')}</Chip>} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        {p.status === 'cancelled' && <div class="notice tone-bad" style="margin-bottom:12px">{t('pu_cancelled')}: {p.cancel_reason}</div>}
        {!opening && (
          <div class="card pad row" style="gap:12px">
            <div class="grow">
              {d.supplier?.gstin && <div class="faint num" style="font-size:13px;font-weight:600">GSTIN {d.supplier.gstin}</div>}
              <div class="muted" style="font-size:13px">{t('pu_by', d.by || '')} · {shortDate(p.created_at, tz)} {time(p.created_at, tz)}</div>
            </div>
            {p.status === 'saved' && <Chip tone={p.settled === 'outside' ? 'neutral' : p.pay_status === 'paid' ? 'ok' : Number(d.left) < Number(p.total_amount) - 0.5 ? 'accent' : 'warn'}>
              {p.settled === 'outside' ? t('pu_paid_outside') : p.pay_status === 'paid' ? t('pu_paid') : Number(d.left) < Number(p.total_amount) - 0.5 ? t('sk_part', money(Number(p.total_amount), false)) : t('pu_to_pay')}</Chip>}
          </div>
        )}
        {!opening && p.status === 'saved' && (
          <div class="card pad" style="margin-top:10px">
            {p.pay_status !== 'paid' && <div class="row" style="justify-content:space-between;align-items:baseline">
              <span class="muted">{t('sk_still_to_pay')}</span><b class="num" style="font-size:22px;color:var(--bad)">{money(Number(d.left), false)}</b></div>}
            {d.due_date && p.pay_status !== 'paid' && <div class="faint" style="font-size:13px;font-weight:600;margin-top:2px">{d.due_date < shopToday() ? <b style="color:var(--bad)">{t('sk_overdue_since', fmtDay(d.due_date))}</b> : t('sk_due_on', fmtDay(d.due_date))}</div>}
            {(d.paid_by || []).map((x) => <div class="row" style="justify-content:space-between;font-size:13.5px;margin-top:6px"><span class="muted">{t('sk_paid_on', fmtDay(x.day, false))} · {x.account}{x.method ? ` · ${x.method === 'Cheque' ? t('pm_cheque') : x.method}` : ''}</span><b class="num">{money(Number(x.amount), false)}</b></div>)}
            {(d.notes || []).map((x) => <div class="row" style="justify-content:space-between;font-size:13.5px;margin-top:6px"><span class="muted">{t(`sk_k_${x.kind}`)}{x.note_no ? ` · ${x.note_no}` : ''} · {fmtDay(x.date, false)}</span><b class="num">− {money(Number(x.amount), false)}</b></div>)}
            {p.settled === 'outside' && <div class="muted" style="font-size:13.5px">{t('pu_paid_outside_s')}</div>}
            <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
              {p.pay_status !== 'paid' && d.supplier && <button class="btn btn-brand grow" onClick={() => go(`/supplier/${d.supplier.id}`)}><Icon name="IndianRupee" size={17} />{t('sk_record_payment')}</button>}
              {p.pay_status !== 'paid' && Number(d.left) >= Number(p.total_amount) - 0.5 && <button class="btn btn-ghost" disabled={paid.busy} onClick={() => paid.run({ id: p.id, paid: true }).then(() => load()).catch(() => {})}>{t('pu_mark_outside')}</button>}
              {p.settled === 'outside' && <button class="btn btn-ghost" disabled={paid.busy} onClick={() => paid.run({ id: p.id, paid: false }).then(() => load()).catch(() => {})}><Icon name="Undo2" size={16} />{t('pu_unmark_outside')}</button>}
            </div>
            {paid.error && <div class="error">{paid.error.message}</div>}
          </div>
        )}
        {d.file_url && <a class="btn btn-ghost btn-block" style="margin-top:10px" href={d.file_url} target="_blank" rel="noopener"><Icon name="FileText" size={18} />{t('pu_open_file')}</a>}

        <div class="sec"><h3>{t('pu_lines')}</h3><span class="faint num" style="font-size:13px;font-weight:600">{kgTxt(p.total_kg)}</span></div>
        <div class="card">
          {d.lines.map((l) => (
            <button class="li" onClick={() => go(`/stock/${l.stock_item_id}`)}>
              <div class="grow">
                <div class="t">{l.description}</div>
                <div class="s num">{l.hsn ? `HSN ${l.hsn} · ` : ''}{kgTxt(l.kg)} · {money(l.rate)}/kg</div>
                <div class="s"><Icon name="Boxes" size={13} /> {l.code} · {shapeWord(l.shape)}{l.label ? ` · ${l.label}` : ''} · {t('st_on_hand')} {kgTxt(l.on_hand)}</div>
              </div>
              <b class="num">{money(l.amount, true)}</b>
            </button>
          ))}
        </div>
        <div class="card" style="margin-top:10px;padding:4px 16px">
          <R a={t('pu_lines')} b={money(p.items_amount, true)} />
          {Number(p.freight) > 0 && <R a={t('pu_freight')} b={money(p.freight, true)} />}
          {Number(p.other_charges) > 0 && <R a={t('pu_other')} b={money(p.other_charges, true)} />}
          {Number(p.gst_amount) > 0 && <R a={t('pu_gst')} b={money(p.gst_amount, true)} />}
          {Number(p.round_off) !== 0 && <R a={t('pu_round')} b={money(p.round_off, true)} />}
          <R a={t('pu_total')} b={money(p.total_amount, true)} top strong />
        </div>
        {p.note && <div class="card pad muted" style="margin-top:10px;font-size:14px">{p.note}</div>}
        {p.status === 'saved' && (
          <button class="link" style="margin-top:14px;color:var(--bad)" onClick={() => { setWhy(''); setCancel(true); }}><Icon name="Undo2" size={16} />{t('pu_cancel')}</button>
        )}
      </div>
      <Sheet open={cancel} onClose={() => setCancel(false)} title={t('pu_cancel')}
        footer={d.can_cancel && <button class="btn btn-block" style="background:var(--bad);color:#fff" disabled={cx.busy || !why.trim()}
          onClick={() => cx.run({ id: p.id, reason: why }).then(() => { setCancel(false); forgetStock(); toast(t('pu_cancelled')); load(); }).catch(() => {})}>{t('pu_cancel')}</button>}>
        {d.can_cancel ? <>
          <div class="muted" style="font-size:14.5px;line-height:1.45;margin-bottom:12px">{t('pu_cancel_s')}</div>
          <input class="textarea" value={why} onInput={(e) => setWhy(e.currentTarget.value)} placeholder={t('pu_cancel_ph')} autofocus />
          {cx.error && <div class="error" style="margin-top:10px">{cx.error.message}</div>}
        </> : <div class="notice tone-warn">{t('pu_cancel_no')}</div>}
      </Sheet>
    </>
  );
}
