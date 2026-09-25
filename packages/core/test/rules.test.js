/**
 * RULES: the business rules agreed with the owner (claude/agreed-business-rules.md),
 * written as plain examples. These must hold no matter where the code runs
 * (phone, laptop, or a server in another time zone).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

const item = (x) => ({ matId: 'EN8', unit: 'mm', rate: 75, cutRate: 3, density: 7850, aw: null, rows: [{ len: 500, pcs: 1, cuts: '' }], ...x });

test('cutting: 100 mm = 3.94 in → 4 in; 4 × 4 = 16 sq in × Rs 3 = Rs 48 per cut', () => {
  const r = c.calcItem(item({ shape: 'square', d: [100] }), 'est', { minInch: 1 });
  assert.equal(r.sides[0].inch, 4);
  assert.equal(r.area, 16);
  assert.equal(r.cut, 48);
});

test('inch rounding: 3.5 in and above goes up, below goes down', () => {
  assert.equal(c.inchOf(88.9), 4); // exactly 3.5 in
  assert.equal(c.inchOf(88.8), 3); // just under 3.5 in
  assert.equal(c.inchOf(25.4 * 2.49), 2);
});

test('smallest inches per side: under 12.7 mm rounds to 0, the minimum setting lifts it', () => {
  assert.equal(c.inchOf(10, 0), 0);
  assert.equal(c.inchOf(10, 1), 1);
});

test('number of cuts = number of pieces unless typed', () => {
  assert.equal(c.calcItem(item({ shape: 'round', d: [40], rows: [{ len: 300, pcs: 8, cuts: '' }] }), 'est').cuts, 8);
  assert.equal(c.calcItem(item({ shape: 'round', d: [40], rows: [{ len: 300, pcs: 8, cuts: 5 }] }), 'est').cuts, 5);
});

test('one item, several lengths: 10 pcs × 20 in and 5 pcs × 5 in share one grade and size', () => {
  const it = item({ shape: 'flat', unit: 'in', d: [10, 1], rows: [{ len: 20, pcs: 10, cuts: '' }, { len: 5, pcs: 5, cuts: '' }] });
  const r = c.calcItem(it, 'est');
  assert.equal(r.pcs, 15);
  assert.equal(r.cuts, 15);
  assert.equal(r.rows.length, 2);
});

test('sizes can be typed as 2.5, "2 1/2", "2-1/2" or "1/2"', () => {
  assert.equal(c.parseLen('2 1/2'), 2.5);
  assert.equal(c.parseLen('2-1/2'), 2.5);
  assert.equal(c.parseLen('1/2'), 0.5);
  assert.equal(c.parseLen('2.5'), 2.5);
  assert.ok(Number.isNaN(c.parseLen('')));
});

test('final price uses the ACTUAL weighed weight; estimate uses weight from size', () => {
  const it = item({ shape: 'square', d: [50], aw: 10 });
  assert.equal(c.calcItem(it, 'final').weight, 10);
  assert.notEqual(c.calcItem(it, 'est').weight, 10);
  assert.equal(c.calcItem(it, 'final').mat, 750); // 10 kg × Rs 75
});

test('GST bill adds 18% on material + cutting; no-bill adds 10% spread inside both', () => {
  const o = { items: [item({ shape: 'square', d: [50], aw: 10 })] }; // mat 750, cut 2×2×3×1 = 12
  const g = c.orderTotals(o, 'final', { bill: 'pakka' });
  assert.equal(g.base, 762);
  assert.equal(g.gst, 137.16);
  assert.equal(g.total, 899.16);
  const k = c.orderTotals(o, 'final', { bill: 'kacha' });
  assert.equal(k.matK, 825);
  assert.equal(k.cutK, 13.2);
  assert.equal(k.gst, 0);
  assert.equal(k.total, 838.2);
});

test('the % saved on a finished order wins over today\'s setting (old bills never change)', () => {
  const o = { bill: 'pakka', gstPct: 12, items: [item({ shape: 'square', d: [50], aw: 10 })] };
  assert.equal(c.orderTotals(o, 'final', { gstPct: 18 }).pct, 12);
});

test('finish: advance comes off; extra advance stays with the customer', () => {
  const order = { items: [item({ shape: 'square', d: [50], aw: 10 })] };
  const f = c.finishCalc({ order, advance: 1000, bill: 'pakka' }); // total 899.16
  assert.equal(f.B, 0);
  assert.equal(f.extra, 100.84);
  assert.equal(f.mode, 'now');
  assert.equal(c.finishProblem(f), null);
});

test('finish: part payment must be more than 0 and less than the balance', () => {
  const order = { items: [item({ shape: 'square', d: [50], aw: 10 })] };
  const f = (paid) => c.finishCalc({ order, advance: 0, bill: 'pakka', payMode: 'part', paid });
  assert.equal(c.finishProblem(f(0)), 'need_part');
  assert.equal(c.finishProblem(f(899.16)), 'need_part');
  assert.equal(c.finishProblem(f(300)), null);
  assert.equal(f(300).due, 599.16);
  assert.equal(c.finishProblem(c.finishCalc({ order, bill: null })), 'choose_bill');
});

test('khata: paid in full at pickup stays out; anything else goes in', () => {
  assert.equal(c.staysInKhata(899.16, 899.16), false);
  assert.equal(c.staysInKhata(500, 899.16), true);
});

test('khata: payments clear the oldest unpaid bill first', () => {
  const orders = [
    { id: 1, cust: 'c1', status: 'done', inKhata: true, bill: 'pakka', doneAt: '2026-09-01T06:00:00Z', items: [item({ shape: 'square', d: [50], aw: 10 })], gstPct: 18 },
    { id: 2, cust: 'c1', status: 'done', inKhata: true, bill: 'pakka', doneAt: '2026-09-10T06:00:00Z', items: [item({ shape: 'square', d: [50], aw: 10 })], gstPct: 18 },
  ];
  const payments = [{ id: 'p1', cust: 'c1', at: '2026-09-12T06:00:00Z', amt: 1000, mode: 'Cash', side: 'pakka', oid: null, kind: 'due' }];
  const l = c.customerLedger({ custId: 'c1', orders, payments, sides: ['pakka'] });
  assert.equal(l.bills[0].rem, 0); // oldest paid off first
  assert.equal(l.bills[1].rem, 798.32);
  assert.equal(l.due, 798.32);
  assert.equal(l.entries.at(-1).bal, 798.32);
});

test('weigh together: one reading split by expected weight (from the prototype\'s own run)', () => {
  assert.deepEqual(c.splitBatchWeight([20.096, 11.303999999999998], 60), [38.4, 21.6]);
  assert.equal(c.canWeighTogether([{ matId: 'EN8' }, { matId: 'EN8' }]), true);
  assert.equal(c.canWeighTogether([{ matId: 'EN8' }, { matId: 'EN9' }]), false); // different grades never together
});

test('order stages: estimate → accepted → weighed → done, no skipping or going back', () => {
  assert.ok(c.canTransition('estimate', 'accepted'));
  assert.ok(c.canTransition('accepted', 'weighed'));
  assert.ok(c.canTransition('weighed', 'done'));
  assert.ok(!c.canTransition('estimate', 'done'));
  assert.ok(!c.canTransition('done', 'estimate'));
  assert.ok(c.isEditable('estimate') && !c.isEditable('accepted'));
  assert.ok(c.canAddAdvance('accepted') && c.canAddAdvance('weighed') && !c.canAddAdvance('done'));
});

test('permissions: weigher sees no money; kacha only with the kacha permission', () => {
  const w = c.ROLE_PRESETS.weigher();
  assert.equal(c.can(w, 'money'), false);
  assert.deepEqual(c.visibleSides(w), ['pakka']);
  assert.deepEqual(c.visibleSides(c.ROLE_PRESETS.owner()), ['pakka', 'kacha']);
});

test('slip numbers: date-tag formats for each scheme', () => {
  const iso = '2026-09-22T06:00:00Z';
  assert.equal(c.formatSlipNo('daily', iso, 1), '22Sep-1');
  assert.equal(c.formatSlipNo('monthly', iso, 1), 'Sep26-1');
  assert.equal(c.formatSlipNo('yearly', iso, 1), 'FY26-27-1');
  assert.equal(c.formatSlipNo('never', iso, 1061), '1061');
});

test('slip numbers: Indian financial year flips on 1 April', () => {
  assert.equal(c.slipKeyFor('yearly', '2026-03-31T12:00:00Z'), '2025-2026');
  assert.equal(c.slipKeyFor('yearly', '2026-04-01T00:00:00Z'), '2026-2027'); // 05:30 IST on 1 Apr
});

test('slip numbers use the SHOP\'s midnight, even on a server running in UTC', () => {
  // 18:45 UTC on 22 Sep is already 00:15 on 23 Sep in India → a new daily book.
  assert.equal(c.slipTagFor('daily', '2026-09-22T18:45:00Z'), '23Sep');
  assert.equal(c.slipTagFor('daily', '2026-09-22T18:29:00Z'), '22Sep');
  // a shop elsewhere gets its own midnight
  assert.equal(c.slipTagFor('daily', '2026-09-22T18:45:00Z', 'Europe/London'), '22Sep');
});

test('next slip: daily counter restarts per day; continuous mirrors the internal number', () => {
  const a = c.nextSlip({ scheme: 'daily', iso: '2026-09-22T06:00:00Z', counters: {} });
  assert.deepEqual(a, { slipNo: '22Sep-1', counterKey: '2026-09-22', counterValue: 1 });
  const b = c.nextSlip({ scheme: 'daily', iso: '2026-09-22T07:00:00Z', counters: { '2026-09-22': 1 } });
  assert.equal(b.slipNo, '22Sep-2');
  assert.equal(c.nextSlip({ scheme: 'daily', iso: '2026-09-23T06:00:00Z', counters: { '2026-09-22': 9 } }).slipNo, '23Sep-1');
  assert.equal(c.nextSlip({ scheme: 'never', internalNo: 1061 }).slipNo, '1061');
});
