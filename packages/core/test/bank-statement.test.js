// Bank statement → khata (25 Oct 2026): reading statements as Indian banks give them, and suggesting what each line is.
// The names, numbers and UPI ids below are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/index.js';

test('dates as banks write them (day first)', () => {
  assert.equal(c.bankDay('01/10/2026'), '2026-10-01');
  assert.equal(c.bankDay('1-10-26'), '2026-10-01');
  assert.equal(c.bankDay('01.10.2026'), '2026-10-01');
  assert.equal(c.bankDay('1 Oct 2026'), '2026-10-01');
  assert.equal(c.bankDay('01-Oct-26'), '2026-10-01');
  assert.equal(c.bankDay('01Oct2026'), '2026-10-01');
  assert.equal(c.bankDay('2026-10-01'), '2026-10-01');
  assert.equal(c.bankDay('Oct 1, 2026'), '2026-10-01');
  assert.equal(c.bankDay(46296), '2026-10-01', 'Excel day number');
  assert.equal(c.bankDay('31/02/2026'), null);
  assert.equal(c.bankDay('Opening Balance'), null);
  assert.equal(c.bankDay(''), null);
});

test('amounts: commas, Cr / Dr, brackets, rupee signs', () => {
  assert.deepEqual(c.bankAmount('1,25,000.00'), { value: 125000, side: null });
  assert.deepEqual(c.bankAmount('25,000.00 Cr'), { value: 25000, side: 'cr' });
  assert.deepEqual(c.bankAmount('500.00Dr'), { value: 500, side: 'dr' });
  assert.equal(c.bankAmount('(500.00)').value, -500);
  assert.equal(c.bankAmount('₹ 1,200.50').value, 1200.5);
  assert.equal(c.bankAmount('').value, null);
  assert.equal(c.bankAmount('-').value, null);
  assert.equal(c.bankAmount('abc').value, null);
});

const SBI = [
  ['State Bank of India'], ['Account Name', 'SHREE STEEL TRADERS'], ['Account Number', 'XXXXXXX1234'], [],
  ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
  ['1 Oct 2026', '1 Oct 2026', 'BY TRANSFER-UPI/CR/629512345678/SHARMA ENGG/HDFC/sharmaeng@okhdfcbank/Payment', 'TRANSFER FROM 99999', '', '25,000.00', '1,45,000.00'],
  ['2 Oct 2026', '2 Oct 2026', 'TO TRANSFER-UPI/DR/629512345999/BSES RAJDHANI/ICIC/bses@icici/Bill', '', '3,450.00', '', '1,41,550.00'],
  ['3 Oct 2026', '3 Oct 2026', 'ATM WDL-ATM CASH 1234 VISHNU GARDEN', '', '10,000.00', '', '1,31,550.00'],
  ['5 Oct 2026', '5 Oct 2026', 'BY TRANSFER-NEFT*HDFC0000123*N278261234*RANA TOOLS PVT LTD', 'N278261234', '', '58,500.00', '1,90,050.00'],
  ['6 Oct 2026', '6 Oct 2026', 'SMS ALERT CHARGES', '', '17.70', '', '1,90,032.30'],
];

test('SBI-style statement: header found, money in and out, adds up from the opening', () => {
  const r = c.readStatementRows(SBI);
  assert.equal(r.lines.length, 5);
  assert.equal(r.opening, 120000);
  assert.equal(r.closing, 190032.3);
  assert.equal(r.from, '2026-10-01'); assert.equal(r.to, '2026-10-06');
  assert.deepEqual(r.lines.map((l) => l.amount), [25000, -3450, -10000, 58500, -17.7]);
  assert.equal(r.adds_up, true); assert.equal(r.checked, 5);
  assert.equal(r.lines[3].ref, 'N278261234');
  assert.ok(r.lines.every((l) => l.fingerprint), 'every line has its own mark');
});

test('HDFC-style: newest first, two-line narrations, short dates', () => {
  const rows = [
    ['HDFC BANK Ltd.'], ['Statement of account'],
    ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ['08/10/26', 'UPI-GUPTA STEEL WORKS-GUPTASTEEL@YBL-SBIN0001234-629812345678-ORDER 553', '0000629812345678', '08/10/26', '', '12,000.00', '52,000.00'],
    ['07/10/26', 'NEFT CR-ICIC0000456-MEHTA', '', '07/10/26', '', '20,000.00', '40,000.00'],
    ['', 'FABRICATORS PVT LTD-ICICN52026100712345', '', '', '', '', ''],
    ['06/10/26', 'Opening Balance', '', '', '', '', '20,000.00'],
  ];
  const r = c.readStatementRows(rows);
  assert.equal(r.lines.length, 2);
  assert.equal(r.lines[0].day, '2026-10-07', 'oldest first');
  assert.match(r.lines[0].narration, /MEHTA FABRICATORS PVT LTD/, 'the second line of the narration is joined');
  assert.equal(r.opening, 20000); assert.equal(r.closing, 52000);
  assert.equal(r.adds_up, true);
});

