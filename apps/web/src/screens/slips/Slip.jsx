// One slip: items, weights, amounts, money taken — and the next step for its stage.
import { useEffect, useRef, useState } from 'preact/hooks';
import { r2, calcItem } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { loadOrderAny, dimText, lengthsText, shapeName, totalPcs } from '../../lib/orders.js';
import { outboxVersion } from '../../lib/offline/outbox.js';
import { usesOf, payPatch } from '../../lib/offline/local.js';
import { online } from '../../lib/net.js';
import { db } from '../../lib/backend.js';
import { useAction } from '../../lib/action.js';
import { money, kg, shortDate, time } from '../../lib/format.js';
import { go, route } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { STAGES, BILLS } from '../../config/options.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { GiveSlip } from '../docs/GiveSlip.jsx';
import { call } from '../../lib/api.js';
import { DeleteSheet, AskDeleteSheet } from './DeleteSheet.jsx';
import { loadStock, forgetStock } from '../../lib/stock.js';
import { StockLine, StockPick } from '../../ui/stock/StockPick.jsx';
import { MoneyTo, useWhere } from '../../ui/money/MoneyTo.jsx';
import { whereArgs, whereProblem, modeText, modeIcon, accName, whereLabel } from '../../lib/accounts.js';
import { moneySaved } from '../../lib/easy.js';
import '../docs/docs-screens.css';
import './slips.css';

const KIND_WORD = { advance: 'kind_adv', pickup: 'kind_pick', khata: 'kind_khata', refund: 'kind_refund', transfer: 'kind_transfer', reversal: 'kind_reversal' };

