// "Unlock with your fingerprint next time?" — asked once per person per phone, right after the PIN was
// accepted (the server lets fingerprint be switched on only within 10 minutes of a PIN). Only on phones /
// laptops that have a fingerprint or face lock.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n.js';
import { auth, pinJustNow, fingerOn, fingerAsked, fingerNotNow, switchOnFinger } from '../lib/session.js';
import { devicePeople } from '../lib/device.js';
import { passkeyReady } from '../lib/passkey.js';
import { online } from '../lib/net.js';
import { toast } from './toast.js';
import { Icon } from './kit.jsx';
import { Sheet } from './Sheet.jsx';

export const deviceLabel = () => {
  const ua = navigator.userAgent || '';
  const m = ua.match(/\(([^;)]+);?\s*([^;)]*)/);
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) { const model = ua.match(/Android[^;]*;\s*([^;)]+)/); return model ? model[1].trim().slice(0, 40) : 'Android phone'; }
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows laptop';
  return (m && m[1]) || 'Phone';
};

/** Switch it on (shared by the offer and More). Returns true when it is on. */
export async function turnFingerOn() {
  try {
    await switchOnFinger(deviceLabel());
    toast(t('fp_on_done'));
    return true;
  } catch (e) {
    if (e?.code === 'pin_required' || e?.status === 401 || e?.status === 403) toast(t('fp_pin_first'), 5000);
    else if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') toast(t('fp_failed'));
    else if (e?.name === 'InvalidStateError') toast(t('fp_already'));
    else toast(e?.message || t('fp_failed'));
    return false;
  }
}

export function FingerOffer() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const when = pinJustNow.value;
  useEffect(() => {
    if (!when || auth.value.step !== 'ready' || !online.value || fingerOn() || fingerAsked()) return;
    let live = true;
    passkeyReady().then((ok) => { if (live && ok && Date.now() - when < 9 * 60000) setShow(true); });
    return () => { live = false; };
  }, [when, auth.value.step]);
  if (!show) return null;
  const shared = devicePeople.value.length > 1;
  const yes = async () => { setBusy(true); const ok = await turnFingerOn(); setBusy(false); if (ok) setShow(false); };
  const no = () => { fingerNotNow(); setShow(false); };
  return (
    <Sheet open={show} onClose={no} title={t('fp_offer_t')}
      footer={<div class="row" style="gap:10px">
        <button class="btn btn-ghost grow" onClick={no}>{t('fp_not_now')}</button>
        <button class="btn btn-brand grow" disabled={busy} onClick={yes}><Icon name="Fingerprint" size={20} />{busy ? t('fp_touch') : t('fp_switch_on')}</button>
      </div>}>
      <div class="row" style="gap:14px;align-items:flex-start">
        <div class="iconbox tone-accent" style="width:56px;height:56px;border-radius:18px"><Icon name="Fingerprint" size={32} stroke={1.8} /></div>
        <div class="grow muted" style="font-size:15px;line-height:1.5">{t('fp_offer_s')}</div>
      </div>
      {shared && <div class="notice tone-warn" style="margin-top:14px;font-size:13.5px">{t('fp_shared')}</div>}
    </Sheet>
  );
}