test('Kotak / Axis style: one amount column + Dr / Cr', () => {
  const rows = [
    ['Sl. No.', 'Date', 'Description', 'Chq / Ref No.', 'Amount', 'Dr / Cr', 'Balance'],
    ['1', '10-10-2026', 'IMPS/P2A/629912345678/VERMA CONSTRUCTION/Kotak', '629912345678', '15,000.00', 'CR', '65,000.00'],
    ['2', '11-10-2026', 'RENT OCT KIRAYA', '', '20,000.00', 'DR', '45,000.00'],
  ];
  const r = c.readStatementRows(rows);
  assert.deepEqual(r.lines.map((l) => l.amount), [15000, -20000]);
  assert.equal(r.opening, 50000);
  assert.equal(r.adds_up, true);
});

test('one amount column, no Dr / Cr: the running balance decides', () => {
  const rows = [
    ['Date', 'Particulars', 'Amount', 'Balance'],
    ['12/10/2026', 'CASH DEPOSIT BY SELF', '30,000.00', '80,000.00'],
    ['13/10/2026', 'CHQ PAID 000123 JINDAL STEEL', '45,000.00', '35,000.00'],
  ];
  const r = c.readStatementRows(rows);
  assert.deepEqual(r.lines.map((l) => l.amount), [30000, -45000]);
  assert.equal(r.adds_up, true);
});

test('a line that does not add up is shown as a problem', () => {
  const rows = [['Date', 'Narration', 'Withdrawal', 'Deposit', 'Balance'],
    ['01/10/2026', 'A', '', '100.00', '1,100.00'], ['02/10/2026', 'B', '', '100.00', '1,300.00']];
  const r = c.readStatementRows(rows);
  assert.equal(r.adds_up, false);
  assert.equal(r.problems.length, 1);
  assert.deepEqual(r.problems[0], { day: '2026-10-02', amount: 100, expected: 1200, balance: 1300 });
});

test('no header → nothing read (and says why)', () => {
  assert.deepEqual(c.readStatementRows([['hello'], ['world']]).problems, ['no_header']);
});

test('CSV text → rows (quotes, commas inside amounts)', () => {
  const rows = c.csvRows('Date,Narration,Debit,Credit,Balance\n01/10/2026,"UPI/CR/SHARMA, ENGG",,"25,000.00","1,45,000.00"\r\n');
  assert.deepEqual(rows[1], ['01/10/2026', 'UPI/CR/SHARMA, ENGG', '', '25,000.00', '1,45,000.00']);
  const r = c.readStatementRows(rows);
  assert.equal(r.lines[0].amount, 25000);
  assert.equal(c.csvRows('a\tb\n1\t2')[1][1], '2', 'tab separated');
});

test('the same line twice in one file gets its own mark (#2); re-reading gives the same marks', () => {
  const rows = [['Date', 'Narration', 'Debit', 'Credit'],
    ['01/10/2026', 'UPI/CR/1/RAM/ram@ybl', '', '500.00'], ['01/10/2026', 'UPI/CR/1/RAM/ram@ybl', '', '500.00']];
  const a = c.readStatementRows(rows).lines.map((l) => l.fingerprint);
  assert.notEqual(a[0], a[1]); assert.match(a[1], /#2$/);
  assert.deepEqual(c.readStatementRows(rows).lines.map((l) => l.fingerprint), a);
});

test('PDF text lines: amounts go to the column they sit under', () => {
  const L = (...items) => ({ items: items.map(([str, x]) => ({ str, x, w: 40 })) });
  const lines = [
    L(['Statement of Account', 10]),
    L(['Date', 10], ['Narration', 80], ['Withdrawal', 300], ['Deposit', 380], ['Balance', 460]),
    L(['Opening Balance', 80], ['1,20,000.00', 460]),
    L(['01/10/2026', 10], ['UPI/CR/629512345678/SHARMA ENGG/', 80], ['25,000.00', 380], ['1,45,000.00', 460]),
    L(['HDFC/sharmaeng@okhdfcbank', 80]),
    L(['02/10/2026', 10], ['SMS ALERT CHARGES', 80], ['17.70', 300], ['1,44,982.30', 460]),
    L(['Page 1 of 3', 200]),
  ];
  const r = c.readStatementText(lines);
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.lines.map((l) => l.amount), [25000, -17.7]);
  assert.match(r.lines[0].narration, /sharmaeng@okhdfcbank/);
  assert.equal(r.opening, 120000); assert.equal(r.adds_up, true);
});

