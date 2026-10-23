// Waiting to send (23 Oct 2026): everything made on this phone without internet, oldest first. It goes by
// itself when the internet is back; here the person can send now, try a refused one again, or remove one.
// Address: #/waiting
import { useState } from 'preact/hooks';
import { t } from '../lib/i18n.js';
import { company, unlockToSend } from '../lib/session.js';
import { online } from '../lib/net.js';
import { outbox, sending, needUnlock, flush, retry, discard } from '../lib/offline/outbox.js';
import { blockedBy } from '../lib/offline/overlay.js';
import { money, time, shortDate } from '../lib/format.js';
import { go } from '../lib/router.js';
import { toast } from '../ui/toast.js';
import { Icon, TopBar } from '../ui/kit.jsx';

const ICON = { createOrder: 'ReceiptText', createCustomer: 'UserPlus', acceptOrder: 'Check', addAdvance: 'HandCoins', recordWeights: 'Scale',
  finalizeOrder: 'PackageCheck', recordPayment: 'IndianRupee', saveExpense: 'Receipt', saveTransfer: 'ArrowRightLeft', saveCashCount: 'ClipboardCheck' };

/** One line about an entry: who / how much / which slip. */
export function entryLine(e) {
  const a = e.args || {}; const m = e.meta || {};
  const slip = m.localNo || m.slipNo ? `#${m.slipNo || m.localNo}` : '';
  switch (e.op) {
    case 'createOrder': return [m.localNo ? t('off_slip_no', m.localNo) : '', m.order?.customers?.name].filter(Boolean).join(' · ');
    case 'createCustomer': return a.name || '';
    case 'recordPayment': return [m.payment?.customer || '', money(Number(a.amount), false)].filter(Boolean).join(' · ');
    case 'saveExpense': return [m.expense ? (m.expense.paid_to || '') : '', money(Number(a.amount), false)].filter(Boolean).join(' · ');
    case 'saveTransfer': return [`${m.transfer?.from || ''} → ${m.transfer?.to || ''}`, money(Number(a.amount), false)].join(' · ');
    case 'saveCashCount': return money(Number(a.counted), false);
    case 'addAdvance': return [slip, money(Number(a.amount), false)].filter(Boolean).join(' · ');
    default: return [slip, m.customer].filter(Boolean).join(' · ');
  }
}

export function Waiting() {
  const tz = company.value?.timezone || 'Asia/Kolkata';
  const list = outbox.value;
  const blocked = blockedBy(list);
  const sendNow = async () => {
    if (needUnlock.value) { unlockToSend(); return; }
    const r = await flush();
    if (r.sent) toast(t('off_sent_n', r.sent));
    else if (!online.value) toast(t('off_needs_net'));
  };
  const [asking, setAsking] = useState(null);   // the entry whose "Remove" was tapped once
  const remove = async (e) => {
    if (asking !== e.id) { setAsking(e.id); return; }
    setAsking(null);
    const gone = await discard(e.id);
    toast(t('off_removed_n', gone.length));
  };
  return (
    <>
      <TopBar title={t('off_title')} sub={t('off_title_s')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 110px)">
        <div class={`notice ${online.value ? 'tone-ok' : 'tone-warn'} row`} style="gap:10px">
          <Icon name={online.value ? 'Wifi' : 'WifiOff'} size={18} />
          <span class="grow">{online.value ? (needUnlock.value ? t('off_need_unlock_s') : t('off_online')) : t('off_offline_s')}</span>
        </div>
        {!list.length ? (
          <div class="card pad row" style="gap:10px;margin-top:12px;color:var(--ok);font-weight:700"><Icon name="CloudCheck" size={20} />{t('off_none')}</div>
        ) : (
          <div class="card" style="margin-top:12px">
            {list.map((e) => {
              const isBlocked = e.status === 'blocked' || (blocked.get(e.id) || []).some((id) => list.some((x) => x.id === id));
              const state = e.status === 'failed' ? 'failed' : e.status === 'sending' ? 'sending' : isBlocked ? 'blocked' : 'waiting';
              return (
                <div class="li" style="align-items:flex-start">
                  <div class={`iconbox tone-${state === 'failed' ? 'bad' : state === 'sending' ? 'accent' : 'neutral'}`}><Icon name={ICON[e.op] || 'CloudUpload'} size={18} /></div>
                  <div class="grow" style="min-width:0">
                    <div class="t">{t(`off_kind_${e.op}`)}</div>
                    <div class="s ellip">{entryLine(e)}</div>
                    <div class="s">{shortDate(e.args?.offline_at || e.at, tz)} · {time(e.args?.offline_at || e.at, tz)} · <b style={`color:var(--${state === 'failed' ? 'bad' : 'ink-2'})`}>{t(state === 'failed' ? 'off_failed' : state === 'sending' ? 'off_sending' : state === 'blocked' ? 'off_blocked' : 'off_waiting')}</b></div>
                    {state === 'failed' && <div class="notice tone-bad" style="margin-top:6px;font-size:13px">{t('off_failed_s', e.error?.message || '')}</div>}
                    {asking === e.id && <div class="notice tone-warn" style="margin-top:6px;font-size:13px">{t('off_discard_q')}</div>}
                    <div class="row" style="gap:14px">
                      {state === 'failed' && <button class="link" onClick={() => retry(e.id)}><Icon name="RotateCcw" size={15} />{t('off_retry')}</button>}
                      {state !== 'sending' && <button class="link" style="color:var(--bad)" onClick={() => remove(e)}><Icon name="Trash2" size={15} />{asking === e.id ? t('off_discard_sure') : t('off_discard')}</button>}
                      {e.op === 'createOrder' && <button class="link" onClick={() => go(`/slip/${e.args.order_id}`)}>{t('see')}</button>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {list.length > 0 && (
        <div class="actionbar">
          <button class="btn btn-brand btn-block" disabled={sending.value} onClick={sendNow}><Icon name={needUnlock.value ? 'Lock' : 'CloudUpload'} size={20} />
            {sending.value ? t('off_sending') : needUnlock.value ? t('off_need_unlock') : t('off_send_now')}</button>
        </div>
      )}
    </>
  );
}
