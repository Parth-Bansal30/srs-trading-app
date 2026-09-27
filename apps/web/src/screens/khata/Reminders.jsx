// Reminders: the app lists who to remind (slips unpaid for N days) and ASKS. Nothing goes out without "Send".
// The message is written by the backend from the real figures and never names the bill type.
import { useEffect, useState } from 'preact/hooks';
import { t, lang } from '../../lib/i18n.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { loadCatalog } from '../../lib/catalog.js';
import { money } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { APP } from '../../config/app.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';

export function Reminders() {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [after, setAfter] = useState(25);
  const load = () => call('reminderList', { lang: lang.value }).then(setList).catch(() => setList([]));
  useEffect(() => { load(); loadCatalog().then((c) => setAfter(c.settings?.reminder_after_days ?? 25)); }, []);
  return (
    <>
      <TopBar title={t('nav_reminders')} sub={list ? `${list.length}` : ''} />
      <div class="page">
        {!list ? <Skeleton h={90} /> : list.length === 0 ? (
          <div class="card li"><div class="iconbox tone-ok"><Icon name="CircleCheck" /></div>
            <div class="grow"><div class="t">{t('rem_none')}</div><div class="s">{t('rem_none_s', after)}</div></div></div>
        ) : (
          <div class="card">
            {list.map((x) => (
              <button class="li" onClick={() => setOpen(x)}>
                <div class="iconbox tone-bad"><Icon name="BellRing" size={18} /></div>
                <div class="grow"><div class="t ellip">{x.customer.name}</div>
                  <div class="s">{t('n_days', x.oldest_days)} · {x.slips.length} {t('nav_slips').toLowerCase()} · {t(x.side === 'pakka' ? 'bill_gst_short' : 'bill_none_short')}</div></div>
                <div class="num" style="font-weight:800">{money(x.due, false)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
      {open && <ReminderSheet customer={open.customer} side={open.side} sides={[open.side]} onClose={() => setOpen(null)} onSent={() => { setOpen(null); load(); }} />}
    </>
  );
}

/** Preview → choose language → Send on WhatsApp (logged, then WhatsApp opens with the text). */
export function ReminderSheet({ customer, side: firstSide, sides, onClose, onSent }) {
  const [side, setSide] = useState(firstSide);
  const [l, setL] = useState(lang.value);
  const [p, setP] = useState(null);
  const send = useAction('sendReminder');
  useEffect(() => { setP(null); call('reminderPreview', { customer_id: customer.id, side, lang: l }).then(setP).catch((e) => setP({ error: e.message })); }, [side, l]);
  const go_ = async () => {
    const r = await send.run({ customer_id: customer.id, side, lang: l }).catch(() => null);
    if (!r) return;
    window.open(r.whatsapp_link, '_blank');
    toast(t('done_ok'));
    onSent?.();
  };
  return (
    <Sheet open onClose={onClose} title={t('rem_title')}
      footer={p && !p.error && (p.has_phone
        ? <div class="row"><button class="btn btn-ghost" onClick={onClose}>{t('not_now')}</button><button class="btn btn-wa grow" disabled={send.busy} onClick={go_}><Icon name="MessageCircle" size={20} stroke={2.4} />{t('rem_send')}</button></div>
        : <button class="btn btn-ghost btn-block" onClick={() => go(`/customer/${customer.id}`)}>{t('rem_no_phone')}</button>)}>
      <div class="muted" style="margin-bottom:12px">{p?.slips ? t('rem_sub', customer.name, p.slips.length, p.oldest_days) : customer.name}</div>
      {sides.length > 1 && <div class="seg" style="margin-bottom:10px"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}</button></div>}
      <div class="pick" style="margin-bottom:10px">{APP.languages.map((x) => <button class={l === x.id ? 'on' : ''} onClick={() => setL(x.id)}>{x.label}</button>)}</div>
      {!p ? <Skeleton h={160} /> : p.error ? <div class="error">{p.error}</div> : (
        <div class="wa-bubble">{p.preview}<div class="wa-meta">{t('preview')}</div></div>
      )}
      {p?.has_phone && <div class="faint" style="font-size:12px;font-weight:600;margin-top:10px">{t('rem_goes_to', customer.phone, p.repeat_days)}</div>}
      {send.error && <div class="error">{send.error.message}</div>}
    </Sheet>
  );
}
