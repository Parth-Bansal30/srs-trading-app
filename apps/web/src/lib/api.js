// Every change goes through ONE door: the backend "api" function.
// Each action gets its own request key, so if the network drops and we retry,
// the backend does it only once and returns the first answer.
import { db } from './backend.js';
import { APP, BACKEND } from '../config/app.js';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * call('createOrder', {...}) → data.  Throws ApiError with a plain message.
 * Pass the same `key` when the SAME tap is retried (e.g. the person presses Save again after an error).
 */
export async function call(op, args = {}, { key = newKey(), tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const { data: { session } } = await db.auth.getSession();
    if (!session) throw new ApiError(401, 'not_signed_in', 'Please sign in.');
    let res;
    try {
      res = await fetch(`${BACKEND.url}/functions/v1/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: BACKEND.publicKey, Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ v: APP.apiVersion, op, key, args }),
      });
    } catch (e) { // network problem → try again with the SAME key
      lastErr = new ApiError(0, 'offline', 'No internet.');
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
