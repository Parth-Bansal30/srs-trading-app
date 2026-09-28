/**
 * GST number (GSTIN) check — works offline, no GST portal needed.
 * A GSTIN is 15 characters: 2-digit state code, the 10-character PAN, the entity number,
 * the letter Z, and a check character calculated from the first 14 (catches typing mistakes).
 * Looking up the business NAME needs a paid GST data service — that comes later.
 */

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** State / UT for each GST state code. */
export const GST_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
  '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

/** The check character for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/**
 * Check a typed GST number. Returns
 *   { ok: true, gstin, stateCode, state, pan }  or  { ok: false, reason }
 * reason: 'empty' | 'length' | 'format' | 'state' | 'check' (a typing mistake somewhere).
 */
export function checkGstin(input) {
  const g = String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
  if (!g) return { ok: false, reason: 'empty' };
  if (g.length !== 15) return { ok: false, reason: 'length' };
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return { ok: false, reason: 'format' };
  const stateCode = g.slice(0, 2);
  if (!GST_STATES[stateCode]) return { ok: false, reason: 'state' };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return { ok: false, reason: 'check' };
  return { ok: true, gstin: g, stateCode, state: GST_STATES[stateCode], pan: g.slice(2, 12) };
}
