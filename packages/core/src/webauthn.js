/**
 * Fingerprint / face unlock (passkeys, WebAuthn) — checking what the phone answers (23 Oct 2026).
 *
 * The phone keeps a private key that only opens with the person's finger or face; it never leaves the
 * phone. When switching it on, the phone gives its PUBLIC key (in "attestationObject"). Each unlock, the
 * phone signs a fresh challenge; the signature is checked with the saved public key.
 *
 * Used by the backend (the real unlock) and by the phone itself (unlocking while offline: the same check
 * with the key saved on the phone). Plain WebCrypto, no libraries. ES256 (most phones) and RS256 (Windows).
 */

export class WebAuthnError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
const fail = (code, msg) => { throw new WebAuthnError(code, msg); };
const subtle = () => globalThis.crypto?.subtle || fail('no_crypto', 'This device cannot check fingerprints.');

// ---------- base64url ----------
export function b64uEncode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*$/.test(s)) fail('bad_input', 'Not base64url.');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
export const sha256 = async (bytes) => new Uint8Array(await subtle().digest('SHA-256', bytes));

// ---------- a small CBOR reader (enough for WebAuthn) ----------
/** Decode one CBOR item at `pos`. Returns { value, end }. Maps become Map objects (keys: numbers or strings). */
export function cborDecode(bytes, pos = 0) {
  const b = bytes;
  const need = (n) => { if (pos + n > b.length) fail('bad_cbor', 'Cut short.'); };
  need(1);
  const first = b[pos++];
  const major = first >> 5; const info = first & 31;
  let len;
  if (info < 24) len = info;
  else if (info === 24) { need(1); len = b[pos]; pos += 1; }
  else if (info === 25) { need(2); len = (b[pos] << 8) | b[pos + 1]; pos += 2; }
  else if (info === 26) { need(4); len = ((b[pos] << 24) >>> 0) + (b[pos + 1] << 16) + (b[pos + 2] << 8) + b[pos + 3]; pos += 4; }
  else if (info === 27) { need(8); len = 0; for (let i = 0; i < 8; i++) len = len * 256 + b[pos + i]; pos += 8; }
  else fail('bad_cbor', 'Unsupported length.');
  switch (major) {
    case 0: return { value: len, end: pos };
    case 1: return { value: -1 - len, end: pos };
    case 2: need(len); return { value: b.slice(pos, pos + len), end: pos + len };
    case 3: need(len); return { value: new TextDecoder().decode(b.slice(pos, pos + len)), end: pos + len };
    case 4: {
      const arr = [];
      for (let i = 0; i < len; i++) { const r = cborDecode(b, pos); arr.push(r.value); pos = r.end; }
      return { value: arr, end: pos };
    }
    case 5: {
      const m = new Map();
      for (let i = 0; i < len; i++) {
        const k = cborDecode(b, pos); pos = k.end;
        const v = cborDecode(b, pos); pos = v.end;
        m.set(k.value, v.value);
      }
      return { value: m, end: pos };
    }
    case 7:
      if (info === 20) return { value: false, end: pos };
      if (info === 21) return { value: true, end: pos };
      if (info === 22) return { value: null, end: pos };
      return fail('bad_cbor', 'Unsupported simple value.');
    default: return fail('bad_cbor', 'Unsupported item.');
  }
}

// ---------- authenticator data ----------
/** rpIdHash (32) · flags (1) · signCount (4) · [attested credential: aaguid (16) · idLen (2) · id · COSE key] */
export function parseAuthData(ad) {
  if (!(ad instanceof Uint8Array) || ad.length < 37) fail('bad_auth_data', 'Too short.');
  const flags = ad[32];
  const out = {
    rpIdHash: ad.slice(0, 32),
    flags: { up: !!(flags & 0x01), uv: !!(flags & 0x04), at: !!(flags & 0x40), ed: !!(flags & 0x80) },
    signCount: ((ad[33] << 24) >>> 0) + (ad[34] << 16) + (ad[35] << 8) + ad[36],
  };
  if (out.flags.at) {
    if (ad.length < 55) fail('bad_auth_data', 'No credential.');
    const idLen = (ad[53] << 8) | ad[54];
    const idEnd = 55 + idLen;
    if (ad.length < idEnd) fail('bad_auth_data', 'Credential cut short.');
    out.credentialId = ad.slice(55, idEnd);
    const key = cborDecode(ad, idEnd);
    out.cosePublicKey = key.value;
  }
  return out;
}

