/**
 * Bank statement → khata (25 Oct 2026). Reads a bank statement (rows from Excel / CSV, or text lines from a PDF) into
 * plain lines { day, amount (+ in, − out), narration, ref, balance }, checks it adds up, and suggests what each line is:
 * a payment already in the app, a customer's payment, money given back, an expense, a supplier payment, cash moved.
 * Nothing here saves anything — the owner approves every line. No screen / database code (it runs in the app and the
 * backend alike).
 */
import { r2 } from './round.js';

// ---------------------------------------------------------------- small readers
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const validDay = (y, m, d) => {
  if (!(y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const year4 = (y) => (y < 100 ? 2000 + y : y);

/** A bank date → 'YYYY-MM-DD' (Indian banks write the day first). Excel day numbers work too. null if it isn't a date. */
export function bankDay(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (n > 30000 && n < 80000) {   // Excel's day number (1900 system)
      const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
      return validDay(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
    return null;
  }
  const s = String(v).trim().replace(/\s+/g, ' ');
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);                       // 2026-10-01
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/);                         // 01/10/2026, 01-10-26
  if (m) return validDay(year4(+m[3]), +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/. ]?([A-Za-z]{3,4})[A-Za-z]*[-/., ]*(\d{2}|\d{4})(?:\s.*)?$/);    // 01-Oct-2026, 1 Oct 26, 01Oct2026
  if (m && MONTHS[m[2].toLowerCase()]) return validDay(year4(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
  m = s.match(/^([A-Za-z]{3,4})[A-Za-z]* (\d{1,2}),? (\d{4})$/);                                // Oct 1, 2026
  if (m && MONTHS[m[1].toLowerCase()]) return validDay(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  return null;
}

/** "1,25,000.00 Cr" → 125000 · "(500.00)" / "500.00 Dr" / "-500" → −500 · "" → null. { value, side: 'cr'|'dr'|null } */
export function bankAmount(v) {
  if (v == null) return { value: null, side: null };
  if (typeof v === 'number') return { value: Number.isFinite(v) ? r2(v) : null, side: null };
  let s = String(v).trim().replace(/[₹ ]|INR|Rs\.?/gi, '').trim();
  if (!s || s === '-' || s === '--') return { value: null, side: null };
  let side = null;
  const sm = s.match(/\s*\(?(cr|dr|c|d)\)?\.?$/i);
  if (sm && /\d/.test(s.slice(0, sm.index))) { side = /^c/i.test(sm[1]) ? 'cr' : 'dr'; s = s.slice(0, sm.index).trim(); }
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^-/.test(s)) { neg = true; s = s.slice(1); }
  s = s.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,3})?$/.test(s)) return { value: null, side: null };
  const n = r2(Number(s) * (neg ? -1 : 1));
  return { value: n, side };
}
const amountOf = (v) => bankAmount(v).value;
const isMoneyToken = (t) => /^\(?-?[\d,]+\.\d{2}\)?(cr|dr)?$/i.test(String(t || '').replace(/\s/g, ''));

// ---------------------------------------------------------------- tables (Excel / CSV)
const HEAD = {
  date: /^(txn\.?|tran\.?|transaction|trans\.?|post(ing|ed)?|book(ing)?)?\s*(date|dt\.?)$|^date$/i,
  valueDate: /value\s*(date|dt)/i,
  narration: /narration|description|particulars|remarks|details|transaction\s*(remarks|details|description)|^transaction$|^description$/i,
  ref: /chq|cheque|ref(erence)?|utr|instrument/i,
  debit: /withdraw|debit|^dr\.?$|paid\s*out|^withdrawal/i,
  credit: /deposit|credit|^cr\.?$|paid\s*in|receipt/i,
  amount: /^(txn\.?\s*|transaction\s*)?amount(\s*\(.*\))?$|^amt\.?$/i,
  drcr: /^(dr|cr)\s*\/\s*(cr|dr)$|^type$|^(debit|credit)\s*\/\s*(credit|debit)$|^d\/c$|^c\/d$/i,
  balance: /balance/i,
};

