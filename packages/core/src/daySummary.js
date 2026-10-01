import { r2 } from './round.js';

const sum = (xs, f = (x) => x) => r2(xs.reduce((a, x) => a + Number(f(x) || 0), 0));
const ADVANCE_KINDS = ['advance', 'refund', 'transfer'];
const MODES = ['Cash', 'UPI', 'Bank', 'Cheque'];

/**
 * The owner's evening summary for one shop day, from that day's data (already filtered to what the
 * person may see — no no-bill figures without that permission).
 *
 * orders:   slips finished that day  [{ id, slipNo, customer, bill: 'pakka'|'kacha', total, weight, inKhata, by,
 *             items: [{ grade, rate, stdRate, special }], payments: [{ amount, kind, mode }] }]
 * payments: money moved that day     [{ amount, kind, rev, mode, customer, orderId }]   (mode 'Adjust' = moved, not money;
 *           a correction (rev) carries the kind of the payment it corrects)
 * cashClose: the day's cash count    { expected, counted, by, at } | null
 * weighed:  items weighed that day   [{ slipNo, grade, expected, actual }]  (expected = weight worked out from the size)
 * waiting:  weighed before this day, not picked up [{ slipNo, customer }]
 * cancelled: [{ slipNo, customer, reason }]
 * deleted:  slips deleted that day [{ slipNo, customer, reason, by }]
 * stock:    { groups: [{ code, shape, kg, lowKg, negative }], noStock: [slip numbers sold without stock], … } | null
 * reminders: customers who should get a reminder [{ name, due, days }]
 * toReceive: everything customers owe right now (khata)
 * lastWeek: { total, n } for the same weekday a week earlier
 */
