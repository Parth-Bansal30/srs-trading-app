// A finished GST slip's details for the CA (6 Nov 2026, plan v2 F10): where the steel went (place of supply and the
// split, or "CA to check"), the HSN saved with it, and the Tally bill no. the CA made for it. The slip itself never
// changes; these details sit next to it.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { fmtDay } from '../../lib/docs.js';
import { toast } from '../toast.js';
import { Sheet } from '../Sheet.jsx';
import { Icon } from '../kit.jsx';
import { GstWhere, PosLine } from './GstWhere.jsx';
import './gst.css';

const flagsOf = (g) => {
  const f = [];
  for (const x of g?.items || []) {
    if (!x.hsn) f.push('hsn_missing'); else if (!x.hsn_checked) f.push('hsn_unchecked');
  }
  return [...new Set(f)];
};

export function GstCard({ o, onChange }) {
  const [g, setG] = useState(undefined);
  const [sheet, setSheet] = useState(null);
  const load = () => call('slipGstGet', { order_id: o.id }).then((x) => setG(x || null)).catch(() => setG(null));
  useEffect(() => { load(); }, [o.id]);
  if (g === undefined) return null;
  const gst = Number(o.gst_amount); const pct = Number(o.gst_pct);
  const locked = !!g?.tally_no && !can('settings');
  return (
    <div class="card pad gst-card" style="margin-bottom:12px">
      <div class="row"><Icon name="FileSpreadsheet" size={18} /><b class="grow">{t('gc_title')}</b>
        {!locked && <button class="link" style="min-height:0" onClick={() => setSheet('where')}>{g?.pos?.to || g?.delivery ? t('gc_change') : t('gc_set')}</button>}</div>
      {g ? <PosLine shop={g.shop_state || g.pos?.from} delivery={g.delivery} dest={g.dest_state} gst={gst} pct={pct} />
        : <div class="pos-line check"><Icon name="CircleHelp" size={16} /><span class="grow">{t('gc_none')}</span></div>}
      {flagsOf(g).map((f) => <span class="gst-flag">{t(`rf_${f}`)}</span>)}
      <div class="row" style="margin-top:12px;align-items:center">
        <span class="grow"><span class="k">{t('gc_tally')}</span><br />
          {g?.tally_no ? <b class="num">{g.tally_no}</b> : <span class="muted" style="font-weight:700">{t('gc_tally_none')}</span>}
          {g?.tally_no && <span class="faint" style="font-size:12px;font-weight:600"> · {fmtDay(g.tally_date, false)}{g.tally_by ? ` · ${g.tally_by}` : ''}</span>}</span>
        {can('khata') && (!g?.tally_no || can('settings')) && <button class="btn btn-ghost" style="min-height:42px" onClick={() => setSheet('tally')}><Icon name="Pencil" size={15} />{g?.tally_no ? t('gc_tally_change') : t('gc_tally_add')}</button>}
      </div>
      <div class="faint" style="font-size:12px;font-weight:600;margin-top:8px">{t('gc_s')}</div>
      <WhereSheet open={sheet === 'where'} o={o} g={g} onClose={() => setSheet(null)} onDone={() => { setSheet(null); load(); onChange?.(); }} />
      <TallySheet open={sheet === 'tally'} o={o} g={g} onClose={() => setSheet(null)} onDone={() => { setSheet(null); load(); onChange?.(); }} />
    </div>
  );
}

function WhereSheet({ open, o, g, onClose, onDone }) {
  const [ctx, setCtx] = useState(null);
  const [v, setV] = useState({});
  const a = useAction('slipGst');
  useEffect(() => {
    if (!open) return;
    a.setError(null);
    setV({ delivery: g?.delivery && g.delivery !== 'direct' ? g.delivery : 'pickup', dest: g?.dest_state || undefined });
    call('gstContext', { customer_id: o.customer_id }).then((c) => { setCtx(c); if (!g?.dest_state && c?.customer?.dest_state) setV((x) => ({ ...x, dest: c.customer.dest_state })); }).catch(() => setCtx({}));
  }, [open]);
  const direct = !!o.direct_purchase_id;
  return (
    <Sheet open={open} onClose={onClose} title={t('gc_title')}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy} onClick={() => a.run({ order_id: o.id, delivery: direct ? 'direct' : v.delivery, dest: v.dest || null })
        .then(() => { toast(t('gc_saved')); onDone(); }).catch(() => {})}><Icon name="Check" size={18} />{t('save')}</button>}>
      {ctx && <GstWhere ctx={ctx} value={v} onChange={setV} direct={direct} gst={Number(o.gst_amount)} pct={Number(o.gst_pct)} />}
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

function TallySheet({ open, o, g, onClose, onDone }) {
  const [no, setNo] = useState('');
  const [day, setDay] = useState('');
  const [twice, setTwice] = useState(false);
  const a = useAction('slipTally');
  useEffect(() => { if (open) { setNo(g?.tally_no || ''); setDay(g?.tally_date || ''); setTwice(false); a.setError(null); } }, [open]);
  const save = (force) => a.run({ order_id: o.id, tally_no: no.trim() || null, tally_date: day || null, force })
    .then(() => { toast(no.trim() ? t('gc_tally_saved', no.trim()) : t('gc_tally_off')); onDone(); })
    .catch((e) => { if (e.code === 'duplicate' || e.status === 409) setTwice(true); });
  return (
    <Sheet open={open} onClose={onClose} title={t('gc_tally')}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy || (!no.trim() && !g?.tally_no)} onClick={() => save(twice)}>
        <Icon name="Check" size={18} />{twice ? t('gc_tally_anyway') : no.trim() ? t('save') : t('gc_tally_remove')}</button>}>
      <div class="lbl">{t('gc_tally_no')}</div>
      <div class="field"><input value={no} onInput={(e) => { setNo(e.currentTarget.value); setTwice(false); }} placeholder="SRS/26-27/0142" maxLength={40} autofocus /></div>
      <div class="lbl" style="margin-top:12px">{t('gc_tally_date')}</div>
      <div class="field"><input type="date" value={day} onInput={(e) => setDay(e.currentTarget.value)} /></div>
      <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:8px">{t('gc_tally_s')}</div>
      {a.error && <div class={twice ? 'notice tone-warn' : 'error'} style="margin-top:10px">{a.error.message}</div>}
    </Sheet>
  );
}
