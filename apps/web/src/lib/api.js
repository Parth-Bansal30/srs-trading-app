// Every change goes through ONE door: the backend "api" function.
// Each action gets its own request key, so if the network drops and we retry,
// the backend does it only once and returns the first answer.
//
// Without internet (23 Oct 2026):
//  - a READ answers from the copy kept on the phone (the last time that screen loaded), and fromCache says so;
//  - a CHANGE that can be made offline (lib/offline/outbox.js OFFLINE_OPS) is kept on the phone and sent
//    later, when the screen gave what to show meanwhile (opts.local = { meta, result }). Anything else says
//    "needs internet".
import { db } from './backend.js';
import { APP, BACKEND } from '../config/app.js';
import { online, fetchWithin } from './net.js';
import { remember, recall, keyOf, fromCache } from './offline/cache.js';
import { OFFLINE_OPS, queue, setSender } from './offline/outbox.js';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
export { newKey };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Operations that only read (no request key; their answers are kept on the phone for offline use). */
export const READ_OPS = new Set(['accounts', 'weighingList', 'askSteelQuestion', 'khata', 'reminderList', 'reminderPreview', 'daySummary', 'eveningGet',
  'deletedSlips', 'deletePreview', 'stockData', 'stockItem', 'purchaseContext', 'purchases', 'purchase', 'readPurchaseBill',
  'cashBook', 'expenses', 'uploadReceipt', 'expenseFile', 'accountBalances', 'accountBook', 'suppliers', 'passkeys']);
const NO_COPY = new Set(['askSteelQuestion', 'readPurchaseBill', 'uploadReceipt', 'expenseFile', 'deletePreview']);
const offlineError = () => new ApiError(0, 'offline', 'No internet. This needs the internet — please try again when it is back.');

/** One request to the api (with retries on network trouble). */
async function send(op, args, key, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { if (!online.value) throw offlineError(); throw new ApiError(401, 'not_signed_in', 'Please sign in.'); }
    let res;
    try {
      res = await fetchWithin(`${BACKEND.url}/functions/v1/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: BACKEND.publicKey, Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ v: APP.apiVersion, op, key, args }),
      }, 20000);
    } catch (e) { // network problem → try again with the SAME key
      lastErr = offlineError();
      if (!online.value) break;
      await sleep(600 * (i + 1));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return body.data;
    // only real server hiccups are retried (not "AI switched off" and the like)
    if (res.status >= 500 && (!body.error || body.error === 'server_error') && i < tries - 1) { lastErr = new ApiError(res.status, body.error, body.message); await sleep(800 * (i + 1)); continue; }
    throw new ApiError(res.status, body.error || 'error', body.message || 'Something went wrong.');
  }
  throw lastErr;
}
// the outbox sends waiting entries the same way (one try each; it tries again later itself)
setSender((op, args, key) => send(op, args, key, 1));

/**
 * call('createOrder', {...}) → data.  Throws ApiError with a plain message.
 * Pass the same `key` when the SAME tap is retried (e.g. the person presses Save again after an error).
 * opts.local = { meta, result } lets a change be kept on the phone when there is no internet (see outbox.js).
 */
export async function call(op, args = {}, { key = newKey(), tries = 3, local = null } = {}) {
  if (READ_OPS.has(op)) {
    const ck = keyOf('api', op, args);
    if (online.value || NO_COPY.has(op)) {
      try {
        const data = await send(op, args, null, tries);
        if (!NO_COPY.has(op)) remember(ck, data);
        fromCache.value = null;
        return data;
      } catch (e) {
        if (e.code !== 'offline' || NO_COPY.has(op)) throw e;
      }
    }
    const hit = await recall(ck);
    if (hit) { fromCache.value = hit.at; return hit.body; }
    throw offlineError();
  }
  if (OFFLINE_OPS.has(op) && local) {
    if (!online.value) return keep(op, args, key, local);
    try { return await send(op, args, key, 1); } catch (e) {
      if (e.code === 'offline') return keep(op, args, key, local);
      throw e;
    }
  }
  if (!online.value) throw offlineError();
  return send(op, args, key, tries);
}

async function keep(op, args, key, localIn) {
  const local = typeof localIn === 'function' ? localIn() : localIn;
  const e = await queue(op, args, key, local.meta || {});
  return { ...(local.result || {}), pending: true, entry_id: e.id };
}