/** Which column is which in the header row (or null when this row is not the header). */
export function statementColumns(row) {
  const cells = (row || []).map((c) => String(c ?? '').trim().replace(/\s+/g, ' '));
  const find = (re, not = []) => cells.findIndex((c, i) => c && re.test(c) && !not.includes(i));
  const col = {};
  col.drcr = find(HEAD.drcr);
  col.balance = find(HEAD.balance);
  col.valueDate = find(HEAD.valueDate);
  col.date = find(HEAD.date, [col.valueDate]);
  if (col.date < 0 && col.valueDate >= 0) { col.date = col.valueDate; col.valueDate = -1; }
  col.narration = find(HEAD.narration);
  col.debit = find(HEAD.debit, [col.balance, col.drcr]);
  col.credit = find(HEAD.credit, [col.balance, col.drcr, col.debit]);
  col.amount = find(HEAD.amount, [col.balance, col.debit, col.credit]);
  col.ref = find(HEAD.ref, [col.narration, col.debit, col.credit, col.amount, col.balance, col.date, col.valueDate]);
  const money = (col.debit >= 0 && col.credit >= 0) || col.amount >= 0;
  if (col.date < 0 || col.narration < 0 || !money) return null;
  return col;
}

const OPENING = /opening\s*balance|balance\s*b\/?f|brought\s*forward|^b\/f$/i;
const CLOSING = /closing\s*balance|balance\s*c\/?f|carried\s*forward|^total|grand\s*total/i;

/**
 * Rows of cells (Excel, CSV, an HTML table) → { lines, opening, closing, from, to, checked, problems, columns }.
 * Lines are in date order (oldest first). amount: + money in, − money out.
 */
export function readStatementRows(rows) {
  const list = (rows || []).filter((r) => Array.isArray(r));
  let at = -1; let col = null;
  for (let i = 0; i < Math.min(list.length, 60); i++) { const c = statementColumns(list[i]); if (c) { at = i; col = c; break; } }
  if (!col) return { lines: [], opening: null, closing: null, problems: ['no_header'], checked: 0 };
  const cell = (r, i) => (i >= 0 ? r[i] : null);
  const raw = [];
  let opening = null;
  for (const r of list.slice(at + 1)) {
    const narr = String(cell(r, col.narration) ?? '').trim().replace(/\s+/g, ' ');
    const day = bankDay(cell(r, col.date));
    if (!day) {
      if (OPENING.test(narr) || OPENING.test(String(r.join(' ')))) { const b = amountOf(cell(r, col.balance)); if (b != null) opening = b; continue; }
      if (CLOSING.test(narr) || CLOSING.test(String(r[0] ?? ''))) continue;
      const prev = raw[raw.length - 1];
      const others = r.filter((c, i) => i !== col.narration && String(c ?? '').trim());
      if (prev && narr && others.length === 0 && prev.more < 3) { prev.narration = `${prev.narration} ${narr}`.trim(); prev.more++; }
      continue;
    }
    if (OPENING.test(narr)) { const b = amountOf(cell(r, col.balance)); if (b != null) opening = b; continue; }
    let amount = null; let side = null;
    if (col.debit >= 0 && col.credit >= 0) {
      const dr = bankAmount(cell(r, col.debit)).value; const cr = bankAmount(cell(r, col.credit)).value;
      if (cr) amount = Math.abs(cr); else if (dr) amount = -Math.abs(dr);
      side = cr ? 'cr' : dr ? 'dr' : null;
    } else {
      const a = bankAmount(cell(r, col.amount));
      const t = String(cell(r, col.drcr) ?? '').trim();
      side = /^c/i.test(t) ? 'cr' : /^d/i.test(t) ? 'dr' : a.side || (a.value < 0 ? 'dr' : null);
      if (a.value != null && a.value !== 0) amount = side === 'dr' ? -Math.abs(a.value) : side === 'cr' ? Math.abs(a.value) : a.value;
    }
    if (amount == null || amount === 0) continue;
    const bal = bankAmount(cell(r, col.balance));
    const balance = bal.value == null ? null : bal.side === 'dr' ? -Math.abs(bal.value) : bal.value;
    raw.push({ day, amount: r2(amount), sure: !!side, narration: narr, ref: String(cell(r, col.ref) ?? '').trim() || null, balance, more: 0 });
  }
  return finish(raw, opening, col);
}

