// Fingerprint unlock (passkeys) and the supplier GST check (23 Oct 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

import { phone, cbor, rawToDer } from './helpers/phone.js';

const ORIGINS = ['http://localhost:8173', 'https://srs-trading-app.bansalparth12345.workers.dev'];
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof c.WebAuthnError && e.code === code);

test('fingerprint: switching on reads the phone\'s public key; unlocking checks the signature (ES256)', async () => {
  const p = await phone();
  const ch = c.newChallenge();
  const reg = await c.verifyRegistration(p.create(ch), { challenge: ch, origins: ORIGINS });
  assert.equal(reg.credentialId, p.credId);
  assert.equal(reg.alg, -7);
  assert.equal(reg.jwk.kty, 'EC');
  assert.equal(reg.rpId, 'localhost');
  const ch2 = c.newChallenge();
  const ok = await c.verifyAssertion(await p.get(ch2), { challenge: ch2, origins: ORIGINS, jwk: reg.jwk, alg: reg.alg });
  assert.equal(ok.signCount, 1);
  const ok2 = await c.verifyAssertion(await p.get(ch2), { challenge: ch2, origins: ORIGINS, jwk: reg.jwk, alg: reg.alg });
  assert.equal(ok2.signCount, 2, 'the counter goes up');
});

test('fingerprint: refuses an old challenge, another site, no finger check, a wrong key, a changed answer', async () => {
  const p = await phone();
  const ch = c.newChallenge();
  const reg = await c.verifyRegistration(p.create(ch), { challenge: ch, origins: ORIGINS });
  await rejects(c.verifyRegistration(p.create(ch), { challenge: c.newChallenge(), origins: ORIGINS }), 'wrong_challenge');
  await rejects(c.verifyRegistration(p.create(ch, 0x41), { challenge: ch, origins: ORIGINS }), 'no_user_check');
  const ch2 = c.newChallenge();
  await rejects(c.verifyAssertion(await p.get(ch2), { challenge: c.newChallenge(), origins: ORIGINS, jwk: reg.jwk, alg: -7 }), 'wrong_challenge');
  await rejects(c.verifyAssertion(await p.get(ch2, { from: 'https://evil.example' }), { challenge: ch2, origins: ORIGINS, jwk: reg.jwk, alg: -7 }), 'wrong_origin');
  await rejects(c.verifyAssertion(await p.get(ch2, { type: 'webauthn.create' }), { challenge: ch2, origins: ORIGINS, jwk: reg.jwk, alg: -7 }), 'wrong_type');
  await rejects(c.verifyAssertion(await p.get(ch2, { flags: 0x01 }), { challenge: ch2, origins: ORIGINS, jwk: reg.jwk, alg: -7 }), 'no_user_check');
  const other = await phone();
  const och = c.newChallenge();
  const oreg = await c.verifyRegistration(other.create(och), { challenge: och, origins: ORIGINS });
  await rejects(c.verifyAssertion(await p.get(ch2), { challenge: ch2, origins: ORIGINS, jwk: oreg.jwk, alg: -7 }), 'bad_signature');
  const a = await p.get(ch2);
  const tampered = { ...a, authenticatorData: c.b64uEncode(Uint8Array.from(c.b64uDecode(a.authenticatorData), (x, i) => (i === 36 ? x ^ 1 : x))) };
  await rejects(c.verifyAssertion(tampered, { challenge: ch2, origins: ORIGINS, jwk: reg.jwk, alg: -7 }), 'bad_signature');
  // a key made for another site
  const away = await phone({ rpId: 'other.example' });
  const ach = c.newChallenge();
  await rejects(c.verifyRegistration(away.create(ach), { challenge: ach, origins: ORIGINS }), 'wrong_rp');
});

test('fingerprint: Windows Hello style RS256 keys work too', async () => {
  const p = await phone({ rsa: true });
  const ch = c.newChallenge();
  const reg = await c.verifyRegistration(p.create(ch), { challenge: ch, origins: ORIGINS });
  assert.equal(reg.alg, -257);
  const ch2 = c.newChallenge();
  assert.equal((await c.verifyAssertion(await p.get(ch2), { challenge: ch2, origins: ORIGINS, jwk: reg.jwk, alg: -257 })).signCount, 1);
});