/** A COSE public key → { jwk, alg }. ES256 (P-256) or RS256. */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) fail('bad_key', 'No public key.');
  const kty = cose.get(1); const alg = cose.get(3);
  if (kty === 2 && alg === -7) {
    if (cose.get(-1) !== 1) fail('bad_key', 'Only the P-256 curve.');
    const x = cose.get(-2); const y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) fail('bad_key', 'Bad point.');
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64uEncode(x), y: b64uEncode(y) } };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1); const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) fail('bad_key', 'Bad RSA key.');
    return { alg: -257, jwk: { kty: 'RSA', n: b64uEncode(n), e: b64uEncode(e) } };
  }
  return fail('unsupported_key', 'This phone uses a kind of key the app does not support.');
}

/** A DER ECDSA signature (SEQUENCE { r, s }) → the 64-byte r‖s WebCrypto wants. */
export function derToRaw(der) {
  if (der[0] !== 0x30) fail('bad_signature', 'Not DER.');
  let p = 2;
  if (der[1] & 0x80) p = 2 + (der[1] & 0x7f);
  const int = () => {
    if (der[p] !== 0x02) fail('bad_signature', 'Not an integer.');
    const len = der[p + 1];
    let v = der.slice(p + 2, p + 2 + len);
    p += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) fail('bad_signature', 'Too long.');
    return concat(new Uint8Array(32 - v.length), v);
  };
  const r = int(); const s = int();
  return concat(r, s);
}

/** Check clientDataJSON: type, challenge and an allowed origin. Returns { origin, rpId }. */
function checkClientData(cdBytes, type, challenge, origins) {
  let cd;
  try { cd = JSON.parse(new TextDecoder().decode(cdBytes)); } catch { fail('bad_client_data', 'Unreadable.'); }
  if (cd.type !== type) fail('wrong_type', `Expected ${type}.`);
  if (typeof cd.challenge !== 'string' || cd.challenge.replace(/=+$/, '') !== String(challenge).replace(/=+$/, '')) fail('wrong_challenge', 'Old or wrong challenge.');
  if (!origins.includes(cd.origin)) fail('wrong_origin', `Not from this app (${cd.origin}).`);
  let rpId;
  try { rpId = new URL(cd.origin).hostname; } catch { fail('wrong_origin', 'Bad origin.'); }
  return { origin: cd.origin, rpId };
}

/**
 * Switching fingerprint on: check the phone's answer to navigator.credentials.create().
 * r: { clientDataJSON, attestationObject } (base64url). Returns { credentialId (base64url), jwk, alg, signCount, origin, rpId }.
 */
export async function verifyRegistration(r, { challenge, origins }) {
  const cd = b64uDecode(r?.clientDataJSON);
  const { origin, rpId } = checkClientData(cd, 'webauthn.create', challenge, origins);
  const att = cborDecode(b64uDecode(r?.attestationObject)).value;
  if (!(att instanceof Map) || !(att.get('authData') instanceof Uint8Array)) fail('bad_attestation', 'No authenticator data.');
  const ad = parseAuthData(att.get('authData'));
  if (!same(ad.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) fail('wrong_rp', 'Made for another site.');
  if (!ad.flags.up || !ad.flags.uv) fail('no_user_check', 'The phone did not check the finger / face.');
  if (!ad.flags.at || !ad.credentialId) fail('bad_attestation', 'No new key.');
  const { jwk, alg } = coseToJwk(ad.cosePublicKey);
  await importKey(jwk, alg); // fails for a broken key
  return { credentialId: b64uEncode(ad.credentialId), jwk, alg, signCount: ad.signCount, origin, rpId };
}

async function importKey(jwk, alg) {
  try {
    if (alg === -7) return await subtle().importKey('jwk', { ...jwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (alg === -257) return await subtle().importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch { fail('bad_key', 'The saved key is broken.'); }
  return fail('unsupported_key', 'Unknown key.');
}

/**
 * Unlocking: check the phone's answer to navigator.credentials.get() with the saved public key.
 * a: { clientDataJSON, authenticatorData, signature } (base64url). Returns { signCount, origin, rpId }.
 */
export async function verifyAssertion(a, { challenge, origins, jwk, alg }) {
  const cd = b64uDecode(a?.clientDataJSON);
  const { origin, rpId } = checkClientData(cd, 'webauthn.get', challenge, origins);
  const adBytes = b64uDecode(a?.authenticatorData);
  const ad = parseAuthData(adBytes);
  if (!same(ad.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) fail('wrong_rp', 'Made for another site.');
  if (!ad.flags.up || !ad.flags.uv) fail('no_user_check', 'The phone did not check the finger / face.');
  const key = await importKey(jwk, alg);
  const data = concat(adBytes, await sha256(cd));
  const sig = b64uDecode(a?.signature);
  const ok = alg === -7
    ? await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), data)
    : await subtle().verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, data);
  if (!ok) fail('bad_signature', 'The fingerprint answer did not match.');
  return { signCount: ad.signCount, origin, rpId };
}

/** A fresh random challenge (base64url, 32 bytes). */
export function newChallenge() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return b64uEncode(b);
}
