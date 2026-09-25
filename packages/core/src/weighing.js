/**
 * "Weigh together": one scale reading for several items of the SAME grade,
 * split by each item's expected weight. Returns the weight for each item (kg, 2 decimals).
 *
 * Guarantees (approved by the owner, 25 Sept 2026 — see docs/KNOWN-ISSUES.md #2):
 *  - the parts always add up to exactly the scale reading (to 0.01 kg), and
 *  - every part is within 0.01 kg of its exact share, however many items are in the batch.
 * Method: work in 10-gram units, round every share down, then hand out the leftover
 * 10 g units one each to the shares that were rounded down the most.
 * (The prototype rounded each share on its own, so parts could miss the reading by 0.01+ kg.)
 */
export function splitBatchWeight(expectedWeights, totalWeight) {
  const n = expectedWeights.length;
  if (!n) return [];
  const totalEst = expectedWeights.reduce((a, b) => a + b, 0);
  const units = Math.round(Number(totalWeight) * 100);
  const exact = expectedWeights.map((e) => (totalEst > 0 ? e / totalEst : 1 / n) * units);
  const parts = exact.map((x) => Math.floor(x + 1e-9));
  let left = units - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - parts[i], est: expectedWeights[i] }))
    .sort((a, b) => b.frac - a.frac || b.est - a.est || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % n, left--) parts[order[k].i] += 1;
  return parts.map((u) => u / 100);
}

/** Only items of the exact same grade may be weighed together. */
export const canWeighTogether = (items) => items.length > 0 && items.every((it) => it.matId === items[0].matId);

/** How far the actual weight is from the expected weight, in percent. */
export const weightDeviationPct = (expected, actual) => (Math.abs(actual - expected) / expected) * 100;
