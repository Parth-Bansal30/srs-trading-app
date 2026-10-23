// Unlocking without internet: the server normally checks the PIN. When the phone has no internet, it checks
// the PIN itself against a scrambled copy (PBKDF2, never the PIN) made the last time the server said the PIN
// was right. Nothing is sent or saved by the server until the internet is back and the server has checked
// the PIN again. 5 wrong tries → wait 15 minutes (on this phone).
const enc = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ITER = 150000;

async function derive(pin, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

/** A scrambled copy of a PIN that was just accepted by the server: { s, h, i }. */
export async function pinCopy(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { s: b64(salt), h: b64(await derive(pin, salt, ITER)), i: ITER };
}

/** Does this PIN match the copy? */
export async function pinMatches(copy, pin) {
  if (!copy?.s || !copy?.h) return false;
  const got = await derive(pin, unb64(copy.s), copy.i || ITER);
  const want = unb64(copy.h);
  if (got.length !== want.length) return false;
  let d = 0;
  for (let i = 0; i < got.length; i++) d |= got[i] ^ want[i];
  return d === 0;
}