export function daySummary({
  orders = [], payments = [], cashClose = null, weighed = [], waiting = [], cancelled = [], deleted = [], reminders = [], stock = null,
  toReceive = 0, lastWeek = null, weightWarnPct = 5, isToday = false,
}) {
  // ---- sales: slips finished today
  const slips = orders.map((o) => {
    // (a correction carries the kind of the payment it corrects, as in the khata)
    const adv = sum(o.payments.filter((p) => ADVANCE_KINDS.includes(p.kind)), (p) => p.amount);
    const pick = sum(o.payments.filter((p) => p.kind === 'pickup'), (p) => p.amount);
    const toKhata = o.inKhata ? r2(Math.max(0, Number(o.total) - adv - pick)) : 0;
    return { id: o.id, no: o.slipNo, customer: o.customer, bill: o.bill, weight: Number(o.weight || 0), total: r2(Number(o.total)), advance: adv, pickup: pick, toKhata };
  });
  const bills = (b) => slips.filter((s) => s.bill === b);
  const sales = {
    total: sum(slips, (s) => s.total), n: slips.length, kg: r2(sum(slips, (s) => s.weight)),
    pakka: { total: sum(bills('pakka'), (s) => s.total), n: bills('pakka').length },
    kacha: { total: sum(bills('kacha'), (s) => s.total), n: bills('kacha').length },
    // where today's slips went: paid at pickup + advance taken earlier + into khata (+ any extra kept on the slip)
    pickup: sum(slips, (s) => s.pickup), advance: sum(slips, (s) => s.advance), toKhata: sum(slips, (s) => s.toKhata),
  };
  sales.extra = r2(sales.total - sales.pickup - sales.advance - sales.toKhata); // negative = paid more than the slips
  if (lastWeek && lastWeek.total > 0) sales.vsLastWeek = Math.round(((sales.total - lastWeek.total) / lastWeek.total) * 100);

  // ---- money that came in (or went out) today
  const real = payments.filter((p) => p.mode !== 'Adjust');
  const byMode = Object.fromEntries(MODES.map((m) => [m, sum(real.filter((p) => p.mode === m), (p) => p.amount)]));
  const money = {
    total: sum(real, (p) => p.amount), byMode,
    list: real.map((p) => ({ at: p.at || null, customer: p.customer || '', kind: p.kind, rev: !!p.rev, mode: p.mode, amount: r2(Number(p.amount)) })),
    pickup: sum(real.filter((p) => p.kind === 'pickup'), (p) => p.amount),
    advances: sum(real.filter((p) => p.kind === 'advance'), (p) => p.amount),
    oldDues: sum(real.filter((p) => p.kind === 'khata'), (p) => p.amount),
    out: sum(real.filter((p) => p.amount < 0), (p) => -p.amount),
  };

  // ---- cash drawer
  const cash = { expected: byMode.Cash, counted: cashClose ? r2(Number(cashClose.counted)) : null, by: cashClose?.by || null, at: cashClose?.at || null };
  cash.diff = cash.counted == null ? null : r2(cash.counted - cash.expected);

  // ---- khata
  const khata = { newDues: sales.toKhata, collected: money.oldDues, toReceive: r2(toReceive) };

  // ---- things that need a look (most important first)
  const look = [];
  if (cash.diff != null && cash.diff !== 0) look.push({ type: cash.diff < 0 ? 'cash_short' : 'cash_over', amount: Math.abs(cash.diff) });
  if (cash.diff == null && !isToday && cash.expected !== 0) look.push({ type: 'cash_not_counted', amount: cash.expected });
  for (const o of orders) {
    for (const it of o.items || []) {
      if (!it.special && it.stdRate != null && Number(it.rate) < Number(it.stdRate)) {
        look.push({ type: 'rate', slipNo: o.slipNo, orderId: o.id, customer: o.customer, grade: it.grade, rate: Number(it.rate), std: Number(it.stdRate), by: o.by || null });
      }
    }
  }
  for (const w of weighed) {
    if (!(w.expected > 0) || !(w.actual > 0)) continue;
    const pct = Math.round(((w.actual - w.expected) / w.expected) * 100);
    if (Math.abs(w.actual - w.expected) / w.expected > weightWarnPct / 100) look.push({ type: 'weight', slipNo: w.slipNo, grade: w.grade, actual: r2(w.actual), expected: r2(w.expected), pct });
  }
  for (const c of [...cancelled]) look.push({ type: 'cancelled', slipNo: c.slipNo, customer: c.customer, reason: c.reason || '' });
  for (const d of [...deleted]) look.push({ type: 'deleted', slipNo: d.slipNo, customer: d.customer, reason: d.reason || '', by: d.by || null });
  // stock below zero first (sold more than the app knew about), then stock running low
  for (const g of stock?.groups || []) if (g.negative) look.push({ type: 'stock_negative', code: g.code, shape: g.shape || null, kg: r2(g.kg) });
  for (const g of stock?.groups || []) {
    if (!g.negative && g.lowKg != null && g.kg < g.lowKg) look.push({ type: 'stock_low', code: g.code, shape: g.shape || null, kg: r2(g.kg), lowKg: r2(g.lowKg) });
  }
  if (stock?.noStock?.length) look.push({ type: 'no_stock', n: stock.noStock.length, slips: stock.noStock.slice(0, 5) });
  for (const p of real.filter((x) => x.amount < 0 && x.kind === 'refund' && !x.rev)) look.push({ type: 'money_out', customer: p.customer, amount: -p.amount, mode: p.mode });
  for (const r of [...reminders].sort((a, b) => b.due - a.due).slice(0, 3)) look.push({ type: 'overdue', customer: r.name, amount: r2(r.due), days: r.days });
  if (waiting.length) look.push({ type: 'waiting', n: waiting.length, customers: [...new Set(waiting.map((w) => w.customer))].slice(0, 3) });

  // ---- best customers today
  const byCust = new Map();
  for (const s of slips) {
    const x = byCust.get(s.customer) || { customer: s.customer, total: 0, n: 0, kg: 0 };
    x.total = r2(x.total + s.total); x.n += 1; x.kg = r2(x.kg + s.weight);
    byCust.set(s.customer, x);
  }
  const top = [...byCust.values()].sort((a, b) => b.total - a.total).slice(0, 3);

  return { sales, slips, money, cash, khata, look, top, lastWeek, stock };
}