/** Order, signs from the running balance, opening / closing, and how many lines the balance proves. */
function finish(raw, opening0, columns = null) {
  let lines = raw.map((l, i) => ({ ...l, i }));
  if (lines.length > 1) {
    const first = lines[0].day; const last = lines[lines.length - 1].day;
    let desc = first > last;
    if (first === last && lines.every((l) => l.balance != null)) desc = chain(lines.slice().reverse()) > chain(lines);
    if (desc) lines = lines.reverse();
  }
  // a line without a sure sign (one amount column, no Dr/Cr): the running balance decides
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (l.sure || l.balance == null) continue;
    const prevBal = k > 0 ? lines[k - 1].balance : opening0;
    if (prevBal == null) continue;
    if (Math.abs(r2(prevBal + Math.abs(l.amount)) - l.balance) < 0.011) l.amount = Math.abs(l.amount);
    else if (Math.abs(r2(prevBal - Math.abs(l.amount)) - l.balance) < 0.011) l.amount = -Math.abs(l.amount);
  }
  const withBal = lines.filter((l) => l.balance != null);
  const opening = opening0 != null ? opening0 : withBal.length && lines[0].balance != null ? r2(lines[0].balance - lines[0].amount) : null;
  const closing = withBal.length ? withBal[withBal.length - 1].balance : opening != null ? r2(opening + lines.reduce((s, l) => s + l.amount, 0)) : null;
  const problems = [];
  let checked = 0; let prev = opening;
  for (const l of lines) {
    if (l.balance != null && prev != null) {
      if (Math.abs(r2(prev + l.amount) - l.balance) < 0.011) checked++;
      else problems.push({ day: l.day, amount: l.amount, expected: r2(prev + l.amount), balance: l.balance });
    }
    if (l.balance != null) prev = l.balance; else if (prev != null) prev = r2(prev + l.amount);
  }
  const out = lines.map(({ i, more, sure, ...l }) => l);   // eslint-disable-line no-unused-vars
  return { lines: withFingerprints(out), opening, closing, from: out[0]?.day || null, to: out[out.length - 1]?.day || null,
    checked, problems, columns, adds_up: out.length > 0 && problems.length === 0 && checked === withBal.length };
}
const chain = (ls) => ls.reduce((n, l, k) => (k > 0 && ls[k - 1].balance != null && Math.abs(r2(ls[k - 1].balance + l.amount) - l.balance) < 0.011 ? n + 1 : n), 0);

/** A line's own mark, so the same statement uploaded twice adds nothing twice (the same line twice in one file: #2). */
function withFingerprints(lines) {
  const seen = new Map();
  return lines.map((l) => {
    const base = [l.day, l.amount.toFixed(2), l.balance == null ? '' : l.balance.toFixed(2), (l.ref || '').slice(0, 30),
      normWords(l.narration).slice(0, 80)].join('|');
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return { ...l, fingerprint: n > 1 ? `${base}#${n}` : base };
  });
}

// ---------------------------------------------------------------- PDF text
/**
 * Text lines of a PDF statement → the same result as readStatementRows. Each line: { items: [{ str, x }] } (left to
 * right) or a plain string. When the header line ("Withdrawal … Deposit … Balance") is found, an amount goes to the
 * column it sits under; otherwise the running balance decides money in or out.
 */
