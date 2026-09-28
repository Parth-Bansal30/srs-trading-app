// People who have logged in on THIS phone or tablet — for the "Who is using?" screen.
// Each person keeps their own login session here, so switching person never needs a new SMS
// code: only that person's PIN (checked by the server). "Log out" removes a person from the phone.
import { signal } from '@preact/signals';
import { store } from './store.js';

const KEY = 'device_people';
export const devicePeople = signal(store.json(KEY) || []);

function save(list) {
  const sorted = [...list].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  devicePeople.value = sorted;
  store.setJson(KEY, sorted);
}

/** Add or update the person who is signed in right now. */
export function remember(session, status) {
  if (!session?.user?.id || !status?.person) return;
  const uid = session.user.id;
  const rest = devicePeople.value.filter((p) => p.uid !== uid);
  save([...rest, {
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
  const list = devicePeople.value;
  const i = list.findIndex((p) => p.uid === session.user.id);
  if (i < 0 || list[i].refresh_token === session.refresh_token) return;
  const next = [...list];
  next[i] = { ...next[i], access_token: session.access_token, refresh_token: session.refresh_token };
  save(next);
}

export function touch(uid) {
  save(devicePeople.value.map((p) => (p.uid === uid ? { ...p, lastUsed: Date.now() } : p)));
}

export function setPersonLang(uid, lang) {
  save(devicePeople.value.map((p) => (p.uid === uid ? { ...p, lang } : p)));
}

export function forget(uid) {
  save(devicePeople.value.filter((p) => p.uid !== uid));
}
