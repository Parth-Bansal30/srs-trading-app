// Phone notifications (the evening summary at 8 pm). The phone gives us an address to send to
// (a "push subscription"); the backend keeps it and sends the evening message there.
import { call } from './api.js';

const b64uToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** 'ok' | 'no_support' | 'needs_install' (iPhone in Safari) | 'blocked' */
export function pushSupport() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return ios && !standalone ? 'needs_install' : 'no_support';
  if (Notification.permission === 'denied') return 'blocked';
  return 'ok';
}

async function registration() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg || navigator.serviceWorker.register('./sw.js');
}

/** Is this phone switched on right now? */
export async function pushIsOn() {
  try {
    if (pushSupport() !== 'ok') return false;
    const reg = await registration();
    return !!(await reg.pushManager.getSubscription()) && Notification.permission === 'granted';
  } catch { return false; }
}

/** Switch notifications on for this phone (must be called from a tap). */
export async function pushOn(publicKey) {
  if (!publicKey) throw Object.assign(new Error('not_ready'), { code: 'not_ready' });
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw Object.assign(new Error('blocked'), { code: 'blocked' });
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const want = b64uToBytes(publicKey);
  const same = sub?.options?.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).every((b, i) => b === want[i]);
  if (sub && !same) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
  return call('savePush', { sub: sub.toJSON(), on: true, ua: navigator.userAgent.slice(0, 300) });
}

/** Switch notifications off for this phone. */
export async function pushOff() {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { on: false };
  const r = await call('savePush', { sub: sub.toJSON(), on: false }).catch(() => ({ on: false }));
  await sub.unsubscribe().catch(() => {});
  return r;
}
