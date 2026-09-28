// Getting in: welcome → mobile number → SMS code → (register a business | join from an invite)
// → PIN. Every day: who is using? → PIN. The SERVER decides every step (login_status); this
// file only follows it and remembers who has used this phone (device.js).
import { signal, computed } from '@preact/signals';
import { db } from './backend.js';
import { normalizeIndianMobile } from '@srs/core';
import { setLang } from './i18n.js';
import { store } from './store.js';
import { replace } from './router.js';
import { devicePeople, remember, keepTokens, touch, forget } from './device.js';

/**
 * step: loading | welcome | tour | who | phone | code | not_staff | register | joining | set_pin | unlock | ready | error
 * mode: login | signup | join   (which door the person came in through)
 */
export const auth = signal({ step: 'loading', mode: 'login' });
export const me = computed(() => auth.value.status?.person || null);
export const company = computed(() => auth.value.status?.company || null);
/** Permission check for the screens. A business that makes no estimates never sees that choice. */
export const can = (perm) => (perm === 'kacha' && company.value?.estimates === false ? false : !!me.value?.perms?.[perm]);

const set = (patch) => { auth.value = { ...auth.value, error: null, ...patch }; };
const start = () => (devicePeople.value.length ? 'who' : 'welcome');

// Keep every person's newest login tokens (the active one refreshes itself in the background).
db.auth.onAuthStateChange((event, session) => {
  if (session && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) keepTokens(session);
});

export async function boot() {
  const { data: { session } } = await db.auth.getSession();
  const joining = /^#\/join/.test(location.hash);
  if (joining) replace('/'); // the invite link only picks the door; after login the app starts on Today
  if (!session) return set({ step: joining ? 'phone' : start(), mode: joining ? 'join' : 'login', phone: '' });
  return refresh({ boot: true });
}

/** Ask the server where we are. */
export async function refresh(extra = {}) {
  const { data, error } = await db.rpc('login_status');
  if (error) {
    if (/JWT|token|expired|invalid/i.test(error.message || '')) { await db.auth.signOut({ scope: 'local' }); return set({ step: start() }); }
    return set({ step: 'error', error: error.message });
  }
  if (!data?.signed_in) return set({ step: start(), status: null });

  if (!data.staff) {
    // Invited by an owner? A fresh SMS code links this number to its staff record.
    if (!extra.claimed && data.can_register) {
      const { data: linked } = await db.rpc('join_by_phone');
      if (linked > 0) return refresh({ ...extra, claimed: true });
    }
    if (auth.value.mode === 'signup' && data.can_register) return set({ step: 'register', status: data });
    return set({ step: 'not_staff', status: data });
  }

  if (!auth.value.status && data.person?.lang && !store.get('lang')) setLang(data.person.lang);
  if (data.unlocked && !extra.resetting && !auth.value.resetting) return ready(data);
  if (data.can_set_pin && (!data.has_pin || data.blocked || extra.resetting || auth.value.resetting)) {
    return set({ step: !data.has_pin && !auth.value.resetting ? 'joining' : 'set_pin', status: data });
  }
  if (!data.has_pin || data.blocked) { // needs a fresh SMS code first
    const { data: { session } } = await db.auth.getSession();
    await db.auth.signOut({ scope: 'local' });
    if (session) forget(session.user.id);
    return set({ step: 'phone', mode: 'login', status: null, notice: data.blocked ? 'pin_blocked' : null });
  }
  if (extra.boot && devicePeople.value.length > 1) return set({ step: 'who', status: data });
  return set({ step: 'unlock', status: data });
}

async function ready(status, patch = {}) {
  const { data: { session } } = await db.auth.getSession();
  remember(session, status);
  // A different person on this phone starts on Today, not on the last person's screen.
  if (status?.person?.id && store.get('last_person') !== status.person.id) { store.set('last_person', status.person.id); replace('/'); }
  set({ step: 'ready', status, resetting: false, ...patch });
}

// ---------- the doors on the welcome screen ----------
export const openDoor = (mode) => set({ step: mode === 'signup' ? 'tour' : 'phone', mode, notice: null });
export const goPhone = () => set({ step: 'phone', notice: null });
export const goBack = () => set({ step: start(), notice: null });

