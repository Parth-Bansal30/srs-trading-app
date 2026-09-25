/**
 * Slip numbers people see. Schemes: 'never' (continuous), 'daily', 'monthly',
 * 'yearly' (Indian financial year, 1 Apr – 31 Mar). Dates are read in the shop's
 * time zone — NOT the server's — so "daily" restarts at the shop's midnight.
 */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const MONTH_SHORT = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

const fmtCache = new Map();
function partsIn(iso, timeZone) {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    fmtCache.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month) - 1, d: Number(p.day) };
}
const pad = (n) => String(n).padStart(2, '0');

/**
 * The shop's calendar date ('YYYY-MM-DD') for a moment in time, in the shop's time zone.
 * Use this for anything filed "by day" (cash count, daily summary) — never the UTC date.
 * Fixes docs/KNOWN-ISSUES.md #1 (prototype saved the 2 am cash count under yesterday).
 */
export function businessDate(iso, timeZone = DEFAULT_TIMEZONE) {
  const p = partsIn(iso, timeZone);
  return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
}
const fyStart = ({ y, m }) => (m >= 3 ? y : y - 1);

/** Which counter a slip belongs to, e.g. '2026-09-22' (daily), '2026-09' (monthly), '2026-2027' (yearly). */
export function slipKeyFor(scheme, iso, timeZone = DEFAULT_TIMEZONE) {
  const p = partsIn(iso, timeZone);
  if (scheme === 'daily') return `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
  if (scheme === 'monthly') return `${p.y}-${pad(p.m + 1)}`;
  if (scheme === 'yearly') { const y = fyStart(p); return `${y}-${y + 1}`; }
  return 'all';
}

/** The date tag shown in front of the number, e.g. '22Sep', 'Sep26', 'FY26-27'. */
export function slipTagFor(scheme, iso, timeZone = DEFAULT_TIMEZONE) {
  const p = partsIn(iso, timeZone);
  const mon = MONTH_SHORT[p.m];
  if (scheme === 'daily') return `${p.d}${mon}`;
  if (scheme === 'monthly') return mon + String(p.y).slice(-2);
  if (scheme === 'yearly') { const y = fyStart(p); return `FY${String(y).slice(-2)}-${String(y + 1).slice(-2)}`; }
  return '';
}

export function formatSlipNo(scheme, iso, n, timeZone = DEFAULT_TIMEZONE) {
  const tag = slipTagFor(scheme, iso, timeZone);
  return tag ? `${tag}-${n}` : String(n);
}

/**
 * The slip number a new order gets. Pure: returns the counter change instead of
 * making it — the backend applies it atomically so two phones can't get the same number.
 * 'never' mirrors the order's permanent internal number, exactly like the prototype.
 */
export function nextSlip({ scheme = 'never', iso, counters = {}, internalNo, timeZone = DEFAULT_TIMEZONE }) {
  if (scheme === 'never') return { slipNo: String(internalNo), counterKey: null, counterValue: null };
  const key = slipKeyFor(scheme, iso, timeZone);
  const n = (counters[key] || 0) + 1;
  return { slipNo: formatSlipNo(scheme, iso, n, timeZone), counterKey: key, counterValue: n };
}
