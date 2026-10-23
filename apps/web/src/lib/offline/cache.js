// The last data each screen showed, kept on the phone for each person (so screens open without internet).
// Only the person who is signed in can see their own copy; logging out of the phone removes it.
import { signal } from '@preact/signals';
import { idb } from './store.js';

let owner = null;                       // the login (user id) whose copy is used
/** When a screen is showing a kept copy: the time it was saved (ISO), else null. */
export const fromCache = signal(null);

export const setCacheOwner = (uid) => { owner = uid || null; };
export const cacheOwner = () => owner;

/** A short, stable key for a request. */
export function keyOf(...parts) {
  const s = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p ?? null))).join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}:${s.length}`;
}

export async function remember(key, body) {
  if (!owner) return;
  try { await idb.put('cache', `${owner}|${key}`, { at: new Date().toISOString(), body }); } catch { /* the phone is full: fine */ }
}
/** { at, body } or null. */
export async function recall(key) {
  if (!owner) return null;
  try { return (await idb.get('cache', `${owner}|${key}`)) || null; } catch { return null; }
}
/** Remove a person's kept copy (log out of this phone). */
export const forgetPerson = (uid) => idb.clear('cache', `${uid}|`).catch(() => {});
