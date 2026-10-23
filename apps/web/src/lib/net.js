// Is there internet right now? The phone's own signal (online / offline events) plus what our requests find:
// a request that can't reach the server marks the app offline; the next one that works marks it online again.
import { signal } from '@preact/signals';

export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
let listeners = [];
/** Run fn() whenever the internet comes back. Returns a stop function. */
export function whenOnline(fn) { listeners.push(fn); return () => { listeners = listeners.filter((x) => x !== fn); }; }

export function markOnline() {
  if (online.value) return;
  online.value = true;
  for (const fn of listeners) { try { fn(); } catch { /* keep going */ } }
}
export function markOffline() { online.value = false; }

if (typeof addEventListener === 'function') {
  addEventListener('online', () => markOnline());
  addEventListener('offline', () => markOffline());
}

/** A fetch that gives up after `ms` (a weak signal often never answers). Throws a TypeError like a network failure. */
export async function fetchWithin(input, init = {}, ms = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  if (init.signal) init.signal.addEventListener('abort', () => ac.abort());
  try {
    const res = await fetch(input, { ...init, signal: ac.signal });
    markOnline();
    return res;
  } catch (e) {
    if (init.signal?.aborted) throw e;
    markOffline();
    throw new TypeError('offline');
  } finally { clearTimeout(timer); }
}

// While offline, look for the internet every 15 seconds (a phone often says "online" late, or never).
let probeUrl = null; let probeTimer = null;
export function startProbe(url) {
  probeUrl = url;
  if (probeTimer) return;
  probeTimer = setInterval(async () => {
    if (online.value || !probeUrl) return;
    try { await fetchWithin(probeUrl, { method: 'GET', cache: 'no-store' }, 8000); } catch { /* still offline */ }
  }, 15000);
}
