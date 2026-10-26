// One customer's account: how much, how old, every slip and payment — record a payment, remind, old balances.
import { useEffect, useState } from 'preact/hooks';
import { whatsappLink, periodDates } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { usesOf, payPatch } from '../../lib/offline/local.js';
import { outbox, outboxVersion } from '../../lib/offline/outbox.js';
import { pendingPayments } from '../../lib/offline/overlay.js';
import { money, shortDate, kg, dayStartISO } from '../../lib/format.js';
import { loadCustomer, boughtSince, specialRates, sentSlips, avatarColour, firstLetter } from '../../lib/customers.js';
import { fmtDay } from '../../lib/docs.js';
import { CustomerEdit } from './CustomerEdit.jsx';
import { StatementSheet } from '../docs/StatementSheet.jsx';
import { go, route } from '../../lib/router.js';
import { moneySaved } from '../../lib/easy.js';
import { toast } from '../../ui/toast.js';
import { MoneyTo, useWhere } from '../../ui/money/MoneyTo.jsx';
import { whereArgs, whereProblem, modeText, modeIcon, whereLabel } from '../../lib/accounts.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { ReminderSheet } from './Reminders.jsx';
import { daysSince } from './Khata.jsx';
import './khata.css';

const KIND_WORD = { advance: 'kind_adv', pickup: 'kind_pick', khata: 'kind_khata', refund: 'kind_refund', transfer: 'kind_transfer' };

