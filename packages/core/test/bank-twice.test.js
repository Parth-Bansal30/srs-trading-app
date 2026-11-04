// Bank statements, 3 Nov 2026: the owner tried a real 6-month YES Bank PDF. What it taught (all names and numbers here are made up):
// a failed IMPS returned is printed as a MINUS under Withdrawals · the opening and closing balance sit on one summary line ·
// every page repeats the shop's name and account number at the top (it must not stick to the last entry of the page above) ·
// NEFT lines carry the shop's own name next to the payer's · a payment that went out and came back adds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStatementText, readStatementRows, readNarration, payerKey, ownNames, suggestBankLines } from '../src/bankStatement.js';

const it = (str, x, w = 30) => ({ str, x, w });
// a YES-Bank-like page: header block, two-line column header, newest first
function page(p, rows, { first = false } = {}) {
  const top = first
    ? [[it('Statement of account:', 227, 80), it('003000000001234', 306, 60)], [it('Period:', 227, 25), it('01 Aug 2026 - 31 Aug 2026', 255, 90)],
      [it('RANA STEEL CENTRE', 12, 80)]]
    : [[it('Customer Id:', 523, 45), it('1234567', 572, 30)], [it('Primary Account Holder', 431, 85), it('Name:', 520, 22), it('RAJ RANA', 545, 40)]];
  const head = [
    [it('Transaction details for your account number', 139, 160), it('003000000001234', 301, 60), it('(CURRENT) (Currency -', 364, 85), it('INR)', 455, 15)],
    [it('Primary Holder:', 8, 58), it('RAJ RANA', 69, 40), it('A/C Opening Date:', 216, 68), it('01/04/2015', 286, 40)],
    [it('Transaction', 13, 40)],
    [it('Value Date', 62, 38), it('Cheque No/Reference No', 129, 90), it('Description', 300, 41), it('Withdrawals', 414, 44), it('Deposits', 489, 32), it('Running Balance', 543, 60)],
    [it('Date', 24, 16)],
  ];
  const body = [];
  for (const r of rows) {
    body.push([it(r.d, 14, 45), it(r.d, 61, 45), it(r.ref, 123, 100), it(r.t[0], 235, 150),
      ...(r.wd ? [it(r.wd, 470 - 6 * r.wd.length, 6 * r.wd.length)] : []), ...(r.dep ? [it(r.dep, 540 - 6 * r.dep.length, 6 * r.dep.length)] : []),
      it(r.bal, 600 - 6 * r.bal.length, 6 * r.bal.length)]);
    for (const more of r.t.slice(1)) body.push([it(more, 235, 120)]);
  }
  return [...top, ...head, ...body].map((items) => ({ page: p, items }));
}
const P1 = [
  { d: '31 Aug 2026', ref: '3282220260831004600000001', t: ['NEFT Cr-HDFC0000001-JAIN AUTO PARTS-RANA', 'STEEL CENTRE-N1000000000001'], dep: '52,000.00', bal: '-17,195.00' },
  { d: '30 Aug 2026', ref: '1387420260830000201000002', t: ['IMPS/NA/XXX9999/REV/', 'RRN:911100002222/Axis'], wd: '-590.00', bal: '-69,195.00' },
  { d: '30 Aug 2026', ref: '1387420260830000201000001', t: ['IMPS/NA/XXX9999/', 'RRN:911100002222/Axis'], wd: '590.00', bal: '-69,785.00' },
];
const P2 = [
  { d: '29 Aug 2026', ref: '000000005577', t: ['CHQ DEPOSIT DELHI-BOB'], dep: '20,500.00', bal: '-69,195.00' },
  { d: '28 Aug 2026', ref: '3282220260828004600000003', t: ['NEFT Cr-PUNB0000001-MEHRA STEEL WORKS-', 'RANA STEEL CENTRE-PUNBH10000000002'], dep: '14,000.00', bal: '-89,695.00' },
];
const summary = [{ page: 2, items: [it('Opening Balance: -1,03,695.00', 12, 108), it('Total Withdrawals: 590.00', 170, 100), it('Total Deposits: 86,500.00', 330, 100), it('Closing Balance: -17,195.00', 470, 98)] },
  { page: 2, items: [it('OD Limit: 0.00', 12, 50), it('Uncleared Amount: 0.00', 200, 80)] },
  { page: 2, items: [it('Please review the information provided in the statement.', 12, 300)] }];
