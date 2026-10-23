// Entries made without internet wait here (on the phone) and are sent, in the order they were made, as soon
// as the internet is back and the person is unlocked. Each keeps its own request key, so even if the phone
// sent one just before the signal dropped, the server saves it only once. Each also says when it really
// happened (offline_at), so the day's sales and cash come out right.
//
// What the screens use: outbox (this person's waiting entries), outboxVersion (changes when something was
// sent, so screens reload), queue(), pendingOf(), flush(), discard(), retry().
import { signal } from '@preact/signals';
import { idb } from './store.js';
import { blockedBy } from './overlay.js';

/** Changes that can be made without internet. */
export const OFFLINE_OPS = new Set(['createCustomer', 'createOrder', 'acceptOrder', 'addAdvance', 'recordWeights', 'finalizeOrder', 'recordPayment',
  'saveExpense', 'saveTransfer', 'saveCashCount']);

export const outbox = signal([]);          // this person's entries, oldest first
export const outboxVersion = signal(0);    // +1 whenever entries were sent (screens reload)
export const sending = signal(false);
export const needUnlock = signal(false);   // the server wants the PIN before it takes them
/** The real slip numbers given to slips made on this phone: { localOrderId: { no: '1072', local: 'P3' } } (for this visit). */
export const sentSlips = signal({});
/** A bill finished offline whose total the server worked out differently (rates changed meanwhile): [{ id, slipNo, phone, server }]. */
export const billChanged = signal([]);

let owner = null;
let sender = null;
export const setSender = (fn) => { sender = fn; };

export async function loadOutbox(uid) {
  owner = uid || null;
  if (!owner) { outbox.value = []; return; }
  const rows = await idb.list('outbox', `${owner}|`).catch(() => []);
  outbox.value = rows.map(([, v]) => v).sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.seq - b.seq);
}
const save = (e) => idb.put('outbox', `${e.uid}|${e.id}`, e);
const drop = (e) => idb.del('outbox', `${e.uid}|${e.id}`);
let seq = 0;

/** The next "Phone-N" number for a slip made offline on this phone. */
export function nextLocalNo() {
  let n = 1;
  try { n = Number(localStorage.getItem('srs:localSlip') || '0') + 1; localStorage.setItem('srs:localSlip', String(n)); } catch { n = Date.now() % 1000; }
  return `P${n}`;
}

/** Keep an entry on the phone. key = its request key. Returns the entry. */
export async function queue(op, args, key, meta = {}) {
  if (!owner) throw new Error('not signed in');
  const at = new Date().toISOString();
  const e = { id: key, uid: owner, op, args: { ...args, offline_at: args.offline_at || at }, at, seq: ++seq, meta, status: 'waiting', error: null, tries: 0 };
  const existing = outbox.value.find((x) => x.id === key);
  if (existing) return existing;  // the same tap again
  outbox.value = [...outbox.value, e];
  await save(e);
  return e;
}

export const pendingOf = (ops) => outbox.value.filter((e) => !ops || ops.includes(e.op));
export const waitingCount = () => outbox.value.length;

async function update(e, patch) {
  const next = { ...e, ...patch };
  outbox.value = outbox.value.map((x) => (x.id === e.id ? next : x));
  await save(next);
  return next;
}
async function remove(e) {
  outbox.value = outbox.value.filter((x) => x.id !== e.id);
  await drop(e);
}

/**
 * Send what is waiting, oldest first. Stops at the first "no internet" / "enter your PIN" / server hiccup
 * (tries again later); an entry the server refuses is marked failed (with the reason) and the ones that
 * depend on it wait. Returns { sent, failed, left }.
 */
let flushing = null;
export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    if (!sender || !owner) return { sent: 0, failed: 0, left: outbox.value.length };
    sending.value = true;
    let sent = 0; let failed = 0;
    try {
      for (const e0 of [...outbox.value]) {
        const e = outbox.value.find((x) => x.id === e0.id);
        if (!e) continue;
        const blocked = blockedBy(outbox.value).get(e.id);
        if (blocked && blocked.some((id) => outbox.value.some((x) => x.id === id))) {
          if (e.status !== 'blocked') await update(e, { status: 'blocked' });
          continue;
        }
        if (e.status === 'failed') continue;           // waits for "try again" or "remove"
        await update(e, { status: 'sending', tries: e.tries + 1 });
        try {
          const data = await sender(e.op, e.args, e.id);
          if (e.op === 'createOrder' && data?.slip_no) sentSlips.value = { ...sentSlips.value, [e.args.order_id]: { no: data.slip_no, local: e.meta?.localNo || '' } };
          const shown = e.meta?.patch?.totals?.total_amount;
          if (e.op === 'finalizeOrder' && shown != null && data?.breakdown && Math.abs(Number(data.breakdown.total) - Number(shown)) >= 0.01) {
            billChanged.value = [...billChanged.value, { id: e.id, orderId: e.args.order_id, slipNo: sentSlips.value[e.args.order_id]?.no || e.meta?.slipNo, phone: Number(shown), server: Number(data.breakdown.total) }];
          }
          await remove(e);
          sent++;
        } catch (err) {
          const status = Number(err?.status || 0);
          if (status === 0 || status >= 500) { await update(e, { status: 'waiting' }); break; }
          if (status === 401) { await update(e, { status: 'waiting' }); needUnlock.value = true; break; }
          await update(e, { status: 'failed', error: { code: err.code || 'error', message: err.message || 'Refused.' } });
          failed++;
        }
      }
    } finally {
      sending.value = false;
      if (sent || failed) outboxVersion.value++;
    }
    if (sent) needUnlock.value = false;
    return { sent, failed, left: outbox.value.length };
  })().finally(() => { flushing = null; });
  return flushing;
}

/** Try a refused entry again (e.g. after fixing something on another phone). */
export async function retry(id) {
  const e = outbox.value.find((x) => x.id === id);
  if (e) await update(e, { status: 'waiting', error: null });
  return flush();
}

/** Throw away a waiting entry — and the ones that need it (a slip's weighing needs the slip). */
export async function discard(id) {
  const deps = blockedBy(outbox.value);
  const gone = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [eid, needs] of deps) if (!gone.has(eid) && needs.some((n) => gone.has(n))) { gone.add(eid); grew = true; }
  }
  for (const e of outbox.value.filter((x) => gone.has(x.id))) await remove(e);
  outboxVersion.value++;
  return [...gone];
}

/** Log out of this phone: that person's waiting entries go too (the screen warns first). */
export async function forgetOutbox(uid) {
  for (const [k] of await idb.list('outbox', `${uid}|`).catch(() => [])) await idb.del('outbox', k);
  if (uid === owner) outbox.value = [];
}