export function Customer({ id }) {
  const [r, setR] = useState(undefined);
  const [sheet, setSheet] = useState(null); // pay | remind | old | edit | statement | giveback
  const [payOpen, setPayOpen] = useState(null);   // a payment row tapped → its details (+ owner: cancel / give back)
  useEffect(() => { if (route.value.query.pay && can('khata')) setSheet('pay'); if (route.value.query.giveback && can('delete')) setSheet('giveback'); }, []);
  const [info, setInfo] = useState(null);     // gstin, address, note…
  const [extra, setExtra] = useState({});     // bought this year, special rates, sent slips
  const tz = company.value?.timezone;
  const fy = periodDates('this_fy', new Date().toISOString(), tz);
  const load = () => call('khata', { customer_id: id }).then(([x]) => setR(x || null)).catch(() => setR(null));
  const loadInfo = () => loadCustomer(id).then(setInfo).catch(() => {});
  useEffect(() => { if (r !== undefined) load(); }, [outboxVersion.value]);
  useEffect(() => {
    load(); loadInfo();
    Promise.all([boughtSince(id, dayStartISO(tz, new Date(`${fy.from}T12:00:00Z`))), specialRates(id), sentSlips(id)])
      .then(([bought, rates, sent]) => setExtra({ bought, rates, sent })).catch(() => {});
  }, [id]);
  if (r === undefined) return <><TopBar title="…" /><div class="page"><Skeleton h={140} /><Skeleton h={220} style="margin-top:12px" /></div></>;
  if (r === null) return <><TopBar title={t('nav_khata')} /><div class="page muted">{t('err_generic')}</div></>;

  const c = { ...r.customer, ...(info || {}) };
  const sides = Object.keys(r.by_side || {});
  const days = r.oldest ? daysSince(r.oldest, tz) : 0;
  const pak = r.by_side?.pakka?.due || 0; const kac = r.by_side?.kacha?.due || 0;
  const entries = [...(r.entries || [])].filter((e) => !e.reversal).reverse();   // a cancellation shows on the payment it cancels
  const waiting = pendingPayments(outbox.value, id);

  return (
    <>
      <TopBar title={c.name} right={can('new') && <button class="round" onClick={() => setSheet('edit')} aria-label={t('cust_edit')}><Icon name="Pencil" size={18} /></button>} />
      <div class="page">
        <div class="row" style="gap:14px">
          <div class="cav big" style={`background:${avatarColour(c.id)}`}>{firstLetter(c.name)}</div>
          <div class="grow" style="min-width:0">
            <div class="num" style="font-weight:700">{c.phone || <span class="muted">{t('no_phone')}</span>}</div>
            {(c.address || c.gstin) && <div class="faint" style="font-size:13px;font-weight:600">{[c.address, c.gstin && `GSTIN ${c.gstin}`].filter(Boolean).join(' · ')}</div>}
          </div>
        </div>
        <div class="cacts">
          {c.phone && <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}><Icon name="Phone" size={17} stroke={2.3} />{t('cust_call')}</a>}
          {c.phone && <a href={whatsappLink(c.phone, t('cust_wa_hello', c.name)) || '#'} target="_blank" rel="noopener"><Icon name="MessageCircle" size={17} stroke={2.3} />WhatsApp</a>}
          {can('new') && <button class="new" onClick={() => go(`/new?customer=${c.id}`)}><Icon name="Plus" size={17} stroke={2.4} />{t('nav_new')}</button>}
        </div>
        <div style="height:14px" />
        <div class="card pad">
          <div class="faint" style="font-size:13px;font-weight:600">{r.due > 0 ? t('to_receive_cap') : r.credit > 0 ? t('advance_held') : t('all_clear')}</div>
          <div class="num" style="font-size:36px;font-weight:800;letter-spacing:-.04em;margin:2px 0 10px">{money(r.due > 0 ? r.due : r.credit, false)}</div>
          {sides.length > 1 && r.due > 0 && (
            <>
              <div class="split"><div style={`flex:${pak || 0.001};background:var(--pakka)`} /><div style={`flex:${kac || 0.001};background:var(--kacha)`} /></div>
              <div class="row" style="justify-content:space-between;font-size:13px;font-weight:600;margin-top:8px">
                <span style="color:var(--pakka)">● {t('gst_bills')} {money(pak, false)}</span><span style="color:var(--kacha)">● {t('no_bills')} {money(kac, false)}</span>
              </div>
            </>
          )}
          {waiting.length > 0 && <div class="notice tone-accent row" style="gap:8px;font-size:13.5px"><Icon name="CloudUpload" size={16} />
            {t('off_pay_waiting', money(waiting.reduce((x, p) => x + p.amount, 0), false))}</div>}
          <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:12px">
            {r.due > 0 && <Chip tone={days >= 30 ? 'bad' : days >= 10 ? 'warn' : 'ok'}>{t('oldest_days_chip', days)}</Chip>}
            {r.credit > 0 && r.due > 0 && <Chip tone="ok">{t('credit_chip', money(r.credit, false))}</Chip>}
            {r.pending_advance > 0 && <Chip tone="neutral">{t('pending_adv')} {money(r.pending_advance, false)}</Chip>}
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          {can('khata') && <button class="btn btn-brand grow" style="min-height:50px;font-size:15px" onClick={() => setSheet('pay')}><Icon name="IndianRupee" size={18} stroke={2.4} />{t('record_payment')}</button>}
          {can('khata') && r.due > 0 && <button class="btn btn-ghost" style="min-height:50px;font-size:15px;color:var(--bad)" onClick={() => setSheet('remind')}><Icon name="BellRing" size={18} />{t('remind')}</button>}
          {can('delete') && r.due <= 0 && (r.credit > 0 || r.pending_advance > 0) && <button class="btn btn-ghost" style="min-height:50px;font-size:15px;color:var(--warn)" onClick={() => setSheet('giveback')}><Icon name="Undo2" size={18} />{t('gb_btn')}</button>}
        </div>

        {can('khata') && <button class="btn btn-brand btn-block" style="margin-top:12px" onClick={() => setSheet('statement')}><Icon name="FileText" size={19} stroke={2.3} />{t('send_stmt')}</button>}
        {(extra.bought?.n > 0 || extra.rates?.length > 0 || c.notes) && (
          <div class="card" style="margin-top:12px">
            {extra.bought?.n > 0 && <div class="li"><div class="iconbox tone-neutral"><Icon name="ChartColumn" size={18} /></div>
              <div class="grow"><div class="t">{t('cust_bought_year', fmtDay(fy.from, false))}</div><div class="s num">{t('cust_bought_s', extra.bought.n, kg(extra.bought.kg, 0))}</div></div>
              <b class="num">{money(extra.bought.amount, false)}</b></div>}
            {extra.rates?.length > 0 && <div class="li"><div class="iconbox tone-neutral"><Icon name="Tag" size={18} /></div>
              <div class="grow"><div class="t">{t('cust_special')}</div><div class="s num">{extra.rates.map((x) => `${x.code} ${money(x.rate)}/kg`).join(' · ')}</div></div></div>}
            {c.notes && <div class="li"><div class="iconbox tone-neutral"><Icon name="StickyNote" size={18} /></div>
              <div class="grow"><div class="t">{t('cust_note_t')}</div><div class="s">{c.notes}</div></div></div>}
          </div>
        )}

        <div class="sec"><h3>{t('account_title')}</h3>{can('khata') && <button class="link" onClick={() => setSheet('old')}><Icon name="Plus" size={15} stroke={2.4} />{t('add_old')}</button>}</div>
        <div class="card">
          {entries.length === 0 ? <div class="li muted">{t('all_clear')}</div> : entries.map((e) => e.t === 'bill' ? (
            <button class="li" onClick={() => !e.old && go(`/slip/${e.oid}`)}>
              <div class={`iconbox tone-${e.side}`}><Icon name={e.old ? 'BookOpenText' : 'ReceiptText'} size={18} /></div>
              <div class="grow"><div class="t num">{e.old ? (e.ref ? t('old_slip', e.ref) : t('old_balance')) : `${t('slip')} #${r.slips?.[e.oid] ?? ''}`}</div>
                <div class="s">{shortDate(e.date, tz)} · {t(e.side === 'pakka' ? 'bill_gst_short' : 'bill_none_short')}{extra.sent?.has(e.oid) && <span style="color:var(--ok);font-weight:700"> · {t('sent_tick')}</span>}</div></div>
              <div style="text-align:right"><div class="num" style="font-weight:700">{money(e.amt)}</div>
                {e.rem > 0 ? <Chip tone={e.paid > 0 ? 'accent' : 'warn'}>{e.paid > 0 ? t('due_left', money(e.rem)) : t('s_unpaid')}</Chip> : <Chip tone="ok">{t('s_paid')}</Chip>}</div>
            </button>
          ) : (
            <button class={`li ${e.cancelled ? 'pay-cancelled' : ''}`} style={e.pending ? 'opacity:.7' : ''} onClick={() => e.pid && setPayOpen(e)}>
              <div class={`iconbox tone-${e.cancelled ? 'neutral' : e.amt < 0 ? 'bad' : 'ok'}`}><Icon name={e.cancelled ? 'Ban' : e.mode && e.mode !== 'Adjust' ? modeIcon(e.mode) : 'RefreshCw'} size={18} /></div>
              <div class="grow"><div class="t">{e.pending ? t('pending_adv') : t(KIND_WORD[e.kind] || 'payment')}{e.mode && e.mode !== 'Adjust' ? ` · ${modeText(e.mode)}` : ''}</div>
                {e.cancelled
                  ? <div class="s ellip" style="color:var(--bad);font-weight:700">{`${t('pc_cancelled_t')}: ${e.cancelled.reason}${e.cancelled.by ? ` · ${e.cancelled.by}` : ''}`}</div>
                  : <div class="s ellip">{shortDate(e.date, tz)}{e.oid && r.slips?.[e.oid] ? ` · #${r.slips[e.oid]}` : ''}{e.note ? ` · ${e.note}` : ''}</div>}</div>
              <div class="num amt" style={`font-weight:700;color:${e.cancelled ? 'var(--ink-3)' : e.amt < 0 ? 'var(--bad)' : 'var(--ok)'}`}>{e.amt < 0 ? money(-e.amt) : `− ${money(e.amt)}`}</div>
            </button>
          ))}
        </div>
      </div>

      <PaySheet open={sheet === 'pay'} c={c} sides={sides} onClose={() => setSheet(null)} onDone={(amt) => { setSheet(null); toast(t('pay_saved', money(amt))); load(); }} />
      <GiveBackSheet open={sheet === 'giveback'} c={c} r={r} entries={entries} sides={sides} onClose={() => setSheet(null)} onDone={(amt) => { setSheet(null); toast(t('gb_done', money(amt))); load(); }} />
      <PaymentSheet e={payOpen} slips={r.slips || {}} tz={tz} onClose={() => setPayOpen(null)} onDone={() => { setPayOpen(null); toast(t('pc_done')); load(); }} />
      <OldDueSheet open={sheet === 'old'} c={c} sides={sides} onClose={() => setSheet(null)} onDone={() => { setSheet(null); toast(t('done_ok')); load(); }} />
      <CustomerEdit open={sheet === 'edit'} c={c} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); toast(t('cust_saved')); loadInfo(); load(); }} />
      {can('khata') && <StatementSheet open={sheet === 'statement'} c={c} sides={sides} onClose={() => setSheet(null)} />}
      {sheet === 'remind' && <ReminderSheet customer={c} side={kac > 0 && (!pak || kac >= pak) ? 'kacha' : 'pakka'} sides={sides.filter((s) => r.by_side[s].due > 0)} onClose={() => setSheet(null)} onSent={() => { setSheet(null); load(); }} />}
    </>
  );
}