const pdf = [...page(1, P1, { first: true }), ...page(2, P2), ...summary];

test('a YES-Bank-like PDF: minus under Withdrawals is money back, summary line opening/closing, page tops not glued', () => {
  const r = readStatementText(pdf);
  assert.equal(r.lines.length, 5);
  assert.equal(r.opening, -103695);
  assert.equal(r.closing, -17195);
  assert.equal(r.problems.length, 0);
  assert.equal(r.adds_up, true);
  const back = r.lines.find((l) => /REV/.test(l.narration));
  assert.equal(back.amount, 590, 'the reversed IMPS came back in');
  const p1last = r.lines.find((l) => l.day === '2026-08-29');
  assert.equal(p1last.narration, '000000005577 CHQ DEPOSIT DELHI-BOB', 'nothing from the next page stuck to it');
  assert.ok(!r.lines.some((l) => /Customer Id|Primary|Transaction details|Please review|OD Limit/.test(l.narration)));
});

test('the closing balance printed at the end catches a line that was not read', () => {
  const lost = pdf.filter((ln) => !(ln.items[0]?.str === '31 Aug 2026'));
  const r = readStatementText(lost);
  assert.equal(r.adds_up, false);
  assert.ok(r.problems.some((p) => p.closing));
});

test('no balance read at all is never "adds up"', () => {
  const rows = [['Date', 'Narration', 'Debit', 'Credit'], ['01/08/2026', 'UPI-A', '', '500.00'], ['02/08/2026', 'UPI-B', '100.00', '']];
  assert.equal(readStatementRows(rows).adds_up, false);
  // …but the printed opening + lines = the printed closing is a real check
  const r = readStatementRows([...rows, ['', 'Opening Balance: 1,000.00', '', ''], ['', 'Closing Balance: 1,400.00', '', '']]);
  assert.equal(r.adds_up, true);
});

test('Excel: a minus under Withdrawals is money back; a bank that prints every withdrawal with a minus is still money out', () => {
  const head = ['Transaction Date', 'Description', 'Withdrawals', 'Deposits', 'Running Balance'];
  const a = readStatementRows([head, ['30/08/2026', 'IMPS/NA/REV/RRN:911100002222', -590, '', 1000], ['30/08/2026', 'IMPS/NA/RRN:911100002222', 590, '', 410]]);
  assert.equal(a.lines.find((l) => /REV/.test(l.narration)).amount, 590);
  assert.equal(a.lines.find((l) => !/REV/.test(l.narration)).amount, -590);
  assert.equal(a.adds_up, true);
  const b = readStatementRows([head, ['01/08/2026', 'ATM', '-500.00', '', '1,500.00'], ['02/08/2026', 'NEFT', '-200.00', '', '1,300.00'], ['03/08/2026', 'UPI', '', '100.00', '1,400.00']]);
  assert.deepEqual(b.lines.map((l) => l.amount), [-500, -200, 100]);
});

test('the shop\'s own name in a NEFT line is never the payer (and never remembered as one)', () => {
  const t = 'NEFT Cr-BKID0000001-KAPOOR ENGG WORKS-RANA STEEL CENTRE-BKIDN10000000001';
  assert.equal(readNarration(t, ['Rana Steel Centre']).name, 'kapoor engg works');
  assert.equal(payerKey(t, ['Rana Steel Centre']), 'name:kapoor engg works');
  assert.ok(!readNarration('NEFT Cr-X-GUPTA TRADERS-RANA STEELS CENTER-UTR', ['Rana Steel Centre']).words.includes('rana'));
  // found in the statement itself when the app's name for the shop is different
  const lines = Array.from({ length: 8 }, (_, k) => ({ amount: 1000 + k, narration: `NEFT Cr-HDFC000${k}-PAYER NUMBER ${'ABCDEFGH'[k]}-RANA STEEL CENTRE-N${k}` }));
  assert.ok(ownNames(lines, null).includes('rana steel centre'));
});

