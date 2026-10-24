// People who have logged in on THIS phone or tablet — for the "Who is using?" screen.
// Each person keeps their own login session here, so switching person never needs a new SMS
// code: only that person's PIN (checked by the server). "Log out" removes a person from the phone.
import { signal } from '@preact/signals';
import { store } from './store.js';

const KEY = 'device_people';
export const devicePeople = signal(store.json(KEY) || []);
/** Always build on the newest stored list (another tab or window of the app may have changed it). */
const current = () => store.json(KEY) || devicePeople.value;
// another tab changed the list: show it here too
if (typeof addEventListener === 'function') addEventListener('storage', (e) => { if (e.key === `srs:${KEY}`) devicePeople.value = store.json(KEY) || []; });

function save(list) {
  const sorted = [...list].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  devicePeople.value = sorted;
  store.setJson(KEY, sorted);
}

/** Add or update the person who is signed in right now. */
export function remember(session, status) {
  if (!session?.user?.id || !status?.person) return;
  const uid = session.user.id;
  const list = current();
  const was = list.find((p) => p.uid === uid) || {};
  const rest = list.filter((p) => p.uid !== uid);
  save([...rest, {
    ...was,   // keeps the offline PIN check, fingerprint key and last unlock (23 Oct 2026)
    uid,
    name: status.person.name,
    role: status.person.role,
    lang: status.person.lang,
    company: status.company?.name || '',
    city: status.company?.city || '',
    phone: session.user.phone ? `+${session.user.phone}` : '',
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    lastUsed: Date.now(),
  }]);
}

/** The login refreshed itself — keep the newest tokens for that person. */
export function keepTokens(session) {
  if (!session?.user?.id) return;
  const list = current();
  const i = list.findIndex((p) => p.uid === session.user.id);
  if (i < 0 || list[i].refresh_token === session.refresh_token) return;
  const next = [...list];
  next[i] = { ...next[i], access_token: session.access_token, refresh_token: session.refresh_token };
  save(next);
}

export function touch(uid) {
  save(current().map((p) => (p.uid === uid ? { ...p, lastUsed: Date.now() } : p)));
}

export function setPersonLang(uid, lang) {
  save(current().map((p) => (p.uid === uid ? { ...p, lang } : p)));
}

export function forget(uid) {
  save(current().filter((p) => p.uid !== uid));
}

/** One person on this phone (by login id). */
export const personOf = (uid) => (uid ? devicePeople.value.find((p) => p.uid === uid) || null : null);

/**
 * Keep extra things for a person on this phone (23 Oct 2026): status (who they are, for opening offline),
 * unlockedAt, pinCheck (scrambled PIN copy for offline), offFails / offLockUntil, passkey ({ credId, jwk, alg }).
 */
export function setPersonExtra(uid, patch) {
  const list = current();
  const i = list.findIndex((p) => p.uid === uid);
  if (i < 0) return;
  const next = [...list];
  next[i] = { ...next[i], ...patch };
  devicePeople.value = next;
  store.setJson(KEY, next);
}
