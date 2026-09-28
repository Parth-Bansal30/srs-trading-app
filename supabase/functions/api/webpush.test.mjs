// Phone notifications: the encryption matches the RFC 8291 worked example exactly, and the VAPID
// signature checks out with the public key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPayload, b64u, generateVapidKeys, vapidAuth, sendPush } from './webpush.js';

test('web push: RFC 8291 example (section 5) comes out byte for byte', async () => {
  const body = await encryptPayload(
    { keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } },
    'When I grow up, I want to be a watermelon',
    { asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', salt: 'DGv6ra1nlYgDCS1FRnbzlw' },
  );
  assert.equal(b64u.encode(body), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('web push: VAPID token is signed with the private key and names the push service', async () => {
  const v = await generateVapidKeys();
  const h = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', { ...v, subject: 'mailto:shop@example.com' }, 1_800_000_000);
  const [, tok, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v.publicKey);
  const [hd, bd, sg] = tok.split('.');
  const claims = JSON.parse(new TextDecoder().decode(b64u.decode(bd)));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200, sub: 'mailto:shop@example.com' });
  const pub = await crypto.subtle.importKey('raw', b64u.decode(v.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64u.decode(sg), new TextEncoder().encode(`${hd}.${bd}`)));
});

test('web push: a phone that unsubscribed (410) is reported as gone', async () => {
  const phone = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sub = { endpoint: 'https://push.example.com/x', keys: { p256dh: b64u.encode(new Uint8Array(await crypto.subtle.exportKey('raw', phone.publicKey))), auth: b64u.encode(crypto.getRandomValues(new Uint8Array(16))) } };
  const v = await generateVapidKeys();
  let seen;
  const r = await sendPush(sub, { title: 'Hi' }, { ...v, subject: 'mailto:a@b.c' }, { fetchFn: async (url, init) => { seen = init; return { status: 410 }; } });
  assert.deepEqual(r, { ok: false, status: 410, gone: true });
  assert.equal(seen.headers['Content-Encoding'], 'aes128gcm');
});
