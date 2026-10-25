// Fingerprint / face unlock (passkeys). The phone keeps a private key that only opens with the person's
// finger or face; the server keeps the public key (switched on once, after the PIN). Each unlock the phone
// signs a fresh challenge from the server. Without internet the phone checks it itself with the same public
// key (kept on the phone for this person), and the server checks again when the internet is back.
//
// iPhone / iPad / Mac (23 Oct 2026): the same passkey opens with Face ID (Touch ID on older iPhones and Macs). Apple
// only shows Face ID after a tap, so on Apple devices the app waits for the tap instead of asking by itself, and the
// server's challenge is fetched BEFORE the tap so Face ID comes up at once (a slow network between the tap and the
// Face ID request makes Safari refuse it).
import { b64uEncode, b64uDecode, verifyRegistration, verifyAssertion, newChallenge } from '@srs/core';
import { call } from './api.js';
import { t } from './i18n.js';
import { APP } from '../config/app.js';

// ---------- what this device calls it ----------
const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent || '');
const isIPad = () => /iPad/.test(ua()) || (/Macintosh/.test(ua()) && (navigator.maxTouchPoints || 0) > 1);
const isIPhone = () => /iPhone|iPod/.test(ua());
/** Apple phones, tablets and Macs (Safari and every iPhone browser) — Face ID / Touch ID only after a tap. */
export const isApple = () => isIPhone() || isIPad() || (/Macintosh/.test(ua()) && /Safari/.test(ua()) && !/Chrome|Chromium|Edg|Firefox/.test(ua()));
/**
 * face (iPhone X and newer — the tall screens), touch (iPhone 8 / SE, Macs), apple (iPads: some Face ID, some Touch ID),
 * hello (Windows), finger (Android and the rest).
 */
export function bioKind() {
  if (isIPhone()) return Math.max(screen.width, screen.height) >= 812 ? 'face' : 'touch';
  if (isIPad()) return 'apple';
  if (/Macintosh/.test(ua())) return 'touch';
  if (/Windows/.test(ua())) return 'hello';
  return 'finger';
}
/** "Face ID", "Touch ID", "fingerprint", "Windows Hello" in the person's language. */
export const bioName = () => t(`bio_${bioKind()}`);
export const bioIcon = () => (bioKind() === 'face' || bioKind() === 'apple' ? 'ScanFace' : 'Fingerprint');
/** A fingerprint word with this device's name in it ({0}); a sentence never starts with a small letter. */
export function bt(key) {
  const s = t(key, bioName());
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** "Look at the phone…" (face) or "Touch the sensor…" while the phone is asking. */
export const bioWaiting = () => t(bioKind() === 'face' ? 'fp_look' : 'fp_touch');

/** Can this phone / laptop unlock with a finger or face at all? */
export async function passkeyReady() {
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

const b = (buf) => b64uEncode(new Uint8Array(buf));

// ---------- the server's challenge, fetched before the tap (used once, fresh for 3 minutes) ----------
const ready = { register: null, unlock: null };   // { p: promise of the server's answer, at }
const FRESH_MS = 150000;
/** Fetch the challenge now (screen opened), so the tap can go straight to Face ID / the fingerprint. */
export function prepare(purpose) {
  const r = ready[purpose];
  if (r && Date.now() - r.at < 5000) return r.p;           // already on its way
  const p = call('passkeyBegin', { purpose }).catch(() => null);
  ready[purpose] = { p, at: Date.now() };
  return p;
}
async function challengeFor(purpose) {
  const r = ready[purpose];
  ready[purpose] = null;   // a challenge works once
  if (r && Date.now() - r.at < FRESH_MS) { const o = await r.p; if (o) return o; }
  return call('passkeyBegin', { purpose });
}

/** Switch it on for the person signed in now (needs a PIN in the last 10 minutes). Returns { credId, jwk, alg } to keep on the phone. */
export async function registerPasskey(label) {
  const o = await challengeFor('register');
  const hasKeys = (o.exclude || []).length > 0;   // this person already has a key somewhere (maybe on this very phone)
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
    challenge: b64uDecode(o.challenge),
    rp: { name: o.rp?.name || APP.name, id: location.hostname },
    user: { id: b64uDecode(o.user.id), name: o.user.name || o.user.displayName, displayName: o.user.displayName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    excludeCredentials: (o.exclude || []).map((id) => ({ type: 'public-key', id: b64uDecode(id) })),
    timeout: 60000, attestation: 'none',
    } });
  } catch (e) {
    // InvalidStateError = this phone already has this person's key (the app forgot it: logged out, "forgot PIN",
    // opened from Safari instead of the Home Screen) → offer "Use it with Face ID" (reconnectPasskey)
    if (hasKeys && e) { try { e.hasKeys = true; } catch { /* read-only error */ } prepare('unlock'); }
    throw e;
  }
  const answer = { clientDataJSON: b(cred.response.clientDataJSON), attestationObject: b(cred.response.attestationObject) };
  // the same check the server makes — and it gives the public key to keep for unlocking offline
  const mine = await verifyRegistration(answer, { challenge: o.challenge, origins: [location.origin] });
  await call('passkeyRegister', { challenge: o.challenge, ...answer, label });
  return { credId: mine.credentialId, jwk: mine.jwk, alg: mine.alg };
}

async function ask(challenge, credIds) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: b64uDecode(challenge), rpId: location.hostname, userVerification: 'required', timeout: 60000,
    allowCredentials: credIds.map((id) => ({ type: 'public-key', id: b64uDecode(id), transports: ['internal', 'hybrid'] })),
  } });
  return { credential_id: b(a.rawId), clientDataJSON: b(a.response.clientDataJSON), authenticatorData: b(a.response.authenticatorData), signature: b(a.response.signature) };
}

/** Unlock with the server (online). keep = { credId } kept on this phone. Throws when it fails or is cancelled. */
export async function unlockOnline(keep) {
  const o = await challengeFor('unlock');
  const ids = (o.credentials || []).filter((id) => !keep?.credId || id === keep.credId);
  if (!ids.length) throw Object.assign(new Error('not on this phone'), { code: 'no_key' });
  return call('passkeyUnlock', { challenge: o.challenge, ...(await ask(o.challenge, ids)) });
}

/**
 * The phone already has this person's key but the app forgot it: one Face ID / fingerprint check with the server
 * (also unlocks), and the server sends the public half back to keep. Returns { credId, jwk, alg } like registerPasskey.
 */
export async function reconnectPasskey() {
  const o = await challengeFor('unlock');
  const ids = o.credentials || [];
  if (!ids.length) throw Object.assign(new Error('no key'), { code: 'no_key' });
  const a = await ask(o.challenge, ids);
  const r = await call('passkeyUnlock', { challenge: o.challenge, ...a });
  if (!r?.jwk) throw Object.assign(new Error('no key'), { code: 'no_key' });
  return { credId: r.credential_id || a.credential_id, jwk: r.jwk, alg: r.alg };
}

/** Unlock without internet: the phone checks the finger's signature itself with the kept public key. */
export async function unlockOffline(keep) {
  const challenge = newChallenge();
  const a = await ask(challenge, [keep.credId]);
  await verifyAssertion(a, { challenge, origins: [location.origin], jwk: keep.jwk, alg: keep.alg });
  return true;
}
