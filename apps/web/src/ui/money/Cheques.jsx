// Cheques and DDs (4 Nov 2026, plan v2 F5 — Parth's D1 / D2): staff note a cheque when it comes in; it is NOT in the
// khata until the owner confirms its clearing line in the bank statement. These pieces are shared by the customer page,
// the payment sheet, the Cheques list and the bank review.
import { useEffect, useState } from 'preact/hooks';
import { chequeShow } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { useAction } from '../../lib/action.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { shopToday } from '../../lib/expenses.js';
import { loadAccounts, accName } from '../../lib/accounts.js';
import { go } from '../../lib/router.js';
import { Icon, Chip } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';
import './money.css';

/** Banks people write on cheques most (a tap instead of typing); anything else can be typed. */
export const CHEQUE_BANKS = ['SBI', 'PNB', 'BOB', 'HDFC', 'ICICI', 'AXIS', 'KOTAK', 'CANARA', 'UNION', 'YES'];

export const STATUS_TONE = { received: 'warn', deposited: 'accent', given: 'warn', cleared: 'ok', returned: 'bad', cancelled: 'neutral' };
export const chqKind = (q) => t(q?.instrument === 'dd' ? 'chq_kind_dd' : 'chq_kind_cheque');
/** "Cheque 004512" / "DD 445566" */
export const chqName = (q) => `${chqKind(q)} ${chequeShow(q?.number) || ''}`.trim();
export const chqStatus = (q) => t(`chq_st_${q.status}${q.direction === 'out' && q.status === 'cleared' ? '_out' : ''}`);
export const isOpen = (q) => ['received', 'deposited', 'given'].includes(q?.status);

/** Is the money being written as a cheque? (the payment sheet's "where" choice) */
export const chequeChosen = (w) => w?.mode === 'Cheque' || (w?.ids || []).some((id) => w.methods?.[id] === 'Cheque');

/** The boxes for a cheque / DD: kind, number, bank, the date on it. v = { instrument, number, bank, date } */
export function ChequeFields({ v, set, dir = 'in' }) {
  const today = shopToday();
  return (
    <>
      <div class="seg" style="margin-top:4px"><button class={v.instrument !== 'dd' ? 'on' : ''} onClick={() => set({ ...v, instrument: 'cheque' })}>{t('chq_kind_cheque')}</button>
        <button class={v.instrument === 'dd' ? 'on' : ''} onClick={() => set({ ...v, instrument: 'dd' })}>{t('chq_kind_dd')}</button></div>
      <div class="lbl" style="margin-top:14px">{t(v.instrument === 'dd' ? 'chq_number_dd' : 'chq_number')}</div>
      <div class="field"><Icon name="ScrollText" size={16} style="color:var(--ink-3)" />
        <input class="num" inputmode="numeric" value={v.number} maxLength={20} placeholder="004512" onInput={(e) => set({ ...v, number: e.currentTarget.value.replace(/[^0-9A-Za-z/-]/g, '').toUpperCase() })} /></div>
      {dir === 'in' && <>
        <div class="lbl" style="margin-top:14px">{t('chq_bank')}</div>
        <div class="chq-banks">{CHEQUE_BANKS.map((b) => <button class={v.bank === b ? 'on' : ''} onClick={() => set({ ...v, bank: v.bank === b ? '' : b })}>{b}</button>)}</div>
        <div class="field" style="margin-top:8px"><input value={v.bank} maxLength={40} placeholder={t('chq_bank_ph')} onInput={(e) => set({ ...v, bank: e.currentTarget.value.toUpperCase() })} /></div>
      </>}
      <div class="lbl" style="margin-top:14px">{t('chq_date')} <span class="faint" style="font-weight:600">· {t('chq_date_s')}</span></div>
      <div class="field"><input type="date" value={v.date} min={today} onInput={(e) => set({ ...v, date: e.currentTarget.value })} /></div>
    </>
  );
}
export const emptyCheque = () => ({ instrument: 'cheque', number: '', bank: '', date: '' });
/** The arguments of chequeAdd for a customer's cheque. */
export const chequeArgs = (v, { customer_id, side, amount, note }) => ({ direction: 'in', instrument: v.instrument, number: v.number, bank_name: v.bank || null,
  amount: Number(amount), customer_id, side, cheque_date: v.date && v.date > shopToday() ? v.date : null, note: note || null });

/** One register row. */
export function ChequeRow({ q, onOpen, who = true }) {
  const inOut = q.direction === 'in';
  return (
    <button class="li chq-row" onClick={() => onOpen?.(q)}>
      <div class={`iconbox tone-${STATUS_TONE[q.status] || 'neutral'}`}><Icon name={q.status === 'returned' ? 'Undo2' : q.status === 'cleared' ? 'CircleCheck' : q.status === 'cancelled' ? 'Ban' : 'ScrollText'} size={18} /></div>
      <div class="grow" style="min-width:0">
        <div class="t ellip">{who ? `${inOut ? q.customer : q.supplier} · ` : ''}<span class="num">{chqName(q)}</span></div>
        <div class="s ellip">{[q.bank_name, `${t(inOut ? 'chq_got' : 'chq_given_on', fmtDay(q.got_on, false))}`, q.account && q.status !== 'received' ? t('chq_into', accName({ name: q.account })) : null,
          q.cheque_date ? t('chq_dated', fmtDay(q.cheque_date, false)) : null].filter(Boolean).join(' · ')}</div>
      </div>
      <div style="text-align:right">
        <b class="num" style={`color:${q.status === 'cancelled' ? 'var(--ink-3)' : inOut ? 'var(--ok)' : 'var(--bad)'}`}>{inOut ? '' : '− '}{money(q.amount, false)}</b>
        <div><Chip tone={STATUS_TONE[q.status] || 'neutral'}>{chqStatus(q)}</Chip></div>
      </div>
    </button>
  );
}

