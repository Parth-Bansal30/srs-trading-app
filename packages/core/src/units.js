/** Lengths: typed in mm or inches, stored as typed, converted to mm for maths. */
export const MM_PER_INCH = 25.4;

/** Sizes may be typed as 2.5, "2 1/2", "2-1/2" or "1/2". Returns NaN when unreadable. */
export function parseLen(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  const m = s.match(/^(?:(\d+)[\s-]+)?(\d+)\/(\d+)$/);
  if (m) {
    const den = Number(m[3]);
    return den ? (m[1] ? Number(m[1]) : 0) + Number(m[2]) / den : NaN;
  }
  return Number(s);
}

export const unitOf = (item) => (item && item.unit === 'in' ? 'in' : 'mm');

export const toMm = (v, unit) => {
  const n = parseLen(v);
  return unit === 'in' ? n * MM_PER_INCH : n;
};

/** Convert a typed length between units for display (mm keeps 2 decimals, inches 3). */
export function convLen(v, from, to) {
  if (from === to || v === '' || v == null) return v;
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
