// Getting in: welcome → mobile number → SMS code → (register a business | join from an invite)
// → PIN. Every day: who is using? → PIN. The SERVER decides every step (login_status); this
// file only follows it and remembers who has used this phone (device.js).
import { signal, computed } from '@preact/signals';
import { db, storedSession } from './backend.js';
import { normalizeIndianMobile } from '@srs/core';
import { setLang } from './i18n.js';
import { store } from './store.js';
import { replace } from './router.js';
import { devicePeople, remember, keepTokens, touch, forget, setPersonExtra, personOf } from './device.js';
import { online, whenOnline, markOffline } from './net.js';
import { setCacheOwner, forgetPerson } from './offline/cache.js';
import { loadOutbox, flush, needUnlock, outbox, forgetOutbox } from './offline/outbox.js';
import { pinCopy, pinMatches } from './offline/pin.js';
import { unlockOnline, unlockOffline, registerPasskey, prepare } from './passkey.js';
import { call } from './api.js';
import { warmUp } from './offline/warm.js';
import { lockAfterOf, shouldLock, noteHidden, takeLeaving, clearLeaving, watchLeavingOnPurpose } from './autolock.js';

/**
 * step: loading | welcome | tour | who | phone | code | not_staff | register | joining | set_pin | unlock | ready | error
 * mode: login | signup | join   (which door the person came in through)
 */
export const auth = signal({ step: 'loading', mode: 'login' });
export const me = computed(() => auth.value.status?.person || null);
export const company = computed(() => auth.value.status?.company || null);
/** Permission check for the screens. A business that makes no estimates never sees that choice. */
export const can = (perm) => (perm === 'kacha' && company.value?.estimates === false ? false : !!me.value?.perms?.[perm]);

const set = (patch) => {
  const next = { ...auth.value, error: null, ...patch };
  // the app stays open underneath only for an automatic lock of the same person; any other step forgets that
  if (patch.step && !(patch.step === 'unlock' && (patch.autoLocked || (auth.value.step === 'unlock' && auth.value.autoLocked)))) next.autoLocked = false;
  auth.value = next;
};
const start = () => (devicePeople.value.length ? 'who' : 'welcome');

