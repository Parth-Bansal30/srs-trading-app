// Same customer twice + joining two customers (plan v2 F9) — all names and numbers made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phone10, normName, similarNames, similarCustomers, joinPlan } from '../src/customerMatch.js';
import { customerLedger } from '../src/ledger.js';

const list = [
  { id: 'a', name: 'Sharma Engineering', phone: '+91 98110 22334', active: true },
  { id: 'b', name: 'Gupta Iron Store', phone: null, active: true },
  { id: 'c', name: 'Sharma Steels', phone: '9810099887', active: true },
  { id: 'd', name: 'Old Sharma Engg', phone: '9811022334', active: true, joined_into: 'a' },
];

test('phone: the last 10 digits', () => {
  assert.equal(phone10('+91 98110-22334'), '9811022334');
  assert.equal(phone10('098110 22334'), '9811022334');
  assert.equal(phone10('22334'), '');
});

test('names: spelling that does not make a different business', () => {
  assert.equal(normName('M/s. Sharma Engg. & Co.'), 'sharma eng');
  assert.equal(normName('Sharma Engineering Pvt Ltd'), 'sharma eng');
  assert.ok(similarNames('Sharma Engg', 'Sharma Engineering'));
  assert.ok(similarNames('Gupta Iron Stor', 'Gupta Iron Store'), 'a small typo');
  assert.ok(!similarNames('Sharma Steels', 'Sharma Engineering'), 'a different business');
  assert.ok(!similarNames('Jain', 'Jain Tools'), 'one short word is not enough');
  assert.ok(similarNames('Laxmi Tools', 'Laxmi Tools Faridabad'));
});

test('adding "Sharma Engg" with Sharma Engineering\'s phone: a strong warning; a similar name alone: softer', () => {
  const m = similarCustomers(list, { name: 'Sharma Engg', phone: '9811022334' });
  assert.deepEqual(m.map((x) => [x.c.id, x.why, x.strong]), [['a', 'phone', true]], 'the joined customer is never offered');
  const n = similarCustomers(list, { name: 'Sharma Engg', phone: '' });
  assert.deepEqual(n.map((x) => [x.c.id, x.why, x.strong]), [['a', 'name', false]]);
  assert.deepEqual(similarCustomers(list, { name: 'Sharma Engg', phone: '9811022334' }, ['a']), [], '"different person" is remembered');
});

test('join: the moves come from the khata; the total of both khatas does not change', () => {
  // kept: GST ₹10,000 + no bill ₹2,000 due · old: GST ₹4,000 due and ₹500 paid extra on no bill
  const orders = [
    { id: 'o1', cust: 'K', status: 'done', inKhata: true, bill: 'pakka', billTotal: 10000, doneAt: '2026-10-01' },
    { id: 'o2', cust: 'K', status: 'done', inKhata: true, bill: 'kacha', billTotal: 2000, doneAt: '2026-10-02' },
    { id: 'o3', cust: 'O', status: 'done', inKhata: true, bill: 'pakka', billTotal: 4000, doneAt: '2026-10-03' },
  ];
  const payments = [{ id: 'p1', cust: 'O', amt: 500, side: 'kacha', kind: 'khata', at: '2026-10-04' }];
  const sides = ['pakka', 'kacha'];
  const K = customerLedger({ custId: 'K', orders, payments, sides });
  const O = customerLedger({ custId: 'O', orders, payments, sides });
  const plan = joinPlan(K.bySide, O.bySide);
  assert.deepEqual(plan.moves, [{ side: 'kacha', kind: 'credit', amount: 500 }, { side: 'pakka', kind: 'due', amount: 4000 }]);
  // what the database writes: old → a join payment for the due, a balance entry for the credit; kept → the opposite
  const at = '2026-11-05';
  const pay2 = [...payments, { id: 'j1', cust: 'O', amt: 4000, side: 'pakka', kind: 'join', at }, { id: 'j2', cust: 'K', amt: 500, side: 'kacha', kind: 'join', at }];
  const old2 = [{ id: 'd1', cust: 'K', side: 'pakka', date: at, amt: 4000 }, { id: 'd2', cust: 'O', side: 'kacha', date: at, amt: 500 }];
  const K2 = customerLedger({ custId: 'K', orders, payments: pay2, oldDues: old2, sides });
  const O2 = customerLedger({ custId: 'O', orders, payments: pay2, oldDues: old2, sides });
  assert.deepEqual([O2.due, O2.adv], [0, 0], 'the old customer is at ₹0');
  assert.deepEqual([K2.bySide.pakka.due, K2.bySide.kacha.due, K2.bySide.kacha.adv], [14000, 1500, 0]);
  assert.deepEqual(plan.after.kept, { kacha: { due: 1500, adv: 0 }, pakka: { due: 14000, adv: 0 } }, 'the preview says the same');
  assert.equal(r(K.due - K.adv + O.due - O.adv), r(K2.due - K2.adv + O2.due - O2.adv), 'same total before and after');
});
const r = (x) => Math.round(x * 100) / 100;

test('a new supplier: who looks the same (9 Nov 2026), and a name off a bank line', async () => {
  const { similarSuppliers, bankNameGuess } = await import('../src/customerMatch.js');
  const list = [{ id: 's1', name: 'Ridhi Sidhi Enterprises' }, { id: 's2', name: 'PK Traders', gstin: '07AABCP1234Q1Z5' }, { id: 's3', name: 'Old Co', active: false }];
  assert.deepEqual(similarSuppliers(list, { name: 'RIDHI SIDHI EN TERPRISES' }).map((x) => [x.s.id, x.why]), [['s1', 'name']]);
  assert.deepEqual(similarSuppliers(list, { name: 'New Steel', gstin: '07aabcp1234q1z5' }).map((x) => [x.s.id, x.strong]), [['s2', true]]);
  assert.equal(similarSuppliers(list, { name: 'Old Co' }).length, 0, 'not the ones switched off');
  assert.equal(similarSuppliers(list, { name: 'Bansal Metals' }).length, 0);
  assert.equal(bankNameGuess('RIDHI SIDHI EN TERPRISES'), 'Ridhi Sidhi En Terprises');
  assert.equal(bankNameGuess('  M/S  sharma  & sons '), 'M/S Sharma & Sons');
  assert.equal(bankNameGuess(''), '');
});
