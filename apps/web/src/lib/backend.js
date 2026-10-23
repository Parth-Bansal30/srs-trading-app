// The connection to the shop's database (Supabase). Reads go straight to the database
// (it only returns what this person may see); every CHANGE goes through api.js.
//
// Without internet (23 Oct 2026): a read (and "where am I in the login") answers from the copy kept on the
// phone the last time it worked, so screens still open; fromCache says when that copy is from.
import { createClient } from '@supabase/supabase-js';
import { BACKEND } from '../config/app.js';
import { online, fetchWithin, startProbe } from './net.js';
import { remember, recall, keyOf, fromCache } from './offline/cache.js';

const header = (init, name) => {
  const h = init?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(name) || '';
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : '';
};

async function keptFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
  const keep = (method === 'GET' && url.includes('/rest/v1/')) || (method === 'POST' && url.includes('/rest/v1/rpc/login_status'));
  const ck = keep ? keyOf('rest', url.replace(BACKEND.url, ''), header(init, 'accept'), method === 'POST' ? String(init.body || '') : '') : null;
  if (keep && !online.value) {
    const hit = await recall(ck);
    if (hit) { fromCache.value = hit.at; return new Response(hit.body, { status: 200, headers: { 'content-type': 'application/json', 'x-kept-at': hit.at } }); }
  }
  try {
    const res = await fetchWithin(input, init, 15000);
    if (keep && res.ok) { res.clone().text().then((t) => remember(ck, t)).catch(() => {}); fromCache.value = null; }
    return res;
  } catch (e) {
    if (keep) {
      const hit = await recall(ck);
      if (hit) { fromCache.value = hit.at; return new Response(hit.body, { status: 200, headers: { 'content-type': 'application/json', 'x-kept-at': hit.at } }); }
    }
    throw e;
  }
}

export const db = createClient(BACKEND.url, BACKEND.publicKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'srs:auth', detectSessionInUrl: false },
  global: { fetch: keptFetch },
});
startProbe(`${BACKEND.url}/auth/v1/health`);

/** The saved login on this phone, read straight from storage (works offline, even when it needs refreshing). */
export function storedSession() {
  try { const s = JSON.parse(localStorage.getItem('srs:auth') || 'null'); return s?.user ? s : null; } catch { return null; }
}
