// Pickup: GST bill or No bill (both amounts shown), advance taken off, how it's paid → finish → send slip.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { finishCalc, finishProblem } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { loadOrder } from '../../lib/orders.js';
import { loadCatalog } from '../../lib/catalog.js';
import { useAction } from '../../lib/action.js';
import { money, kg, shortDate } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { PAY_METHODS } from '../../config/options.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import './pickup.css';

const coreItem = (i) => ({ shape: i.shape, unit: i.unit, d: i.dims, rows: i.order_item_lengths.map((l) => ({ len: l.len ?? '', pcs: l.pcs, cuts: l.cuts ?? '' })),
  rate: Number(i.sell_rate), cutRate: Number(i.cut_rate), density: Number(i.density), aw: i.actual_weight == null ? null : Number(i.actual_weight) });

export function Pickup({ id }) {
  const [o, setO] = useState(undefined);
  const [cat, setCat] = useState(null);
  const [bill, setBill] = useState(null);
  const [mode, setMode] = useState('now');
  const [paid, setPaid] = useState('');
  const [method, setMethod] = useState('Cash');
  const [note, setNote] = useState('');
  const fin = useAction('finalizeOrder');
  const tz = company.value?.timezone;
  const load = () => Promise.all([loadOrder(id), loadCatalog(true)]).then(([x, c]) => { setO(x); setCat(c); });
  useEffect(() => { load(); }, [id]);

  const calc = useMemo(() => {
    if (!o || !cat) return null;
    const base = { order: { items: o.order_items.map(coreItem) }, advance: o.advance, payMode: mode, paid,
      gstPct: Number(cat.settings.gst_pct), kachaPct: Number(cat.settings.kacha_pct), minInch: o.pricing_rules?.min_inch ?? cat.settings.min_inch };
    return { pakka: finishCalc({ ...base, bill: 'pakka' }), kacha: finishCalc({ ...base, bill: 'kacha' }), chosen: bill ? finishCalc({ ...base, bill }) : null };
  }, [o, cat, bill, mode, paid]);

  if (o === undefined || !calc) return <><TopBar title={t('pickup_title')} /><div class="page"><Skeleton h={120} /><Skeleton h={220} style="margin-top:12px" /></div></>;
  if (!o || o.status !== 'weighed') { go(o ? `/slip/${o.id}` : '/slips'); return null; }

  const f = calc.chosen;
  const problem = f ? finishProblem(f) : 'choose_bill';
  const submit = async (share) => {
    try {
      await fin.run({ order_id: o.id, bill, pay_mode: f.mode, paid: f.mode === 'part' ? Number(paid) : undefined, pay_method: method, note });
      toast(t('completed_msg', o.slip_no));
      // the slip page shows "Pickup done" and the WhatsApp / Print / PDF buttons (share → the send sheet opens)
      go(`/slip/${o.id}?done=1${share ? '&send=1' : ''}`);
    } catch (e) { if (e.code === 'changed') { toast(t('changed_retry')); load(); } }
  };

  const Opt = ({ id, label, sub, c }) => (
    <button class={`billopt ${bill === id ? 'on' : ''} b-${id}`} onClick={() => setBill(id)}>
      <div class="row" style="justify-content:space-between"><span class="bl">{label}</span><span class={`radio ${bill === id ? 'on' : ''}`}>{bill === id && <Icon name="Check" size={14} stroke={3} />}</span></div>
      <div class="num ba">{money(c.T.total, true)}</div><div class="faint bs">{sub}</div>
    </button>
  );

  return (
    <div>
      <TopBar title={t('pickup_title')} sub={`#${o.slip_no} · ${o.customers?.name} · ${kg(o.order_items.reduce((a, i) => a + Number(i.actual_weight || 0), 0))}`} />
      <div class="page" style="padding-bottom:130px">
        <div class="q">{t('bill_q')}</div>
        <div class="row" style="gap:10px;align-items:stretch">
          <Opt id="pakka" label={t('bill_gst_short')} sub={t('incl_gst', Number(cat.settings.gst_pct))} c={calc.pakka} />
          {can('kacha') && <Opt id="kacha" label={t('bill_none_short')} sub={t('incl_local')} c={calc.kacha} />}
        </div>

        {f && (
          <div class="card" style="margin-top:14px;padding:6px 16px">
            <L a={t('material')} b={money(f.T.matK, true)} />
            <L a={t('cutting')} b={money(f.T.cutK, true)} />
            {bill === 'pakka' && <L a={t('gst_line', f.T.pct)} b={money(f.T.gst, true)} />}
            <L a={<b>{t('total')}</b>} b={<b>{money(f.T.total, true)}</b>} top />
            {f.A > 0 && <L a={t('adv_less')} b={<span style="color:var(--ok)">− {money(f.A, true)}</span>} />}
            <div class="row collect"><span>{t('to_collect')}</span><span class="num">{money(f.B, true)}</span></div>
            {f.extra > 0 && <div class="notice tone-ok" style="margin-bottom:10px">{t('adv_excess', money(f.extra, true))}</div>}
          </div>
        )}

        {f && f.B > 0 && (
          <>
            <div class="lbl" style="margin-top:16px">{t('how_paying')}</div>
            <div class="seg">{[['now', 'pay_full_now'], ['part', 'pay_part_short'], ['later', 'pay_later_short']].map(([m, w]) => <button class={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{t(w)}</button>)}</div>
            {mode === 'part' && <div class="field" style="margin-top:10px"><span class="faint">₹</span><input inputmode="decimal" value={paid} onInput={(e) => setPaid(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder={t('amount_paid_now')} /></div>}
            {mode !== 'later' && (
              <>
                <div class="pick" style="margin-top:10px">{PAY_METHODS.map((p) => <button class={method === p.id ? 'on' : ''} onClick={() => setMethod(p.id)}><Icon name={p.icon} size={18} />{t(p.word)}</button>)}</div>
                <input class="textarea" style="margin-top:10px" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('pay_note')} />
              </>
            )}
            {f.due > 0 && <div class="notice tone-warn" style="margin-top:10px">{t('fin_khata_note', money(f.due, true), o.customers?.name, t(bill === 'pakka' ? 'bill_gst_short' : 'bill_none_short'), o.slip_no)}</div>}
          </>
        )}
        {fin.error && fin.error.code !== 'changed' && <div class="error">{fin.error.message}</div>}
      </div>
      <div class="dock">
        {problem ? <button class="btn btn-block btn-ghost" disabled>{t(problem === 'need_part' ? 'need_part' : 'choose_bill')}</button> : (
          <div class="row">
            <button class="btn btn-ghost" disabled={fin.busy} onClick={() => submit(false)}>{t('finish_only')}</button>
            <button class="btn btn-accent grow" disabled={fin.busy} onClick={() => submit(true)}><Icon name="MessageCircle" size={20} stroke={2.4} />{t('finish_share')}</button>
          </div>
        )}
      </div>
    </div>
  );
}

const L = ({ a, b, top }) => <div class="row" style={`justify-content:space-between;padding:9px 0;${top ? 'border-top:1px solid var(--line)' : ''}`}><span class="muted">{a}</span><span class="num">{b}</span></div>;
