/** Money/weight rounding used everywhere. Identical to the prototype's r2(). */
export const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