test('suggestions: a reversed pair is skipped together · the payment that fits the name is linked · a near payment is asked', () => {
  const lines = [
    { id: 'a', day: '2026-08-30', amount: -590, narration: 'IMPS/NA/XXX9999/ RRN:911100002222/Axis', status: 'open' },
    { id: 'b', day: '2026-08-30', amount: 590, narration: 'IMPS/NA/XXX9999/REV/ RRN:911100002222/Axis', status: 'open' },
    { id: 'c', day: '2026-08-31', amount: 5000, narration: 'UPI-JAIN AUTO PARTS-JAINAUTO@OKICICI-ICIC0001234-630512345678-PAY', status: 'open' },
    { id: 'd', day: '2026-08-31', amount: 2500, narration: 'NEFT Cr-HDFC0000001-MOHIT VERMA-RANA STEEL CENTRE-N1', status: 'open' },
  ];
  const customers = [{ id: 'jain', name: 'Jain Auto Parts' }, { id: 'bhatia', name: 'Bhatia Fabricators' }, { id: 'mohit', name: 'Mohit Verma' }];
  const moves = [
    { src: 'payment', ref: 'p-bhatia', amount: 5000, day: '2026-08-31', label: 'Bhatia Fabricators', customer_id: 'bhatia', linked: false },
    { src: 'payment', ref: 'p-jain', amount: 5000, day: '2026-08-31', label: 'Jain Auto Parts', customer_id: 'jain', linked: false },
    { src: 'payment', ref: 'p-mohit', amount: 2000, day: '2026-08-30', label: 'Mohit Verma', customer_id: 'mohit', linked: false },
  ];
  const s = suggestBankLines({ lines, moves, customers, shop: 'Rana Steel Centre', dues: { mohit: { pakka: 2500, kacha: 0 } } });
  const by = Object.fromEntries(s.map((x) => [x.line, x]));
  assert.equal(by.a.reason, 'came_back'); assert.equal(by.b.reason, 'came_back'); assert.equal(by.a.action, 'skip');
  assert.equal(by.c.move, 'p-jain', 'the ₹5,000 from Jain goes to Jain\'s payment, not Bhatia\'s');
  assert.equal(by.d.reason, 'near_payment'); assert.equal(by.d.confidence, 'likely', 'Mohit already has ₹2,000 written the day before: ask');
});

test('a UPI payment written in "Shop UPI" is found in the bank statement (the money lands in the bank)', () => {
  const lines = [{ id: 'x', day: '2026-08-31', amount: 1200, narration: 'UPI-SONU KUMAR-9000000111@YBL-YESB0YBLUPI-630212345678-UPI', status: 'open' }];
  const moves = [{ src: 'payment', ref: 'p1', amount: 1200, day: '2026-08-31', label: 'Sonu Kumar', customer_id: 'sonu', linked: false, via: 'Shop UPI' }];
  const [one] = suggestBankLines({ lines, moves, customers: [{ id: 'sonu', name: 'Sonu Kumar' }] });
  assert.equal(one.action, 'link'); assert.equal(one.reason, 'already_via'); assert.equal(one.via, 'Shop UPI');
});

test('a line with a doubt is never ready, even when it matches something in the app', () => {
  const lines = [{ id: 'x', day: '2026-08-31', amount: 1200, narration: 'UPI-SONU KUMAR-9000000111@YBL', status: 'open', doubts: ['direction'] },
    { id: 'y', day: '2026-08-31', amount: -17.7, narration: 'SMS ALERT CHARGES', status: 'open', doubts: ['date_style'] }];
  const moves = [{ src: 'payment', ref: 'p1', amount: 1200, day: '2026-08-31', label: 'Sonu Kumar', linked: false }];
  const s = suggestBankLines({ lines, moves, customers: [] });
  assert.equal(s[0].action, 'link'); assert.equal(s[0].confidence, 'unknown'); assert.deepEqual(s[0].doubt, ['direction']);
  assert.equal(s[1].action, 'expense'); assert.equal(s[1].confidence, 'unknown');
});
