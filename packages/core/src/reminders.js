/**
 * Payment reminders (owner decision, 26 Sept 2026).
 * - The app finds customers whose slips are unpaid or part-paid for a set number of days,
 *   per side (pakka / kacha separately), and ASKS before sending anything.
 * - Loose payments clear the oldest slips first (same as the khata).
 * - The message never says kacha/pakka or anything like it: only "pending amount" and slip numbers.
 */
import { r2 } from './round.js';
import { businessDate, DEFAULT_TIMEZONE, MONTH_SHORT } from './slips.js';
import { customerLedger } from './ledger.js';

const DAY = 86400000;
const byDate = (a, b) => new Date(a.date) - new Date(b.date);
const ymd = (d, tz) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? String(d) : businessDate(d, tz));
const dayNo = (d, tz) => Date.parse(`${ymd(d, tz)}T00:00:00Z`) / DAY;

/** Indian mobile: 10 digits starting 6–9, typed with or without +91 / 0 / spaces → "+91XXXXXXXXXX" or null. */
export function normalizeIndianMobile(input) {
  const d = String(input ?? '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null;
}

/** A WhatsApp link that opens the chat with the message already typed (sent from the phone's own WhatsApp). */
export function whatsappLink(phone, text) {
  const p = normalizeIndianMobile(phone);
  return p ? `https://wa.me/${p.slice(1)}?text=${encodeURIComponent(text)}` : null;
}

/**
 * One customer's unpaid or part-paid slips on ONE side, oldest first, with age in days
 * (by the shop's own calendar). Advances on open orders are not dues and are left out.
 */
export function dueSlips({ custId, side, orders, payments, oldDues = [], now, timeZone = DEFAULT_TIMEZONE, totals = {} }) {
  const l = customerLedger({ custId, orders, payments, oldDues, sides: [side], allSides: ['pakka', 'kacha'], totals });
  const refOf = new Map(orders.map((o) => [o.id, o.slipNo != null ? String(o.slipNo) : String(o.id)]));
  const today = dayNo(now, timeZone);
  const slips = l.bills.filter((b) => b.rem > 0).sort(byDate).map((b) => ({
    ref: b.old ? b.ref : refOf.get(b.oid), old: !!b.old, oid: b.old ? null : b.oid,
    date: ymd(b.date, timeZone), amount: b.amt, paid: b.paid, balance: b.rem, days: today - dayNo(b.date, timeZone),
  }));
  const since = slips[0]?.date;
  const recentPayments = l.pays
    .filter((p) => !p.pending && p.amt > 0 && p.mode !== 'Adjust' && (!since || ymd(p.date, timeZone) >= since))
    .sort(byDate).reverse().slice(0, 3)
    .map((p) => ({ date: ymd(p.date, timeZone), amount: p.amt, mode: p.mode }));
  return {
    side, due: l.bySide[side]?.due ?? 0, credit: l.bySide[side]?.adv ?? 0, slips,
    oldestDays: slips.length ? slips[0].days : 0,
    paidOnThese: r2(slips.reduce((a, s) => a + s.paid, 0)),
    recentPayments,
  };
}

/** Should the app ASK about a reminder now? (Never sends by itself.) */
export function needsReminder(d, { afterDays = 25, repeatDays = 7, lastReminderAt = null, now, timeZone = DEFAULT_TIMEZONE }) {
  if (!(d.due > 0) || d.oldestDays < afterDays) return false;
  if (!lastReminderAt) return true;
  return dayNo(now, timeZone) - dayNo(lastReminderAt, timeZone) >= repeatDays;
}

// ---------- the message ----------
export const money = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
const shortDate = (s) => { const [, m, d] = s.split('-').map(Number); return `${d} ${MONTH_SHORT[m - 1]}`; };

const WORDS = {
  en: {
    hello: (c) => `Namaste ${c},`,
    intro: (shop) => `A gentle reminder from ${shop} about your pending amount.`,
    slip: (ref) => `Slip ${ref}`, oldSlip: (ref) => `Old slip ${ref}`, oldBal: 'Old balance',
    paid: 'paid', bal: 'balance', total: 'Total pending', got: 'Payments received',
    pay: (a, mode, d) => `${a} by ${mode} on ${d}`, more: (n) => `…and ${n} more slip(s)`,
    end: 'Please clear it at your earliest convenience. Thank you!',
  },
  hn: {
    hello: (c) => `Namaste ${c} ji,`,
    intro: (shop) => `${shop} ki taraf se aapke pending amount ki yaad dilana chahte hain.`,
    slip: (ref) => `Slip ${ref}`, oldSlip: (ref) => `Purani slip ${ref}`, oldBal: 'Purana baaki',
    paid: 'diya', bal: 'baaki', total: 'Kul baaki', got: 'Mila hua payment',
    pay: (a, mode, d) => `${a} ${mode} se ${d} ko`, more: (n) => `…aur ${n} slip`,
    end: 'Kripya jaldi clear kar dein. Dhanyavaad!',
  },
  hi: {
    hello: (c) => `नमस्ते ${c} जी,`,
    intro: (shop) => `${shop} की ओर से आपकी बकाया राशि की याद दिलाना चाहते हैं।`,
    slip: (ref) => `स्लिप ${ref}`, oldSlip: (ref) => `पुरानी स्लिप ${ref}`, oldBal: 'पुराना बकाया',
    paid: 'दिया', bal: 'बाकी', total: 'कुल बकाया', got: 'मिला भुगतान',
    pay: (a, mode, d) => `${a} ${mode} से ${d} को`, more: (n) => `…और ${n} स्लिप`,
    end: 'कृपया जल्द भुगतान कर दें। धन्यवाद!',
  },
};

/**
 * The reminder text for one customer and one side (from dueSlips). Plain text for WhatsApp/SMS.
 * Deliberately neutral: no bill type, no rates — slip numbers, amounts, paid, balance.
 */
export function reminderMessage({ lang = 'en', shop, customer, due, maxSlips = 10 }) {
  const w = WORDS[lang] || WORDS.en;
  const lines = [w.hello(customer), w.intro(shop), ''];
  due.slips.slice(0, maxSlips).forEach((s) => {
    const name = s.old ? (s.ref ? w.oldSlip(s.ref) : w.oldBal) : w.slip(s.ref);
    const parts = [money(s.amount)];
    if (s.paid > 0) parts.push(`${w.paid} ${money(s.paid)}`);
    parts.push(`${w.bal} ${money(s.balance)}`);
    lines.push(`${name} (${shortDate(s.date)}): ${parts.join(' · ')}`);
  });
  if (due.slips.length > maxSlips) lines.push(w.more(due.slips.length - maxSlips));
  lines.push('', `${w.total}: ${money(due.due)}`);
  if (due.recentPayments?.length) {
    lines.push(`${w.got}: ${due.recentPayments.map((p) => w.pay(money(p.amount), p.mode, shortDate(p.date))).join(', ')}`);
  }
  lines.push('', w.end);
  return lines.join('\n');
}
