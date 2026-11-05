// One customer's account: how much, how old, every slip and payment — record a payment, remind, old balances.
import { useEffect, useState } from 'preact/hooks';
import { whatsappLink, periodDates, paymentTwins } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { usesOf, payPatch } from '../../lib/offline/local.js';
import { outbox, outboxVersion } from '../../lib/offline/outbox.js';
import { pendingPayments } from '../../lib/offline/overlay.js';
import { money, shortDate, kg, dayStartISO, longDay, time } from '../../lib/format.js';
import { loadCustomer, boughtSince, specialRates, sentSlips, avatarColour, firstLetter } from '../../lib/customers.js';
import { fmtDay } from '../../lib/docs.js';
import { forgetCatalog } from '../../lib/catalog.js';
import { CustomerEdit } from './CustomerEdit.jsx';
import { JoinSheet } from './JoinSheet.jsx';
import { StatementSheet } from '../docs/StatementSheet.jsx';
import { go, route } from '../../lib/router.js';
import { moneySaved } from '../../lib/easy.js';
import { toast } from '../../ui/toast.js';
import { useCashRule } from '../../ui/money/CashRule.jsx';
import { MoneyTo, useWhere } from '../../ui/money/MoneyTo.jsx';
import { whereArgs, whereProblem, modeText, modeIcon, whereLabel } from '../../lib/accounts.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { ChequeFields, ChequeRow, ChequeActSheet, emptyCheque, chequeArgs, chequeChosen, isOpen as chequeOpen } from '../../ui/money/Cheques.jsx';
import '../review/review.css';
import { Sheet } from '../../ui/Sheet.jsx';
import { ReminderSheet } from './Reminders.jsx';
import { TransferSheet } from '../../ui/money/TransferSheet.jsx';
import { fixPreset, shopToday, canFixDay } from '../../lib/expenses.js';
import { db } from '../../lib/backend.js';
import { online } from '../../lib/net.js';
import { daysSince } from './Khata.jsx';
import './khata.css';

const KIND_WORD = { advance: 'kind_adv', pickup: 'kind_pick', khata: 'kind_khata', refund: 'kind_refund', transfer: 'kind_transfer', join: 'kind_join' };

