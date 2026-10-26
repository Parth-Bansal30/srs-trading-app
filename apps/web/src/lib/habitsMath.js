// What this shop usually does (26 Oct 2026, pure — tested in apps/web/test/habits.test.mjs): the regular customers, the usual
// sizes and cut lengths of a grade, and turning a customer's last order into new order items ("Same as last time").

/** Customers with the most slips (from rows [{ customer_id }]), at least `min` slips. → [{ id, n }] best first. */
export function topCustomers(rows, { limit = 6, min = 2 } = {}) {
  const n = new Map();
  for (const r of rows || []) if (r?.customer_id) n.set(r.customer_id, (n.get(r.customer_id) || 0) + 1);
  return [...n.entries()].filter(([, k]) => k >= min).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id, k]) => ({ id, n: k }));
}

const cleanNum = (v) => String(v ?? '').trim().replace(/\.0+$/, '');
const sizeKey = (dims) => (dims || []).map(cleanNum).join('×');

/**
 * The usual sizes and cut lengths of one grade + shape (+ unit) from recent order items
 * [{ material_id, shape, unit, dims, order_item_lengths: [{ len }] }]. → { sizes: [['32'], ['40', '20']], lengths: ['500', '1000'] }
 * (most used first, at least twice, up to `limit`). With dims given, the lengths are those used with that size when there are any.
 */
export function usualFor(items, materialId, shape, unit, { dims = null, limit = 5 } = {}) {
  const same = (items || []).filter((i) => i && i.material_id === materialId && i.shape === shape && (!unit || (i.unit || 'mm') === unit));
  const sizes = new Map();
  for (const i of same) {
    const k = sizeKey(i.dims);
    if (!k) continue;
    const s = sizes.get(k) || { dims: (i.dims || []).map(cleanNum), n: 0 };
    s.n++; sizes.set(k, s);
  }
  const want = dims && dims.some((d) => cleanNum(d)) ? sizeKey(dims) : null;
  const lenFrom = (list) => {
    const m = new Map();
    for (const i of list) for (const l of i.order_item_lengths || []) { const v = cleanNum(l.len); if (v && Number(v) > 0) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0])).slice(0, limit).map(([v]) => v);
  };
  let lengths = want ? lenFrom(same.filter((i) => sizeKey(i.dims) === want)) : [];
  if (!lengths.length) lengths = lenFrom(same);
  return {
    sizes: [...sizes.values()].filter((s) => s.n >= 2).sort((a, b) => b.n - a.n).slice(0, limit).map((s) => s.dims),
    lengths,
  };
}

/**
 * A customer's last order → new order items, at TODAY's rates (rate / cut rate left empty so the current rate or the
 * customer's special rate applies). key: a function giving each item a fresh key.
 */
export function repeatItems(order, key = () => Math.random().toString(36).slice(2)) {
  return [...(order?.order_items || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((i) => ({
    key: key(), material_id: i.material_id, shape: i.shape, unit: i.unit || 'mm', d: (i.dims || []).map(String),
    rows: [...(i.order_item_lengths || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((l) => ({ len: l.len == null ? '' : String(l.len), pcs: String(l.pcs ?? ''), cuts: l.cuts == null ? '' : String(l.cuts) })),
    rate: null, cut_rate: null,
  }));
}

/** "EN8 32 round · 4×500" — a short line for each item of the last order. codeOf: material id → code. */
export function orderSummary(order, codeOf, shapeWord = (s) => s) {
  return [...(order?.order_items || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((i) => {
    const lens = [...(i.order_item_lengths || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((l) => (l.len ? `${l.pcs}×${cleanNum(l.len)}` : `${l.pcs}`)).join(', ');
    return `${codeOf(i.material_id) || '?'} ${sizeKey(i.dims)} ${shapeWord(i.shape)}${lens ? ` · ${lens}` : ''}`.replace(/\s+/g, ' ').trim();
  });
}
