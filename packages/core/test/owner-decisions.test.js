// Rules added from the owner's decisions of 26 Sept 2026 (not in the prototype):
// advance refunds / moves / credit, cancelling, old balances from the paper khata,
// payment reminders (oldest slip first, neutral wording), and the "change rate" permission.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

const TZ = 'Asia/Kolkata';
const order = (id, slipNo, bill, total, doneAt, extra = {}) => ({ id, slipNo, cust: 'c1', status: 'done', inKhata: true, bill, billTotal: total, doneAt, ...extra });
const pay = (id, amt, kind, extra = {}) => ({ id, cust: 'c1', at: '2026-09-20T10:00:00Z', amt, mode: 'Cash', side: null, oid: null, kind, ...extra });

test('old balances: lump sum and old slips count as the oldest dues; payments clear them first', () => {
  const oldDues = [
    { id: 'd1', cust: 'c1', side: 'kacha', date: '2026-07-01', amt: 20000, ref: null },
    { id: 'd2', cust: 'c1', side: 'kacha', date: '2026-07-15', amt: 5000, ref: '553' },
    { id: 'd3', cust: 'c1', side: 'pakka', date: '2026-07-10', amt: 8000, ref: null },
  ];
  const orders = [order('o1', '1042', 'kacha', 12500, '2026-09-03T08:00:00Z')];
  const payments = [pay('p1', 22000, 'khata', { side: 'kacha', at: '2026-09-10T08:00:00Z', mode: 'UPI' })];
  const l = c.customerLedger({ custId: 'c1', orders, payments, oldDues, sides: ['pakka', 'kacha'] });
  assert.equal(l.bySide.kacha.due, 20000 + 5000 + 12500 - 22000);
  assert.equal(l.bySide.pakka.due, 8000);
  const lump = l.bills.find((b) => b.did === 'd1'), slip553 = l.bills.find((b) => b.did === 'd2');
  assert.equal(lump.rem, 0, 'lump sum (oldest) cleared first');
  assert.equal(slip553.rem, 3000, 'then the old slip, partly');
  assert.equal(l.bills.find((b) => b.oid === 'o1').rem, 12500, 'newest untouched');
  assert.equal(l.oldest, '2026-07-10', 'oldest unpaid across both sides');
});

test('advance returned, moved or kept as credit — balances stay right', () => {
  const orders = [
    { id: 'o1', slipNo: '1050', cust: 'c1', status: 'accepted' },
    { id: 'o2', slipNo: '1051', cust: 'c1', status: 'accepted' },
  ];
  const payments = [
    pay('a1', 10000, 'advance', { oid: 'o1' }),
    pay('r1', -4000, 'refund', { oid: 'o1', mode: 'UPI' }),           // part returned
    pay('t1', -3000, 'transfer', { oid: 'o1', mode: 'Adjust' }),      // moved to o2
    pay('a2', 3000, 'advance', { oid: 'o2', mode: 'Adjust' }),
    pay('t2', -3000, 'transfer', { oid: 'o1', mode: 'Adjust' }),      // rest kept as credit
    pay('k1', 3000, 'khata', { side: 'pakka', mode: 'Adjust' }),
  ];
  assert.equal(c.advanceOf('o1', payments), 0, 'nothing left on o1');
  assert.equal(c.advanceOf('o2', payments), 3000);
  const l = c.customerLedger({ custId: 'c1', orders, payments, sides: ['pakka', 'kacha'] });
  assert.equal(l.pend, 3000, 'pending advance = only what sits on open orders');
  assert.equal(l.bySide.pakka.adv, 3000, 'credit held for the customer');
  assert.equal(l.adv, 6000);
  assert.ok(c.canCancel('accepted') && c.canCancel('weighed') && !c.canCancel('done') && !c.canCancel('estimate'));
  assert.ok(c.canTransition('weighed', 'cancelled') && !c.canTransition('cancelled', 'accepted'));
});

test('extra advance after finishing can be returned', () => {
  const orders = [order('o1', '1060', 'pakka', 7000, '2026-09-20T08:00:00Z', { inKhata: true })];
  const payments = [pay('a1', 10000, 'advance', { oid: 'o1' }), pay('r1', -3000, 'refund', { oid: 'o1' })];
  const l = c.customerLedger({ custId: 'c1', orders, payments, sides: ['pakka'] });
  assert.equal(l.bySide.pakka.due, 0);
  assert.equal(l.bySide.pakka.adv, 0, 'extra 3,000 was returned, nothing held');
});

