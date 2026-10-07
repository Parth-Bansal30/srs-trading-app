// Deleting slips (owners, with a one-time SMS code) and asking an owner to delete (staff).
// Step 1 shows what will be undone and asks why; step 2 is the code from the SMS.
import { useEffect, useState } from 'preact/hooks';
import { r2 } from '@srs/core';
import { t, tIn } from '../../lib/i18n.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money } from '../../lib/format.js';
import { MoneyTo, useWhere } from '../../ui/money/MoneyTo.jsx';
import { whereArgs } from '../../lib/accounts.js';
import { Icon } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import './slips.css';

const REASONS = ['del_r_test', 'del_r_twice', 'del_r_wrong', 'del_r_cancel'];
// test / typed twice → the money was never really there; otherwise it's the customer's
const MONEY_FOR = { del_r_test: 'never', del_r_twice: 'never' };

/** Reason chips + "Other…". The saved reason is always in English, so everyone reads the same record. */
function Reason({ value, other, onPick, onOther }) {
  return (
    <>
      <div class="lbl" style="margin-top:16px">{t('del_why')}</div>
      <div class="del-chips">
        {[...REASONS, 'other'].map((k) => (
          <button class={value === k ? 'on' : ''} onClick={() => onPick(k)}>{t(k === 'other' ? 'del_r_other' : k)}</button>
        ))}
      </div>
      {value === 'other' && <input class="textarea" style="margin-top:10px" value={other} maxLength={300}
        onInput={(e) => onOther(e.currentTarget.value)} placeholder={t('del_other_ph')} autofocus />}
    </>
  );
}
const reasonText = (value, other) => (value === 'other' ? other.trim() : value ? tIn('en', value) : '');

function Effect({ icon, tone = 'neutral', children }) {
  return <div class="li" style="padding:10px 0"><div class={`iconbox tone-${tone}`} style="width:34px;height:34px"><Icon name={icon} size={17} /></div><div class="grow t" style="font-size:14.5px">{children}</div></div>;
}

/** The six boxes, typed through one real input (so the phone's "code from SMS" suggestion works). */
function CodeBoxes({ value, onInput }) {
  return (
    <label class="code-boxes">
      {[0, 1, 2, 3, 4, 5].map((i) => <span class={`num ${i === value.length ? 'here' : ''}`}>{value[i] || ''}</span>)}
      <input inputmode="numeric" autocomplete="one-time-code" maxLength={6} value={value} autofocus aria-label={t('del_code_title')}
        onInput={(e) => onInput(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))} />
    </label>
  );
}

/**
 * ids: the slips to delete. onDone(result) after they are deleted.
 */
