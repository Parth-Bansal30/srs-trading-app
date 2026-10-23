// Fingerprint / face unlock (passkeys). The phone keeps a private key that only opens with the person's
// finger or face; the server keeps the public key (switched on once, after the PIN). Each unlock the phone
// signs a fresh challenge from the server. Without internet the phone checks it itself with the same public
// key (kept on the phone for this person), and the server checks again when the internet is back.
import { b64uEncode, b64uDecode, verifyRegistration, verifyAssertion, newChallenge } from '@srs/core';
import { call } from './api.js';
import { APP } from '../config/app.js';

/** Can this phone / laptop unlock with a finger or face at all? */
export async function passkeyReady() {
  try {
    if (!window.PublicKeyCredential || !navigator.credentials) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

const b = (buf) => b64uEncode(new Uint8Array(buf));

/** Switch it on for the person signed in now (needs a PIN in the last 10 minutes). Returns { credId, jwk, alg } to keep on the phone. */
export async function registerPasskey(label) {
  const o = await call('passkeyBegin', { purpose: 'register' });
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: b64uDecode(o.challenge),
    rp: { name: o.rp?.name || APP.name, id: location.hostname },
    user: { id: b64uDecode(o.user.id), name: o.user.name || o.user.displayName, displayName: o.user.displayName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
    excludeCredentials: (o.exclude || []).map((id) => ({ type: 'public-key', id: b64uDecode(id) })),
    timeout: 60000, attestation: 'none',
  } });
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
  const o = await call('passkeyBegin', { purpose: 'unlock' });
  const ids = (o.credentials || []).filter((id) => !keep?.credId || id === keep.credId);
  if (!ids.length) throw Object.assign(new Error('not on this phone'), { code: 'no_key' });
  return call('passkeyUnlock', { challenge: o.challenge, ...(await ask(o.challenge, ids)) });
}

/** Unlock without internet: the phone checks the finger's signature itself with the kept public key. */
export async function unlockOffline(keep) {
  const challenge = newChallenge();
  const a = await ask(challenge, [keep.credId]);
  await verifyAssertion(a, { challenge, origins: [location.origin], jwk: keep.jwk, alg: keep.alg });
  return true;
}
