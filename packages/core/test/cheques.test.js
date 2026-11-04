// Cheques and DDs in bank statements (plan v2 F5). All names and numbers are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chequeLine, chequeNo, chequeShow, chequeCandidates, depositOf } from '../src/cheques.js';
import { suggestBankLines } from '../src/bankStatement.js';

const L = (amount, narration, ref = null, day = '2026-10-27') => ({ id: narration, day, amount, narration, ref, status: 'open' });

test('cheque lines in the ways Indian banks write them: kind, number, bank', () => {
  const cases = [
    [25000, 'CHQ DEP 004512 DELHI-BOB', null, 'in', '4512', 'BOB'],
    [25000, 'BY CLG 004512', null, 'in', '4512', null],
    [25000, 'CLG/SHARMA STEEL/004512/BOB', null, 'in', '4512', 'BOB'],
    [20500, 'CHQ DEPOSIT DELHI-BOB', '000000005577', 'in', '5577', 'BOB'],
    [20500, '000000005577 CHQ DEPOSIT DELHI-BOB', null, 'in', '5577', 'BOB'],
    [20500, 'CHQ DEP - MICR CTS - CLG', '0000000000005577', 'in', '5577', null],
    [-80000, 'CLG DR 118244', null, 'out', '118244', null],
    [-80000, 'CHQ PAID-MICR CTS-118244-GUPTA IRON', null, 'out', '118244', null],
    [-25000, 'CHQ RETURN 004512 FUNDS INSUFFICIENT', null, 'return', '4512', null],
    [-25000, 'O/W RTN CHQ NO 004512', null, 'return', '4512', null],
    [80000, 'CHQ RET 118244 INSUFF FUNDS', null, 'out_return', '118244', null],
    [-354, 'CHQ RTN CHGS INCL GST', null, 'charges', null, null],
    [40000, 'BY DD 445566 SBI', null, 'in', '445566', 'SBI'],
    [-40250, 'DD ISSUE 445567', null, 'out', '445567', null],
  ];
  for (const [amt, text, ref, kind, no, bank] of cases) {
    const c = chequeLine(L(amt, text, ref));
    assert.ok(c, `${text} is a cheque line`);
    assert.equal(c.kind, kind, `${text}: ${kind}`);
    assert.equal(c.number, no, `${text}: number`);
    if (bank) assert.equal(c.bank, bank, `${text}: bank`);
  }
  assert.equal(chequeLine(L(40000, 'BY DD 445566 SBI')).instrument, 'dd');
  assert.equal(chequeLine(L(25000, 'CHQ DEP 004512')).instrument, 'cheque');
});

test('not cheque lines: digital payments, cash, a self cheque, the cheque book, other charges, an inward remittance', () => {
  for (const [amt, text] of [[5000, 'UPI-SONU KUMAR-9000000111@YBL'], [52000, 'NEFT Cr-HDFC0000001-JAIN AUTO PARTS'], [10000, 'CASH DEP DELHI'],
    [-20000, 'SELF CHQ 000123 CASH WDL'], [-118, 'CHQ BOOK ISSUE CHGS'], [-17.7, 'SMS ALERT CHARGES'], [90000, 'INWARD REMITTANCE SWIFT'],
    [-500, 'ATM WDL DELHI'], [1500, 'IMPS/P2A/ADD MONEY']]) {
    assert.equal(chequeLine(L(amt, text)), null, text);
  }
});

test('numbers: leading zeros do not matter, shown as six digits', () => {
  assert.equal(chequeNo('004512'), '4512');
  assert.equal(chequeNo('4512'), '4512');
  assert.equal(chequeShow('4512'), '004512');
  assert.equal(chequeShow('118244'), '118244');
  assert.equal(chequeNo(''), null);
});