function SideSeg({ sides, side, setSide }) {
  if (sides.length < 2) return null;
  return <><div class="lbl" style="margin-top:14px">{t('which_account')}</div>
    <div class="seg"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}</button></div></>;
}

function PaySheet({ open, c, sides, onClose, onDone }) {
  const [amt, setAmt] = useState(''); const [note, setNote] = useState(''); const [side, setSide] = useState('pakka');
  const [where, setWhere, accs] = useWhere(open);
  const a = useAction('recordPayment');
  const bad = Number(amt) > 0 ? whereProblem(where, Number(amt), accs) : null;
  return (
    <Sheet open={open} onClose={onClose} title={t('add_payment')}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy || !(Number(amt) > 0) || !!bad} onClick={() => a.run({ customer_id: c.id, amount: Number(amt), side, note, ...whereArgs(where, Number(amt)) }, {
        local: { meta: { uses: usesOf(c.id), customer: c.name, payment: { customer: c.name, ...payPatch(amt, whereArgs(where, Number(amt)), accs) } } },
      }).then(() => { moneySaved({ amount: Number(amt), customer: c.name, account: whereLabel(where, accs) }); onDone(amt); }).catch(() => {})}>{bad ? t(bad) : <>{t('record_payment')} {Number(amt) > 0 ? money(amt) : ''}</>}</button>}>
      <div class="lbl">{t('amount')}</div>
      <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
      <SideSeg sides={sides} side={side} setSide={setSide} />
      <div class="lbl" style="margin-top:14px">{t('acc_where')}</div>
      <MoneyTo amount={Number(amt) || 0} value={where} onChange={setWhere} accounts={accs} />
      <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('pay_note_ph')} />
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

