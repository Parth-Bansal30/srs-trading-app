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
