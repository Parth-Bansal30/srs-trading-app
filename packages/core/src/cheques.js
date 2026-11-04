// Cheques and demand drafts in a bank statement (4 Nov 2026, plan v2 F5).
// The statement never says "received" — only deposited / cleared / returned — so the register in the app (noted when a
// cheque comes in or is given) is what a line is compared with. The app only FINDS: which lines are cheques, their
// number and bank, and which register cheques could be the one. A person matches and confirms every one.
//
// Indian banks write cheque lines many ways (made-up examples):
//   CHQ DEP 004512 DELHI-BOB · BY CLG 004512 · CLG/SHARMA/004512/BOB · CHQ DEPOSIT - MICR CTS · 000000004512 (ref column)
//   CLG DR 118244 · CHQ PAID-MICR CTS-118244 · TO CLG 118244 · INWARD CLG 118244
//   CHQ RETURN 004512 · O/W RTN 004512 · OW RTN CHQ · I/W RETURN · CHQ RET FUNDS INSUFFICIENT · DISHONOURED
//   CHQ RTN CHGS · RETURN CHARGES · DD ISSUE 445566 · BY DD 445566 · DEMAND DRAFT

const CHEQUE = /\bCHQS?\b|\bCHEQUES?\b|\bCLG\b|CLEARING|\bCTS\b|\bMICR\b|\b(?:INWARD|OUTWARD)\s*(?:CLG|CLEARING|RET|RTN|RETURN|CHQ)|\bO\/W\b|\bI\/W\b|\bOW\s*RTN\b|\bIW\s*RTN\b|\bINST(?:RUMENT)?\s*NO/i;
const DD = /(?:^|[^A-Z@.])DD(?:[^A-Z@.]|$)|DEMAND\s*DRAFT|\bD\.D\.?(?:\s|$)/i;
const RETURN = /\bRET(?:URN(?:ED)?)?\b|\bRTN\b|\bRETN\b|\bRTD\b|BOUNCE|DISHONOU?R|\bUNPAID\b|\bREJECT/i;
const CHARGES = /CHGS?\b|CHARGES?\b|\bCHRG|\bFEES?\b|\bCOMM(?:ISSION)?\b/i;
// not a cheque line even when "CHQ" is in it: digital payments, cash, self cheques (cash out of the bank), cheque books
const NOT = /\bUPI\b|\bNEFT\b|\bIMPS\b|\bRTGS\b|\bNACH\b|\bECS\b|\bATM\b|CASH\s*(?:DEP|W)|\bSELF\b|\bBY\s*CASH\b|CHQ\s*BOOK|CHEQUE\s*BOOK|\bCHQBK\b/i;
// the bank a cheque was drawn on, when the line says it (a hint only — "DELHI-BOB")
const BANKS = [['SBI', /\bSBI(?:N)?\b|STATE\s*BANK/], ['BOB', /\bBOB\b|\bBARB\b|BARODA/], ['PNB', /\bPNB\b|\bPUNB\b|PUNJAB\s*NATIONAL/],
  ['HDFC', /\bHDFC\b/], ['ICICI', /\bICICI?\b|\bICIC\b/], ['AXIS', /\bAXIS\b|\bUTIB\b/], ['KOTAK', /\bKOTAK\b|\bKKBK\b/], ['CANARA', /\bCANARA\b|\bCNRB\b/],
  ['UNION', /\bUNION\s*BANK\b|\bUBIN\b/], ['BOI', /\bBOI\b|\bBKID\b|BANK\s*OF\s*INDIA/], ['IOB', /\bIOB\b|\bIOBA\b/], ['IDBI', /\bIDBI\b|\bIBKL\b/],
  ['YES', /\bYES\s*BANK\b|\bYESB\b/], ['INDUSIND', /\bINDUSIND\b|\bINDB\b/], ['IDFC', /\bIDFC\b/], ['FEDERAL', /\bFEDERAL\b|\bFDRL\b/],
  ['CENTRAL', /\bCBI\b|\bCBIN\b|CENTRAL\s*BANK/], ['UCO', /\bUCO\b|\bUCBA\b/], ['INDIAN', /\bINDIAN\s*BANK\b|\bIDIB\b/], ['PSB', /\bPSB\b|\bPSIB\b/]];

/** A cheque / DD number without its leading zeros ("004512" and "4512" are the same cheque). */
export const chequeNo = (v) => {
  const s = String(v ?? '').toUpperCase().replace(/\s/g, '');
  if (!s) return null;
  const t = s.replace(/^0+(?=.)/, '');
  return t === '0' ? null : t;
};
/** For showing: at least 6 digits, as printed on Indian cheques. */
export const chequeShow = (v) => { const n = chequeNo(v); return n && /^\d+$/.test(n) && n.length < 6 ? n.padStart(6, '0') : n; };

