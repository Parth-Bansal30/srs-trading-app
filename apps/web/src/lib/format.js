// How numbers and dates look. Money in Indian style (₹3,26,791), dates in the SHOP's time zone.
import { APP } from '../config/app.js';
import { MONTH_SHORT } from '@srs/core';

const fmt0 = new Intl.NumberFormat(APP.moneyLocale, { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat(APP.moneyLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ₹ amount. paise: 'auto' shows .xx only when not a whole rupee; true always; false never. */
export function money(n, paise = 'auto') {
  const v = Number(n) || 0;
  const neg = v < 0 ? '− ' : '';
  const a = Math.abs(v);
  const s = paise === true || (paise === 'auto' && Math.round(a * 100) % 100 !== 0) ? fmt2.format(a) : fmt0.format(Math.round(a));
  return `${neg}₹${s}`;
}
export const kg = (n, d = 2) => `${(Number(n) || 0).toLocaleString(APP.moneyLocale, { maximumFractionDigits: d })} kg`;

const parts = (iso, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short',
}).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));

export const shortDate = (iso, tz) => { const p = parts(iso, tz); return `${p.day} ${MONTH_SHORT[p.month - 1]}`; };
export const longDay = (iso, tz) => { const p = parts(iso, tz); return `${p.weekday}, ${p.day} ${MONTH_SHORT[p.month - 1]}`; };
export const time = (iso, tz) => { const p = parts(iso, tz); return `${p.hour}:${p.minute} ${p.dayPeriod?.toLowerCase() ?? ''}`.trim(); };

/** The moment the shop's day started (as an ISO string), e.g. midnight in India. */
export function dayStartISO(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const guess = Date.UTC(+p.year, +p.month - 1, +p.day);
  const off = offsetMinutes(tz, new Date(guess));
  return new Date(guess - off * 60000).toISOString();
}
function offsetMinutes(tz, at) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((x) => x.type === 'timeZoneName').value;
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}