test('PDF text without a header: the running balance decides', () => {
  const r = c.readStatementText(['01 Oct 2026  BY CASH DEPOSIT  5,000.00  25,000.00', '02 Oct 2026  ATM WDL  2,000.00  23,000.00']);
  assert.deepEqual(r.lines.map((l) => l.amount), [5000, -2000]);
  assert.equal(r.opening, 20000);
});

test('what a bank line says: kind, UPI id, phone, name', () => {
  const a = c.readNarration('BY TRANSFER-UPI/CR/629512345678/SHARMA ENGG/HDFC/sharmaeng@okhdfcbank/Payment');
  assert.equal(a.kind, 'upi'); assert.equal(a.method, 'UPI'); assert.equal(a.upi, 'sharmaeng@okhdfcbank'); assert.equal(a.name, 'sharma engg');
  const b = c.readNarration('UPI-RAMESH KUMAR-9876543210@ybl-SBIN0001234-629812345678-PAY');
  assert.equal(b.phone, '9876543210'); assert.equal(b.name, 'ramesh kumar');
  assert.equal(c.readNarration('NEFT CR-ICIC0000456-MEHTA FABRICATORS PVT LTD-ICICN520261').name, 'mehta fabricators pvt ltd');
  // HDFC puts hyphens between the parts: the UPI id is only what is right before the @
  assert.equal(c.readNarration('UPI-BANKLINE ZXJR TRADERS-BANKLINEZXJR@OKAXIS-UTIB0001234-629812345678-PAY').upi, 'banklinezxjr@okaxis');
  assert.equal(c.payerKey('UPI-NOBODY KNOWN PERSON-ZZ9@YBL-SBIN0000001-6298-PAY'), 'upi:zz9@ybl');
  assert.equal(c.payerKey('UPI-BANKLINE ZXJR TRADERS-BANKLINEZXJR@OKAXIS-UTIB0001234-6298-PAY'), c.payerKey('BY TRANSFER-UPI/CR/6295/BANKLINE ZXJR TRADERS/AXIS/banklinezxjr@okaxis/Payment'),
    'the same payer from two banks\' ways of writing it');
  assert.equal(c.readNarration('ATM WDL-ATM CASH 1234').kind, 'atm');
  assert.equal(c.readNarration('BY CASH DEPOSIT').kind, 'cash');
  assert.equal(c.readNarration('SMS ALERT CHARGES').kind, 'charges');
  assert.equal(c.readNarration('CHQ DEP 000123 CLG').method, 'Cheque');
  assert.equal(c.payerKey('UPI/CR/1/SHARMA ENGG/sharmaeng@okhdfcbank'), 'upi:sharmaeng@okhdfcbank');
  assert.equal(c.payerKey('NEFT CR-ICIC0000456-MEHTA FABRICATORS'), 'name:mehta fabricators');
  assert.equal(c.shortNarration('BY TRANSFER-UPI/CR/629512345678/SHARMA ENGG/HDFC/sharmaeng@okhdfcbank/Payment'), 'UPI · SHARMA ENGG · sharmaeng@okhdfcbank');
});

test('name fit: own words count, common words (Engg, Pvt, Steel) do not', () => {
  const w = c.readNarration('UPI/CR/1/SHARMA ENGG/x@ybl').words;
  assert.equal(c.nameFit('Sharma Engineering', w), 1);
  assert.equal(c.nameFit('Gupta Engineering', w), 0);
  assert.ok(c.nameFit('Mehta Fabricators', c.readNarration('NEFT CR-ICIC0000456-MEHTA FABRICATORS PVT LTD').words) === 1);
});

const customers = [
  { id: 'c-sharma', name: 'Sharma Engineering', phone: '98100 11111' },
  { id: 'c-rana', name: 'Rana Tools', phone: null },
  { id: 'c-ramesh', name: 'Ramesh Fabrication', phone: '9876543210' },
  { id: 'c-verma1', name: 'Verma Construction', phone: null },
];
const suppliers = [{ id: 's-jindal', name: 'Jindal Steel' }];