// Keep every person's newest login tokens (the active one refreshes itself in the background).
db.auth.onAuthStateChange((event, session) => {
  if (session && (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN')) keepTokens(session);
});

/** When the PIN was last accepted by the server on this visit (fingerprint can be switched on for 10 minutes after). */
export const pinJustNow = signal(0);

// ---------- working without internet (23 Oct 2026) ----------
const UNLOCK_MS = 12 * 3600 * 1000;           // a PIN unlock lasts a working day (same as the server's default)
let offlinePin = null;                         // the PIN typed while offline — in memory only, to unlock with the server later
let offlineSwitch = null;                      // a person chosen on "Who is using?" while offline (their login is set when online)
const isNetErr = (e) => !online.value || /fetch|network|offline|Failed|Load failed|abort/i.test(String(e?.message || e || ''));

/** No internet: carry on with what this phone knows about the person (only if they were fully in before). */
function offlineStep(uid, extra = {}) {
  const p = personOf(uid);
  if (!p?.status) return set({ step: 'error', error: 'offline_first', offline: true });
  setCacheOwner(uid); loadOutbox(uid);
  const fresh = p.unlockedAt && Date.now() - p.unlockedAt < UNLOCK_MS && !extra.locked && !(extra.boot && lockedByTime(p));
  if (fresh) return set({ step: 'ready', status: p.status, offline: true });
  return set({ step: 'unlock', status: p.status, offline: true, offlineUid: uid });
}

export async function boot() {
  const joining = /^#\/join/.test(location.hash);
  if (joining) replace('/'); // the invite link only picks the door; after login the app starts on Today
  if (!online.value) { const st = storedSession(); return st ? offlineStep(st.user.id, { boot: true }) : set({ step: start(), mode: 'login', phone: '' }); }
  let session = null;
  try { ({ data: { session } } = await db.auth.getSession()); } catch { /* checked below */ }
  if (!session) {
    const st = storedSession();
    if (st && !online.value) return offlineStep(st.user.id, { boot: true });
    return set({ step: joining ? 'phone' : start(), mode: joining ? 'join' : 'login', phone: '' });
  }
  return refresh({ boot: true });
}

/** Ask the server where we are. */
export async function refresh(extra = {}) {
  let data, error;
  try { ({ data, error } = await db.rpc('login_status')); } catch (e) { error = e; }
  if (error) {
    if (/JWT|token|expired|invalid/i.test(error.message || '') && online.value) { await db.auth.signOut({ scope: 'local' }); return set({ step: start() }); }
    if (isNetErr(error)) {
      markOffline();
      if (auth.value.step === 'ready') return set({ offline: true });   // keep working
      const st = storedSession();
      if (st) return offlineStep(st.user.id, { boot: extra.boot });
    }
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
  if (data.unlocked && !extra.resetting && !auth.value.resetting) {
    const uid = (await db.auth.getSession()).data.session?.user?.id;
    const p = personOf(uid);
    // the app was opened fresh: has this person's "lock the app after…" time passed since they left it?
    if (extra.boot && p && lockedByTime(p)) {
      try { await db.rpc('lock_session'); } catch { /* checked again by the server anyway */ }
      setPersonExtra(uid, { unlockedAt: 0 });
      return set({ step: 'unlock', status: data, offlineUid: uid });
    }
    return ready(data, { unlockedNow: !p?.unlockedAt || extra.unlockedNow });
  }
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
  if (session?.user?.id) {
    setCacheOwner(session.user.id);
    setPersonExtra(session.user.id, { status, ...(patch.unlockedNow ? { unlockedAt: Date.now() } : {}) });
    if (patch.unlockedNow) clearLeaving();
    await loadOutbox(session.user.id);
    offlinePin = null; offlineSwitch = null; needUnlock.value = false;
    if (outbox.value.length) flush();
    warmUp(status?.person?.perms || {});
  }
  delete patch.unlockedNow;
  patch.offline = false;
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
  await keepPinCopy(pin);
  pinJustNow.value = Date.now();
  await ready(data, { unlockedNow: true });
  return null;
}

/** The server said this PIN is right: keep a scrambled copy so the phone can check it when offline. */
async function keepPinCopy(pin) {
  try {
    const { data: { session } } = await db.auth.getSession();
    if (session?.user?.id) setPersonExtra(session.user.id, { pinCheck: await pinCopy(pin), offFails: 0, offLockUntil: 0 });
  } catch { /* offline checking just won't be there */ }
}

/** Without internet: the phone checks the PIN against its scrambled copy. */
async function unlockOfflinePin(pin) {
  const uid = auth.value.offlineUid || storedSession()?.user?.id;
  const p = personOf(uid);
  if (!p?.pinCheck) return { reason: 'error', message: 'offline_no_pin' };
  if (p.offLockUntil > Date.now()) return { reason: 'locked', locked_until: new Date(p.offLockUntil).toISOString() };
  if (await pinMatches(p.pinCheck, pin)) {
    offlinePin = pin;
    setPersonExtra(uid, { offFails: 0, offLockUntil: 0, unlockedAt: Date.now() });
    setCacheOwner(uid); await loadOutbox(uid);
    set({ step: 'ready', status: p.status, offline: true });
    return { ok: true };
  }
  const fails = (p.offFails || 0) + 1;
  const lockUntil = fails % 5 === 0 ? Date.now() + 15 * 60000 : 0;
  setPersonExtra(uid, { offFails: fails, offLockUntil: lockUntil });
  if (lockUntil) return { reason: 'locked', locked_until: new Date(lockUntil).toISOString() };
  return { reason: 'wrong_pin', attempts_left: 5 - (fails % 5) };
}

/** Returns { ok } or { reason, attempts_left, locked_until }. */
export async function unlock(pin) {
  if (!online.value || auth.value.offline && offlineSwitch) return unlockOfflinePin(pin);
  let data, error;
  try { ({ data, error } = await db.rpc('unlock', { p_pin: pin })); } catch (e) { error = e; }
  if (error && isNetErr(error)) { markOffline(); return unlockOfflinePin(pin); }
  if (error) return { reason: 'error', message: error.message };
  if (data.ok) { await keepPinCopy(pin); pinJustNow.value = Date.now(); await ready(data, { unlockedNow: true }); return { ok: true }; }
  if (data.reason === 'blocked' || data.reason === 'no_pin') {
    const { data: { session } } = await db.auth.getSession();
    await db.auth.signOut({ scope: 'local' });
    if (session) forget(session.user.id);
    set({ step: 'phone', mode: 'login', status: null, notice: 'pin_blocked' });
  }
  return data;
}

/**
 * Unlock with the finger / face (when switched on for this person on this phone). Online: the server checks it
 * and unlocks. Offline: the phone checks it with the kept public key. Throws when cancelled or it fails (→ PIN).
 */
export async function unlockFinger() {
  const uid = auth.value.offlineUid || storedSession()?.user?.id;
  const p = personOf(uid);
  if (!p?.passkey) throw Object.assign(new Error('not on this phone'), { code: 'no_key' });
  if (!online.value || offlineSwitch) {
    await unlockOffline(p.passkey);
    setPersonExtra(uid, { unlockedAt: Date.now() });
    setCacheOwner(uid); await loadOutbox(uid);
    set({ step: 'ready', status: p.status, offline: true });
    return { ok: true };
  }
  await unlockOnline(p.passkey);
  await refresh({ unlockedNow: true });
  return { ok: true };
}

/** Get the server's challenge ready before the tap (iPhone: Face ID must come straight after the tap). */
export function prepareFinger(purpose = 'unlock') {
  if (!online.value || (purpose === 'unlock' && (offlineSwitch || !fingerOn()))) return;
  prepare(purpose);
}

/** Is fingerprint unlock switched on for this person on this phone? */
export const fingerOn = (uid) => !!personOf(uid || storedSession()?.user?.id)?.passkey;

/** Switch fingerprint unlock on for the person using the phone (needs a PIN in the last 10 minutes; the server checks). */
export async function switchOnFinger(label) {
  const uid = storedSession()?.user?.id;
  const keep = await registerPasskey(label);
  if (uid) setPersonExtra(uid, { passkey: keep, fingerAsked: true });
  return keep;
}
/** Switch it off on this phone (the server forgets this phone's key too). */
export async function switchOffFinger() {
  const uid = storedSession()?.user?.id;
  const p = personOf(uid);
  if (p?.passkey?.credId) {
    try {
      const list = await call('passkeys', {});
      const k = (list || []).find((x) => x.credential_id === p.passkey.credId);
      if (k) await call('passkeyRemove', { id: k.id });
    } catch { /* offline: switched off on the phone now, the server key goes the next time */ }
  }
  if (uid) setPersonExtra(uid, { passkey: null });
}
/** "Not now" to the fingerprint offer (asked once per person per phone). */
export const fingerNotNow = () => { const uid = storedSession()?.user?.id; if (uid) setPersonExtra(uid, { fingerAsked: true }); };
export const fingerAsked = () => !!personOf(storedSession()?.user?.id)?.fingerAsked;

// Internet back: make sure the server knows this person is unlocked, then send what is waiting.
whenOnline(async () => {
  if (auth.value.step !== 'ready') return;
  try {
    if (offlineSwitch) {
      const person = offlineSwitch; offlineSwitch = null;
      const { error } = await db.auth.setSession({ access_token: person.access_token, refresh_token: person.refresh_token });
      if (error) { forget(person.uid); return set({ step: 'phone', mode: 'login', status: null, phone: person.phone }); }
    }
    const { data } = await db.rpc('login_status');
    if (!data?.signed_in) return;
    if (data.unlocked) { set({ offline: false }); return void flush(); }
    if (offlinePin) {
      const pin = offlinePin;
      const { data: r } = await db.rpc('unlock', { p_pin: pin });
      if (r?.ok) { set({ offline: false }); return void flush(); }
    }
    needUnlock.value = true;   // the waiting entries need the PIN (or finger) again
    set({ offline: false });
  } catch { /* still not really online */ }
});

/** "Unlock to send": the server wants the PIN again before it takes the waiting entries. */
export function unlockToSend() { set({ step: 'unlock', offline: false }); }

export async function lock() {
  clearLeaving();
  try { await db.rpc('lock_session'); } catch { /* offline: the phone locks itself */ }
  const uid = storedSession()?.user?.id;
  if (uid) setPersonExtra(uid, { unlockedAt: 0 });
  offlinePin = null;
  set({ step: devicePeople.value.length > 1 ? 'who' : 'unlock', offlineUid: uid });
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
  if (!online.value) {   // offline: the PIN (or finger) is checked on the phone; their login is set when the internet is back
    touch(person.uid);
    if (person.lang) setLang(person.lang);
    const cur = storedSession()?.user?.id;
    offlineSwitch = cur === person.uid ? null : person;
    if (!person.status) return set({ step: 'error', error: 'offline_first', offline: true });
    return set({ step: 'unlock', status: person.status, offline: true, offlineUid: person.uid });
  }
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
  const uid = storedSession()?.user?.id;
  if (uid) setPersonExtra(uid, { unlockedAt: 0 });
  offlinePin = null;
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
  await db.auth.signOut({ scope: 'local' }).catch(() => {});
  const uid = session?.user?.id || storedSession()?.user?.id;
  if (uid) { forget(uid); await forgetPerson(uid); await forgetOutbox(uid); }
  set({ step: start(), mode: 'login', status: null });
  // start fresh: this also loads the newest version of the app (see lib/update.js)
  setTimeout(() => location.reload(), 50);
}

// ---------- "Lock the app after…" (24 Oct 2026, lib/autolock.js) ----------
/** A plain cover over the app while it is off the screen (so the recent-apps picture shows nothing) and while locking. */
export const covered = signal(false);
let hiddenAt = 0;

/** This person's choice on this phone, in minutes (0 = instantly). */
export const lockAfter = (uid) => lockAfterOf(personOf(uid || storedSession()?.user?.id));
export function setLockAfter(minutes) {
  const uid = storedSession()?.user?.id;
  if (uid) setPersonExtra(uid, { lockAfter: minutes });
}

/** Opened fresh: lock if the person left the app longer ago than their choice (or we don't know when). */
function lockedByTime(p) {
  const away = p.lastSeen ? Date.now() - p.lastSeen : null;
  return shouldLock(lockAfterOf(p), away, takeLeaving(), true);
}

/** Lock because the person was away: the screen they were on stays open underneath and comes back after the unlock. */
async function autoLock(uid) {
  covered.value = true;
  if (online.value) {
    try { await Promise.race([db.rpc('lock_session'), new Promise((r) => setTimeout(r, 4000))]); } catch { /* offline: the phone locks itself */ }
  }
  setPersonExtra(uid, { unlockedAt: 0 });
  offlinePin = null;
  set({ step: 'unlock', autoLocked: true, offlineUid: uid });
  covered.value = false;
}

function wentAway() {
  if (auth.value.step !== 'ready' || hiddenAt) return;
  const now = Date.now();
  hiddenAt = now;
  const uid = storedSession()?.user?.id;
  const onPurpose = noteHidden(now);
  if (uid) setPersonExtra(uid, { lastSeen: now });
  if (!onPurpose && lockAfter(uid) === 0) covered.value = true;
}

function cameBack() {
  const at = hiddenAt; hiddenAt = 0;
  if (auth.value.step !== 'ready') { covered.value = false; return; }
  const uid = storedSession()?.user?.id;
  if (uid && at && shouldLock(lockAfter(uid), Date.now() - at, takeLeaving())) return void autoLock(uid);
  covered.value = false;
  // the server's unlock (12 hours by default) can also have run out
  if (!online.value) { const p = personOf(uid); if (p && (!p.unlockedAt || Date.now() - p.unlockedAt > UNLOCK_MS)) offlineStep(uid, { locked: true }); return; }
  refresh();
}

watchLeavingOnPurpose();
addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? cameBack() : wentAway()));
addEventListener('pagehide', wentAway);
addEventListener('pageshow', (e) => { if (e.persisted) cameBack(); });
