// The ₹2 lakh cash rule on every "money received" sheet (5 Nov 2026, plan v2 F8).
// Before saving, the sheet asks the server how much more cash this customer may give today / for this slip and, when
// the cash part is too much, stops the save with a plain box: how much cash is allowed, a one-tap split (the allowed
// cash + the rest by UPI / bank). Staff can never save it. Only the owner can record cash that was really already
// handed over, with what happened — it goes to "To check" for the CA (Parth's D4). Without internet nothing is
// stopped here: the server keeps the entry and flags it when it is sent.
import { useEffect, useRef, useState } from 'preact/hooks';
import { cashCheck } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { online } from '../../lib/net.js';
import { money } from '../../lib/format.js';
import { cashPartOf, lastAccount } from '../../lib/accounts.js';
import { Icon } from '../kit.jsx';
import './money.css';

const isCashAcc = (a) => !!a && (a.is_drawer || a.kind === 'cash' || a.kind === 'safe');

/**
 * useCashRule({ open, customerId, orderId, amount, where, setWhere, accounts })
 *   → { box, blocked, args }: show `box` under the money list, disable Save while `blocked`, spread `args` into the call.
 */
export function useCashRule({ open, customerId, orderId = null, amount, where, setWhere, accounts }) {
  const [room, setRoom] = useState(null);
  const [taken, setTaken] = useState(false);
  const [reason, setReason] = useState('');
  const boxRef = useRef(null);
  useEffect(() => {
    setRoom(null); setTaken(false); setReason('');
    if (!open || !customerId || !online.value || !can('money')) return;
    let live = true;
    call('cashRoom', { customer_id: customerId, ...(orderId ? { order_id: orderId } : {}) }).then((r) => { if (live) setRoom(r); }).catch(() => {});
    return () => { live = false; };
  }, [open, customerId, orderId]);

  const total = Number(amount) || 0;
  const cash = cashPartOf(where, total, accounts);
  const chk = room && cash > 0 ? cashCheck(cash, room.room, total) : null;
  const over = !!chk?.over;
  const owner = can('settings');
  const reasonOk = reason.trim().length >= 5;
  const blocked = over && !(owner && taken && reasonOk);
  // the box may be below a long list of accounts: bring it into view when it first shows
  useEffect(() => { if (over) requestAnimationFrame(() => boxRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })); }, [over]);
  const args = over && owner && taken && reasonOk ? { cash_reason: reason.trim() } : {};

  // the one-tap split: the allowed cash stays where it is, the rest goes to a UPI / bank account
  const usable = (accounts || []).filter((a) => a.usable !== false);
  const cashId = where?.ids?.find((id) => isCashAcc(usable.find((a) => a.id === id))) || usable.find((a) => a.is_drawer)?.id;
  const others = usable.filter((a) => !isCashAcc(a));
  const otherId = where?.ids?.find((id) => others.some((a) => a.id === id)) || others.find((a) => a.id === lastAccount())?.id
    || others.find((a) => a.kind === 'upi')?.id || others[0]?.id;
  const canFix = over && !!where && (where.ids ? !!otherId : chk.keep === 0);
  const fix = () => {
    if (!where.ids) { setWhere({ mode: 'UPI' }); return; }
    if (chk.keep > 0 && cashId) {
      setWhere({ ...where, ids: [cashId, otherId], amounts: { [cashId]: String(chk.keep), [otherId]: String(Math.round((total - chk.keep) * 100) / 100) }, split: true, auto: otherId,
        methods: Object.fromEntries(Object.entries(where.methods || {}).filter(([k]) => k === otherId)) });
    } else setWhere({ ...where, ids: [otherId], split: false, amounts: {}, auto: undefined });
  };
  const otherAcc = usable.find((a) => a.id === otherId);

  const box = over && (
    <div class="cash-rule" ref={boxRef}>
      <div class="t"><Icon name="Banknote" size={17} /> {t('cash_t')}</div>
      <div class="s">{room.slip > room.day ? t('cash_slip_had', money(room.slip)) : t('cash_day_had', money(room.day))}</div>
      <div class="s" style="margin-top:4px"><b>{chk.keep > 0 ? t('cash_room', money(chk.keep), money(total - chk.keep)) : t('cash_no_room', money(total))}</b></div>
      {canFix && <button class="btn btn-brand btn-block" style="margin-top:10px" onClick={fix}>
        <Icon name="Split" size={17} />{chk.keep > 0 ? t('cash_fix', money(chk.keep), money(total - chk.keep), otherAcc?.name || 'UPI') : t('cash_fix_all', otherAcc?.name || 'UPI')}</button>}
      {!canFix && where?.ids && <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:6px">{t('cash_need_acc')}</div>}
      <div class="faint" style="font-size:12px;font-weight:600;margin-top:8px">{t('cash_why')}</div>
      {owner ? (
        <>
          <label class="cash-taken"><input type="checkbox" checked={taken} onChange={(e) => setTaken(e.currentTarget.checked)} /><span>{t('cash_taken')}</span></label>
          {taken && <>
            <input class="textarea" style="margin-top:8px" value={reason} onInput={(e) => setReason(e.currentTarget.value)} placeholder={t('cash_reason_ph')} />
            <div class="faint" style="font-size:12px;font-weight:600;margin-top:4px">{t('cash_reason_s')}</div>
          </>}
        </>
      ) : <div class="s" style="margin-top:8px">{t('cash_staff')}</div>}
    </div>
  );
  return { box: box || null, blocked, args, over };
}

/** The server stopped it (no room known before, e.g. two phones at once): a short plain line. */
export const isCashStop = (e) => e?.code === 'cash_limit';
