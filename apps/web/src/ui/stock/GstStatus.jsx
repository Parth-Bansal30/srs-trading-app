// Is the supplier's GST number real and active? (23 Oct 2026) — shared by the purchase bill screen and
// the Suppliers screen. A GST data service checks it by itself when the owner has added its key; without
// it, the person checks on the free GST portal and notes what it said. Warn only — the person decides.
import { useState } from 'preact/hooks';
import { GST_PORTAL_SEARCH } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { online } from '../../lib/net.js';
import { fmtDay } from '../../lib/docs.js';
import { shortDate } from '../../lib/format.js';
import { toast } from '../toast.js';
import { Icon } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';

export const GST_TONE = { active: 'ok', cancelled: 'bad', suspended: 'bad', inactive: 'bad', not_found: 'bad' };
/** Is the GST data service switched on? (learnt from the server; null = not known yet) */
let service = null;
export const setGstService = (on) => { service = on == null ? service : !!on; };

/** "Active" / "Cancelled" / … chip; null status = "Not checked". */
export function GstBadge({ status, small = false }) {
  const s = status || null;
  return (
    <span class={`chip tone-${s ? GST_TONE[s] : 'neutral'}`} style={small ? 'height:20px;font-size:11px' : ''}>
      <Icon name={!s ? 'CircleDashed' : s === 'active' ? 'ShieldCheck' : 'ShieldX'} size={small ? 12 : 13} stroke={2.4} />
      {t(s ? `gst_st_${s}` : 'gst_unchecked')}
    </span>
  );
}

/** A check from the api (snake_case) → what supplierGstWarnings wants. */
export const gstFromCheck = (c) => (c ? { status: c.status, checkedAt: c.checked_at, cancelDate: c.cancel_date || null, legalName: c.legal_name || null,
  tradeName: c.trade_name || null, source: c.source || null } : null);
/** A supplier row (api_suppliers / purchase context) → the same. */
export const gstFromSupplier = (s) => (s?.gst_status ? { status: s.gst_status, checkedAt: s.gst_checked_at, cancelDate: s.gst_cancel_date || null,
  legalName: s.gst_legal_name || null, tradeName: s.gst_trade_name || null, source: s.gst_source || null } : null);

/** Title + text for a GST warning (from @srs/core supplierGstWarnings). */
export function gstWords(w) {
  if (w.type === 'gst_unchecked') return [t('gst_unchecked_t'), t('gst_unchecked_s')];
  if (w.type === 'gst_old') return [t('gst_old_t', shortDate(w.checkedAt)), t('gst_old_s')];
  if (w.type === 'gst_name') return [t('gst_name_t'), t('gst_name_s', [w.legalName, w.tradeName].filter(Boolean).join(' / '))];
  const st = w.type.replace('gst_', '');
  return [t('gst_bad_t', t(`gst_st_${st}`)) + (w.cancelDate ? ` · ${t('gst_since', fmtDay(w.cancelDate))}` : ''),
    `${w.afterCancel ? `${t('gst_after_cancel')} ` : ''}${t('gst_bad_s')}`];
}

/**
 * The "check this GST number" panel: Check now (service) / check on the GST portal and note what it said.
 * onDone(check) with the saved check (api shape).
 */
export function GstCheckPanel({ gstin, onDone, compact = false }) {
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState(false);
  const [svc, setSvc] = useState(service);   // null = not asked yet; false = service off
  const now = async (refresh) => {
    setBusy(true);
    try {
      const r = await call('gstCheck', { gstin, refresh: refresh || undefined });
      setSvc(r.service); setGstService(r.service);
      if (r.check) onDone?.(r.check);
      else if (r.service) toast(t('gst_failed'));
      else setMark(true);
    } catch (e) { toast(e.message || t('err_generic')); } finally { setBusy(false); }
  };
  const copyOpen = () => {
    try { navigator.clipboard?.writeText(gstin); } catch { /* fine */ }
    window.open(GST_PORTAL_SEARCH, '_blank', 'noopener');
    setMark(true);
  };
  return (
    <>
      <div class={`row ${compact ? '' : 'gst-panel'}`} style="gap:8px;flex-wrap:wrap;margin-top:8px">
        {svc !== false && <button class="pill" disabled={busy || !online.value} onClick={() => now(true)}><Icon name={busy ? 'LoaderCircle' : 'ShieldCheck'} size={15} class={busy ? 'spin' : ''} />{t('gst_check_now')}</button>}
        <button class="pill" onClick={copyOpen}><Icon name="ExternalLink" size={15} />{t('gst_check_portal')}</button>
        <button class="pill" onClick={() => setMark(true)}><Icon name="ClipboardCheck" size={15} />{t('gst_portal_said')}</button>
      </div>
      {svc === false && <div class="faint" style="font-size:12.5px;margin-top:6px;line-height:1.45">{t('gst_service_off')}</div>}
      <GstMarkSheet open={mark} gstin={gstin} onClose={() => setMark(false)} onDone={(c) => { setMark(false); onDone?.(c); }} />
    </>
  );
}

