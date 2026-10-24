// "Lock the app after…" (24 Oct 2026). Each person chooses on each phone how long the app stays open after
// they leave it: instantly, 5 minutes, 30 minutes, 1 hour or 12 hours. New default: instantly.
// The server's own unlock (company setting, 12 hours) still applies on top — this can only lock sooner.
//
// "Leaving" means the app is no longer on the screen (another app, the home screen, the phone locked, closed from
// recent apps). Leaving ON PURPOSE from inside the app — sharing a slip on WhatsApp, taking a bill photo, calling a
// customer, opening a link, Face ID itself, an app update — never locks if you come back within 5 minutes.
import { store } from './store.js';

/** The choices, in minutes (0 = instantly). */
export const LOCK_CHOICES = [0, 5, 30, 60, 720];
export const LOCK_DEFAULT = 0;
/** Coming back this quickly never counts as leaving (a flicker, a system sheet). */
export const BLINK_MS = 3000;
/** Leaving on purpose from inside the app: no lock if back within this long. */
export const ON_PURPOSE_MS = 5 * 60000;

const KEY = 'leaving_on_purpose';
/** The tap that sends the person out must be followed by the app leaving the screen within this long. */
export const TAP_TO_LEAVE_MS = 15000;
let tappedAt = 0;

/** The person's choice (minutes); anything unknown → the default. */
export const lockAfterOf = (person) => (LOCK_CHOICES.includes(person?.lockAfter) ? person.lockAfter : LOCK_DEFAULT);

/**
 * Should the app lock now that the person is back?
 * @param {number} lockAfter minutes (0 = instantly)
 * @param {number|null} awayMs how long the app was off the screen (null = unknown → treat as long ago)
 * @param {boolean} onPurpose left from inside the app (share / photo / call / link) and came back in time
 * @param {boolean} fresh the app was closed and opened again (not just back from the background): no "blink" allowance
 */
export function shouldLock(lockAfter, awayMs, onPurpose = false, fresh = false) {
  if (onPurpose) return false;
  if (awayMs == null || !Number.isFinite(awayMs)) return true;
  if (awayMs < BLINK_MS && !fresh) return false;
  return awayMs >= (lockAfter || 0) * 60000;
}

/** The app is about to send the person somewhere else on purpose (share, photo, call, link). */
export function markLeaving(now = Date.now()) { tappedAt = now; }
/** The app just left the screen: if that came right after such a tap, it is a trip on purpose. */
export function noteHidden(now = Date.now()) {
  const onPurpose = tappedAt && now - tappedAt < TAP_TO_LEAVE_MS;
  tappedAt = 0;
  try { store.set(KEY, onPurpose ? String(now + ON_PURPOSE_MS) : ''); } catch { /* storage off */ }
  return !!onPurpose;
}
/** Back: was it a trip on purpose that is still within its time? (Used once — then forgotten.) */
export function takeLeaving(now = Date.now()) {
  let until = 0;
  try { until = Number(store.get(KEY)) || 0; store.set(KEY, ''); } catch { /* storage off */ }
  return until > now;
}
/** Forget any trip on purpose (after an unlock, a lock, a person switch). */
export function clearLeaving() { tappedAt = 0; try { store.set(KEY, ''); } catch { /* storage off */ } }

let installed = false;
/** Notice every way the app sends the person out on purpose (no screen needs to remember to say so). */
export function watchLeavingOnPurpose() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  // taps: bill photo / file picker, phone calls, WhatsApp links, links that open outside the app
  document.addEventListener('click', (e) => {
    const el = e.target?.closest?.('input[type=file], a[href]');
    if (!el) return;
    if (el.tagName === 'INPUT') return markLeaving();
    const href = el.getAttribute('href') || '';
    if (/^(tel|sms|mailto|whatsapp|upi|intent):/i.test(href) || el.target === '_blank' || /wa\.me|whatsapp\.com/i.test(href)) markLeaving();
  }, true);
  // untilDone: the share sheet / Face ID sheet tells us when it closes — after that, leaving is an ordinary leave again
  const wrap = (obj, name, untilDone = false) => {
    const fn = obj?.[name];
    if (typeof fn !== 'function') return;
    obj[name] = function (...args) {
      markLeaving();
      const r = fn.apply(this, args);
      if (untilDone && r && typeof r.then === 'function') { const over = () => { tappedAt = 0; }; r.then(over, over); }
      return r;
    };
  };
  wrap(window, 'open');
  wrap(window, 'print');
  wrap(navigator, 'share', true);
  if (navigator.credentials) { wrap(navigator.credentials, 'get', true); wrap(navigator.credentials, 'create', true); }
}