export async function sendCode(typed) {
  const phone = normalizeIndianMobile(typed);
  if (!phone) return set({ error: 'login_bad_phone' });
  set({ busy: true });
  // Someone else is signed in on this phone: lock them first (they stay on "Who is using?").
  const { data: { session } } = await db.auth.getSession();
  if (session && session.user.phone !== phone.slice(1)) { try { await db.rpc('lock_session'); } catch { /* offline is fine */ } }
  const { error } = await db.auth.signInWithOtp({ phone });
  if (error) {
    const msg = error.message || '';
    const why = error.status === 429 || /rate|second/i.test(msg) ? 'login_wait'
      : /sms|provider|twilio|messagebird|vonage|textlocal|send/i.test(msg) && import.meta.env.MODE !== 'production' ? 'login_sms_off'
      : 'err_generic';
    return set({ busy: false, error: why });
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

/** Register a new business (all details + the owner's PIN in one go). Returns null, 'code' or an error text. */
export async function registerCompany(form, pin) {
  const { data, error } = await db.rpc('register_company', { p: form, p_pin: pin });
  if (error) {
    if (error.code === '42501' && /code|confirm/i.test(error.message || '')) return 'code';
    return error.message || 'err_generic';
  }
  if (!data?.staff) return 'err_generic';
  await ready(data, { justRegistered: true });
  return null;
}

/** The SMS code got too old while filling the form: send a new one, then come back to the form. */
export async function reconfirmNumber() {
  const { data } = await db.rpc('login_status');
  set({ mode: 'signup' });
  return sendCode(data?.phone || auth.value.phone || '');
}

// ---------- PIN ----------
/** Returns an error text (from the server rules, e.g. "too easy") or null. */
export async function setPin(pin) {
  const { data, error } = await db.rpc('set_pin', { p_pin: pin });
  if (error) return error.message;
  await ready(data);
  return null;
}

/** Returns { ok } or { reason, attempts_left, locked_until }. */
export async function unlock(pin) {
  const { data, error } = await db.rpc('unlock', { p_pin: pin });
  if (error) return { reason: 'error', message: error.message };
  if (data.ok) { await ready(data); return { ok: true }; }
  if (data.reason === 'blocked' || data.reason === 'no_pin') {
    const { data: { session } } = await db.auth.getSession();
    await db.auth.signOut({ scope: 'local' });
    if (session) forget(session.user.id);
    set({ step: 'phone', mode: 'login', status: null, notice: 'pin_blocked' });
  }
  return data;
}

export async function lock() {
  await db.rpc('lock_session');
  set({ step: devicePeople.value.length > 1 ? 'who' : 'unlock' });
}

export async function forgotPin() {
  const { data: { session } } = await db.auth.getSession();
  await db.auth.signOut({ scope: 'local' });
  if (session) forget(session.user.id);
  set({ step: 'phone', mode: 'login', status: null, resetting: true, phone: session?.user?.phone ? `+${session.user.phone}` : '' });
}

// ---------- shared phone: switch between people ----------
/** "Who is using?" → tap a person → their PIN. */
export async function switchTo(person) {
  const { data: { session } } = await db.auth.getSession();
  if (session?.user?.id === person.uid) { touch(person.uid); if (person.lang) setLang(person.lang); return refresh(); }
  if (session) { try { await db.rpc('lock_session'); } catch { /* offline is fine */ } keepTokens(session); }
  const { data, error } = await db.auth.setSession({ access_token: person.access_token, refresh_token: person.refresh_token });
  if (error || !data?.session) { // that login ended (logged out elsewhere / deactivated): prove the number again
    forget(person.uid);
    return set({ step: 'phone', mode: 'login', status: null, phone: person.phone, notice: null });
  }
  touch(person.uid);
  if (person.lang) setLang(person.lang);
  return refresh();
}

/** Lock the current person and show "Who is using?". */
export async function switchPerson() {
  try { await db.rpc('lock_session'); } catch { /* offline is fine */ }
  set({ step: 'who', status: null });
}

/** "Someone new" on a shared phone: the current person stays saved; the new one proves their number. */
export async function addPerson() {
  try { await db.rpc('lock_session'); } catch { /* offline is fine */ }
  set({ step: 'phone', mode: 'login', status: null, phone: '', notice: null });
}

/** Log this person out of this phone completely. */
export async function logOut() {
  const { data: { session } } = await db.auth.getSession();
  try { await db.rpc('lock_session'); } catch { /* offline is fine */ }
  await db.auth.signOut({ scope: 'local' });
  if (session) forget(session.user.id);
  set({ step: start(), mode: 'login', status: null });
}

// The PIN unlock lasts a working day; re-check when the app comes back to the screen.
addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && auth.value.step === 'ready') refresh(); });
