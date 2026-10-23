import { checkGstin } from './gstin.js';

/**
 * Is a supplier's GST number active? (owner decision 23 Oct 2026)
 * GST paid on a bill from a cancelled, suspended or made-up GST number is not allowed back to the buyer —
 * a known trap in steel ("fake GST bills"). These rules read a GST data service's answer and say what to warn.
 */

export const GST_STATUSES = Object.freeze(['active', 'cancelled', 'suspended', 'inactive', 'not_found']);
/** The official "Search Taxpayer" page on the GST portal (a person can check there for free). */
export const GST_PORTAL_SEARCH = 'https://services.gst.gov.in/services/searchtp';

/** "Active", "Cancelled suo-moto", "ACT", "Suspended", "Inactive" … → our status. */
export function gstStatusWord(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^(act|active|provisional)\b/.test(s) || s === 'a') return 'active';
  if (s.includes('cancel') || s === 'cnl') return 'cancelled';
  if (s.includes('suspend')) return 'suspended';
  if (s.includes('inactive') || s.includes('in-active') || s.includes('not active')) return 'inactive';
  if (s.includes('not found') || s.includes('invalid') || s.includes('no record')) return 'not_found';
  return null;
}

/** "12/08/2026" (portal), "2026-08-12", "12-08-2026" → "2026-08-12"; anything else → null. */
export function gstDate(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

/**
 * A GST data service's answer → { status, legalName, tradeName, regDate, cancelDate, taxpayerType } (or null when it can't be read).
 * Understands the GST portal's own fields (sts, lgnm, tradeNam, rgdt, cxdt, dty — what most services pass on, often inside
 * data / data.data / result) and common names (registration_status / gstin_status, legal_name, trade_name, …).
 */
export function readGstAnswer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const layers = [raw, raw.data, raw.data?.data, raw.result, raw.result?.data, raw.taxpayerInfo, raw.data?.taxpayerInfo].filter((x) => x && typeof x === 'object');
  const pick = (...names) => {
    for (const l of layers) for (const n of names) if (l[n] != null && l[n] !== '') return l[n];
    return null;
  };
  const notFound = layers.some((l) => /not\s*found|invalid gstin|no record/i.test(String(l.message || l.error || l.msg || '')))
    || /^(INVALID_GSTIN|GSTIN_NOT_FOUND|NOT_FOUND)$/i.test(String(pick('error_code', 'errorCode', 'code') || ''));
  const status = gstStatusWord(pick('sts', 'status_of_gstin', 'gstin_status', 'gst_in_status', 'registration_status', 'taxpayer_status', 'gstinStatus', 'status'))
    || (notFound ? 'not_found' : null);
  if (!status) return null;
  const txt = (v) => (v == null ? null : String(v).trim().slice(0, 200) || null);
  return {
    status,
    legalName: txt(pick('lgnm', 'legal_name', 'legal_name_of_business', 'legalName', 'legal_business_name')),
    tradeName: txt(pick('tradeNam', 'trade_name', 'trade_name_of_business', 'tradeName')),
    regDate: gstDate(pick('rgdt', 'registration_date', 'date_of_registration', 'regDate')),
    cancelDate: gstDate(pick('cxdt', 'cancellation_date', 'date_of_cancellation', 'cancelDate')),
    taxpayerType: txt(pick('dty', 'taxpayer_type', 'taxpayerType'))?.slice(0, 60) || null,
  };
}

const NAME_NOISE = /\b(m\/?s|messrs|the|and|&|pvt|private|ltd|limited|llp|co|company|corporation|corp|inc|india|enterprises?|industries|industry|traders?|trading|steels?|steel|metals?|works|mills?|rolling|sons?)\b/g;
/** Two business names that are clearly the same firm (ignoring M/s, Pvt Ltd, "Steels", spaces and dots)? */
export function sameFirm(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[.,()'"-]/g, ' ').replace(NAME_NOISE, ' ').replace(/[^a-z0-9]/g, '');
  const x = norm(a); const y = norm(b);
  if (!x || !y) return true; // nothing to compare
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * What to warn about a supplier's GST number on a bill (warn only — the person decides).
 * gst: the supplier's last check { status, checkedAt, cancelDate, legalName, tradeName } (or null = never checked)
 * bill: { gstin, billDate, supplierName, billType }   now: ISO time (for "checked long ago")
 * Returns [{ key, type, level: 'bad' | 'warn' | 'info', … }].
 *   gst_cancelled / gst_suspended / gst_inactive / gst_not_found (bad) — bill_after_cancel adds the bill date
 *   gst_name (warn) — the GST record's name is a different firm
 *   gst_unchecked (info) — never checked;  gst_old (info) — last checked more than 30 days ago
 */
export function supplierGstWarnings(gst, bill = {}, now = new Date().toISOString()) {
  const out = [];
  if (bill.billType === 'kacha') return out;
  const g = checkGstin(bill.gstin);
  if (!g.ok) return out; // typing mistakes have their own check
  if (!gst || !gst.status) {
    out.push({ key: `gst_unchecked:${g.gstin}`, type: 'gst_unchecked', level: 'info', gstin: g.gstin });
    return out;
  }
  if (gst.status !== 'active') {
    const afterCancel = !!(gst.cancelDate && bill.billDate && String(bill.billDate) >= String(gst.cancelDate));
    out.push({ key: `gst_${gst.status}:${g.gstin}`, type: `gst_${gst.status}`, level: 'bad', gstin: g.gstin, cancelDate: gst.cancelDate || null,
      afterCancel, checkedAt: gst.checkedAt || null, source: gst.source || null });
  } else if (gst.checkedAt && Date.parse(now) - Date.parse(gst.checkedAt) > 30 * 86400000) {
    out.push({ key: `gst_old:${g.gstin}`, type: 'gst_old', level: 'info', gstin: g.gstin, checkedAt: gst.checkedAt });
  }
  const names = [gst.legalName, gst.tradeName].filter(Boolean);
  if (bill.supplierName && names.length && !names.some((n) => sameFirm(bill.supplierName, n))) {
    out.push({ key: `gst_name:${g.gstin}`, type: 'gst_name', level: 'warn', gstin: g.gstin, legalName: gst.legalName || null, tradeName: gst.tradeName || null });
  }
  return out;
}