export function readStatementText(lines) {
  const L = (lines || []).map((ln) => (typeof ln === 'string'
    ? { items: ln.split(/\s{2,}|\t/).filter(Boolean).map((str, k) => ({ str, x: k * 100 })) }
    : { items: (ln.items || []).filter((t) => String(t.str || '').trim()).map((t) => ({ str: String(t.str).trim(), x: Number(t.x) || 0, w: Number(t.w) || 0 })) }));
  // the header: where the money columns are
  let cols = null;
  for (const ln of L.slice(0, 80)) {
    const pos = (re) => { const t = ln.items.find((x) => re.test(x.str)); return t ? t.x + (t.w || 0) / 2 : null; };
    const dr = pos(/withdraw|debit|^dr\.?$/i); const cr = pos(/deposit|credit|^cr\.?$/i); const bal = pos(/balance/i);
    if (dr != null && cr != null) { cols = { dr, cr, bal }; break; }
  }
  const raw = [];
  let opening = null;
  for (const ln of L) {
    const words = ln.items.flatMap((t) => (isMoneyToken(t.str) ? [t] : t.str.split(/\s+/).map((s, k) => ({ str: s, x: t.x + k }))));
    const text = ln.items.map((t) => t.str).join(' ');
    if (OPENING.test(text)) { const m = ln.items.filter((t) => isMoneyToken(t.str)); if (m.length) opening = amountOf(m[m.length - 1].str); continue; }
    if (CLOSING.test(text)) continue;
    let k = 0; let day = null;
    // one or two dates at the start ("01/10/2026 01/10/2026 …" or "01 Oct 2026 …")
    for (let tries = 0; tries < 2; tries++) {
      for (const n of [3, 2, 1]) {
        const d = bankDay(words.slice(k, k + n).map((w) => w.str).join(' '));
        if (d) { day = day || d; k += n; break; }
      }
    }
    const money = words.slice(k).filter((w) => isMoneyToken(w.str));
    if (!day || !money.length) {
      const prev = raw[raw.length - 1];
      if (prev && !day && !money.length && prev.more < 3 && text.length < 120 && !/page\s*\d|statement|narration|description|withdraw|deposit/i.test(text)) {
        prev.narration = `${prev.narration} ${text}`.trim(); prev.more++;
      }
      continue;
    }
    const narration = words.slice(k).filter((w) => !isMoneyToken(w.str)).map((w) => w.str).join(' ').replace(/\s+/g, ' ').trim();
    let amount = null; let balance = null; let sure = false;
    if (cols) {
      for (const t of money) {
        const c = t.x + (t.w || 0) / 2;
        const near = [['dr', cols.dr], ['cr', cols.cr], ['bal', cols.bal]].filter(([, x]) => x != null)
          .sort((a, b) => Math.abs(a[1] - c) - Math.abs(b[1] - c))[0][0];
        const a = bankAmount(t.str);
        if (near === 'bal') balance = a.side === 'dr' ? -Math.abs(a.value) : a.value;
        else if (a.value) { amount = near === 'cr' ? Math.abs(a.value) : -Math.abs(a.value); sure = true; }
      }
    } else {
      const a = bankAmount(money[0].str);
      if (money.length >= 2) { const b = bankAmount(money[money.length - 1].str); balance = b.side === 'dr' ? -Math.abs(b.value) : b.value; }
      amount = a.side === 'dr' ? -Math.abs(a.value) : a.side === 'cr' ? Math.abs(a.value) : a.value;
      sure = !!a.side;
    }
    if (!amount) continue;
    const refTok = narration.match(/\b(\d{6,22})\b/);
    raw.push({ day, amount: r2(amount), sure, narration, ref: refTok ? refTok[1] : null, balance, more: 0 });
  }
  return finish(raw, opening, cols ? { pdf: true, columns: true } : { pdf: true });
}

/** CSV / tab text → rows of cells (quotes understood). */
export function csvRows(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const firstLine = s.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// ---------------------------------------------------------------- what a narration says
const BANK_WORDS = new Set(('upi cr dr neft imps rtgs ach nach ecs mmt p2a p2m pay payment paid transfer trf tfr to from by inb ib mob '
  + 'bank hdfc icici sbi axis kotak pnb canara bob yes idbi indusind federal union boi iob paytm phonepe gpay google ybl okaxis oksbi okhdfcbank okicici '
  + 'ibl axl apl upi/cr credit debit ref chq cheque clg clearing deposit dep inward outward rev reversal txn imps/p2a').split(' '));
const NAME_SKIP = /^(mr|mrs|ms|m\/s|ms\.|shri|sri|smt)$/i;
export const normWords = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9@]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameWords = (s) => normWords(s).split(' ').filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !BANK_WORDS.has(w) && !NAME_SKIP.test(w)
  && !/^[a-z]{4}0[a-z0-9]{6}$/.test(w));   // not an IFSC
/** Words that say nothing about who it is (in customer / supplier names). */
const COMMON = new Set('pvt private ltd limited llp co company and the m s engg engineering eng works enterprises enterprise industries ind inds traders trading steel steels sons bros brothers corp corporation agencies agency store stores mart'.split(' '));

/**
 * What a bank line's text says: { kind, method, upi, phone, name, words }.
 * kind: upi | neft | imps | rtgs | cheque | cash | atm | charges | interest | other.
 */