/** "What did the GST portal show?" — Active / Cancelled / Suspended / Not found (+ since when, the name there). */
export function GstMarkSheet({ open, gstin, onClose, onDone }) {
  const [status, setStatus] = useState(null);
  const [since, setSince] = useState('');
  const [name, setName] = useState('');
  const save = useAction('gstMark');
  const submit = () => save.run({ gstin, status, cancel_date: status !== 'active' && since ? since : undefined, legal_name: name.trim() || undefined })
    .then((c) => { toast(t('gst_saved')); setStatus(null); setSince(''); setName(''); onDone?.(c); }).catch(() => {});
  return (
    <Sheet open={open} onClose={onClose} title={t('gst_portal_said')}
      footer={<>
        {save.error && <div class="error" style="margin:0 0 8px">{save.error.message}</div>}
        <button class="btn btn-accent btn-block" disabled={!status || save.busy || !online.value} onClick={submit}><Icon name="Check" size={20} stroke={2.6} />{save.busy ? '…' : t('gst_mark_save')}</button>
      </>}>
      <div class="muted" style="font-size:14px;line-height:1.5">{t('gst_portal_how', gstin)}</div>
      <a class="link" href={GST_PORTAL_SEARCH} target="_blank" rel="noopener"><Icon name="ExternalLink" size={15} />services.gst.gov.in</a>
      <div class="lbl" style="margin-top:12px">{t('gst_it_says')}</div>
      <div class="pick">{['active', 'cancelled', 'suspended', 'not_found'].map((s) => (
        <button class={status === s ? 'on' : ''} onClick={() => setStatus(s)}><Icon name={s === 'active' ? 'ShieldCheck' : 'ShieldX'} size={16} style={`color:var(--${GST_TONE[s]})`} />{t(`gst_st_${s}`)}</button>
      ))}</div>
      {status && status !== 'active' && status !== 'not_found' && <>
        <div class="lbl" style="margin-top:12px">{t('gst_cancel_date')}</div>
        <div class="field"><Icon name="Calendar" size={18} /><input type="date" value={since} onInput={(e) => setSince(e.currentTarget.value)} /></div>
      </>}
      {status && status !== 'not_found' && <>
        <div class="lbl" style="margin-top:12px">{t('gst_legal_name')} <span class="faint" style="text-transform:none;letter-spacing:0">({t('acc_optional')})</span></div>
        <div class="field"><input value={name} maxLength={200} onInput={(e) => setName(e.currentTarget.value)} /></div>
      </>}
    </Sheet>
  );
}

/** The warnings box under the supplier on a bill: bad (red) / warn / info, with what to do. */
export function GstNote({ w, gstin, onChecked, onOk }) {
  const [a, b] = gstWords(w);
  const level = w.level === 'info' ? 'warn' : w.level;
  return (
    <div class={`chk chk-${level}`} role="alert" style={w.level === 'info' ? 'background:var(--sunk);border-color:var(--line)' : ''}>
      <Icon name={w.level === 'bad' ? 'ShieldX' : w.level === 'warn' ? 'TriangleAlert' : 'ShieldQuestion'} size={17} stroke={2.4} />
      <div class="grow">
        <div class="chk-t">{a}</div>
        {b && <div class="chk-s">{b}</div>}
        {w.type !== 'gst_name' && <GstCheckPanel gstin={gstin} onDone={onChecked} compact />}
        {w.level !== 'info' && onOk && <div class="chk-a"><button onClick={onOk}>{t('chk_correct')}</button></div>}
      </div>
    </div>
  );
}
