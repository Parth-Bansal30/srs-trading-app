// The thin bar at the top of every screen when there is no internet, or entries are waiting to be sent.
// Tap → the "Waiting to send" list. It also keeps trying to send what is waiting.
import { useEffect } from 'preact/hooks';
import { t } from '../lib/i18n.js';
import { online } from '../lib/net.js';
import { fromCache } from '../lib/offline/cache.js';
import { outbox, sending, needUnlock, flush, sentSlips, billChanged } from '../lib/offline/outbox.js';
import { money } from '../lib/format.js';
import { unlockToSend, company } from '../lib/session.js';
import { go } from '../lib/router.js';
import { time } from '../lib/format.js';
import { toast } from './toast.js';
import { Icon } from './kit.jsx';

let shown = {};
export function OfflineBar({ path }) {
  const n = outbox.value.length;
  // keep trying while something waits (the phone often says "online" before the internet really works)
  useEffect(() => {
    if (!n || !online.value) return undefined;
    flush();
    const id = setInterval(() => { if (online.value && !needUnlock.value) flush(); }, 30000);
    return () => clearInterval(id);
  }, [n > 0, online.value]);
  // "Phone slip P3 is now #1072"
  useEffect(() => {
    for (const [id, x] of Object.entries(sentSlips.value)) if (!shown[id]) { shown[id] = true; toast(t('off_sent_slip', x.local, x.no)); }
  }, [sentSlips.value]);

  // a bill finished without internet came out different on the server (a rate changed meanwhile): say it plainly
  const changed = billChanged.value;
  if (changed.length) {
    const c = changed[0];
    return (
      <button class="offbar tone-warn" onClick={() => { billChanged.value = changed.slice(1); go(`/slip/${c.orderId}`); }}>
        <Icon name="TriangleAlert" size={16} stroke={2.4} /><span class="grow"><b>{t('off_bill_changed', c.slipNo || '', money(c.server, true), money(c.phone, true))}</b></span><Icon name="ChevronRight" size={16} />
      </button>
    );
  }
  if (online.value && !n) return null;
  if (path === '/waiting' && online.value) return null;
  const tz = company.value?.timezone || 'Asia/Kolkata';
  if (online.value && needUnlock.value) {
    return (
      <button class="offbar tone-warn" onClick={unlockToSend}>
        <Icon name="Lock" size={16} stroke={2.4} /><span class="grow"><b>{t('off_need_unlock')}</b> · {t('off_waiting_n', n)}</span><Icon name="ChevronRight" size={16} />
      </button>
    );
  }
  if (online.value) {
    return (
      <button class="offbar tone-accent" onClick={() => go('/waiting')}>
        <Icon name={sending.value ? 'LoaderCircle' : 'CloudUpload'} size={16} stroke={2.4} class={sending.value ? 'spin' : ''} />
        <span class="grow"><b>{sending.value ? t('off_sending') : t('off_waiting_n', n)}</b></span><Icon name="ChevronRight" size={16} />
      </button>
    );
  }
  return (
    <button class="offbar tone-off" onClick={() => go('/waiting')}>
      <Icon name="WifiOff" size={16} stroke={2.4} />
      <span class="grow"><b>{t('off_bar')}</b>{fromCache.value ? <span class="offbar-s"> · {t('off_bar_last', time(fromCache.value, tz))}</span> : null}</span>
      {n > 0 && <span class="offbar-n">{t('off_waiting_n', n)}</span>}
    </button>
  );
}
