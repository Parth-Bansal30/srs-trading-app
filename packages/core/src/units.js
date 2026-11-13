/** Lengths: typed in mm or inches, stored as typed, converted to mm for maths. */
export const MM_PER_INCH = 25.4;

const FRAC = { '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4', '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8' };
const fracs = (s) => s.replace(/[½¼¾⅛⅜⅝⅞]/g, (c) => FRAC[c]).replace(/\s+/g, ' ').trim();

/**
 * Each number can carry its own unit (13 Nov 2026, Parth: "2 inch thick, 50 mm wide, 10 ft long"): 2in · 2" · 50mm ·
 * 10ft · 10' · 2ft6in · 5cm. A plain number uses the item's unit (mm or inch), exactly as before.
 * Returns { num, unit } — unit null when the value has none of its own.
 */
const FT = '(?:ft|feet|foot|\'|′)';
const IN = '(?:in|inch|inches|"|″)';
export function splitUnit(v) {
  const s = fracs(String(v ?? ''));
  let m = s.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*${FT}\\s*(\\d[\\d ./-]*?)\\s*${IN}?$`, 'i'));
  if (m) return { num: m[1], unit: 'ftin', inch: m[2].trim() };
  m = s.match(new RegExp(`^(.*?)\\s*(mm|cm|${IN.slice(3, -1)}|${FT.slice(3, -1)})$`, 'i'));
  if (m && m[1] !== '') {
    const u = m[2].toLowerCase();
    return { num: m[1].trim(), unit: u === 'mm' ? 'mm' : u === 'cm' ? 'cm' : /^(ft|feet|foot|'|′)$/.test(u) ? 'ft' : 'in' };
  }
  return { num: s, unit: null };
}

/** Sizes may be typed as 2.5, "2 1/2", "2-1/2", "1/2" or "1½" (a unit after it is ignored here). Returns NaN when unreadable. */
export function parseLen(v) {
  if (typeof v === 'number') return v;
  const s = splitUnit(v).num;
  if (!s) return NaN;
  const m = s.match(/^(?:(\d+)[\s-]+)?(\d+)\/(\d+)$/);
  if (m) {
    const den = Number(m[3]);
    return den ? (m[1] ? Number(m[1]) : 0) + Number(m[2]) / den : NaN;
  }
  return Number(s);
}

export const unitOf = (item) => (item && item.unit === 'in' ? 'in' : 'mm');

const MM = { mm: 1, cm: 10, in: MM_PER_INCH, ft: 304.8 };
export const toMm = (v, unit) => {
  if (typeof v === 'number') return unit === 'in' ? v * MM_PER_INCH : v;
  const x = splitUnit(v);
  if (x.unit === 'ftin') return parseLen(x.num) * MM.ft + parseLen(x.inch) * MM.in;
  const n = parseLen(x.num);
  return n * MM[x.unit || (unit === 'in' ? 'in' : 'mm')];
};
/** Does this value carry its own unit? */
export const ownUnit = (v) => splitUnit(v).unit;

const UNIT_MARK = { mm: 'mm', cm: 'cm', in: '"', ft: 'ft' };
const pretty = (num) => String(num).replace(/(\d+) 1\/2$/, '$1½').replace(/^1\/2$/, '½');
/** One value as it should be read: "2\"", "10ft", "2ft 6\"", "300mm" — a plain value gets the item's unit. */
export function valueText(v, unit) {
  const x = splitUnit(v);
  if (x.unit === 'ftin') return `${pretty(x.num)}ft ${pretty(x.inch)}"`;
  const u = x.unit || (unit === 'in' ? 'in' : 'mm');
  return `${pretty(x.num)}${UNIT_MARK[u]}`;
}
/** The size of an item: "40 × 20 mm" (as before), or with each number's own unit "2\" × 50 mm". */
export function sizeText(dims, unit) {
  const d = (dims || []).filter((x) => x !== '' && x != null);
  if (!d.some((x) => splitUnit(x).unit)) return `${d.join(' × ')}${unit === 'in' ? '"' : ' mm'}`;
  return d.map((x) => valueText(x, unit).replace(/(\d)(mm|cm|ft)$/, '$1 $2')).join(' × ');
}
/** A cut length: "300mm", "12\"" (as before), "10ft", "2ft 6\"". */
export const lenText = (len, unit) => valueText(len, unit);

/** Convert a typed length between units for display (mm keeps 2 decimals, inches 3). */
export function convLen(v, from, to) {
  if (from === to || v === '' || v == null) return v;
  if (splitUnit(v).unit) return v;   // a number with its own unit stays as it is
  const n = parseLen(v);
  if (!(n >= 0)) return v;
  const mm = from === 'in' ? n * MM_PER_INCH : n;
  return to === 'in' ? String(+(mm / MM_PER_INCH).toFixed(3)) : String(+mm.toFixed(2));
}

/**
 * Cutting-charge inch rounding: exact mm→inch, then nearest whole inch
 * (3.5 and above goes up). `minInch` (a shop setting) sets a floor per side.
 */
export function inchOf(mm, minInch = 0) {
  let x = Math.floor(mm / MM_PER_INCH + 0.5 + 1e-9);
  const m = Number(minInch) || 0;
  if (m > 0) x = Math.max(x, m);
  return x;
}