function numberIn(text, ref) {
  const s = String(text || '').toUpperCase();
  // "CHQ NO 004512", "CHQ 004512", "CHEQUE NO.004512", "INST NO 4512", "DD NO 445566", "CLG/…/004512"
  const m = s.match(/(?:CHQS?|CHEQUE|INST(?:RUMENT)?|DD|CLG|CTS)\.?(?:\s*(?:DEP(?:OSIT)?|PAID|ISSUED?|RET(?:URN)?|RTN|DR|CR|BY|TO))?\s*(?:NO\.?|NUMBER|#)?\s*[:.\-#/]?\s*(\d{3,10})(?!\d)/);
  if (m && m[1].replace(/^0+/, '').length <= 8) return chequeNo(m[1]);
  // the bank's ref column holds the cheque number, padded ("000000004512")
  const r = String(ref || '').replace(/\s/g, '');
  if (/^\d{1,20}$/.test(r) && /[1-9]/.test(r) && r.replace(/^0+/, '').length <= 6 && (r.length <= 6 || /^0{4,}/.test(r))) return chequeNo(r);
  // a padded number at the front of the text (PDFs put the ref there)
  const pad = s.match(/(?:^|\s)(0{4,}[1-9]\d{0,5})(?!\d)/);
  if (pad && pad[1].length <= 20) return chequeNo(pad[1]);
  // one 6-digit group and nothing else that looks like a number
  const six = s.match(/(?<![\d])\d{6}(?![\d])/g) || [];
  if (six.length === 1 && !(s.match(/\d{7,}/g) || []).length) return chequeNo(six[0]);
  return null;
}

/**
 * What a statement line says about a cheque / DD, or null when it is not one:
 * { kind: 'in' | 'return' | 'out' | 'out_return' | 'charges', instrument: 'cheque' | 'dd', number, bank }
 *   in = a cheque / DD we deposited has cleared (money in) · return = it came back (money out again)
 *   out = our cheque / DD to someone was paid (money out) · out_return = our cheque came back (money in again)
 *   charges = the bank's charges for a returned cheque
 */
export function chequeLine(l) {
  const text = `${l?.narration || ''}`;
  if (!text || !l?.amount || NOT.test(text)) return null;
  const isDd = DD.test(text) && !/\bCHQ|CHEQUE/i.test(text);
  if (!isDd && !CHEQUE.test(text)) return null;
  const back = RETURN.test(text);
  const bank = (BANKS.find(([, re]) => re.test(text.toUpperCase())) || [])[0] || null;
  const instrument = isDd ? 'dd' : 'cheque';
  if (CHARGES.test(text)) {
    // only a return's charges belong with the cheques; other bank charges stay bank charges
    return back && l.amount < 0 ? { kind: 'charges', instrument, number: numberIn(text, null), bank } : null;
  }
  const number = numberIn(text, l.ref);
  const kind = l.amount > 0 ? (back ? 'out_return' : 'in') : (back ? 'return' : 'out');
  return { kind, instrument, number, bank };
}

const dayNo = (d) => Math.round(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / 86400000);

/**
 * Register cheques that could be this line, best first: [{ id, why: 'number' | 'amount', same_amount, days }].
 * Number first (with the amount or not — a different amount needs a note when matched), then the same amount; never
 * a cheque noted after the line, nor one more than 6 months before it. A DD never "comes back".
 */
export function chequeCandidates(line, info, cheques = []) {
  if (!info || info.kind === 'charges') return [];
  const amt = Math.abs(line.amount);
  const want = { in: ['in', ['received', 'deposited']], return: ['in', ['cleared', 'deposited', 'received']],
    out: ['out', ['given']], out_return: ['out', ['given', 'cleared']] }[info.kind];
  const day = dayNo(line.day);
  const out = [];
  for (const c of cheques) {
    if (c.direction !== want[0] || !want[1].includes(c.status)) continue;
    if (info.kind === 'return' && c.instrument === 'dd') continue;
    const days = day - dayNo(c.got_on);
    if (days < -1 || days > 183) continue;
    const sameNo = !!info.number && chequeNo(c.number) === info.number;
    const sameAmt = Math.abs(Number(c.amount) - amt) < 0.005;
    if (!sameNo && !sameAmt) continue;
    // a different number on the same amount is still shown, after the others (numbers are misread / mistyped)
    // a return: the one that cleared first (its payment must be cancelled), then waiting ones
    const rank = (sameNo ? 0 : 10) + (sameAmt ? 0 : 5) + (info.kind === 'return' && c.status !== 'cleared' ? 1 : 0) + Math.min(Math.abs(days), 183) / 1000;
    out.push({ id: c.id, why: sameNo ? 'number' : 'amount', same_amount: sameAmt, days, rank });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 5).map(({ rank, ...x }) => x);
}

/**
 * A returned cheque's own deposit line in the same statement (both still open): the money went in and out again.
 * Same number when both show one, else the same amount within 15 days before.
 */
export function depositOf(ret, info, lines = []) {
  if (!info || info.kind !== 'return') return null;
  let best = null; let bestScore = -1;
  for (const o of lines) {
    if (o === ret || o.id === ret.id || (o.status && o.status !== 'open') || Math.abs(o.amount + ret.amount) > 0.005) continue;
    const oi = chequeLine(o);
    if (!oi || oi.kind !== 'in') continue;
    const gap = dayNo(ret.day) - dayNo(o.day);
    if (gap < 0 || gap > 15) continue;
    if (info.number && oi.number && info.number !== oi.number) continue;
    const score = (info.number && oi.number === info.number ? 10 : 0) - gap / 100;
    if (score > bestScore) { best = o; bestScore = score; }
  }
  return best ? best.id : null;
}