/** A cheque's details, and what can be done with it here: given to the bank (which account), cancelled (why). */
export function ChequeActSheet({ q, onClose, onDone }) {
  const [step, setStep] = useState(null);   // deposit | cancel
  const [acc, setAcc] = useState(null);
  const [accs, setAccs] = useState([]);
  const [why, setWhy] = useState('');
  const a = useAction('chequeMark');
  useEffect(() => { setStep(null); setWhy(''); a.setError(null); if (q) loadAccounts().then((l) => { const b = (l || []).filter((x) => x.kind === 'bank' && !x.hidden); setAccs(b); setAcc(q.account_id || b[0]?.id || null); }).catch(() => {}); }, [q?.id]);
  if (!q) return null;
  const inOut = q.direction === 'in';
  const mayAct = isOpen(q) && (inOut ? can('khata') : (can('stock') || can('settings')));
  const save = () => a.run(step === 'deposit' ? { id: q.id, status: 'deposited', account_id: acc } : { id: q.id, status: 'cancelled', note: why }).then(onDone).catch(() => {});
  return (
    <Sheet open={!!q} onClose={onClose} title={chqName(q)}
      footer={step && <button class={`btn btn-block ${step === 'cancel' ? '' : 'btn-brand'}`} style={step === 'cancel' ? 'background:var(--bad);color:#fff' : ''}
        disabled={a.busy || (step === 'deposit' ? !acc : !why.trim())} onClick={save}>
        <Icon name={step === 'cancel' ? 'Ban' : 'Landmark'} size={18} />{step === 'cancel' ? t('chq_cancel_btn') : t('chq_deposited_save')}</button>}>
      <div class="num" style={`font-size:32px;font-weight:800;letter-spacing:-.03em;${q.status === 'cancelled' ? 'text-decoration:line-through;color:var(--ink-3)' : ''}`}>{money(q.amount, false)}</div>
      <div style="margin:6px 0 12px"><Chip tone={STATUS_TONE[q.status]}>{chqStatus(q)}</Chip></div>
      {isOpen(q) && inOut && <div class="notice tone-accent" style="font-size:13.5px">{t('chq_not_khata')}</div>}
      <div class="card" style="margin-top:12px">
        <button class="li" onClick={() => (inOut ? go(`/customer/${q.customer_id}`) : null)}><div class="iconbox tone-neutral"><Icon name={inOut ? 'BookOpenText' : 'Truck'} size={18} /></div>
          <div class="grow"><div class="t">{inOut ? q.customer : q.supplier}</div><div class="s">{inOut ? (q.side === 'kacha' ? t('bill_none_short') : t('bill_gst_short')) : t('chq_to_supplier')}</div></div>
          {inOut && <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />}</button>
        <div class="li"><div class="iconbox tone-neutral"><Icon name="ScrollText" size={18} /></div>
          <div class="grow"><div class="t num">{chqName(q)}{q.bank_name ? ` · ${q.bank_name}` : ''}</div>
            <div class="s">{t(inOut ? 'chq_got' : 'chq_given_on', fmtDay(q.got_on))}{q.cheque_date ? ` · ${t('chq_dated', fmtDay(q.cheque_date))}` : ''}{q.by ? ` · ${t('chq_by', q.by)}` : ''}</div></div></div>
        {q.account && <div class="li"><div class="iconbox tone-neutral"><Icon name="Landmark" size={18} /></div><div class="grow"><div class="t">{accName({ name: q.account })}</div></div></div>}
        {q.return_charges > 0 && <div class="li"><div class="iconbox tone-bad"><Icon name="Receipt" size={18} /></div><div class="grow"><div class="t">{t('chq_charges_on', money(q.return_charges, false))}</div></div></div>}
        {q.note && <div class="li"><div class="iconbox tone-neutral"><Icon name="StickyNote" size={18} /></div><div class="grow"><div class="s" style="color:var(--ink)">{q.note}</div></div></div>}
      </div>
      {mayAct && !step && (
        <div class="row" style="gap:8px;margin-top:12px">
          {inOut && q.status === 'received' && <button class="btn btn-brand grow" onClick={() => setStep('deposit')}><Icon name="Landmark" size={17} />{t('chq_deposited_btn')}</button>}
          <button class="btn btn-ghost grow" style="color:var(--bad)" onClick={() => setStep('cancel')}><Icon name="Ban" size={17} />{t('chq_cancel_btn')}</button>
        </div>
      )}
      {step === 'deposit' && <>
        <div class="lbl" style="margin-top:14px">{t('chq_which_bank')}</div>
        <div class="card">{accs.map((x) => <button class={`li ${acc === x.id ? 'on' : ''}`} onClick={() => setAcc(x.id)}><div class="grow t">{accName(x)}</div><span class={`radio ${acc === x.id ? 'on' : ''}`} /></button>)}
          {!accs.length && <div class="li muted">{t('chq_no_bank')}</div>}</div>
      </>}
      {step === 'cancel' && <>
        {!inOut && q.expense_id && <div class="notice tone-bad" style="margin-top:12px;font-size:13.5px">{t('chq_cancel_out_warn')}</div>}
        <div class="lbl" style="margin-top:14px">{t('reason')}</div>
        <input class="textarea" autofocus value={why} onInput={(e) => setWhy(e.currentTarget.value)} placeholder={t('chq_cancel_ph')} />
      </>}
      {isOpen(q) && <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:12px">{t(inOut ? 'chq_clears_how' : 'chq_clears_how_out')}</div>}
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}
