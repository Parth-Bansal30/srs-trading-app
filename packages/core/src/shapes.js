/** Steel shapes: which sizes they need, volume (mm³) and cut-face area (sq in). */
const PI = Math.PI;
const HEX = Math.sqrt(3) / 2;

export const SHAPES = Object.freeze({
  square: { dims: ['side'], len: true, vol: (d, L) => d[0] * d[0] * L, face: (i) => i[0] * i[0], sides: (d) => [d[0]] },
  round: { dims: ['dia'], len: true, vol: (d, L) => (PI / 4) * d[0] * d[0] * L, face: (i) => (PI / 4) * i[0] * i[0], sides: (d) => [d[0]] },
  flat: { dims: ['width', 'thick'], len: true, vol: (d, L) => d[0] * d[1] * L, face: (i) => i[0] * i[1], sides: (d) => [d[0], d[1]] },
  block: { dims: ['width', 'height'], len: true, vol: (d, L) => d[0] * d[1] * L, face: (i) => i[0] * i[1], sides: (d) => [d[0], d[1]] },
  hex: { dims: ['af'], len: true, vol: (d, L) => HEX * d[0] * d[0] * L, face: (i) => HEX * i[0] * i[0], sides: (d) => [d[0]] },
  // Plate: length × width × thickness; the cut goes across the width, so cut face = width × thickness.
  plate: { dims: ['plen', 'pwid', 'thick'], len: false, vol: (d) => d[0] * d[1] * d[2], face: (i) => i[0] * i[1], sides: (d) => [d[1], d[2]] },
});

export const SHAPE_IDS = Object.freeze(Object.keys(SHAPES));

/** Default densities (kg/m³) by steel family. A shop can override these in settings. */
export const DEFAULT_FAMILY_DENSITY = Object.freeze({ carbon: 7850, alloy: 7850, stainless: 7930, tool: 7700 });

/** A material's own density if set, else its family's. */
export function densityOf(material, familyDensity = DEFAULT_FAMILY_DENSITY) {
  if (!material) return null;
  return material.density ?? familyDensity[material.family] ?? null;
}