test('reminders: unpaid and part-paid slips, oldest first, ages by the shop date', () => {
  const orders = [
    order('o1', '1042', 'kacha', 12500, '2026-08-20T20:00:00Z'), // 21 Aug in India
    order('o2', '1077', 'kacha', 4000, '2026-09-18T06:00:00Z'),
    order('o3', '1080', 'pakka', 9000, '2026-08-25T06:00:00Z'),
  ];
  const payments = [pay('p1', 5000, 'khata', { side: 'kacha', mode: 'UPI', at: '2026-09-01T06:00:00Z' })];
  const d = c.dueSlips({ custId: 'c1', side: 'kacha', orders, payments, now: '2026-09-26T06:00:00Z', timeZone: TZ });
  assert.equal(d.due, 11500);
  assert.deepEqual(d.slips.map((s) => [s.ref, s.paid, s.balance, s.days]), [['1042', 5000, 7500, 36], ['1077', 0, 4000, 8]]);
  assert.deepEqual(d.recentPayments, [{ date: '2026-09-01', amount: 5000, mode: 'UPI' }]);
  assert.ok(c.needsReminder(d, { afterDays: 25, now: '2026-09-26T06:00:00Z', timeZone: TZ }));
  assert.ok(!c.needsReminder(d, { afterDays: 40, now: '2026-09-26T06:00:00Z', timeZone: TZ }));
  assert.ok(!c.needsReminder(d, { afterDays: 25, lastReminderAt: '2026-09-22T06:00:00Z', repeatDays: 7, now: '2026-09-26T06:00:00Z', timeZone: TZ }), 'asked 4 days ago');
  assert.ok(c.needsReminder(d, { afterDays: 25, lastReminderAt: '2026-09-18T06:00:00Z', repeatDays: 7, now: '2026-09-26T06:00:00Z', timeZone: TZ }));
  const p = c.dueSlips({ custId: 'c1', side: 'pakka', orders, payments, now: '2026-09-26T06:00:00Z', timeZone: TZ });
  assert.equal(p.due, 9000, 'sides kept separate');
});

test('reminder message: slip numbers, paid, balance — never the bill type, in 3 languages', () => {
  const due = {
    due: 31500, recentPayments: [{ date: '2026-09-01', amount: 5000, mode: 'UPI' }],
    slips: [
      { ref: null, old: true, date: '2026-07-01', amount: 20000, paid: 0, balance: 20000 },
      { ref: '1042', old: false, date: '2026-08-21', amount: 12500, paid: 5000, balance: 7500 },
      { ref: '1077', old: false, date: '2026-09-18', amount: 4000, paid: 0, balance: 4000 },
    ],
  };
  for (const lang of ['en', 'hn', 'hi']) {
    const m = c.reminderMessage({ lang, shop: 'SRS Trading', customer: 'Rana Tools', due });
    assert.doesNotMatch(m, /kacha|kachha|pakka|kaccha|कच्च|पक्क|gst|bill type|no bill/i, lang);
    assert.match(m, /1042/); assert.match(m, /1077/);
    assert.match(m, /₹31,500/); assert.match(m, /₹7,500/); assert.match(m, /₹5,000/);
  }
  const en = c.reminderMessage({ lang: 'en', shop: 'SRS Trading', customer: 'Rana Tools', due });
  assert.match(en, /Old balance \(1 Jul\): ₹20,000 · balance ₹20,000/);
  assert.match(en, /Slip 1042 \(21 Aug\): ₹12,500 · paid ₹5,000 · balance ₹7,500/);
  assert.match(en, /Payments received: ₹5,000 by UPI on 1 Sep/);
  const link = c.whatsappLink('98111 22334', en);
  assert.ok(link.startsWith('https://wa.me/919811122334?text='));
  assert.equal(decodeURIComponent(link.split('text=')[1]), en);
  assert.equal(c.whatsappLink('12345', en), null);
});

test('change-rate permission: owners have it, other presets do not', () => {
  assert.ok(c.PERMS.includes('price'));
  assert.ok(c.can(c.ROLE_PRESETS.owner(), 'price'));
  for (const r of ['sales', 'weigher', 'accounts']) assert.ok(!c.can(c.ROLE_PRESETS[r](), 'price'), r);
});