export function readNarration(narration) {
  const s = String(narration || '');
  const u = s.toUpperCase();
  // a UPI id: letters / digits / dots before the @ (no hyphen: HDFC writes "UPI-NAME-name@okaxis-…" with hyphens between parts)
  const upi = (s.match(/[a-z0-9._]{2,}@[a-z][a-z0-9]{1,}/i) || [])[0]?.toLowerCase() || null;
  const phone = ((s.replace(/[^0-9]/g, ' ').match(/(?:^|\s)(?:91)?([6-9]\d{9})(?=\s|$)/) || [])[1]) || (upi && (upi.match(/^(?:91)?([6-9]\d{9})@/) || [])[1]) || null;
  let kind = 'other';
  if (/\bATM\b|\bATW\b|\bNWD\b|CASH\s*W(ITH)?D(RA)?W?L?|\bCWDR\b|SELF\s*(CHQ|WITHDRAWAL)/.test(u)) kind = 'atm';
  else if (/CASH\s*DEP|BY\s*CASH|CASH\s*DEPOSIT|\bCDM\b/.test(u)) kind = 'cash';
  else if (/CHRG|CHARGES?\b|SMS\s*ALERT|ANNUAL\s*FEE|\bAMC\b|CARD\s*FEE|GST\s*ON|\bCHG\b|MIN\s*BAL/.test(u)) kind = 'charges';
  else if (/INT\.?\s*PD|INTEREST|INT\s*CR|\bINT\.?CREDIT/.test(u)) kind = 'interest';
  else if (/\bUPI\b/.test(u) || upi) kind = 'upi';
  else if (/\bIMPS\b|\bMMT\b/.test(u)) kind = 'imps';
  else if (/\bRTGS\b/.test(u)) kind = 'rtgs';
  else if (/\bNEFT\b/.test(u)) kind = 'neft';
  else if (/\bCHQ\b|CHEQUE|\bCLG\b|CLEARING|\bINF\b|\bTRANSFER\s*FROM\b/.test(u)) kind = 'cheque';
  const method = { upi: 'UPI', imps: 'IMPS', neft: 'NEFT', rtgs: 'RTGS', cheque: 'Cheque' }[kind] || null;
  // the payer / payee name: the longest run of real words between the separators
  const parts = s.split(/[/|\-:]+|\s{2,}/).map((p) => p.trim()).filter(Boolean)
    .filter((p) => !p.includes('@') && !/^\d+$/.test(p.replace(/\s/g, '')));
  let name = '';
  let best = 0;
  for (const p of parts) {
    const w = nameWords(p);
    const len = w.join(' ').length;
    if (w.length && len > best) { best = len; name = w.join(' '); }
  }
  return { kind, method, upi, phone, name: name || null, words: nameWords(s) };
}
/** The key a bank line is remembered by ("SHARMA ENGG" → Sharma Engineering): the UPI id, else the phone, else the name. */
export function payerKey(narration) {
  const r = readNarration(narration);
  return r.upi ? `upi:${r.upi}` : r.phone ? `ph:${r.phone}` : r.name ? `name:${r.name}` : null;
}

/** How well a person's / firm's name fits the words in a bank line (0–1). */
export function nameFit(name, bankWords) {
  const want = normWords(name).split(' ').filter((w) => w.length >= 2);
  const own = want.filter((w) => !COMMON.has(w));
  const key = own.length ? own : want;
  if (!key.length) return 0;
  const have = new Set(bankWords);
  const joined = bankWords.join('');
  let hit = 0;
  for (const w of key) {
    if (have.has(w) || (w.length >= 4 && joined.includes(w))) hit++;
    else if (w.length >= 5 && bankWords.some((b) => b.length >= 4 && (b.startsWith(w.slice(0, 4)) && w.startsWith(b.slice(0, 4))))) hit += 0.6;
  }
  return Math.min(1, hit / key.length);
}

