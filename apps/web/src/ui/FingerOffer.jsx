// "Unlock with Face ID / fingerprint next time?" — asked once per person per phone, right after the PIN was
// accepted (the server lets fingerprint be switched on only within 10 minutes of a PIN). Only on phones /
// laptops that have a fingerprint or face lock.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n.js';
import { auth, pinJustNow, fingerOn, fingerAsked, fingerNotNow, switchOnFinger, prepareFinger, reconnectFinger } from '../lib/session.js';
import { devicePeople } from '../lib/device.js';
import { passkeyReady, bt, bioIcon, bioWaiting } from '../lib/passkey.js';
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

/**
 * Switch it on (shared by the offer and More). Returns true when it is on, false when not, or 'have' / 'maybe' when
 * the phone already has (or may have) this person's key — then show <UseKey> ("Use it with Face ID").
 */
export async function turnFingerOn() {
  try {
    await switchOnFinger(deviceLabel());
    toast(bt('fp_on_done'));
    return true;
  } catch (e) {
    if (e?.hasKeys && e?.name === 'InvalidStateError') return 'have';
    if (e?.hasKeys && e?.name === 'NotAllowedError') return 'maybe';
    if (e?.code === 'pin_required' || e?.status === 401 || e?.status === 403) toast(bt('fp_pin_first'), 5000);
    else if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') toast(t('fp_failed'));
    else if (e?.name === 'InvalidStateError') toast(bt('fp_already'));
    else toast(e?.message || t('fp_failed'));
    return false;
  }
}

/** "Use it with Face ID": keep the key this phone already has (one Face ID check). Returns true when it is on. */
export async function useKeyOnPhone() {
  try {
    await reconnectFinger();
    toast(bt('fp_on_done'));
    return true;
  } catch (e) {
    toast(e?.code === 'no_key' ? t('fp_failed') : e?.name === 'NotAllowedError' ? bt('fp_use_pin') : e?.message || t('fp_failed'), 5000);
    return false;
  }
}

/** The box shown when the phone already has (sure = 'have') or may have ('maybe') this person's key. */
export function UseKey({ kind, onDone, inSheet = false }) {
  const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); const ok = await useKeyOnPhone(); setBusy(false); if (ok) onDone?.(); };
  return (
    <div class={inSheet ? '' : 'notice tone-accent'} style={inSheet ? '' : 'margin-top:12px'}>
      <div style="font-weight:800;font-size:15px">{bt(kind === 'have' ? 'fp_have_t' : 'fp_maybe_t')}</div>
      <div style="font-size:13.5px;margin-top:4px;line-height:1.45">{bt(kind === 'have' ? 'fp_have_s' : 'fp_maybe_s')}</div>
      <button class="btn btn-brand btn-block fp-btn" style="margin-top:10px" disabled={busy} onClick={go}>
        <Icon name={bioIcon()} size={22} stroke={2} />{busy ? bioWaiting() : bt('fp_use_key')}
      </button>
    </div>
  );
}

export function FingerOffer() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(null);   // 'have' | 'maybe' — the phone already has the key
  const when = pinJustNow.value;
  useEffect(() => {
    if (!when || auth.value.step !== 'ready' || !online.value || fingerOn() || fingerAsked()) return;
    let live = true;
    passkeyReady().then((ok) => { if (live && ok && Date.now() - when < 9 * 60000) { prepareFinger('register'); setShow(true); } });
    return () => { live = false; };
  }, [when, auth.value.step]);
  if (!show) return null;
  const shared = devicePeople.value.length > 1;
  const yes = async () => { setBusy(true); const ok = await turnFingerOn(); setBusy(false); if (ok === true) setShow(false); else if (ok) setKey(ok); };
  const no = () => { fingerNotNow(); setShow(false); };
  return (
    <Sheet open={show} onClose={no} title={bt('fp_offer_t')}
      footer={key ? <button class="btn btn-ghost btn-block" onClick={no}>{t('fp_not_now')}</button> : <div class="row" style="gap:10px">
        <button class="btn btn-ghost grow" onClick={no}>{t('fp_not_now')}</button>
        <button class="btn btn-brand grow" disabled={busy} onClick={yes}><Icon name={bioIcon()} size={20} />{busy ? bioWaiting() : t('fp_switch_on')}</button>
      </div>}>
      {key ? <UseKey kind={key} inSheet onDone={() => setShow(false)} /> : <>
      <div class="row" style="gap:14px;align-items:flex-start">
        <div class="iconbox tone-accent" style="width:56px;height:56px;border-radius:18px"><Icon name={bioIcon()} size={32} stroke={1.8} /></div>
        <div class="grow muted" style="font-size:15px;line-height:1.5">{t('fp_offer_s')}</div>
      </div>
      {shared && <div class="notice tone-warn" style="margin-top:14px;font-size:13.5px">{bt('fp_shared')}</div>}
      </>}
    </Sheet>
  );
}