function OldDueSheet({ open, c, sides, onClose, onDone }) {
  const today = new Date().toISOString().slice(0, 10);
  const [kind, setKind] = useState('lump'); const [amt, setAmt] = useState(''); const [ref, setRef] = useState('');
  const [date, setDate] = useState(today); const [side, setSide] = useState('pakka'); const [note, setNote] = useState('');
  const a = useAction('addOldDue');
  const ok = Number(amt) > 0 && date && (kind === 'lump' || ref.trim());
  return (
    <Sheet open={open} onClose={onClose} title={t('add_old')}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !ok} onClick={() => a.run({ customer_id: c.id, side, ref: kind === 'slip' ? ref : null, date, amount: Number(amt), note }).then(() => { setAmt(''); setRef(''); onDone(); }).catch(() => {})}>{t('add_old')} {Number(amt) > 0 ? money(amt) : ''}</button>}>
      <div class="muted" style="margin-bottom:12px">{t('add_old_s')}</div>
      <div class="seg"><button class={kind === 'lump' ? 'on' : ''} onClick={() => setKind('lump')}>{t('old_lump')}</button><button class={kind === 'slip' ? 'on' : ''} onClick={() => setKind('slip')}>{t('old_by_slip')}</button></div>
      {kind === 'slip' && <><div class="lbl" style="margin-top:14px">{t('old_slip_no')}</div><div class="field"><input value={ref} onInput={(e) => setRef(e.currentTarget.value)} placeholder="553" /></div></>}
      <div class="row" style="margin-top:14px;gap:10px">
        <div class="grow"><div class="lbl">{t('amount')}</div><div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div></div>
        <div class="grow"><div class="lbl">{t('old_date')}</div><div class="field"><input type="date" max={today} value={date} onInput={(e) => setDate(e.currentTarget.value)} /></div></div>
      </div>
      <SideSeg sides={sides} side={side} setSide={setSide} />
      <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

