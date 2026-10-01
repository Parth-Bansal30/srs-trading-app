// Slips and statements for the CUSTOMER: the backend builds each one from the saved figures and
// keeps a copy behind a secret link (#/d/<token>). This file makes the link, the WhatsApp message,
// the UPI payment link and the PDF file name. Words come from content/words.js in the doc's language.
import { whatsappLink } from '@srs/core';
import { call } from './api.js';
import { db } from './backend.js';
import { tIn } from './i18n.js';
import { store } from './store.js';
import { money, shortDate } from './format.js';

/** The customer's link. It opens this same app, which shows only that one document. */
export const docUrl = (token) => `${location.origin}${location.pathname}#/d/${token}`;

/** A UPI ID with "sample" in it is a placeholder: the slip says "do not pay". */
export const isSampleUpi = (id) => /sample/i.test(id || '');

/** upi://pay link for exactly this amount — every UPI app (GPay, PhonePe, Paytm, BHIM) understands it. */
export function upiLink(upi) {
  if (!upi?.id) return null;
  const e = encodeURIComponent;
  return `upi://pay?pa=${e(upi.id)}&pn=${e(upi.name || '')}&am=${Number(upi.amount).toFixed(2)}&cu=INR&tn=${e(upi.note || '')}`;
}

/** Choices remembered on this phone (size, language, QR on/off). */
export const docPrefs = () => ({ size: 'page', lang: 'en', upi: true, ...store.json('doc-prefs') });
export const saveDocPrefs = (p) => store.setJson('doc-prefs', { ...docPrefs(), ...p });

/** Build (or refresh) the slip copy. send=true also marks it as sent. */
export const makeSlipDoc = ({ orderId, lang, upi = true, send = false }) => call('slipDoc', { order_id: orderId, lang, upi, send });
/** Statement: preview=true only works out the numbers; otherwise a new copy + link is saved. */
export const makeStatementDoc = ({ customerId, from, to, which, lang, upi = true, send = false, preview = false }) =>
  call('statementDoc', { customer_id: customerId, from, to, which, lang, upi, send, preview });

/** What has been sent for one slip already (link, when, how often opened) — read only, nothing saved. */
export async function sentInfo(orderId) {
  const { data } = await db.from('shared_docs').select('token,lang,sent_at,send_count,open_count,opened_at').eq('kind', 'slip').eq('order_id', orderId);
  return data || [];
}

const dayText = (iso, tz) => shortDate(iso, tz);

export function slipMessage(doc, url) {
  const l = doc.lang; const s = doc.slip;
  const when = dayText(s.at, doc.timezone);
  return s.balance > 0
    ? tIn(l, 'msg_slip', doc.customer.name, s.no, doc.shop.name, when, money(s.total, true), money(s.paid, true), money(s.balance, true), url)
    : tIn(l, 'msg_slip_paid', doc.customer.name, s.no, doc.shop.name, when, money(s.total, true), url);
}

export function statementMessage(doc, url) {
  const l = doc.lang;
  const range = `${fmtDay(doc.period.from)} – ${fmtDay(doc.period.to)}`;
  return tIn(l, 'msg_stmt', doc.customer.name, doc.shop.name, range, fmtDay(doc.period.to), money(Math.max(0, doc.closing), true), url);
}

/** 'YYYY-MM-DD' → '28 Sep 2026' (a calendar day, no time zone maths needed). */
export function fmtDay(day, year = true) {
  const [y, m, d] = String(day).split('-').map(Number);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return year ? `${d} ${mon} ${y}` : `${d} ${mon}`;
}

const slug = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
export const docFileName = (doc) => (doc.kind === 'slip'
  ? `Slip-${doc.slip.no}-${slug(doc.customer.name)}.pdf`
  : `Statement-${slug(doc.customer.name)}-${doc.period.from}-to-${doc.period.to}.pdf`);

/** wa.me link to the customer's chat (or "choose a chat" when there is no number). */
export const waLink = (phone, text) => whatsappLink(phone, text) || `https://wa.me/?text=${encodeURIComponent(text)}`;

/**
 * Open WhatsApp. Must run straight from a tap; returns false if the phone blocked it
 * (then the screen shows an "Open WhatsApp" button to tap once more).
 */
