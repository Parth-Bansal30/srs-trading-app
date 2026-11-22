// The Tally bill of one GST slip (22 Nov 2026): its no., date and total, typed from the CA's bill so the app and Tally
// always match — a different total shows at once. Used by the GST bills list (with "Save & next") and the slip page.
// Also what the CA did in Tally after a GST slip was deleted (bill cancelled, or a credit note).
import { useEffect, useState } from 'preact/hooks';
import { nextBillNo } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { useAction } from '../../lib/action.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go } from '../../lib/router.js';
import { toast } from '../toast.js';
import { Sheet } from '../Sheet.jsx';
import { Icon } from '../kit.jsx';
import './gst.css';

/**
 * bill: { id, slip_no, date, customer, gstin, total, gst, tally_no, tally_date, tally_total }
 * suggest: the next Tally no. to offer (for a bill without one) · onNext: shown as "Save & next" when given
 * onDone(saved: { tally_no }) after saving.
 */
export function TallySheet({ open, bill, suggest, onClose, onDone, onNext }) {
  const [no, setNo] = useState('');
  const [day, setDay] = useState('');
  const [tot, setTot] = useState('');
  const [twice, setTwice] = useState(false);
  const [moving, setMoving] = useState(false);   // saved, the next bill is on its way: nothing more to tap here
  const a = useAction('slipTally');
  useEffect(() => {
    if (!open || !bill) return;
    setMoving(false);
    setNo(bill.tally_no || ''); setDay(bill.tally_date || bill.date || '');
    setTot(bill.tally_total != null ? String(bill.tally_total) : ''); setTwice(false); a.setError(null);
  }, [open, bill?.id]);
  if (!bill) return null;
  const locked = !!bill.tally_no && !can('settings');   // the no. itself; the date and total can still be filled in
  const total = Number(bill.total);
  const typed = tot.trim() === '' ? null : Number(tot);
  const differs = typed != null && Number.isFinite(typed) && Math.abs(typed - total) > 1;
  const sug = !bill.tally_no && !moving && suggest && suggest !== no.trim() ? suggest : null;
  const save = (force, next) => a.run({ order_id: bill.id, tally_no: no.trim() || null, tally_date: day || null, tally_total: typed, force })
    .then(() => {
      toast(no.trim() ? t('gc_tally_saved', no.trim()) : t('gc_tally_off'));
      const saved = { tally_no: no.trim() || null, next: no.trim() ? nextBillNo(no.trim()) : null };
      if (next && onNext) { setMoving(true); onNext(saved); } else onDone?.(saved);
    })
    .catch((e) => { if (e.code === 'duplicate' || e.status === 409) setTwice(true); });
  const footer = (
    <div class="row" style="gap:8px">
      <button class={`btn btn-block ${onNext ? 'btn-ghost' : 'btn-brand'}`} style={onNext ? 'flex:1' : ''} disabled={a.busy || moving || (!no.trim() && !bill.tally_no)} onClick={() => save(twice, false)}>
        <Icon name="Check" size={18} />{twice ? t('gc_tally_anyway') : no.trim() ? t('save') : t('gc_tally_remove')}</button>
      {onNext && no.trim() && <button class="btn btn-brand btn-block" style="flex:1.4" disabled={a.busy || moving} onClick={() => save(twice, true)}>
        <Icon name="SkipForward" size={18} />{t('ts_next')}</button>}
    </div>);
  return (
    <Sheet open={open} onClose={onClose} title={`${t('ts_title')} · #${bill.slip_no}`} footer={footer}>
      <div class="ts-slip">
        <div class="grow"><b>{bill.customer}</b><div class="faint">{bill.gstin || t('gbl_b2cs')} · {fmtDay(bill.date, false)}</div></div>
        <b class="num">{money(total, true)}</b>
      </div>
      {locked && <div class="notice tone-warn" style="margin-top:10px;font-size:13px">{t('ts_owner')}</div>}
      <div class="lbl" style="margin-top:14px">{t('gc_tally_no')}</div>
      <div class="field"><input value={no} disabled={locked} onInput={(e) => { setNo(e.currentTarget.value); setTwice(false); }} placeholder={suggest || 'SRS/26-27/0142'} maxLength={40} autofocus /></div>
      {sug && !locked && <button class="chip ts-sug" onClick={() => { setNo(sug); setTwice(false); }}><Icon name="Sparkles" size={13} />{t('ts_use', sug)}</button>}
      <div class="lbl" style="margin-top:12px">{t('gc_tally_date')}</div>
      <div class="field"><input type="date" value={day} onInput={(e) => setDay(e.currentTarget.value)} /></div>
      {day && bill.date && day.slice(0, 7) !== String(bill.date).slice(0, 7) && <div class="gst-flag" style="margin-top:6px">{t('rf_tally_month')}</div>}
      <div class="faint" style="font-size:12px;font-weight:600;margin-top:4px">{t('ts_date_s')}</div>
      <div class="lbl" style="margin-top:12px">{t('ts_total')}</div>
      <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={tot} onInput={(e) => setTot(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder={String(total)} /></div>
      {<button class="chip ts-sug" onClick={() => setTot(String(total))}><Icon name="Equal" size={13} />{t('ts_same', money(total, true))}</button>}
      {differs && <div class="notice tone-bad" style="margin-top:10px;font-size:13.5px">{t('ts_differs', money(typed, true), money(total, true))}</div>}
      {a.error && <div class={twice ? 'notice tone-warn' : 'error'} style="margin-top:10px">{a.error.message}</div>}
      <button class="link" style="margin-top:10px" onClick={() => go(`/slip/${bill.id}`)}><Icon name="ExternalLink" size={14} />{t('ts_open_slip')}</button>
    </Sheet>
  );
}

/** A GST slip deleted after its Tally bill: note what the CA did (bill cancelled, or a credit note with its no.). */
export function TallyCancelSheet({ open, bill, onClose, onDone }) {
  const [how, setHow] = useState(null);
  const [no, setNo] = useState('');
  const [day, setDay] = useState('');
  const a = useAction('tallyCancel');
  useEffect(() => {
    if (!open || !bill) return;
    setHow(bill.cancel_how || (bill.need === 'cancel_bill' ? 'bill_cancelled' : 'credit_note')); setNo(bill.cn_no || ''); setDay(bill.cn_date || ''); a.setError(null);
  }, [open, bill?.id]);
  if (!bill) return null;
  const ok = how === 'bill_cancelled' || (how === 'credit_note' && no.trim());
  return (
    <Sheet open={open} onClose={onClose} title={t('tc_title', bill.slip_no)}
      footer={<button class="btn btn-brand btn-block" disabled={!ok || a.busy} onClick={() => a.run({ order_id: bill.id, how, cn_no: how === 'credit_note' ? no.trim() : null, cn_date: day || null })
        .then(() => { toast(t('gc_saved')); onDone?.(); }).catch(() => {})}><Icon name="Check" size={18} />{t('save')}</button>}>
      <div class="ts-slip">
        <div class="grow"><b>{bill.customer}</b><div class="faint">{t('gbl_deleted_on', fmtDay(bill.deleted_on, false))}{bill.delete_reason ? ` · ${bill.delete_reason}` : ''}</div></div>
        <b class="num">{money(Number(bill.total), true)}</b>
      </div>
      <div class="notice tone-warn" style="margin-top:10px;font-size:13.5px">{bill.need === 'cancel_bill' ? t('tc_same', bill.tally_no) : t('tc_later', bill.tally_no)}</div>
      <div class="lbl" style="margin-top:14px">{t('gbl_what_ca_did')}</div>
      <div class="del-radios">
        {[['bill_cancelled', 'tc_cancelled'], ['credit_note', 'tc_cn']].map(([id, w]) => (
          <button class={how === id ? 'on' : ''} onClick={() => setHow(id)}><span class="dot" /><span><b>{t(w)}</b></span></button>))}
      </div>
      {how === 'credit_note' && <>
        <div class="lbl" style="margin-top:12px">{t('tc_cn_no')}</div>
        <div class="field"><input value={no} onInput={(e) => setNo(e.currentTarget.value)} placeholder="CN/26-27/004" maxLength={40} /></div>
        <div class="lbl" style="margin-top:12px">{t('tc_cn_date')}</div>
        <div class="field"><input type="date" value={day} onInput={(e) => setDay(e.currentTarget.value)} /></div>
      </>}
      {a.error && <div class="error" style="margin-top:10px">{a.error.message}</div>}
    </Sheet>
  );
}