test('suggestions: already in the app, remembered, a customer by name / phone, exact due, expenses, cash, supplier', () => {
  const r = c.readStatementRows(SBI);
  const lines = [...r.lines.map((l, i) => ({ ...l, id: `l${i}` })),
    { id: 'l5', day: '2026-10-07', amount: 7000, narration: 'UPI-RAMESH KUMAR-9876543210@ybl-SBIN0001234-6298-PAY' },
    { id: 'l6', day: '2026-10-08', amount: -45000, narration: 'CHQ PAID 000123 JINDAL STEEL' },
    { id: 'l7', day: '2026-10-08', amount: 900, narration: 'UPI/CR/1/UNKNOWN PERSON/zz@ybl' },
    { id: 'l8', day: '2026-10-09', amount: 15000, narration: 'IMPS/P2A/6299/VERMA CONSTRUCTION/Kotak' },
    { id: 'l9', day: '2026-10-09', amount: 4000, narration: 'BY CASH DEPOSIT' },
    { id: 'l10', day: '2026-10-09', amount: 11, narration: 'INT.PD:01-07-2026 TO 30-09-2026', status: 'open' },
    { id: 'l11', day: '2026-10-09', amount: 500, narration: 'already done', status: 'added' },
  ];
  const moves = [{ ref: 'p-rana', src: 'payment', amount: 58500, day: '2026-10-04', label: 'Rana Tools' },   // recorded the day before
    { ref: 'p-old', src: 'payment', amount: 25000, day: '2026-09-01', label: 'too old' }];
  const payers = { 'upi:sharmaeng@okhdfcbank': { action: 'payment', customer_id: 'c-sharma' } };
  const dues = { 'c-verma1': { pakka: 15000, kacha: 0 }, 'c-ramesh': { pakka: 0, kacha: 9000 } };
  const s = c.suggestBankLines({ lines, moves, customers, suppliers, payers, dues, drawer: 'acc-drawer' });
  const by = Object.fromEntries(s.map((x) => [x.line, x]));
  assert.deepEqual([by.l0.action, by.l0.confidence, by.l0.reason, by.l0.customer_id], ['payment', 'sure', 'remembered', 'c-sharma']);
  assert.deepEqual([by.l1.action, by.l1.category], ['expense', 'electricity']);
  assert.deepEqual([by.l2.action, by.l2.to, by.l2.reason], ['move', 'acc-drawer', 'atm']);
  assert.deepEqual([by.l3.action, by.l3.move, by.l3.confidence], ['link', 'p-rana', 'sure'], 'Rana\'s ₹58,500 is already in the app');
  assert.deepEqual([by.l4.action, by.l4.category, by.l4.confidence], ['expense', 'bank', 'sure']);
  assert.deepEqual([by.l5.action, by.l5.customer_id, by.l5.reason, by.l5.confidence, by.l5.side], ['payment', 'c-ramesh', 'phone', 'likely', 'kacha'],
    'a phone number alone is only likely; the side with the money owed');
  assert.deepEqual([by.l6.action, by.l6.supplier_id], ['supplier', 's-jindal']);
  assert.deepEqual([by.l7.action, by.l7.confidence], [null, 'unknown'], 'nobody we know → needs you');
  assert.deepEqual([by.l8.action, by.l8.customer_id, by.l8.confidence, by.l8.reason], ['payment', 'c-verma1', 'sure', 'amount'], 'exactly what they owe');
  assert.deepEqual([by.l9.action, by.l9.reason], ['move', 'cash_deposit']);
  assert.deepEqual([by.l10.action, by.l10.reason], ['skip', 'interest']);
  assert.equal(by.l11.confidence, 'done');
});

test('a name shared by two customers is not guessed', () => {
  const cs = [{ id: 'a', name: 'Sharma Engineering' }, { id: 'b', name: 'Sharma Steel' }];
  const s = c.suggestBankLines({ lines: [{ id: 'x', day: '2026-10-01', amount: 100, narration: 'UPI/CR/1/R SHARMA/r@ybl' }], customers: cs });
  assert.equal(s[0].action, null);
});

test('one app entry is matched to one bank line only (closest day wins)', () => {
  const lines = [{ id: 'a', day: '2026-10-05', amount: 1000, narration: 'x' }, { id: 'b', day: '2026-10-02', amount: 1000, narration: 'y' }];
  const s = c.suggestBankLines({ lines, moves: [{ ref: 'p1', src: 'payment', amount: 1000, day: '2026-10-02' }] });
  assert.equal(s.find((x) => x.line === 'b').action, 'link');
  assert.notEqual(s.find((x) => x.line === 'a').action, 'link');
});

test('money out to a customer who holds credit → give back', () => {
  const s = c.suggestBankLines({ lines: [{ id: 'x', day: '2026-10-01', amount: -2000, narration: 'IMPS/P2A/1/RANA TOOLS/x' }],
    customers, dues: { 'c-rana': { pakka: 0, kacha: 0, credit: 5000 } } });
  assert.deepEqual([s[0].action, s[0].customer_id], ['refund', 'c-rana']);
});
