// What a search means (26 Oct 2026, pure — tested in apps/web/test/search.test.mjs).
//   "Sharma"        → customers named Sharma (and their slips)
//   "#553" / "553"  → slip 553 (a plain number is also tried as an amount)
//   "32 EN8"        → grade EN8, size 32 (stock + slips with it)
//   "5000" / "₹5,000" → payments, slips, bills and expenses of ₹5,000
//   "98100 00001"   → the customer with that phone

/** Letters and digits only, lower case ("EN-8" → "en8"). */
export const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * q + the shop's grades [{ id, code }] → { slip, amount, phone, digits, grade, dims, words } (null when q is empty).
 * slip: a slip number to look up · amount: rupees · phone: 10 digits · digits: 4+ digits to find in phone numbers ·
 * grade: the grade's id · dims: sizes typed with a grade ("32", "40x20" → ["40", "20"]) · words: everything else.
 */
export function parseSearch(q, grades = []) {
  const s = String(q || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const byCode = new Map(grades.filter((g) => g?.code).map((g) => [squash(g.code), g.id]));
  const out = { slip: null, amount: null, phone: null, digits: null, grade: null, dims: [], words: [] };
  const bare = [];   // plain numbers: a slip number, an amount — or a size when a grade is there too
  // a phone number typed with a space ("98100 00001")
  const joined = s.replace(/[\s-]/g, '');
  if (/^(\+?91)?[6-9]\d{9}$/.test(joined)) { out.phone = joined.slice(-10); out.digits = out.phone; return out; }
  for (const tok of s.split(' ')) {
    let m;
    if ((m = tok.match(/^#\s*([A-Za-z]?\d[\w-]{0,15})$/))) { out.slip = m[1]; continue; }
    if ((m = tok.match(/^(?:₹|rs\.?)\s*([\d,]+(?:\.\d{1,2})?)$/i)) || (m = tok.match(/^(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?)$/))) {
      out.amount = Number(m[1].replace(/,/g, '')); continue;
    }
    if ((m = tok.match(/^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?))?$/i))) { out.dims = m.slice(1).filter(Boolean); continue; }
    if (/^\d+(\.\d+)?$/.test(tok)) { bare.push(tok); continue; }
    const g = byCode.get(squash(tok));
    if (g && !out.grade) { out.grade = g; continue; }
    out.words.push(tok.toLowerCase());
  }
  if (out.grade) {
    if (!out.dims.length) out.dims = bare.slice(0, 3);   // "32 EN8" → size 32
  } else {
    const n = bare[0];
    if (n) {
      if (!out.slip && n.length <= 6 && !n.includes('.')) out.slip = n;
      if (out.amount == null) out.amount = Number(n);
      if (n.length >= 4 && !n.includes('.')) out.digits = n;
    }
  }
  return out;
}

/** Does a customer fit the words / phone digits? (every word somewhere in the name) */
export function customerFits(c, p) {
  if (!c || !p) return false;
  const name = String(c.name || '').toLowerCase();
  const phone = String(c.phone || '').replace(/\D/g, '');
  if (p.phone) return phone.endsWith(p.phone);
  const byWords = p.words.length > 0 && p.words.every((w) => name.includes(w));
  const byDigits = !!p.digits && phone.includes(p.digits);
  return byWords || byDigits;
}

/** Best first: a name that starts with the first word, then the rest by name. */
export function rankCustomers(list, p) {
  const w = p?.words?.[0] || '';
  return [...list].sort((a, b) => {
    const as = String(a.name || '').toLowerCase().startsWith(w) ? 0 : 1;
    const bs = String(b.name || '').toLowerCase().startsWith(w) ? 0 : 1;
    return as - bs || String(a.name).localeCompare(String(b.name));
  });
}
