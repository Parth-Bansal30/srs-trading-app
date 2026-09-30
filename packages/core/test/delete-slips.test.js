// Deleting a slip (owner decision 30 Sept 2026): owners only, any stage, kept but counted nowhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

const order = (id, slipNo, total, extra = {}) => ({ id, slipNo, cust: 'c1', status: 'done', inKhata: true, bill: 'pakka', billTotal: total, doneAt: '2026-09-20T08:00:00Z', ...extra });
const pay = (id, amt, kind, extra = {}) => ({ id, cust: 'c1', at: '2026-09-20T10:00:00Z', amt, mode: 'Cash', side: null, oid: null, kind, ...extra });

test('only owners can delete by default; any stage except deleted', () => {
  assert.ok(c.PERMS.includes('delete'));
  assert.ok(c.can(c.ROLE_PRESETS.owner(), 'delete'));
  for (const r of ['sales', 'weigher', 'accounts']) assert.ok(!c.can(c.ROLE_PRESETS[r](), 'delete'), r);
  for (const s of ['estimate', 'accepted', 'weighed', 'done', 'cancelled']) {
    assert.ok(c.canDelete(s), s);
    assert.ok(c.canTransition(s, 'deleted'), s);
  }
  assert.ok(!c.canDelete('deleted'));
  assert.ok(!c.canTransition('deleted', 'done'));
});

test('a deleted slip leaves the khata: its bill and its money are gone', () => {
  // #1 real slip 10,000 (due). #2 deleted slip 5,000 with 1,000 advance that was reversed ("never received").
  const orders = [order('o1', '1', 10000), order('o2', '2', 5000, { status: 'deleted' })];
  const payments = [
    pay('p1', 1000, 'advance', { oid: 'o2' }),
    pay('p1r', -1000, 'advance', { oid: 'o2' }), // a reversal carries the kind it reverses
  ];
  const l = c.customerLedger({ custId: 'c1', orders, payments, sides: ['pakka', 'kacha'] });
  assert.equal(l.due, 10000);
  assert.equal(l.adv, 0);
  assert.equal(l.entries.length, 1);
  assert.ok(l.entries.every((e) => e.oid !== 'o2'));
});

test('deleted with "kept as credit": the customer keeps the money as khata credit', () => {
  // deleted finished slip 5,000 paid 2,000 at pickup → transfer −2,000 on the slip, +2,000 khata credit
  const orders = [order('o2', '2', 5000, { status: 'deleted', inKhata: true })];
  const payments = [
    pay('p1', 2000, 'pickup', { oid: 'o2' }),
    pay('t1', -2000, 'transfer', { oid: 'o2', mode: 'Adjust' }),
    pay('k1', 2000, 'khata', { side: 'pakka', mode: 'Adjust' }),
  ];
  const l = c.customerLedger({ custId: 'c1', orders, payments, sides: ['pakka', 'kacha'] });
  assert.equal(l.due, 0);
  assert.equal(l.adv, 2000);
  // and with a real slip afterwards, the credit pays it first
  const l2 = c.customerLedger({ custId: 'c1', orders: [...orders, order('o3', '3', 3000, { doneAt: '2026-09-25T08:00:00Z' })], payments, sides: ['pakka', 'kacha'] });
  assert.equal(l2.due, 1000);
  assert.equal(l2.adv, 0);
});

test('deleted with "gave it back": nothing left either way', () => {
  const orders = [order('o2', '2', 5000, { status: 'deleted', deletedFrom: 'accepted', billTotal: null, bill: null, inKhata: false })];
  const payments = [pay('p1', 1500, 'advance', { oid: 'o2' }), pay('r1', -1500, 'refund', { oid: 'o2' })];
  const l = c.customerLedger({ custId: 'c1', orders, payments, sides: ['pakka', 'kacha'] });
  assert.equal(l.due, 0);
  assert.equal(l.adv, 0);
  assert.equal(l.pend, 0);
  assert.equal(l.entries.length, 0);
});

test('statements never list a deleted slip', () => {
  const orders = [order('o1', '1', 1000, { inKhata: false }), order('o2', '2', 5000, { status: 'deleted', inKhata: false })];
  const payments = [pay('p1', 1000, 'pickup', { oid: 'o1' })];
  const extra = c.paidSlipEntries({ custId: 'c1', orders, payments, sides: ['pakka'] });
  assert.equal(extra.length, 2);
  assert.ok(extra.every((e) => e.oid === 'o1'));
});

test('evening summary: a slip deleted today needs a look', () => {
  const s = c.daySummary({ deleted: [{ slipNo: '1072', customer: 'Test customer', reason: 'Test entry', by: 'Parth' }] });
  const d = s.look.find((x) => x.type === 'deleted');
  assert.deepEqual(d, { type: 'deleted', slipNo: '1072', customer: 'Test customer', reason: 'Test entry', by: 'Parth' });
});
