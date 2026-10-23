// Move money between two of the shop's own accounts: cash deposited in the bank, cash taken out of the
// bank, Paytm → bank, cash taken home. Never a sale and never an expense.
import { useEffect, useState } from 'preact/hooks';
import { transferProblem, r2 } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { useAction } from '../../lib/action.js';
import { money } from '../../lib/format.js';
import { addDays } from '../../lib/evening.js';
import { loadAccounts, accountsCache, isBankLike } from '../../lib/accounts.js';
import { shopToday, moveReason, moveWord } from '../../lib/expenses.js';
import { Icon, Skeleton } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';
import { AccountPick } from './AccountPick.jsx';
import './money.css';

export function TransferSheet({ open, onClose, onDone, from: startFrom = null }) {
  const [accounts, setAccounts] = useState(accountsCache.value);
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(null);
  const [note, setNote] = useState('');
  const [day, setDay] = useState('today');
  const save = useAction('saveTransfer');
  const today = shopToday();

  useEffect(() => {
    if (!open) return;
    save.setError(null); setAmount(''); setMethod(null); setNote(''); setDay('today'); setTo(null);
    loadAccounts().then((l) => {
      setAccounts(l);
      const usable = l.filter((a) => a.usable !== false);
      setFrom(startFrom && usable.some((a) => a.id === startFrom) ? startFrom : usable.find((a) => a.is_drawer)?.id || usable[0]?.id || null);
    }).catch(() => setAccounts(accountsCache.value || []));
  }, [open]);

  const list = (accounts || []).filter((a) => a.usable !== false);
  const A = list.find((a) => a.id === from); const B = list.find((a) => a.id === to);
  const reason = moveReason(A, B);
  const problem = transferProblem({ from, to, amount: Number(amount) });
  const bank = (A && isBankLike(A)) || (B && isBankLike(B));
  const submit = () => !problem && save.run({ from_account: from, to_account: to, amount: r2(Number(amount)), reason, method: bank ? method || undefined : undefined,
    note: note.trim() || undefined, day: day === 'yesterday' ? addDays(today, -1) : undefined }, {
    local: { meta: { transfer: { amount: r2(Number(amount)), from: A?.name || '', to: B?.name || '', from_drawer: !!A?.is_drawer, to_drawer: !!B?.is_drawer,
      reason, day: day === 'yesterday' ? addDays(today, -1) : today, at: new Date().toISOString(), status: 'ok' } } },
  }).then((r) => onDone?.(r)).catch(() => {});

  return (
    <Sheet open={open} onClose={onClose} title={t('tr_title')}
      footer={<>
        {save.error && <div class="error" style="margin:0 0 8px">{save.error.message}</div>}
        <button class="btn btn-brand btn-block" disabled={!!problem || save.busy} onClick={submit}><Icon name="ArrowRightLeft" size={19} stroke={2.3} />
          {save.busy ? '…' : problem && Number(amount) > 0 && from && to ? t(problem) : t('tr_save', Number(amount) > 0 ? money(Number(amount)) : '')}</button>
      </>}>
      <div class="muted" style="font-size:13.5px;margin:-6px 0 12px">{t('tr_title_s')}</div>
      {!accounts ? <Skeleton h={160} /> : list.length < 2 ? <div class="notice tone-warn">{t('tr_need_two')}</div> : <>
        <div class="lbl">{t('tr_from')}</div>
        <AccountPick accounts={accounts} value={from} onChange={(id) => { setFrom(id); if (id === to) setTo(null); }} showMethods={false} />
        <div class="row" style="justify-content:center;margin:8px 0;color:var(--ink-3)"><Icon name="ArrowDown" size={22} stroke={2.4} /></div>
        <div class="lbl">{t('tr_to')}</div>
        <AccountPick accounts={accounts} value={to} onChange={setTo} hide={from} method={method} onMethod={setMethod} />
        {from && to && <div class="chip tone-accent" style="margin-top:10px">{moveWord(reason)}</div>}
        <div class="lbl" style="margin-top:16px">{t('tr_amount')}</div>
        <div class="field num exp-amount"><span class="faint">₹</span>
          <input inputmode="decimal" value={amount} placeholder="0" onInput={(e) => setAmount(e.currentTarget.value.replace(/[^\d.]/g, ''))} /></div>
        <div class="lbl" style="margin-top:16px">{t('exp_day')}</div>
        <div class="seg">
          <button class={day === 'today' ? 'on' : ''} onClick={() => setDay('today')}>{t('exp_today')}</button>
          <button class={day === 'yesterday' ? 'on' : ''} onClick={() => setDay('yesterday')}>{t('exp_yesterday')}</button>
        </div>
        <div class="lbl" style="margin-top:14px">{t('exp_note')}</div>
        <div class="field"><input value={note} maxLength={300} placeholder={t('exp_note_ph')} onInput={(e) => setNote(e.currentTarget.value)} /></div>
        {!can('settings') && <div class="faint" style="font-size:12.5px;margin-top:8px">{t('exp_only_owner')}</div>}
      </>}
    </Sheet>
  );
}
