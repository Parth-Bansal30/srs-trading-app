// Same customer twice, and joining two customers (5 Nov 2026, plan v2 F9).
// While a customer is added, the app looks for one already in the khata with the same phone (last 10 digits) or a
// very similar name, and asks — it never decides. Joining two customers moves the balances with linked entries
// (the old one goes to ₹0, the kept one gets the same amounts); old slips and payments are never moved.
import { r2 } from './round.js';

/** The last 10 digits of a phone number ('' when fewer than 10). */
export const phone10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };

// spelling that doesn't make a different business
const SAME_WORD = [
  [/^(engineering|engineers|engineer|engg|eng|engg\.)$/, 'eng'],
  [/^(traders|trader|trading|trdg)$/, 'trd'],
  [/^(steels|steel)$/, 'steel'],
  [/^(enterprises|enterprise|ent|entp)$/, 'ent'],
  [/^(industries|industry|inds|ind)$/, 'ind'],
  [/^(brothers|bros|bro)$/, 'bros'],
  [/^(works|work)$/, 'works'],
  [/^(tools|tool)$/, 'tools'],
];
const NOISE = new Set(['m', 's', 'ms', 'and', 'the', 'co', 'company', 'pvt', 'private', 'ltd', 'limited', 'llp', 'firm', 'shop']);

/** "M/s. Sharma Engg. & Co." → "sharma eng" */
export function normName(s) {
  const words = String(s || '').toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.map((w) => { const hit = SAME_WORD.find(([re]) => re.test(w)); return hit ? hit[1] : w; }).filter((w) => !NOISE.has(w)).join(' ');
}

/** Edit distance (small strings only). */
export function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Are two names very similar? (same after cleaning, a small typo, or one is the other plus extra words) */
export function similarNames(a, b) {
  const x = normName(a); const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = Math.min(x.length, y.length);
  if (shorter >= 6 && editDistance(x, y) <= (shorter >= 12 ? 2 : 1)) return true;
  const tx = x.split(' '); const ty = y.split(' ');
  const [small, big] = tx.length <= ty.length ? [tx, ty] : [ty, tx];
  if (small.length === big.length) return false;
  const inBig = small.every((w) => big.includes(w));
  return inBig && (small.length >= 2 || small[0].length >= 5);
}

/**
 * Customers that may be the same as the one being added.
 * list: [{ id, name, phone, active, joined_into }]; who: { name, phone }; notSame: ids the person already said are different.
 * Returns [{ c, why: 'phone' | 'name', strong }] — phone matches first (strong), then names (a softer warning).
 */
export function similarCustomers(list, who, notSame = []) {
  const skip = new Set(notSame);
  const ph = phone10(who?.phone);
  const out = [];
  for (const c of list || []) {
    if (!c || skip.has(c.id) || c.joined_into || c.active === false) continue;
    if (ph && phone10(c.phone) === ph) out.push({ c, why: 'phone', strong: true });
    else if (similarNames(who?.name, c.name)) out.push({ c, why: 'name', strong: false });
  }
  return out.sort((p, q) => Number(q.strong) - Number(p.strong)).slice(0, 5);
}

/**
 * What a join moves, side by side, from the two khatas (customerLedger bySide: { side: { due, adv } }).
 * The old customer's due on a side moves as a due; money it has with us (extra paid) moves as a credit.
 * Returns { moves: [{ side, kind: 'due' | 'credit', amount }], before: { kept, old }, after: { kept, old } }.
 */
export function joinPlan(keptBySide = {}, oldBySide = {}) {
  const sides = [...new Set([...Object.keys(keptBySide), ...Object.keys(oldBySide)])].sort();
  const moves = [];
  const after = { kept: {}, old: {} };
  for (const s of sides) {
    const k = { due: r2(Number(keptBySide[s]?.due) || 0), adv: r2(Number(keptBySide[s]?.adv) || 0) };
    const o = { due: r2(Number(oldBySide[s]?.due) || 0), adv: r2(Number(oldBySide[s]?.adv) || 0) };
    if (o.due > 0) moves.push({ side: s, kind: 'due', amount: o.due });
    if (o.adv > 0) moves.push({ side: s, kind: 'credit', amount: o.adv });
    // the kept customer's own bills use its credit first, exactly as the khata does it
    let due = r2(k.due + o.due); let adv = r2(k.adv + o.adv);
    const use = Math.min(due, adv); due = r2(due - use); adv = r2(adv - use);
    after.kept[s] = { due, adv };
    after.old[s] = { due: 0, adv: 0 };
  }
  return { moves, before: { kept: keptBySide, old: oldBySide }, after };
}