export function Customer({ id }) {
  const [r, setR] = useState(undefined);
  const [sheet, setSheet] = useState(null); // pay | remind | old | edit | statement | giveback
  const [payOpen, setPayOpen] = useState(null);   // a payment row tapped → its details (+ owner: cancel / give back)
  useEffect(() => { if (route.value.query.pay && can('khata')) setSheet('pay'); if (route.value.query.giveback && can('delete')) setSheet('giveback'); }, []);
  const [info, setInfo] = useState(null);     // gstin, address, note…
  const [extra, setExtra] = useState({});     // bought this year, special rates, sent slips
  const [cheques, setCheques] = useState([]); // cheques / DDs not cleared yet, and recent ones that came back (4 Nov 2026)
  const [chqOpen, setChqOpen] = useState(null);
  const [joins, setJoins] = useState([]);   // joined customers (6 Nov 2026, F9): the history links, and the old one's banner
  const undo = useAction('customerJoinUndo');
  const tz = company.value?.timezone;
  const loadCheques = () => (can('money') && can('khata') ? call('cheques', { customer_id: id, days: 60 }).then((l) => setCheques(l || [])).catch(() => {}) : null);
  const fy = periodDates('this_fy', new Date().toISOString(), tz);
  const load = () => call('khata', { customer_id: id }).then(([x]) => setR(x || null)).catch(() => setR(null));
  const loadInfo = () => loadCustomer(id).then(setInfo).catch(() => {});
  const loadJoins = () => (can('money') ? call('customerJoins', { customer_id: id }).then((l) => setJoins(l || [])).catch(() => {}) : null);
  useEffect(() => { if (r !== undefined) load(); }, [outboxVersion.value]);
  useEffect(() => {
    load(); loadInfo(); loadCheques(); loadJoins();
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
  const chqShow = cheques.filter((q) => q.direction === 'in' && (chequeOpen(q) || q.status === 'returned'));
  const chqWait = cheques.filter((q) => q.direction === 'in' && chequeOpen(q));
  const joinedInto = joins.find((j) => j.old_id === id && j.status === 'ok');
  const history = joins.filter((j) => j.kept_id === id && j.status === 'ok');

  return (
    <>
      <TopBar title={c.name} right={can('new') && <button class="round" onClick={() => setSheet('edit')} aria-label={t('cust_edit')}><Icon name="Pencil" size={18} /></button>} />
      <div class="page">
        {joinedInto && (
          <div class="notice tone-warn join-banner">
            <div><b>{t('join_banner', joinedInto.kept, shortDate(joinedInto.at, tz), joinedInto.by || '')}</b><div style="font-weight:600;margin-top:2px">{t('join_banner_s')}</div></div>
            <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
              <button class="btn btn-brand" style="min-height:42px" onClick={() => go(`/customer/${joinedInto.kept_id}`)}><Icon name="BookOpenText" size={16} />{t('join_open_kept', joinedInto.kept)}</button>
              {can('settings') && <button class="btn btn-ghost" style="min-height:42px" disabled={undo.busy}
                onClick={() => undo.run({ join_id: joinedInto.id }).then(() => { toast(t('join_undone')); forgetCatalog(); load(); loadInfo(); loadJoins(); }).catch(() => {})}><Icon name="Undo2" size={16} />{t('join_undo')}</button>}
            </div>
            {undo.error && <div class="error" style="margin-top:8px">{undo.error.message}</div>}
          </div>
        )}
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
          {can('new') && !c.joined_into && <button class="new" onClick={() => go(`/new?customer=${c.id}`)}><Icon name="Plus" size={17} stroke={2.4} />{t('nav_new')}</button>}
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
            {r.due > 0 && <Chip tone={days >= 30 ? 'bad' : days >= 10 ? 'warn' : 'ok'}>{days > 0 ? t('oldest_days_chip', days) : t('oldest_today_chip')}</Chip>}
            {r.due > 0 && r.credit - (r.pending_advance || 0) > 0.009 && <Chip tone="ok">{t('credit_chip', money(r.credit - (r.pending_advance || 0), false))}</Chip>}
            {r.pending_advance > 0 && <Chip tone="neutral">{t('pending_adv')} {money(r.pending_advance, false)}</Chip>}
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          {can('khata') && !c.joined_into && <button class="btn btn-brand grow" style="min-height:50px;font-size:15px" onClick={() => setSheet('pay')}><Icon name="IndianRupee" size={18} stroke={2.4} />{t('record_payment')}</button>}
          {can('khata') && r.due > 0 && !c.joined_into && <button class="btn btn-ghost" style="min-height:50px;font-size:15px;color:var(--bad)" onClick={() => setSheet('remind')}><Icon name="BellRing" size={18} />{t('remind')}</button>}
          {can('delete') && r.due <= 0 && (r.credit > 0 || r.pending_advance > 0) && <button class="btn btn-ghost" style="min-height:50px;font-size:15px;color:var(--warn)" onClick={() => setSheet('giveback')}><Icon name="Undo2" size={18} />{t('gb_btn')}</button>}
        </div>

        {chqShow.length > 0 && (
          <div class="card" style="margin-top:12px">
            <div class="li chq-head"><div class="grow"><div class="t">{t('chq_waiting_t')}{chqWait.length ? ` · ${money(chqWait.reduce((x, q) => x + Number(q.amount), 0), false)}` : ''}</div>
              <div class="s">{t('chq_waiting_s')}</div></div></div>
            {chqShow.map((q) => <ChequeRow q={q} who={false} onOpen={setChqOpen} />)}
          </div>
        )}
        {can('khata') && <button class="btn btn-brand btn-block" style="margin-top:12px" onClick={() => setSheet('statement')}><Icon name="FileText" size={19} stroke={2.3} />{t('send_stmt')}</button>}
        {history.length > 0 && (
          <div class="card" style="margin-top:12px">
            {history.map((j) => <button class="li" onClick={() => go(`/customer/${j.old_id}`)}><div class="iconbox tone-neutral"><Icon name="History" size={18} /></div>
              <div class="grow"><div class="t">{t('join_history', j.old)}</div><div class="s">{t('join_history_s', shortDate(j.at, tz), j.by || '')}</div></div><Icon name="ChevronRight" size={18} /></button>)}
            {can('settings') && history.map((j) => <div class="li" style="min-height:0;padding-top:0"><button class="link" style="min-height:0" disabled={undo.busy}
              onClick={() => undo.run({ join_id: j.id }).then(() => { toast(t('join_undone')); forgetCatalog(); load(); loadJoins(); }).catch(() => {})}><Icon name="Undo2" size={14} />{t('join_undo_of', j.old)}</button></div>)}
            {undo.error && !joinedInto && <div class="error" style="margin:0 14px 10px">{undo.error.message}</div>}
          </div>
        )}
        {can('settings') && !c.joined_into && !joinedInto && <button class="link" style="margin-top:10px" onClick={() => setSheet('join')}><Icon name="GitMerge" size={15} />{t('join_btn')}</button>}
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

        <div class="sec"><h3>{t('account_title')}</h3>{can('khata') && !c.joined_into && <button class="link" onClick={() => setSheet('old')}><Icon name="Plus" size={15} stroke={2.4} />{t('add_old')}</button>}</div>
        <div class="card">
          {entries.length === 0 ? <div class="li muted">{t('all_clear')}</div> : entries.map((e) => e.t === 'bill' ? (
            <button class="li" onClick={() => !e.old && go(`/slip/${e.oid}`)}>
              <div class={`iconbox tone-${e.side}`}><Icon name={e.old ? 'BookOpenText' : 'ReceiptText'} size={18} /></div>
              <div class="grow"><div class="t num">{e.old ? (e.ref ? t('old_slip', e.ref) : t('old_balance')) : `${t('slip')} #${r.slips?.[e.oid] ?? ''}`}</div>
                <div class="s">{shortDate(e.date, tz)} · {t(e.side === 'pakka' ? 'bill_gst_short' : 'bill_none_short')}{e.note ? ` · ${e.note}` : ''}{extra.sent?.has(e.oid) && <span style="color:var(--ok);font-weight:700"> · {t('sent_tick')}</span>}</div></div>
              <div style="text-align:right"><div class="num" style="font-weight:700">{money(e.amt)}</div>
                {e.rem > 0 ? <Chip tone={e.paid > 0 ? 'accent' : 'warn'}>{e.paid > 0 ? t('due_left', money(e.rem)) : t('s_unpaid')}</Chip> : <Chip tone="ok">{t('s_paid')}</Chip>}</div>
            </button>
          ) : (
            <button class={`li ${e.cancelled ? 'pay-cancelled' : ''}`} style={e.pending ? 'opacity:.7' : ''} onClick={() => e.pid && e.kind !== 'join' && setPayOpen(e)}>
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

      <PaySheet open={sheet === 'pay'} c={c} sides={sides} dues={r.by_side} entries={entries} onClose={() => setSheet(null)} onDone={(amt) => { setSheet(null); toast(t('pay_saved', money(amt))); load(); }}
        onCheque={(x) => { setSheet(null); toast(x?.twice ? t('chq_twice') : t('chq_saved')); loadCheques(); }} />
      <ChequeActSheet q={chqOpen} onClose={() => setChqOpen(null)} onDone={() => { setChqOpen(null); toast(t('done_ok')); loadCheques(); }} />
      <GiveBackSheet open={sheet === 'giveback'} c={c} r={r} entries={entries} sides={sides} onClose={() => setSheet(null)} onDone={(amt) => { setSheet(null); toast(t('gb_done', money(amt))); load(); }} />
      <PaymentSheet e={payOpen} name={c.name} slips={r.slips || {}} tz={tz} onClose={() => setPayOpen(null)} onDone={() => { setPayOpen(null); toast(t('pc_done')); load(); }} />
      <OldDueSheet open={sheet === 'old'} c={c} sides={sides} onClose={() => setSheet(null)} onDone={() => { setSheet(null); toast(t('done_ok')); load(); }} />
      {can('settings') && <JoinSheet open={sheet === 'join'} c={c} onClose={() => setSheet(null)}
        onDone={(x) => { setSheet(null); toast(t('join_done')); go(`/customer/${x.kept_id}`); if (x.kept_id === id) { load(); loadJoins(); } }} />}
      <CustomerEdit open={sheet === 'edit'} c={c} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); toast(t('cust_saved')); loadInfo(); load(); }} />
      {can('khata') && <StatementSheet open={sheet === 'statement'} c={c} sides={sides} onClose={() => setSheet(null)} />}
      {sheet === 'remind' && <ReminderSheet customer={c} side={kac > 0 && (!pak || kac >= pak) ? 'kacha' : 'pakka'} sides={sides.filter((s) => r.by_side[s].due > 0)} onClose={() => setSheet(null)} onSent={() => { setSheet(null); load(); }} />}
    </>
  );
}

function SideSeg({ sides, side, setSide, dues }) {
  if (sides.length < 2) return null;
  const due = (sd) => (dues?.[sd]?.due > 0 ? ` · ${money(dues[sd].due, false)}` : '');
  return <><div class="lbl" style="margin-top:14px">{t('which_account')}</div>
    <div class="seg"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}{due('pakka')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}{due('kacha')}</button></div></>;
}
/** The account a payment most likely belongs to: the one with money due (the older one when both are). (26 Oct 2026) */
const likelySide = (dues) => {
  const p = dues?.pakka?.due > 0; const k = dues?.kacha?.due > 0;
  return k && !p ? 'kacha' : 'pakka';
};

function PaySheet({ open, c, sides, dues, entries, onClose, onDone, onCheque }) {
  const [amt, setAmt] = useState(''); const [note, setNote] = useState(''); const [side, setSide] = useState('pakka');
  const [twins, setTwins] = useState(null);   // possible double payment (4 Nov 2026): shown before saving, the person decides
  // a cheque / DD is noted, not paid (D2, 4 Nov 2026): it goes into the khata when the owner confirms it in the bank statement
  const [how, setHow] = useState('money');
  const [chq, setChq] = useState(emptyCheque());
  const [switched, setSwitched] = useState(false);
  useEffect(() => { if (open) { setSide(likelySide(dues)); setTwins(null); setHow('money'); setChq(emptyCheque()); setSwitched(false); } }, [open]);
  useEffect(() => setTwins(null), [amt]);
  const [where, setWhere, accs] = useWhere(open);
  useEffect(() => { if (how === 'money' && chequeChosen(where)) { setHow('cheque'); setSwitched(true); setWhere(where.ids ? { ...where, methods: {} } : { mode: 'Cash' }); } }, [where]);
  const a = useAction('recordPayment');
  const rule = useCashRule({ open: open && how === 'money', customerId: c.id, amount: Number(amt), where, setWhere, accounts: accs });   // the ₹2 lakh rule (F8)
  const ca = useAction('chequeAdd');
  const seen = useAction('paymentTwinSeen');
  const chqOk = Number(amt) > 0 && chq.number.trim().length > 0;
  const saveCheque = () => ca.run(chequeArgs(chq, { customer_id: c.id, side, amount: amt, note })).then((x) => onCheque?.(x)).catch(() => {});
  const bad = Number(amt) > 0 ? whereProblem(where, Number(amt), accs) : null;
  const save = (checked) => a.run({ customer_id: c.id, amount: Number(amt), side, note, ...whereArgs(where, Number(amt)), ...rule.args }, {
    local: { meta: { uses: usesOf(c.id), customer: c.name, payment: { customer: c.name, ...payPatch(amt, whereArgs(where, Number(amt)), accs) } } },
  }).then((x) => {
    if (checked && x?.payment_id) seen.run({ payment_id: x.payment_id }).catch(() => {});
    moneySaved({ amount: Number(amt), customer: c.name, account: whereLabel(where, accs) }); onDone(amt);
  }).catch(() => {});
  const trySave = () => {
    const tw = paymentTwins(entries, Number(amt));
    if (tw.length && !twins) { setTwins(tw); return; }
    save(!!tw.length);
  };
  return (
    <Sheet open={open} onClose={onClose} title={t('add_payment')}
      footer={how === 'cheque'
        ? <button class="btn btn-brand btn-block" disabled={ca.busy || !chqOk || !online.value} onClick={saveCheque}><Icon name="ScrollText" size={18} />{online.value ? t('chq_save', Number(amt) > 0 ? money(amt) : '') : t('chq_online')}</button>
        : !twins && <button class="btn btn-brand btn-block" disabled={a.busy || !(Number(amt) > 0) || !!bad || rule.blocked} onClick={trySave}>{bad ? t(bad) : rule.blocked ? t('cash_t') : <>{t('record_payment')} {Number(amt) > 0 ? money(amt) : ''}</>}</button>}>
      {can('money') && <div class="seg" style="margin-bottom:14px"><button class={how === 'money' ? 'on' : ''} onClick={() => setHow('money')}><Icon name="IndianRupee" size={15} />{t('pay_tab_money')}</button>
        <button class={how === 'cheque' ? 'on' : ''} onClick={() => { setHow('cheque'); setTwins(null); }}><Icon name="ScrollText" size={15} />{t('pay_tab_cheque')}</button></div>}
      {how === 'cheque' && <>
        <div class="notice tone-accent" style="font-size:13.5px">{switched ? t('chq_switched') : t('chq_note_khata')}</div>
        <div class="lbl" style="margin-top:14px">{t('amount')}</div>
        <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
        <div style="height:10px" />
        <ChequeFields v={chq} set={setChq} />
        <SideSeg sides={sides} side={side} setSide={setSide} dues={dues} />
        <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
        <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('pay_note_ph')} />
        {ca.error && <div class="error">{ca.error.message}</div>}
      </>}
      {how === 'money' && <>
      {twins && (
        <div class="twin-box">
          <div class="t"><Icon name="Copy" size={16} /> {t('twin_t')}</div>
          <div class="s" style="font-size:13.5px;margin-top:4px">{t('twin_s', money(Number(amt)))}</div>
          {twins.map((x) => <div class="li"><div class="grow"><div class="t" style="color:var(--ink);font-size:14px">{longDay(x.date, company.value?.timezone)} · {time(x.date, company.value?.timezone)}</div>
            <div class="s">{[x.mode && x.mode !== 'Adjust' ? modeText(x.mode) : null, x.kind && x.kind !== 'khata' ? t(KIND_WORD[x.kind] || 'payment') : null, x.note].filter(Boolean).join(' · ')}</div></div><b class="num">{money(x.amt)}</b></div>)}
          <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:6px">{t('twin_note')}</div>
          <div class="row"><button class="btn btn-ghost" onClick={onClose}>{t('twin_same')}</button>
            <button class="btn btn-brand" disabled={a.busy} onClick={() => save(true)}>{t('twin_diff')}</button></div>
        </div>
      )}
      <div class="lbl">{t('amount')}</div>
      <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
      <SideSeg sides={sides} side={side} setSide={setSide} dues={dues} />
      <div class="lbl" style="margin-top:14px">{t('acc_where')}</div>
      <MoneyTo amount={Number(amt) || 0} value={where} onChange={setWhere} accounts={accs} />
      {rule.box}
      <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('pay_note_ph')} />
      {a.error && <div class="error">{a.error.message}</div>}
      </>}
    </Sheet>
  );
}