export function openWhatsApp(url) {
  const w = window.open(url, '_blank');
  if (!w) return false;
  try { w.opener = null; } catch { /* other app */ }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The slip / statement written out as a WhatsApp message (the "As text" choice).
// Lines inside ``` … ``` show in WhatsApp's fixed-width font, so the amounts line up.
// Never shows rates per kg, payment notes or the word "kacha" (same as the paper).
// ---------------------------------------------------------------------------------------------
const n2 = (v) => money(v, true).replace('₹', '').replace('− ', '-');
const signed = (v) => (v < 0 ? `-${n2(-v)}` : `+${n2(v)}`);
const W = 32; // characters per line that fit a phone screen in WhatsApp's fixed-width font
const line = (left, right) => {
  const room = W - right.length - 1;
  const l = left.length > room ? `${left.slice(0, room - 1)}…` : left;
  return `${l.padEnd(room)} ${right}`;
};
const modeWord = (l, mode) => ({ Cash: 'pm_cash', UPI: 'pm_upi', Bank: 'pm_bank', Cheque: 'pm_cheque' }[mode] ? tIn(l, { Cash: 'pm_cash', UPI: 'pm_upi', Bank: 'pm_bank', Cheque: 'pm_cheque' }[mode]) : '');
const upiLine = (l, upi) => (upi?.id && !isSampleUpi(upi.id) ? tIn(l, 'tx_upi', upi.id) : null);

/** Statement rows that fit in one message; longer statements go as PDF. */
export const TEXT_MAX_ROWS = 40;

export function statementText(doc, url) {
  const l = doc.lang;
  const rowText = (r) => {
    const d = fmtDay(r.day, false).replace(/^(\d) /, '0$1 ');
    let what;
    if (r.type === 'slip') what = `#${r.slip}${r.gst && !doc.gst_only ? ' GST' : ''}`;
    else if (r.type === 'old') what = r.slip ? `${tIn(l, 'tx_old')} #${r.slip}` : tIn(l, 'tx_old');
    else if (r.amount < 0) what = tIn(l, 'tx_ret');
    else if (r.kind === 'advance' && r.slip) what = `${tIn(l, 'tx_adv')} #${r.slip} ${modeWord(l, r.mode)}`;
    else if (r.kind === 'settled' && r.slip) what = `${tIn(l, 'tx_paid')} #${r.slip}`;
    else what = `${tIn(l, 'tx_paid')} ${modeWord(l, r.mode)}`;
    return line(`${d} ${what.trim()}`, r.type === 'pay' ? signed(-r.amount) : signed(r.amount));
  };
  const rows = [line(tIn(l, 'tx_open'), n2(doc.opening)), ...doc.rows.map(rowText)];
  const total = Math.round((doc.opening + doc.bought) * 100) / 100;
  const bal = doc.closing > 0 ? tIn(l, 'tx_bal', money(doc.closing, true)) : doc.closing < 0 ? tIn(l, 'tx_credit', money(-doc.closing, true)) : tIn(l, 'tx_settled');
  return [
    `*${doc.shop.name}*`,
    `${tIn(l, 'stmt_title')} · *${doc.customer.name}*`,
    `${fmtDay(doc.period.from)} – ${fmtDay(doc.period.to)}`,
    '```',
    ...rows,
    '```',
    tIn(l, 'tx_totals', money(doc.opening, true), money(doc.bought, true), money(total, true)),
    tIn(l, 'tx_paid_line', money(doc.paid, true)),
    bal,
    doc.closing > 0 ? upiLine(l, doc.upi) : null,
    doc.shop.phone ? tIn(l, 'tx_call', doc.shop.phone) : null,
    url ? tIn(l, 'tx_stmt_pdf', url) : null,
  ].filter(Boolean).join('\n');
}

export function slipText(doc, url) {
  const l = doc.lang; const s = doc.slip;
  const unit = (u) => (u === 'in' ? '"' : ' mm');
  const items = s.items.flatMap((it) => {
    const size = `${it.shape === 'round' ? 'Ø' : ''}${(it.dims || []).filter((x) => x !== '' && x != null).join('×')}${unit(it.unit)}`;
    const lens = it.lengths.length && it.lengths[0].len != null && it.lengths[0].len !== ''
      ? it.lengths.map((r) => `${r.len}${unit(it.unit).trim()}×${r.pcs}`).join(', ')
      : `${it.pcs} ${tIn(l, 'pcs')}`;
    return [`${it.grade} ${size}${it.hsn ? ` HSN ${it.hsn}` : ''}`, line(` ${lens}`, it.weight != null ? `${it.weight.toFixed(2)} kg` : '')];
  });
  const lines = [[tIn(l, 'material'), s.material], [tIn(l, 'cutting'), s.cutting], ...(s.gst ? [[tIn(l, 'gst_line', s.gst_pct), s.gst_amount]] : [])];
  const pays = s.payments.map((p) => `${p.amount < 0 ? tIn(l, 'doc_returned') : p.kind === 'advance' ? tIn(l, 'doc_pay_adv') : tIn(l, 'doc_pay')} ${shortDate(p.at, doc.timezone)} ${modeWord(l, p.mode)}: ${p.amount < 0 ? '+' : '−'} ${money(Math.abs(p.amount), true)}`.replace(/\s+:/, ':'));
  return [
    `*${doc.shop.name}*`,
    `${tIn(l, 'order_slip')} *#${s.no}* · ${fmtDay(new Date(s.at).toLocaleDateString('en-CA', { timeZone: doc.timezone }))}`,
    tIn(l, 'tx_customer', doc.customer.name),
    '```',
    ...items,
    ...(s.total_weight != null ? [line(tIn(l, 'weight_total'), `${Number(s.total_weight).toFixed(2)} kg`)] : []),
    '```',
    ...lines.map(([a, b]) => `${a}: ${money(b, true)}`),
    `*${tIn(l, 'total')}: ${money(s.total, true)}*`,
    ...pays,
    s.balance > 0 ? tIn(l, 'tx_bal', money(s.balance, true)) : `*${tIn(l, 'paid_full')}*`,
    s.gst ? `_${tIn(l, 'slip_gst')}_` : null,
    s.balance > 0 ? upiLine(l, doc.upi) : null,
    url ? tIn(l, 'tx_slip_pdf', url) : null,
    tIn(l, 'thanks'),
  ].filter(Boolean).join('\n');
}

/** Short note that goes with a shared PDF. */
export function pdfCaption(doc, url) {
  const l = doc.lang;
  if (doc.kind === 'slip') return [tIn(l, 'tx_cap_slip', doc.slip.no, money(doc.slip.total, true), money(doc.slip.balance, true)), doc.shop.name, url].filter(Boolean).join('\n');
  return [tIn(l, 'tx_cap_stmt', `${fmtDay(doc.period.from, false)} – ${fmtDay(doc.period.to, false)}`, money(Math.max(0, doc.closing), true)), doc.shop.name, url].filter(Boolean).join('\n');
}
