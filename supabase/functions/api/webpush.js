// Web Push (phone notifications) with nothing but WebCrypto — works in Deno (Edge Function) and Node (tests).
//   RFC 8291 (message encryption, aes128gcm) + RFC 8292 (VAPID: the server proves who is sending).
// A subscription comes from the phone: { endpoint, keys: { p256dh, auth } } (base64url).
// VAPID keys: public = 65-byte uncompressed P-256 point, private = 32-byte scalar (both base64url).

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export const b64u = {
  encode(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  },
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
const jwkFor = (pub, priv) => ({
  kty: 'EC', crv: 'P-256', ext: true,
  x: b64u.encode(pub.slice(1, 33)), y: b64u.encode(pub.slice(33, 65)),
  ...(priv ? { d: b64u.encode(priv) } : {}),
});

/** A new VAPID key pair (run once; the private key goes into the server's secrets). */
export async function generateVapidKeys() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u.encode(pub), privateKey: jwk.d };
}

/**
 * Encrypt a message for one subscription (RFC 8291). Returns the request body.
 * test: { asPrivate, asPublic, salt } to reproduce the RFC's worked example.
 */
export async function encryptPayload(sub, payload, test = null) {
  const uaPublic = b64u.decode(sub.keys.p256dh);
  const authSecret = b64u.decode(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('bad subscription keys');
  let asPrivateKey; let asPublic;
  if (test) {
    asPublic = b64u.decode(test.asPublic);
    asPrivateKey = await subtle.importKey('jwk', jwkFor(asPublic, b64u.decode(test.asPrivate)), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPrivateKey = kp.privateKey;
    asPublic = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivateKey, 256));
  const salt = test ? b64u.decode(test.salt) : globalThis.crypto.getRandomValues(new Uint8Array(16));

  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])))).slice(0, 32);
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const plain = concat(typeof payload === 'string' ? enc.encode(payload) : payload, new Uint8Array([2]));
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** The VAPID "Authorization" header value for a push service (RFC 8292). */
export async function vapidAuth(endpoint, { publicKey, privateKey, subject }, nowSec = Math.floor(Date.now() / 1000)) {
  const pub = b64u.decode(publicKey);
  const key = await subtle.importKey('jwk', jwkFor(pub, b64u.decode(privateKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.encode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u.encode(sig)}, k=${publicKey}`;
}

/**
 * Send one notification. Returns { ok, status, gone } — gone = the phone unsubscribed (delete the subscription).
 * message: any JSON (the app's service worker shows it).
 */
export async function sendPush(sub, message, vapid, { ttl = 12 * 3600, fetchFn = fetch } = {}) {
  const body = await encryptPayload(sub, JSON.stringify(message));
  const res = await fetchFn(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: 'normal',
    },
    body,
  });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
}