test('small pieces: base64url, CBOR, DER signatures', () => {
  const b = Uint8Array.from([0, 1, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(c.b64uDecode(c.b64uEncode(b)), b);
  assert.ok(!c.b64uEncode(b).includes('='));
  const m = c.cborDecode(cbor(new Map([['a', 1], [-2, Uint8Array.from([7])], [3, -300]]))).value;
  assert.equal(m.get('a'), 1); assert.deepEqual(m.get(-2), Uint8Array.from([7])); assert.equal(m.get(3), -300);
  assert.throws(() => c.cborDecode(Uint8Array.from([0x59, 1])), (e) => e.code === 'bad_cbor');
  const raw = Uint8Array.from({ length: 64 }, (_, i) => (i === 0 ? 0x80 : i === 32 ? 0 : i));
  assert.deepEqual(c.derToRaw(rawToDer(raw)), raw);
});

// ---------- the supplier GST check ----------
test('GST answers from a data service: portal fields and other names', () => {
  const portal = { data: { data: { gstin: '03AAACL1234A1Z5', sts: 'Cancelled', lgnm: 'LUDHIANA STEEL ROLLING MILLS PVT LTD', tradeNam: 'LSRM',
    rgdt: '01/07/2017', cxdt: '12/08/2026', dty: 'Regular' } } };
  assert.deepEqual(c.readGstAnswer(portal), { status: 'cancelled', legalName: 'LUDHIANA STEEL ROLLING MILLS PVT LTD', tradeName: 'LSRM',
    regDate: '2017-07-01', cancelDate: '2026-08-12', taxpayerType: 'Regular' });
  assert.equal(c.readGstAnswer({ data: { registration_status: 'Active', legal_name: 'X', date_of_registration: '2019-04-01' } }).status, 'active');
  assert.equal(c.readGstAnswer({ status: 'FAILED', error_code: 'INVALID_GSTIN', message: 'GSTIN not found' }).status, 'not_found');
  assert.equal(c.readGstAnswer({ result: { sts: 'Suspended' } }).status, 'suspended');
  assert.equal(c.readGstAnswer({ hello: 1 }), null);
  assert.equal(c.readGstAnswer(null), null);
  assert.equal(c.gstStatusWord('Inactive'), 'inactive');
  assert.equal(c.gstStatusWord('ACT'), 'active');
  assert.equal(c.gstDate('2026-08-12T00:00:00Z'), '2026-08-12');
  assert.equal(c.gstDate('soon'), null);
});

test('same firm whatever the M/s, Pvt Ltd and spacing', () => {
  assert.ok(c.sameFirm('M/s Ludhiana Steel Rolling Mills', 'LUDHIANA STEEL ROLLING MILLS PVT. LTD.'));
  assert.ok(c.sameFirm('Gupta Engg', 'GUPTA ENGG WORKS'));
  assert.ok(!c.sameFirm('Gupta Engineering', 'Sharma Metals'));
  assert.ok(c.sameFirm('', 'Anything'));
});

test('warnings for a bill: cancelled (and billed after it), suspended, a different firm, never / long ago checked', () => {
  const gstin = '07AAACR5055K1Z9';
  const now = '2026-10-23T10:00:00Z';
  const cancelled = { status: 'cancelled', cancelDate: '2026-08-12', legalName: 'RAJ STEELS', checkedAt: '2026-10-20T10:00:00Z' };
  let w = c.supplierGstWarnings(cancelled, { gstin, billDate: '2026-09-01', supplierName: 'Raj Steels' }, now);
  assert.deepEqual(w.map((x) => [x.type, x.level, x.afterCancel]), [['gst_cancelled', 'bad', true]]);
  w = c.supplierGstWarnings(cancelled, { gstin, billDate: '2026-08-01', supplierName: 'Raj Steels' }, now);
  assert.equal(w[0].afterCancel, false, 'a bill from before the cancellation');
  w = c.supplierGstWarnings({ status: 'suspended' }, { gstin, supplierName: 'Raj' }, now);
  assert.equal(w[0].type, 'gst_suspended');
  w = c.supplierGstWarnings({ status: 'active', legalName: 'SHARMA METALS', checkedAt: '2026-10-20T10:00:00Z' }, { gstin, supplierName: 'Raj Steels' }, now);
  assert.deepEqual(w.map((x) => x.type), ['gst_name']);
  w = c.supplierGstWarnings({ status: 'active', legalName: 'RAJ STEELS', checkedAt: '2026-08-01T10:00:00Z' }, { gstin, supplierName: 'Raj Steels' }, now);
  assert.deepEqual(w.map((x) => x.type), ['gst_old']);
  assert.deepEqual(c.supplierGstWarnings(null, { gstin }, now).map((x) => x.type), ['gst_unchecked']);
  assert.deepEqual(c.supplierGstWarnings(cancelled, { gstin, billType: 'kacha' }, now), [], 'no GST on a no-bill purchase');
  assert.deepEqual(c.supplierGstWarnings(cancelled, { gstin: '07AAACR5055K1Z4' }, now), [], 'a typing mistake has its own check');
});