export function Slip({ id }) {
  const [o, setO] = useState(undefined);
  const [sheet, setSheet] = useState(null); // 'advance' | 'adjust' | 'cancel' | 'accept' | 'menu' | 'delete' | 'ask'
  const [req, setReq] = useState(null);     // an open "please delete" request (owners)
  const [deleter, setDeleter] = useState('');
  const [stock, setStock] = useState(null);      // to show / change which stock each item comes from
  const [pickFor, setPickFor] = useState(null);  // item whose stock is being changed
  const tz = company.value?.timezone;
  const load = () => loadOrderAny(id).then((x) => {
    setO(x);
    if (x?.local) { setReq(null); return; }   // made on this phone, not sent yet
    if (x?.status === 'deleted' && x.deleted_by) db.from('people').select('display_name').eq('id', x.deleted_by).maybeSingle().then(({ data }) => setDeleter(data?.display_name || '')).catch(() => {});
    if (x && x.status !== 'deleted' && can('delete')) call('deletedSlips', { order_id: x.id }).then((r) => setReq(r.requests?.[0] || null)).catch(() => {});
    else setReq(null);
    if (x && (x.order_items.some((i) => i.stock_item_id) || ['estimate', 'accepted'].includes(x.status))) loadStock(true).then(setStock).catch(() => {});
  }).catch(() => setO(null));
  useEffect(() => { load(); }, [id, outboxVersion.value]);
  // from the customer's account ("Give this advance back"): open the return / move sheet once the slip is here
  const wantAdjust = useRef(route.value.query.adjust === '1');
  useEffect(() => {
    if (!o || !wantAdjust.current) return;
    wantAdjust.current = false;
    const ext = o.status === 'done' ? r2(o.paid - Number(o.total_amount)) : 0;
    if (can('money') && ((['accepted', 'weighed'].includes(o.status) && o.advance > 0) || (ext > 0 && can('delete')))) setSheet('adjust');
  }, [o]);
  const decline = useAction('declineDelete');
  const setStockOf = useAction('setItemStock');
  const done = (msg) => { setSheet(null); toast(msg || t('done_ok')); load(); };

  if (o === undefined) return <><TopBar title="…" /><div class="page"><Skeleton h={120} /><Skeleton h={200} style="margin-top:12px" /></div></>;
  if (o === null) return <><TopBar title={t('nav_slips')} /><div class="page muted">{t('err_generic')}</div></>;

  const st = STAGES[o.status];
  const extra = o.status === 'done' ? r2(o.paid - Number(o.total_amount)) : 0;
  const justDone = o.status === 'done' && route.value.query.done === '1';
  const deleted = o.status === 'deleted';
  const showBar = !deleted && o.status !== 'cancelled' && (o.status !== 'done' || justDone || (extra > 0 && can('money')));
  const billed = o.status === 'done' || o.deleted_from === 'done';
  // made on this phone (not sent yet) or with entries waiting: only what works without internet
  const local = !!o.local; const waits = !!o.pending; const net = online.value && !waits;
  const menu = deleted || local ? [] : can('delete') ? ['delete'] : (can('orders') || can('new')) ? ['ask'] : [];
  const stockOpen = ['estimate', 'accepted'].includes(o.status) && (can('new') || can('weigh')) && !local;
  const needOf = (it) => {
    const c = calcItem({ shape: it.shape, unit: it.unit, d: it.dims, rows: it.order_item_lengths.map((l) => ({ len: l.len ?? '', pcs: l.pcs, cuts: l.cuts ?? '' })),
      rate: 0, cutRate: 0, density: Number(it.density) }, 'est', { minInch: o.pricing_rules?.min_inch ?? 1 });
    return { materialId: it.material_id, shape: it.shape, kg: Number(it.actual_weight) || (c ? c.est : 0) };
  };
  const pickItem = pickFor && o.order_items.find((i) => i.id === pickFor);
  const due = o.status === 'done' ? Math.max(0, r2(Number(o.total_amount) - o.paid)) : 0;

  return (
    <>
      <TopBar title={`#${o.slip_no} · ${o.customers?.name}`} sub={`${shortDate(o.created_at, tz)} · ${time(o.created_at, tz)}`}
        right={<div class="row" style="gap:8px">
          <Chip tone={o.status === 'done' ? BILLS[o.bill_type]?.tone : st.tone}>{o.status === 'done' ? t(BILLS[o.bill_type]?.word) : t(st.word)}</Chip>
          {menu.length > 0 && <button class="round" onClick={() => setSheet('menu')} aria-label={t('slip_more')}><Icon name="EllipsisVertical" size={20} stroke={2.2} /></button>}
        </div>} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 150px)">
        {justDone && (
          <div class="done-banner">
            <div class="ic"><Icon name="Check" size={26} stroke={3} /></div>
            <div><div style="font-weight:800;font-size:17px">{t('pickup_done')}</div>
              <div class="muted" style="font-size:13px">{due > 0 ? t('pickup_done_due', t(BILLS[o.bill_type]?.word), money(due, true)) : t('pickup_done_paid', t(BILLS[o.bill_type]?.word))}</div></div>
          </div>
        )}
        {waits && (
          <div class="notice tone-accent row" style="gap:10px;margin-bottom:12px;align-items:flex-start">
            <Icon name="CloudUpload" size={18} />
            <span class="grow">{local ? t('off_slip_no', o.slip_no) : t('off_waiting')}
              <span style="display:block;font-weight:500;font-size:12.5px">{local ? t('off_slip_no_s') : t('off_slip_wait_s')}</span></span>
            <button class="link" style="min-height:0" onClick={() => go('/waiting')}>{t('see')}</button>
          </div>
        )}
        {o.status === 'done' && can('money') && !waits && <GiveSlip o={o} autoOpen={route.value.query.send === '1'} />}
        {o.status === 'done' && can('money') && waits && <div class="notice tone-warn" style="margin-bottom:12px;font-size:13.5px">{t('off_give_later')}</div>}
        {o.status === 'cancelled' && <div class="card pad tone-bad" style="margin-bottom:12px;font-weight:600">{t('cancelled_because', o.cancel_reason)}</div>}
        {deleted && (
          <div class="del-banner tone-bad">
            <Icon name="Trash2" size={22} />
            <div><div class="t">{t('del_banner', deleter || '…', `${shortDate(o.deleted_at, tz)} · ${time(o.deleted_at, tz)}`)}</div>
              <div class="s">{t('del_banner_s', o.delete_reason)}</div></div>
          </div>
        )}
        {req && (
          <div class="del-banner tone-warn" style="flex-direction:column;gap:10px">
            <div class="row" style="gap:10px;align-items:flex-start"><Icon name="Trash2" size={20} />
              <div><div class="t">{t('del_asked', req.by || '')}</div><div class="s">“{req.reason}”</div></div></div>
            <div class="row" style="gap:10px;width:100%">
              <button class="btn btn-ghost grow" style="min-height:44px;font-size:15px" disabled={decline.busy}
                onClick={() => decline.run({ request_id: req.id }).then(() => { setReq(null); toast(t('done_ok')); }).catch(() => {})}>{t('del_not_needed')}</button>
              <button class="btn btn-bad grow" style="min-height:44px;font-size:15px" onClick={() => setSheet('delete')}><Icon name="Trash2" size={17} />{t('del_delete')}</button>
            </div>
          </div>
        )}

        <div class="sec" style="margin-top:4px"><h3>{t('items_title')}</h3>{o.total_weight && <span class="muted num">{t('weight_total')} {kg(o.total_weight)}</span>}</div>
        <div class="card">
          {o.order_items.map((it, i) => (
            <div class="li slip-item" style="flex-wrap:wrap">
              <div class="iconbox tone-neutral num" style="font-weight:800">{i + 1}</div>
              <div class="grow">
                <div class="t">{it.grade_code} · {shapeName(it.shape)} {dimText(it)}</div>
                <div class="s num">{lengthsText(it)} · {totalPcs(it)} {t('pcs')}</div>
              </div>
              <div style="text-align:right">
                {it.actual_weight ? <div class="num" style="font-weight:700">{kg(it.actual_weight)}</div> : <span class="faint" style="font-size:13px">{t('waiting_weight')}</span>}
                {can('money') && <div class="faint num" style="font-size:12px">{money(it.sell_rate)}/kg{it.special_rate ? ' ★' : ''}</div>}
              </div>
              {stock && (it.stock_item_id || stockOpen) && <div style="flex-basis:100%;padding-left:52px">
                <StockLine stock={stock} value={it.stock_item_id || null} need={needOf(it)} sellRate={it.sell_rate}
                  readOnly={!stockOpen} onOpen={() => setPickFor(it.id)} /></div>}
            </div>
          ))}
        </div>

        {can('money') && billed && (
          <div class="card" style="margin-top:12px;padding:6px 16px">
            <Line a={t('material')} b={money(o.material_amount, true)} />
            <Line a={t('cutting')} b={money(o.cutting_amount, true)} />
            {o.bill_type === 'pakka' && <Line a={t('gst_line', Number(o.gst_pct))} b={money(o.gst_amount, true)} />}
            <Line a={<b>{t('total')}</b>} b={<b>{money(o.total_amount, true)}</b>} top />
            <Line a={t('paid_so_far')} b={money(o.paid, true)} />
            {Number(o.total_amount) - o.paid > 0 && <Line a={<b style="color:var(--bad)">{t('bal_to_pay')}</b>} b={<b style="color:var(--bad)">{money(Number(o.total_amount) - o.paid, true)}</b>} />}
          </div>
        )}

        {can('money') && (
          <>
            <div class="sec"><h3>{t('payments_title')}</h3>{o.status !== 'done' && o.advance > 0 && <span class="num" style="font-weight:700">{t('adj_on_slip', money(o.advance))}</span>}</div>
            <div class="card">
              {o.payments.length === 0 ? <div class="li muted">{t('no_payments')}</div> : o.payments.map((p) => (
                <div class="li" style={p.reversed ? 'opacity:.5' : ''}>
                  <div class={`iconbox tone-${Number(p.amount) < 0 ? 'bad' : 'ok'}`}><Icon name={p.mode === 'Adjust' ? 'RefreshCw' : modeIcon(p.mode)} size={18} /></div>
                  <div class="grow"><div class="t">{t(KIND_WORD[p.kind] || p.kind)} · {p.mode === 'Adjust' ? '—' : modeText(p.mode)}{p.pending && <span class="faint" style="font-weight:600"> · <Icon name="CloudUpload" size={12} /> {t('off_waiting')}</span>}</div>
                    {p.payment_parts?.length > 0 && <div class="s">{p.payment_parts.map((x) => `${accName({ ...x.money_accounts })}${p.payment_parts.length > 1 ? ` ${money(Math.abs(x.amount))}` : ''}${x.method ? ` (${x.method})` : ''}`).join(' · ')}</div>}
                    <div class="s">{shortDate(p.received_at, tz)} · {time(p.received_at, tz)}{p.note ? ` · ${p.note}` : ''}</div></div>
                  <div class="num" style={`font-weight:700;color:${Number(p.amount) < 0 ? 'var(--bad)' : 'var(--ok)'}`}>{money(p.amount)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {showBar && <div class="actionbar">
        {o.status === 'estimate' && can('new') && (
          <div class="row">{!local && <button class="btn btn-ghost" disabled={!net} onClick={() => go(`/new?edit=${o.id}`)}><Icon name="FileText" size={18} />{t('act_edit')}</button>}
            <button class="btn btn-accent grow" onClick={() => setSheet('accept')}><Icon name="Check" size={20} stroke={2.6} />{t('accept')}</button></div>
        )}
        {o.status === 'accepted' && (
          <div class="row">{can('money') && <button class="btn btn-ghost" onClick={() => setSheet('advance')}>{t('adv_add')}</button>}
            {can('weigh') && <button class="btn btn-accent grow" onClick={() => go(`/weigh/${o.id}`)}><Icon name="Scale" size={20} />{t('act_weigh')}</button>}</div>
        )}
        {o.status === 'weighed' && can('money') && (
          <div class="row"><button class="btn btn-ghost" onClick={() => setSheet('advance')}>{t('adv_add')}</button>
            <button class="btn btn-accent grow" onClick={() => go(`/pickup/${o.id}`)}><Icon name="PackageCheck" size={20} />{t('act_pickup')}</button></div>
        )}
        {justDone && can('new') && <button class="btn btn-brand btn-block" onClick={() => go('/new')}><Icon name="Plus" size={20} stroke={2.4} />{t('next_order')}</button>}
        <div class="row" style="justify-content:center;gap:18px;margin-top:6px">
          {net && ['accepted', 'weighed'].includes(o.status) && can('money') && o.advance > 0 && <button class="link" onClick={() => setSheet('adjust')}>{t('act_adjust')}</button>}
          {net && o.status === 'done' && extra > 0 && can('delete') && <button class="link" onClick={() => setSheet('adjust')}>{t('act_return_extra')} ({money(extra)})</button>}
          {net && ['accepted', 'weighed'].includes(o.status) && can('new') && <button class="link" style="color:var(--bad)" onClick={() => setSheet('cancel')}>{t('act_cancel')}</button>}
          {!net && !local && ['accepted', 'weighed', 'done'].includes(o.status) && <span class="faint" style="font-size:12.5px">{t('off_more_later')}</span>}
        </div>
      </div>}

      <AcceptSheet open={sheet === 'accept'} o={o} onClose={() => setSheet(null)} onDone={() => done(t('accepted_msg', o.slip_no))} />
      <AdvanceSheet open={sheet === 'advance'} o={o} onClose={() => setSheet(null)} onDone={() => done()} />
      <AdjustSheet open={sheet === 'adjust'} o={o} extra={extra} onClose={() => setSheet(null)} onDone={() => done()} />
      <CancelSheet open={sheet === 'cancel'} o={o} onClose={() => setSheet(null)} onDone={() => done()} onAdjust={() => setSheet('adjust')} />
      <Sheet open={sheet === 'menu'} onClose={() => setSheet(null)} title={t('slip_more')}>
        <div class="card">
          {menu.includes('delete') && <button class="li" onClick={() => setSheet('delete')}>
            <div class="iconbox tone-bad"><Icon name="Trash2" /></div>
            <div class="grow"><div class="t" style="color:var(--bad)">{t('del_delete')}</div><div class="s">{t('del_delete_s')}</div></div></button>}
          {menu.includes('ask') && <button class="li" onClick={() => setSheet('ask')}>
            <div class="iconbox tone-warn"><Icon name="Trash2" /></div>
            <div class="grow"><div class="t">{t('del_ask')}</div><div class="s">{t('del_ask_s')}</div></div></button>}
        </div>
      </Sheet>
      {can('delete') && <DeleteSheet open={sheet === 'delete'} ids={[o.id]} onClose={() => setSheet(null)}
        onDone={() => done(t('del_done_1', o.slip_no))} />}
      <AskDeleteSheet open={sheet === 'ask'} o={o} onClose={() => setSheet(null)} onDone={() => done(t('del_ask_done'))} />
      {stock && pickItem && <StockPick open={!!pickItem} stock={stock} need={needOf(pickItem)} value={pickItem.stock_item_id || null} onClose={() => setPickFor(null)}
        onPick={(id) => setStockOf.run({ item_id: pickItem.id, stock_item_id: id }).then(() => { setPickFor(null); forgetStock(); load(); }).catch((e) => { setPickFor(null); toast(e.message); })} />}
    </>
  );
}

const Line = ({ a, b, top }) => <div class="row" style={`justify-content:space-between;padding:9px 0;${top ? 'border-top:1px solid var(--line)' : ''}`}><span class="muted">{a}</span><span class="num">{b}</span></div>;

function MoneyInput({ value, onInput }) {
  return <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={value} onInput={(e) => onInput(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>;
}
const Err = ({ a }) => a.error && <div class="error">{a.error.message}</div>;

function AcceptSheet({ open, o, onClose, onDone }) {
  const [amt, setAmt] = useState(''); const [note, setNote] = useState('');
  const [where, setWhere, accs] = useWhere(open && can('money'));
  const a = useAction('acceptOrder');
  const bad = Number(amt) > 0 ? whereProblem(where, Number(amt), accs) : null;
  const go_ = () => a.run({ order_id: o.id, advance: can('money') && Number(amt) > 0 ? { amount: Number(amt), note, ...whereArgs(where, Number(amt)) } : null }, {
    local: { meta: { uses: usesOf(o.id), slipNo: o.slip_no, customer: o.customers?.name, patch: { status: 'accepted', payment: can('money') ? payPatch(amt, whereArgs(where, Number(amt)), accs) : null } } },
  })
    .then((r) => { if (can('money') && Number(amt) > 0) moneySaved({ amount: Number(amt), customer: o.customers?.name, slipNo: o.slip_no, account: whereLabel(where, accs) }); onDone(r); }).catch(() => {});
  return (
    <Sheet open={open} onClose={onClose} title={t('accept')} footer={<button class="btn btn-accent btn-block" disabled={a.busy || !!bad} onClick={go_}><Icon name="Check" size={20} stroke={2.6} />{bad ? t(bad) : t('accept')}</button>}>
      {can('money') && <><div class="muted" style="margin-bottom:12px">{t('adv_note')}</div><div class="lbl">{t('adv_amt')}</div><MoneyInput value={amt} onInput={setAmt} />
        {Number(amt) > 0 && <><div class="lbl" style="margin-top:14px">{t('acc_where')}</div><MoneyTo amount={Number(amt)} value={where} onChange={setWhere} accounts={accs} />
          <div class="lbl" style="margin-top:14px">{t('pay_note')}</div><input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('pay_note_ph')} /></>}</>}
      <Err a={a} />
    </Sheet>
  );
}

function AdvanceSheet({ open, o, onClose, onDone }) {
  const [amt, setAmt] = useState(''); const [note, setNote] = useState('');
  const [where, setWhere, accs] = useWhere(open);
  const a = useAction('addAdvance');
  const bad = Number(amt) > 0 ? whereProblem(where, Number(amt), accs) : null;
  return (
    <Sheet open={open} onClose={onClose} title={t('adv_add')}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !(Number(amt) > 0) || !!bad} onClick={() => a.run({ order_id: o.id, amount: Number(amt), note, ...whereArgs(where, Number(amt)) }, {
        local: { meta: { uses: usesOf(o.id), slipNo: o.slip_no, customer: o.customers?.name, patch: { payment: payPatch(amt, whereArgs(where, Number(amt)), accs) } } },
      }).then((r) => { moneySaved({ amount: Number(amt), customer: o.customers?.name, slipNo: o.slip_no, account: whereLabel(where, accs) }); onDone(r); }).catch(() => {})}>{bad ? t(bad) : <>{t('adv_add')} {Number(amt) > 0 ? money(amt) : ''}</>}</button>}>
      <div class="lbl">{t('adv_amt')}</div><MoneyInput value={amt} onInput={setAmt} />
      <div class="lbl" style="margin-top:14px">{t('acc_where')}</div><MoneyTo amount={Number(amt) || 0} value={where} onChange={setWhere} accounts={accs} />
      <div class="lbl" style="margin-top:14px">{t('pay_note')}</div><input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('pay_note_ph')} />
      <Err a={a} />
    </Sheet>
  );
}

function AdjustSheet({ open, o, extra, onClose, onDone }) {
  const onlyRefund = o.status === 'done';
  const avail = onlyRefund ? extra : o.advance;
  const owner = can('delete');   // giving money back is the owner's (25 Oct 2026); others can move it or keep it as credit
  const [action, setAction] = useState(owner ? 'refund' : 'move');
  const [amt, setAmt] = useState('');
  const [where, setWhere, accs] = useWhere(open);
  const [note, setNote] = useState('');
  const [target, setTarget] = useState(null);
  const [side, setSide] = useState('pakka');
  const [others, setOthers] = useState(null);
  const a = useAction('adjustAdvance');
  useEffect(() => {
    if (!open) return;
    setAmt(String(avail));
    db.from('orders').select('id,slip_no,status,created_at').eq('customer_id', o.customer_id).in('status', ['accepted', 'weighed']).neq('id', o.id).order('created_at', { ascending: false })
      .then(({ data }) => setOthers(data || []));
  }, [open]);
  const ok = Number(amt) > 0 && Number(amt) <= avail && (action !== 'refund' || note.trim()) && (action !== 'move' || target);
  const submit = () => a.run({ order_id: o.id, action, amount: Number(amt), ...(action === 'refund' ? whereArgs(where, Number(amt)) : {}),
    note: note || undefined, target_order_id: action === 'move' ? target : undefined, side: action === 'credit' ? side : undefined }).then(onDone).catch(() => {});
  return (
    <Sheet open={open} onClose={onClose} title={onlyRefund ? t('act_return_extra') : t('act_adjust')}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !ok} onClick={submit}>{t(action === 'refund' ? 'adj_refund' : action === 'move' ? 'adj_move' : 'adj_credit')} {Number(amt) > 0 ? money(amt) : ''}</button>}>
      <div class="muted" style="margin-bottom:12px">{t('adj_on_slip', money(avail))}</div>
      {!onlyRefund && <div class="seg" style="margin-bottom:14px">{[['refund', 'adj_refund'], ['move', 'adj_move'], ['credit', 'adj_credit']].filter(([id]) => id !== 'refund' || owner).map(([id, w]) => <button class={action === id ? 'on' : ''} onClick={() => setAction(id)}>{t(w)}</button>)}</div>}
      <div class="lbl">{t('amount')}</div><MoneyInput value={amt} onInput={setAmt} />
      {action === 'refund' && <><div class="lbl" style="margin-top:14px">{t('acc_from')}</div><MoneyTo amount={Number(amt) || 0} value={where} onChange={setWhere} accounts={accs} single /></>}
      {action === 'move' && <><div class="lbl" style="margin-top:14px">{t('adj_which_slip')}</div>
        {others?.length === 0 ? <div class="muted">{t('adj_no_other')}</div> : <div class="pick">{(others || []).map((x) => <button class={target === x.id ? 'on' : ''} onClick={() => setTarget(x.id)}>#{x.slip_no}</button>)}</div>}</>}
      {action === 'credit' && can('kacha') && <><div class="lbl" style="margin-top:14px">{t('adj_account')}</div>
        <div class="seg"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}</button></div></>}
      <div class="lbl" style="margin-top:14px">{action === 'refund' ? t('reason') : t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('reason_ph')} />
      <Err a={a} />
    </Sheet>
  );
}

function CancelSheet({ open, o, onClose, onDone, onAdjust }) {
  const [reason, setReason] = useState('');
  const a = useAction('cancelOrder');
  const blocked = o.advance > 0;
  return (
    <Sheet open={open} onClose={onClose} title={t('act_cancel')}
      footer={blocked ? <button class="btn btn-ghost btn-block" onClick={onAdjust}>{t('act_adjust')}</button>
        : <button class="btn btn-block" style="background:var(--bad);color:#fff" disabled={a.busy || !reason.trim()} onClick={() => a.run({ order_id: o.id, reason }).then(onDone).catch(() => {})}>{t('act_cancel')}</button>}>
      {blocked ? <div class="notice tone-warn" style="border-radius:12px;padding:12px">{t('cancel_needs_adv', money(o.advance))}</div> : <>
        <div class="lbl">{t('reason')}</div>
        <input class="textarea" value={reason} onInput={(e) => setReason(e.currentTarget.value)} placeholder={t('cancel_reason_ph')} autofocus />
      </>}
      <Err a={a} />
    </Sheet>
  );
}
