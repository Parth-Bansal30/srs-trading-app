/**
 * "Weigh together": one scale reading for several items of the SAME grade,
 * split by each item's expected weight. Returns the weight for each item.
 */
export function splitBatchWeight(expectedWeights, totalWeight) {
  const n = expectedWeights.length;
  const totalEst = expectedWeights.reduce((a, b) => a + b, 0);
  return expectedWeights.map((e) => {
    const share = totalEst > 0 ? e / totalEst : 1 / n;
    return Math.round(totalWeight * share * 100) / 100;
  });
}

/** Only items of the exact same grade may be weighed together. */
export const canWeighTogether = (items) => items.length > 0 && items.every((it) => it.matId === items[0].matId);

/** How far the actual weight is from the expected weight, in percent. */
export const weightDeviationPct = (expected, actual) => (Math.abs(actual - expected) / expected) * 100;