const reg = [
  { id: 'q1', direction: 'in', instrument: 'cheque', number: '004512', amount: 25000, status: 'deposited', got_on: '2026-10-25' },
  { id: 'q2', direction: 'in', instrument: 'cheque', number: '220011', amount: 25000, status: 'received', got_on: '2026-10-26' },
  { id: 'q3', direction: 'in', instrument: 'cheque', number: '991100', amount: 25000, status: 'cleared', got_on: '2026-10-01' },
  { id: 'q4', direction: 'out', instrument: 'cheque', number: '118244', amount: 80000, status: 'given', got_on: '2026-10-24' },
  { id: 'q5', direction: 'in', instrument: 'dd', number: '445566', amount: 40000, status: 'cleared', got_on: '2026-10-20' },
  { id: 'q6', direction: 'in', instrument: 'cheque', number: '004512', amount: 25000, status: 'received', got_on: '2026-11-02' },   // noted after the line
];

test('candidates: the same number first, then the same amount; never one noted after the line', () => {
  const l = L(25000, 'CHQ DEP 004512 DELHI-BOB');
  const c = chequeCandidates(l, chequeLine(l), reg);
  assert.deepEqual(c.map((x) => x.id), ['q1', 'q2']);
  assert.equal(c[0].why, 'number'); assert.equal(c[1].why, 'amount');
  // register ₹25,000 vs statement ₹2,500: the number still finds it, flagged as a different amount
  const s = L(2500, 'CHQ DEP 004512');
  const c2 = chequeCandidates(s, chequeLine(s), reg);
  assert.equal(c2[0].id, 'q1'); assert.equal(c2[0].same_amount, false);
  // a return: the cleared one with that number; a DD never comes back
  const r = L(-25000, 'CHQ RETURN 991100', null, '2026-10-29');
  assert.equal(chequeCandidates(r, chequeLine(r), reg)[0].id, 'q3');
  const rd = L(-40000, 'CHQ RETURN 445566', null, '2026-10-29');
  assert.ok(!chequeCandidates(rd, chequeLine(rd), reg).some((x) => x.id === 'q5'));
  // our cheque to the supplier
  const o = L(-80000, 'CLG DR 118244');
  assert.deepEqual(chequeCandidates(o, chequeLine(o), reg).map((x) => x.id), ['q4']);
  // nothing in the register: no candidates (the owner chooses the customer)
  const n = L(12000, 'CLG 778899 HDFC');
  assert.deepEqual(chequeCandidates(n, chequeLine(n), reg), []);
});

test('a return finds its own deposit line in the same statement', () => {
  const dep = L(9000, 'CHQ DEP 000777 PNB', null, '2026-10-27');
  const other = L(9000, 'CHQ DEP 000778 PNB', null, '2026-10-27');
  const ret = L(-9000, 'CHQ RETURN 000777 PNB', null, '2026-10-29');
  assert.equal(depositOf(ret, chequeLine(ret), [other, dep, ret]), dep.id);
});

test('in the bank review: cheque lines are never ready and never paired as "came back"', () => {
  const lines = [
    L(25000, 'CHQ DEP 004512 DELHI-BOB', null, '2026-10-27'),
    L(-25000, 'CHQ RETURN 004512', null, '2026-10-29'),
    L(-354, 'CHQ RTN CHGS INCL GST', null, '2026-10-29'),
    L(-80000, 'CLG DR 118244', null, '2026-10-28'),
  ];
  const moves = [{ src: 'expense', ref: 'e1', amount: -80000, day: '2026-10-24', label: 'Gupta Iron Store', linked: false }];
  const s = suggestBankLines({ lines, moves, customers: [{ id: 'c1', name: 'Sharma Steel' }], cheques: reg });
  assert.ok(s.every((x) => x.confidence !== 'sure'), 'nothing ready');
  assert.ok(s.every((x) => x.reason !== 'came_back'), 'deposit and return are not skipped as a pair');
  assert.equal(s[0].action, 'cheque'); assert.equal(s[0].candidates[0].id, 'q1');
  assert.equal(s[1].action, 'cheque'); assert.equal(s[1].cheque.kind, 'return'); assert.equal(s[1].deposit_line, lines[0].id);
  assert.equal(s[2].action, 'expense'); assert.equal(s[2].category, 'bank'); assert.equal(s[2].cheque.kind, 'charges');
  assert.equal(s[3].candidates[0].id, 'q4'); assert.equal(s[3].move, 'e1', 'the supplier payment already in the app is offered too');
});
