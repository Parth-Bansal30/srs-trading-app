// Small text fixes found walking through a whole shop day (26 Oct 2026). Pure — no app imports, so tests can load it.

/** "1 items", "1 slips", "1 customers"… → "1 item". English and Hinglish words only; Hindi has no plural -s. Used by t(). */
const ONE = /(^|[^\d.,])1 (item|slip|customer|cut|payment|estimate|bill|piece|day|entry|account|line|reminder|grade|supplier)s\b/g;
export const one = (s) => s.replace(ONE, '$11 $2').replace(/(^|[^\d.,])1 people\b/g, '$11 person')
  .replace(/(^|[^\d.,])1 (payment|GST) (reminder|bill)s\b/g, '$11 $2 $3');

/** An Indian mobile as people say it: "+919000000013" → "90000 00013". Anything else stays as written. */
export function phoneText(p) {
  const d = String(p || '').replace(/[^\d]/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return ten.length === 10 ? `${ten.slice(0, 5)} ${ten.slice(5)}` : String(p || '');
}