function OldDueSheet({ open, c, sides, onClose, onDone }) {
  const today = shopToday();   // the shop's date (rule 4) — the phone's UTC date was yesterday before 5:30 am
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
function PaymentSheet({ e, slips, tz, onClose, onDone, name }) {
  const [why, setWhy] = useState('');
  const [asking, setAsking] = useState(false);
  const [fix, setFix] = useState(null);   // "wrong account?" (26 Oct 2026)
  const a = useAction('reversePayment');
  useEffect(() => { setWhy(''); setAsking(false); setFix(null); a.setError(null); }, [e?.pid]);
  if (!e) return null;
  const openFix = () => db.from('payment_parts').select('account_id').eq('payment_id', e.pid).then(({ data }) => setFix(fixPreset({
    amount: e.amt, at: e.date, from: data?.length === 1 ? data[0].account_id : null,
    label: `${t(KIND_WORD[e.kind] || 'payment')}${e.oid && slips[e.oid] ? ` #${slips[e.oid]}` : ''} · ${name || ''} · ${money(e.amt)}` }))).catch(() => setFix(fixPreset({ amount: e.amt, at: e.date })));
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
      {can('expenses') && !e.cancelled && e.amt > 0 && e.mode && e.mode !== 'Adjust' && online.value && canFixDay(e.date) && <button class="btn btn-ghost btn-block" style="margin-top:12px" onClick={openFix}><Icon name="ArrowRightLeft" size={18} />{t('fix_acc_q')}</button>}
      {fix && <TransferSheet open={!!fix} preset={fix} onClose={() => setFix(null)} onDone={() => { setFix(null); toast(t('fix_acc_done')); onClose(); }} />}
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