// ---------------------------------------------------------------- suggestions
const EXPENSE_WORDS = [
  ['bank', /CHRG|CHARGES?\b|SMS\s*ALERT|ANNUAL\s*FEE|\bAMC\b|CARD\s*FEE|GST\s*ON\s*(CHRG|CHG|CHARGE)|\bCHG\b|MIN\s*BAL/i],
  ['electricity', /ELECTRIC|\bBSES\b|TPDDL|PSPCL|MSEDCL|BESCOM|TORRENT\s*POWER|UPPCL|PVVNL|DHBVN|UHBVN|TATA\s*POWER|\bBIJLI\b/i],
  ['rent', /\bRENT\b|KIRAYA/i],
  ['phone', /AIRTEL|\bJIO\b|VODAFONE|\bVI\s*(RECHARGE|POSTPAID)|BSNL|RECHARGE|BROADBAND/i],
  ['salary', /SALARY|\bSAL\b|WAGES|MAZDOORI/i],
  ['fuel', /PETROL|DIESEL|\bFUEL\b|\bHPCL\b|\bBPCL\b|\bIOCL\b|INDIAN\s*OIL|HP\s*PAY|NAYARA/i],
  ['tax', /GST\s*(PAYMENT|CHALLAN)|\bGSTN\b|\bCBDT\b|\bTDS\b|INCOME\s*TAX|ADVANCE\s*TAX|\bCHALLAN\b|\bTIN\b\s*NSDL|PROPERTY\s*TAX/i],
  ['freight', /TRANSPORT|LOGISTIC|FREIGHT|ROADWAYS|CARRIER/i],
  ['repair', /REPAIR|SERVICE\s*CENT/i],
];

/**
 * Suggest what every open line is. Returns one suggestion per line (same order):
 *   { line, action, confidence: 'sure' | 'likely' | 'unknown', reason, customer_id?, supplier_id?, move?, category?, to?, side? }
 * action: link (already in the app) · payment (customer paid us) · refund (we gave a customer money back) · expense ·
 *         supplier (paid a supplier) · move (cash in / out of the drawer) · skip (not shop money) · null (needs you)
 *
 * moves: the app's own entries in this account near these days { ref, src: payment|expense|transfer_in|transfer_out,
 *        amount (+ in / − out), day, label, linked }
 * customers [{ id, name, phone }] · suppliers [{ id, name }] · payers { key → { action, customer_id, supplier_id, category, to } }
 * dues { customer_id → { pakka, kacha, credit } } (what each customer owes / holds) · drawer: the cash drawer's account id
 */