function MoneyInput({ value, onInput }) {
  return <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={value} onInput={(e) => onInput(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>;
}
const Err = ({ a }) => a.error && <div class="error">{a.error.message}</div>;

/**
 * "Give money back" (owner, 25 Oct 2026): the advance / extra money the customer has with us goes back to them —
 * from the khata credit (refundCredit), or an advance still sitting on an open slip (that slip's own sheet: return or move).
 */
function GiveBackSheet({ open, c, r, entries, sides, onClose, onDone }) {
  const withCredit = sides.filter((s) => (r.by_side?.[s]?.adv || 0) > 0);
  const [side, setSide] = useState(withCredit[0] || 'pakka');
  const avail = r.by_side?.[side]?.adv || 0;
  const [amt, setAmt] = useState('');
  const [where, setWhere, accs] = useWhere(open);
  const [note, setNote] = useState('');
  const a = useAction('refundCredit');
  useEffect(() => { if (open) { setAmt(avail ? String(avail) : ''); setNote(''); } }, [open, side]);
  const onSlips = entries.filter((e) => e.pending && e.oid);
  const ok = Number(amt) > 0 && Number(amt) <= avail && note.trim();
  return (
    <Sheet open={open} onClose={onClose} title={t('gb_title', c.name)}
      footer={avail > 0 && <button class="btn btn-accent btn-block" disabled={a.busy || !ok} onClick={() => a.run({ customer_id: c.id, side, amount: Number(amt), note, ...whereArgs(where, Number(amt)) }).then(() => onDone(Number(amt))).catch(() => {})}>
        <Icon name="Undo2" size={18} stroke={2.4} />{t('gb_give')} {Number(amt) > 0 ? money(amt) : ''}</button>}>
      {avail > 0 ? (
        <>
          <div class="notice tone-ok" style="font-size:14px">{t('gb_has', money(r.credit, false))}</div>
          {withCredit.length > 1 && <SideSeg sides={withCredit} side={side} setSide={setSide} />}
          <div class="lbl" style="margin-top:14px">{t('gb_how_much')}</div><MoneyInput value={amt} onInput={setAmt} />
          <div class="lbl" style="margin-top:14px">{t('gb_from')}</div><MoneyTo amount={Number(amt) || 0} value={where} onChange={setWhere} accounts={accs} single />
          <div class="lbl" style="margin-top:14px">{t('reason')}</div>
          <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('gb_reason_ph')} />
        </>
      ) : <div class="muted">{t('gb_nothing_khata')}</div>}
      {onSlips.length > 0 && (
        <>
          <div class="lbl" style="margin-top:18px">{t('gb_on_slips')}</div>
          <div class="card">{onSlips.map((e) => (
            <button class="li" onClick={() => go(`/slip/${e.oid}?adjust=1`)}>
              <div class="iconbox tone-neutral"><Icon name="ReceiptText" size={18} /></div>
              <div class="grow"><div class="t num">{t('slip')} #{r.slips?.[e.oid] ?? ''}</div><div class="s">{t('gb_slip_s')}</div></div>
              <b class="num">{money(e.amt)}</b><Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
            </button>))}</div>
        </>
      )}
      <Err a={a} />
    </Sheet>
  );
}

/** One payment: what, when, how — and for the owner: cancel it (a mistake) with a reason. Nothing is erased: it shows crossed out. */
function PaymentSheet({ e, slips, tz, onClose, onDone }) {
  const [why, setWhy] = useState('');
  const [asking, setAsking] = useState(false);
  const a = useAction('reversePayment');
  useEffect(() => { setWhy(''); setAsking(false); a.setError(null); }, [e?.pid]);
  if (!e) return null;
  const slipNo = e.oid ? slips[e.oid] : null;
  const owner = can('delete');
  return (
    <Sheet open={!!e} onClose={onClose} title={t(KIND_WORD[e.kind] || 'payment')}
      footer={owner && !e.pending && !e.cancelled && e.amt > 0 && (asking
        ? <button class="btn btn-block" style="background:var(--bad);color:#fff" disabled={a.busy || !why.trim()} onClick={() => a.run({ payment_id: e.pid, note: why }).then(onDone).catch(() => {})}><Icon name="Ban" size={18} />{t('pc_confirm', money(e.amt))}</button>
        : <button class="btn btn-ghost btn-block" style="color:var(--bad)" onClick={() => setAsking(true)}><Icon name="Ban" size={18} />{t('pc_cancel')}</button>)}>
      <div class="num" style={`font-size:34px;font-weight:800;letter-spacing:-.03em;color:${e.cancelled ? 'var(--ink-3)' : 'var(--ok)'}${e.cancelled ? ';text-decoration:line-through' : ''}`}>{money(Math.abs(e.amt), false)}</div>
      {e.cancelled && <div class="notice tone-bad" style="margin-top:10px;font-size:14px"><b>{t('pc_cancelled_t')}</b> · {shortDate(e.cancelled.at, tz)}{e.cancelled.by ? ` · ${e.cancelled.by}` : ''}<br />{e.cancelled.reason}</div>}
      <div class="card" style="margin-top:12px">
        <div class="li"><div class="iconbox tone-neutral"><Icon name={e.mode && e.mode !== 'Adjust' ? modeIcon(e.mode) : 'RefreshCw'} size={18} /></div><div class="grow"><div class="t">{e.mode && e.mode !== 'Adjust' ? modeText(e.mode) : t('kind_transfer')}</div><div class="s">{shortDate(e.date, tz)}</div></div></div>
        {slipNo && <button class="li" onClick={() => go(`/slip/${e.oid}`)}><div class="iconbox tone-neutral"><Icon name="ReceiptText" size={18} /></div><div class="grow"><div class="t num">{t('slip')} #{slipNo}</div><div class="s">{e.pending ? t('pc_on_open_slip') : t('pc_on_slip')}</div></div><Icon name="ChevronRight" size={18} style="color:var(--ink-3)" /></button>}
        {e.note && <div class="li"><div class="iconbox tone-neutral"><Icon name="StickyNote" size={18} /></div><div class="grow"><div class="s" style="color:var(--ink)">{e.note}</div></div></div>}
      </div>
      {owner && e.pending && !e.cancelled && <button class="btn btn-ghost btn-block" style="margin-top:12px" onClick={() => go(`/slip/${e.oid}?adjust=1`)}><Icon name="Undo2" size={18} />{t('pc_adv_back')}</button>}
      {owner && asking && (
        <>
          <div class="notice tone-bad" style="margin-top:12px;font-size:13.5px">{slipNo && !e.pending ? t('pc_warn_slip', slipNo, money(e.amt)) : t('pc_warn')}</div>
          <div class="lbl" style="margin-top:12px">{t('reason')}</div>
          <input class="textarea" autofocus value={why} onInput={(x) => setWhy(x.currentTarget.value)} placeholder={t('pc_reason_ph')} />
        </>
      )}
      {!owner && !e.cancelled && <div class="faint" style="margin-top:12px;font-size:12.5px;font-weight:600">{t('pc_owner_only')}</div>}
      <Err a={a} />
    </Sheet>
  );
}
