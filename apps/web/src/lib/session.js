// Login steps: mobile number → SMS code → set PIN (first time) → unlock with PIN (every day).
// The SERVER decides every step (login_status); this file only follows it.
import { signal, computed } from '@preact/signals';
import { db } from './backend.js';
import { normalizeIndianMobile } from '@srs/core';
import { setLang } from './i18n.js';
import { store } from './store.js';

/** step: loading | phone | code | set_pin | unlock | not_staff | ready | error */
export const auth = signal({ step: 'loading' });
export const me = computed(() => auth.value.status?.person || null);
export const company = computed(() => auth.value.status?.company || null);
export const can = (perm) => !!me.value?.perms?.[perm];

const set = (patch) => { auth.value = { ...auth.value, error: null, ...patch }; };

export async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return set({ step: 'phone', phone: store.get('phone') || '' });
  return refresh();
}

/** Ask the server where we are. */
export async function refresh(extra = {}) {
  const { data, error } = await db.rpc('login_status');
  if (error) {
    if (/JWT|token|expired|invalid/i.test(error.message || '')) { await db.auth.signOut({ scope: 'local' }); return set({ step: 'phone' }); }
    return set({ step: 'error', error: error.message });
  }
  if (!data?.signed_in) return set({ step: 'phone', status: null });
  if (!data.staff) return set({ step: 'not_staff', status: data });
  if (!auth.value.status && data.person?.lang && !store.get('lang')) setLang(data.person.lang);
  if (data.unlocked && !extra.resetting) return set({ step: 'ready', status: data, resetting: false });
  if (data.can_set_pin && (!data.has_pin || data.blocked || extra.resetting || auth.value.resetting)) return set({ step: 'set_pin', status: data });
  if (!data.has_pin || data.blocked) { // needs a fresh SMS code first
    await db.auth.signOut({ scope: 'local' });
    return set({ step: 'phone', status: null, notice: data.blocked ? 'pin_blocked' : null });
  }
  return set({ step: 'unlock', status: data });
}

export async function sendCode(typed) {
  const phone = normalizeIndianMobile(typed);
  if (!phone) return set({ error: 'login_bad_phone' });
  set({ busy: true });
  const { error } = await db.auth.signInWithOtp({ phone });
  if (error) {
    const msg = error.message || '';
    return set({ busy: false, error: /signup|not allowed|not found/i.test(msg) ? 'login_not_added' : error.status === 429 || /rate|second/i.test(msg) ? 'login_wait' : 'err_generic' });
  }
  store.set('phone', phone.slice(3));
  set({ step: 'code', phone, busy: false, sentAt: Date.now() });
}

export async function verifyCode(code) {
  set({ busy: true });
  const { error } = await db.auth.verifyOtp({ phone: auth.value.phone, token: String(code).trim(), type: 'sms' });
  if (error) return set({ busy: false, error: 'login_bad_code' });
  set({ busy: false });
  return refresh();
}

/** Returns an error text (from the server rules, e.g. "too easy") or null. */
export async function setPin(pin) {
  const { data, error } = await db.rpc('set_pin', { p_pin: pin });
  if (error) return error.message;
  set({ step: 'ready', status: data, resetting: false });
  return null;
}

/** Returns { ok } or { reason, attempts_left, locked_until }. */
export async function unlock(pin) {
  const { data, error } = await db.rpc('unlock', { p_pin: pin });
  if (error) return { reason: 'error', message: error.message };
  if (data.ok) { set({ step: 'ready', status: data }); return { ok: true }; }
  if (data.reason === 'blocked' || data.reason === 'no_pin') { await db.auth.signOut({ scope: 'local' }); set({ step: 'phone', status: null, notice: 'pin_blocked' }); }
  return data;
}

export async function lock() {
  await db.rpc('lock_session');
  set({ step: 'unlock' });
}

export async function forgotPin() {
  await db.auth.signOut({ scope: 'local' });
  set({ step: 'phone', status: null, resetting: true });
}

export async function logOut() {
  try { await db.rpc('lock_session'); } catch { /* offline is fine */ }
  await db.auth.signOut({ scope: 'local' });
  set({ step: 'phone', status: null });
}

// The PIN unlock lasts a working day; re-check when the app comes back to the screen.
addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && auth.value.step === 'ready') refresh(); });