export function DeleteSheet({ open, ids, onClose, onDone }) {
  const [info, setInfo] = useState(null);
  const [step, setStep] = useState('what');
  const [reason, setReason] = useState(null);
  const [other, setOther] = useState('');
  const [moneyChoice, setMoney] = useState(null);
  const [where, setWhere, accs] = useWhere(open);
  const [sent, setSent] = useState(null);
  const [left, setLeft] = useState(0);
  const [code, setCode] = useState('');
  const [err, setErr] = useState(null);
  const [sending, setSending] = useState(false);
  const del = useAction('deleteSlips');

  useEffect(() => {
    if (!open) return;
    setInfo(null); setStep('what'); setReason(null); setOther(''); setMoney(null); setSent(null); setCode(''); setErr(null);
    call('deletePreview', { order_ids: ids }).then(setInfo).catch((e) => setErr(e.message));
  }, [open, ids.join(',')]);
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);

  const orders = info?.orders || [];
  const one = ids.length === 1;
  const paid = r2(orders.reduce((a, o) => a + Number(o.paid || 0), 0));
  const done = orders.filter((o) => o.status === 'done');
  const khata = r2(done.filter((o) => o.in_khata).reduce((a, o) => a + Math.max(0, Number(o.total || 0) - Number(o.paid || 0)), 0));
  const open_ = orders.some((o) => ['estimate', 'accepted', 'weighed'].includes(o.status));
  const stockBack = orders.reduce((a, o) => a + Number(o.stock_back_kg || 0), 0);
  // "never really received" only when no part was already given back / moved (the server says per slip)
  const canUndo = orders.every((o) => o.can_undo !== false || !(Number(o.paid) > 0));
  const why = reasonText(reason, other);
  const moneyOk = paid <= 0 || (moneyChoice && (moneyChoice !== 'refund' || (where && (where.mode || where.ids?.length))));
  const ready = info && why && moneyOk;
  const slipNo = orders[0]?.slip_no || '';
  const title = one ? t('del_title_1', slipNo) : t('del_title_n', ids.length);

  const pickReason = (k) => { setReason(k); if (paid > 0 && !moneyChoice) setMoney(MONEY_FOR[k] && canUndo ? MONEY_FOR[k] : 'credit'); };
  const sendCode = async () => {
    setSending(true); setErr(null);
    try {
      const r = await call('deleteCode', { order_ids: ids });
      setSent(r); setLeft(r.wait || 60); setStep('code'); setCode('');
    } catch (e) { setErr(e.message); } finally { setSending(false); }
  };
  const doDelete = () => del.run({ order_ids: ids, reason: why, money: paid > 0 ? moneyChoice : 'none', ...(moneyChoice === 'refund' ? whereArgs(where, paid) : {}), code })
    .then((r) => onDone?.(r, orders))
    .catch((e) => { if (e.code === 'wrong_code') { setCode(''); } });
  const delErr = del.error && (del.error.code === 'wrong_code' ? t('del_wrong_code') : del.error.message);

  const footer = step === 'what'
    ? <button class="btn btn-block btn-bad" disabled={!ready || sending} onClick={sendCode}><Icon name="ShieldCheck" size={19} stroke={2.3} />{sending ? '…' : t('del_get_code')}</button>
    : <button class="btn btn-block btn-bad" disabled={code.length !== 6 || del.busy} onClick={doDelete}><Icon name="Trash2" size={19} stroke={2.3} />{del.busy ? '…' : one ? t('del_do_1') : t('del_do_n', ids.length)}</button>;

  return (
    <Sheet open={open} onClose={onClose} title={step === 'what' ? title : t('del_code_title')} footer={footer}>
      {step === 'what' && (
        <>
          {!info && !err && <div class="muted">…</div>}
          {info && (
            <>
              <div class="muted" style="font-size:14px">
                {one ? `${orders[0]?.customer || ''}${orders[0]?.total != null ? ` · ${money(orders[0].total, true)}` : ''}` : orders.map((o) => `#${o.slip_no}`).join(', ')}
              </div>
              <div class="lbl" style="margin-top:14px">{t('del_what')}</div>
              <div class="card" style="padding:2px 14px">
                {done.length > 0 && <Effect icon="ChartColumn">{t('del_out_sales')}</Effect>}
                {khata > 0 && <Effect icon="BookOpenText">{t('del_out_khata', money(khata, true))}</Effect>}
                {open_ && <Effect icon="PackageCheck">{t('del_out_open')}</Effect>}
                {stockBack > 0 && <Effect icon="Boxes">{t('del_stock_back', `${Math.round(stockBack * 100) / 100} kg`)}</Effect>}
                {paid > 0 && (
                  <div class="li" style="padding:10px 0;align-items:flex-start">
                    <div class="iconbox tone-warn" style="width:34px;height:34px"><Icon name="Banknote" size={17} /></div>
                    <div class="grow">
                      <div class="t" style="font-size:14.5px">{one ? t('del_money_1', money(paid, true)) : t('del_money_n', money(paid, true))}</div>
                      <div class="del-radios">
                        {[['never', 'del_m_never', 'del_m_never_s'], ['credit', 'del_m_credit'], ['refund', 'del_m_refund']].filter(([id]) => id !== 'never' || canUndo).map(([id, w, s]) => (
                          <button class={moneyChoice === id ? 'on' : ''} onClick={() => setMoney(id)}>
                            <span class="dot" /><span><b>{t(w)}</b>{s && <small>{t(s)}</small>}</span>
                          </button>
                        ))}
                      </div>
                      {moneyChoice === 'refund' && <>
                        <div class="lbl" style="margin-top:10px">{t('del_how_back')}</div>
                        <MoneyTo amount={paid} value={where} onChange={setWhere} accounts={accs} single />
                      </>}
                    </div>
                  </div>
                )}
              </div>
              <Reason value={reason} other={other} onPick={pickReason} onOther={setOther} />
            </>
          )}
          {err && <div class="error" style="margin-top:12px">{err}</div>}
        </>
      )}
      {step === 'code' && (
        <div style="text-align:center">
          <div class="del-shield"><Icon name="ShieldCheck" size={34} stroke={2} /></div>
          <div class="muted" style="font-size:15px;margin-top:12px;line-height:1.45">{t('del_code_sent', '')}<br /><b class="num" style="color:var(--ink)">{sent?.to}</b></div>
          <CodeBoxes value={code} onInput={(v) => { setCode(v); del.setError(null); }} />
          {left > 0
            ? <div class="faint" style="font-size:13.5px;font-weight:600;margin-top:12px">{t('del_resend_in', `0:${String(left).padStart(2, '0')}`)}</div>
            : <button class="link" disabled={sending} onClick={sendCode}>{t('del_resend')}</button>}
          {delErr && <div class="error" style="margin-top:12px;text-align:left">{delErr}</div>}
          {del.error && del.error.code !== 'wrong_code' && <button class="link" onClick={() => { del.setError(null); setStep('what'); }}>← {t('del_change')}</button>}
          {err && <div class="error" style="margin-top:12px;text-align:left">{err}</div>}
          <div class="card" style="text-align:left;margin-top:18px;padding:12px 14px;display:flex;gap:12px;align-items:center">
            <div class="iconbox tone-bad" style="width:36px;height:36px"><Icon name="Trash2" size={18} /></div>
            <div class="grow"><div style="font-weight:700;font-size:14px">{one ? `#${slipNo}${orders[0]?.total != null ? ` · ${money(orders[0].total, true)}` : ''}` : t('del_title_n', ids.length).replace('?', '')}</div>
              <div class="s" style="font-size:12.5px;color:var(--ink-2)">{why}{paid > 0 && moneyChoice ? ` · ${t(moneyChoice === 'never' ? 'del_m_never' : moneyChoice === 'credit' ? 'del_m_credit' : 'del_m_refund')}` : ''}</div></div>
          </div>
          <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:10px">{t('del_code_once')}</div>
        </div>
      )}
    </Sheet>
  );
}

/** Staff: ask an owner to delete this slip. */
export function AskDeleteSheet({ open, o, onClose, onDone }) {
  const [reason, setReason] = useState(null);
  const [other, setOther] = useState('');
  const a = useAction('requestDelete');
  useEffect(() => { if (open) { setReason(null); setOther(''); a.setError(null); } }, [open]);
  const why = reasonText(reason, other);
  return (
    <Sheet open={open} onClose={onClose} title={t('del_ask')}
      footer={<button class="btn btn-accent btn-block" disabled={!why || a.busy} onClick={() => a.run({ order_id: o.id, reason: why }).then(onDone).catch(() => {})}>
        <Icon name="Send" size={18} stroke={2.3} />{t('del_ask_send')}</button>}>
      <div class="muted" style="font-size:14px">#{o.slip_no} · {o.customers?.name} — {t('del_ask_s')}</div>
      <Reason value={reason} other={other} onPick={setReason} onOther={setOther} />
      {a.error && <div class="error" style="margin-top:12px">{a.error.message}</div>}
    </Sheet>
  );
}