export function suggestBankLines({ lines = [], moves = [], customers = [], suppliers = [], payers = {}, dues = {}, drawer = null, days = 4 }) {
  const used = new Set(moves.filter((m) => m.linked).map((m) => m.ref));
  const dayNo = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
  const custPhone = new Map(customers.filter((c) => c.phone).map((c) => [String(c.phone).replace(/\D/g, '').slice(-10), c]));
  const sideFor = (cid, amt) => {
    const d = dues[cid];
    if (!d) return 'pakka';
    if ((d.kacha || 0) >= amt && !((d.pakka || 0) >= amt)) return 'kacha';
    if ((d.pakka || 0) >= amt) return 'pakka';
    return (d.kacha || 0) > (d.pakka || 0) ? 'kacha' : 'pakka';
  };
  const out = [];
  // 1. lines that are already in the app (closest day first), so nothing is added twice
  const linkOf = new Map();
  const pairs = [];
  lines.forEach((l, i) => {
    if (l.status && l.status !== 'open') return;
    moves.forEach((m) => {
      if (used.has(m.ref) || Math.abs(m.amount - l.amount) > 0.5 || Math.sign(m.amount) !== Math.sign(l.amount)) return;
      const gap = dayNo(l.day) - dayNo(m.day);
      if (gap < -1 || gap > days) return;   // the bank shows it the same day or a few days later
      pairs.push({ i, m, gap: Math.abs(gap) });
    });
  });
  pairs.sort((a, b) => a.gap - b.gap);
  for (const p of pairs) { if (linkOf.has(p.i) || used.has(p.m.ref)) continue; linkOf.set(p.i, p.m); used.add(p.m.ref); }

  lines.forEach((l, i) => {
    const base = { line: l.id ?? i };
    if (l.status && l.status !== 'open') { out.push({ ...base, action: null, confidence: 'done', reason: l.status }); return; }
    const m = linkOf.get(i);
    if (m) { out.push({ ...base, action: 'link', confidence: 'sure', reason: 'already', move: m.ref, src: m.src, label: m.label || null }); return; }
    const n = readNarration(l.narration);
    const key = n.upi ? `upi:${n.upi}` : n.phone ? `ph:${n.phone}` : n.name ? `name:${n.name}` : null;
    const memo = key && payers[key];
    if (memo && (memo.action !== 'payment' || l.amount > 0) && (memo.action !== 'refund' || l.amount < 0)) {
      out.push({ ...base, action: memo.action, confidence: 'sure', reason: 'remembered', customer_id: memo.customer_id || null,
        supplier_id: memo.supplier_id || null, category: memo.category || null, to: memo.to || null,
        side: memo.customer_id ? sideFor(memo.customer_id, Math.abs(l.amount)) : undefined, method: n.method });
      return;
    }
    // who is it?
    let who = null; let why = null;
    if (n.phone && custPhone.has(n.phone)) { who = custPhone.get(n.phone); why = 'phone'; }
    if (!who) {
      const scored = customers.map((c) => ({ c, f: nameFit(c.name, n.words) })).filter((x) => x.f >= 0.6).sort((a, b) => b.f - a.f);
      if (scored.length && (scored.length === 1 || scored[0].f - scored[1].f >= 0.25)) { who = scored[0].c; why = 'name'; }
    }
    if (l.amount > 0) {
      if (n.kind === 'cash') { out.push({ ...base, action: 'move', confidence: 'likely', reason: 'cash_deposit', to: drawer, method: null }); return; }
      if (n.kind === 'interest') { out.push({ ...base, action: 'skip', confidence: 'likely', reason: 'interest' }); return; }
      if (who) {
        const d = dues[who.id];
        const owes = d ? (d.pakka || 0) + (d.kacha || 0) : 0;
        const exact = d && [d.pakka, d.kacha].some((x) => x && Math.abs(x - l.amount) < 0.5);
        // a name or phone alone is only 'likely' (another Sharma may have paid); the exact amount they owe makes it sure
        out.push({ ...base, action: 'payment', confidence: exact ? 'sure' : 'likely', reason: exact ? 'amount' : why, customer_id: who.id,
          side: sideFor(who.id, l.amount), method: n.method, owes });
        return;
      }
      out.push({ ...base, action: null, confidence: 'unknown', reason: 'unknown', method: n.method, name: n.name });
      return;
    }
    // money out
    if (n.kind === 'atm') { out.push({ ...base, action: 'move', confidence: 'likely', reason: 'atm', to: drawer }); return; }
    const exp = EXPENSE_WORDS.find(([, re]) => re.test(l.narration || ''));
    if (exp) { out.push({ ...base, action: 'expense', confidence: n.kind === 'charges' ? 'sure' : 'likely', reason: 'words', category: exp[0], method: n.method }); return; }
    const sup = suppliers.map((s) => ({ s, f: nameFit(s.name, n.words) })).filter((x) => x.f >= 0.6).sort((a, b) => b.f - a.f)[0];
    if (sup) { out.push({ ...base, action: 'supplier', confidence: 'likely', reason: 'name', supplier_id: sup.s.id, method: n.method }); return; }
    if (who && (dues[who.id]?.credit || 0) >= Math.abs(l.amount) - 0.5) {
      out.push({ ...base, action: 'refund', confidence: 'likely', reason: 'name', customer_id: who.id, side: sideFor(who.id, Math.abs(l.amount)), method: n.method });
      return;
    }
    out.push({ ...base, action: null, confidence: 'unknown', reason: 'unknown', method: n.method, name: n.name });
  });
  return out;
}

/** "UPI · SHARMA ENGG · sharmaeng@okhdfc" — a bank line's text, short and readable. */
export function shortNarration(narration) {
  const n = readNarration(narration);
  const kind = { upi: 'UPI', imps: 'IMPS', neft: 'NEFT', rtgs: 'RTGS', cheque: 'Cheque', cash: 'Cash', atm: 'ATM', charges: 'Charges', interest: 'Interest' }[n.kind];
  const bits = [kind, n.name ? n.name.toUpperCase() : null, n.upi].filter(Boolean);
  return bits.length >= 2 ? bits.join(' · ') : String(narration || '').replace(/\s+/g, ' ').slice(0, 80);
}
