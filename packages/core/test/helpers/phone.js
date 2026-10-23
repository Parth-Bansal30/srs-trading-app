// A pretend phone for the fingerprint tests: makes keys and answers like a real authenticator.
import * as c from '../../src/index.js';

const enc = new TextEncoder();
export function cbor(v) {
  const head = (major, n) => (n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') { const b = enc.encode(v); return Uint8Array.from([...head(3, b.length), ...b]); }
  if (v instanceof Uint8Array) return Uint8Array.from([...head(2, v.length), ...v]);
  if (v instanceof Map) { const parts = [...v].flatMap(([k, x]) => [...cbor(k), ...cbor(x)]); return Uint8Array.from([...head(5, v.size), ...parts]); }
  throw new Error('cbor?');
}
const cat = (...a) => Uint8Array.from(a.flatMap((x) => [...x]));
export const rawToDer = (raw) => {
  const int = (b) => { let x = [...b]; while (x.length > 1 && x[0] === 0 && !(x[1] & 0x80)) x.shift(); if (x[0] & 0x80) x = [0, ...x]; return [2, x.length, ...x]; };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
};
export async function phone({ rpId = 'localhost', origin = 'http://localhost:8173', rsa = false } = {}) {
  const alg = rsa ? { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' } : { name: 'ECDSA', namedCurve: 'P-256' };
  const keys = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const credId = crypto.getRandomValues(new Uint8Array(20));
  const rpHash = await c.sha256(enc.encode(rpId));
  let count = 0;
  const cose = rsa
    ? new Map([[1, 3], [3, -257], [-1, c.b64uDecode(jwk.n)], [-2, c.b64uDecode(jwk.e)]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, c.b64uDecode(jwk.x)], [-3, c.b64uDecode(jwk.y)]]);
  const counter = (n) => Uint8Array.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  return {
    create(challenge, flags = 0x45) {
      const authData = cat(rpHash, [flags], counter(0), new Uint8Array(16), [0, credId.length], credId, cbor(cose));
      const clientDataJSON = enc.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      return { clientDataJSON: c.b64uEncode(clientDataJSON), attestationObject: c.b64uEncode(cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))) };
    },
    async get(challenge, { flags = 0x05, type = 'webauthn.get', from = origin, step = 1 } = {}) {
      count += step;
      const authenticatorData = cat(rpHash, [flags], counter(count));
      const clientDataJSON = enc.encode(JSON.stringify({ type, challenge, origin: from }));
      const data = cat(authenticatorData, await c.sha256(clientDataJSON));
      let sig = new Uint8Array(await crypto.subtle.sign(rsa ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, data));
      if (!rsa) sig = rawToDer(sig);
      return { clientDataJSON: c.b64uEncode(clientDataJSON), authenticatorData: c.b64uEncode(authenticatorData), signature: c.b64uEncode(sig) };
    },
    credId: c.b64uEncode(credId),
  };
}
