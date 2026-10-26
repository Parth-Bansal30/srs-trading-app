// The business operations behind the "api" Edge Function.
//
// Plain JavaScript with NO imports: everything it needs is passed in (the @srs/core rules,
// a database caller, the AI caller). That keeps it runnable in Deno (Edge Function) and in
// Node (tests) exactly the same way.
//
// Pattern for every change:  check the input → do the steel maths with @srs/core →
// hand the result to ONE database function (public.api_*) that re-checks permissions and
// company, and saves everything in one all-or-nothing step, remembering the request key.

export const API_VERSION = 1;
export const SUPPORTED_VERSIONS = [1];

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const bad = (message, code = 'invalid') => new ApiError(400, code, message);
const forbidden = (perm) => new ApiError(403, 'not_allowed', `You don't have permission for this (${perm}).`);

const PAY_METHODS = ['Cash', 'UPI', 'Bank', 'Cheque'];
const BILLS = ['pakka', 'kacha'];
const PAY_MODES = ['now', 'later', 'part'];
const LANG_NAMES = { en: 'simple English', hi: 'simple Hindi in Devanagari script', hn: 'Hinglish (Hindi written in English letters)' };
const FAMILY_NAMES = { carbon: 'Carbon steel', alloy: 'Alloy steel', stainless: 'Stainless steel', tool: 'Tool steel' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v) => typeof v === 'string' && UUID.test(v);
const uuid = (v, message) => { if (!isUuid(v)) throw bad(message); return v; };
const text = (v, max = 500) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s.length > max) throw bad(`Text is too long (max ${max} characters).`);
  return s || null;
};
/** A positive rupee amount, rounded to paise. */
const amount = (v, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw bad(`Enter the ${what}.`);
  return Math.round(n * 100) / 100;
};
const rateValue = (v, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw bad(`Enter a valid ${what}.`);
  return Math.round(n * 100) / 100;
};
const kg = (v, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e6) throw bad(`Enter the weight for ${what}.`);
  return Math.round(n * 1000) / 1000;
};
const payMethod = (v) => { if (!PAY_METHODS.includes(v)) throw bad('Choose how it was paid (Cash, UPI, Bank or Cheque).'); return v; };
const BANK_METHODS = ['UPI', 'IMPS', 'NEFT', 'RTGS', 'Cheque'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/**
 * When an entry made without internet really happened (23 Oct 2026): the phone sends offline_at (ISO time).
 * The database checks it is not in the future and not too old. null = now.
 */
export function offlineAt(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/.test(s) || Number.isNaN(Date.parse(s))) throw bad('Wrong time on that entry.');
  return new Date(Date.parse(s)).toISOString();
}
/** An expense's day + time: a chosen past day (owners) is that day at noon in the shop's time; offline entries keep their time. */
function entryAt(a) {
  const off = offlineAt(a?.offline_at);
  if (off) return off;
  if (a?.day != null && a.day !== '') {
    if (!DAY.test(a.day) || Number.isNaN(Date.parse(a.day))) throw bad('Choose the day.');
    return `${a.day}T12:00:00+05:30`;
  }
  return null;
}

/**
 * Where the money went (money accounts, 6 Oct 2026). a.parts = a split [{account_id, amount, method}] that must add up
 * to `total`; or a.account_id (+ a.method) = all of it in one account. Neither = the old way (mode only).
 * Returns { parts, account } for api_pay, or null.
 */
function placement(a, total) {
  if (Array.isArray(a?.parts) && a.parts.length) {
    if (a.parts.length > 8) throw bad('Up to 8 accounts for one payment.');
    const parts = a.parts.map((x) => {
      if (!isUuid(x?.account_id)) throw bad('Choose where the money went.');
      const amt = Math.round(Number(x.amount) * 100) / 100;
      if (!(amt > 0) || amt > 1e9) throw bad('Enter the amount for each account.');
      const method = BANK_METHODS.includes(x.method) ? x.method : null;
      return { account_id: x.account_id, amount: amt, ...(method ? { method } : {}) };
    });
    if (new Set(parts.map((x) => x.account_id)).size !== parts.length) throw bad('The same account is in the list twice.');
    const placed = r2(parts.reduce((t, x) => t + x.amount, 0));
    if (total != null && placed !== r2(total)) {
      throw bad(`The accounts add up to ₹${placed}, but the amount is ₹${r2(total)}.`, 'split_differs');
    }
    return { parts, account: null };
  }
  if (a?.account_id != null && a.account_id !== '') {
    if (!isUuid(a.account_id)) throw bad('Choose where the money went.');
    return { parts: null, account: { account_id: a.account_id, ...(BANK_METHODS.includes(a.method) ? { method: a.method } : {}) } };
  }
  return null;
}
/** With an account chosen the mode follows the account (the database sets it), so any mode will do here. */
const modeFor = (v, place) => (place ? (PAY_METHODS.includes(v) ? v : 'Cash') : payMethod(v));
const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;
const LANGS = ['en', 'hi', 'hn'];
const UPI_ID = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,63}$/;
/** Shop header on a customer document. The GST number only goes on GST documents. */
const docShop = (s, gst) => ({ name: s?.name || '', address: s?.address || null, phone: s?.phone || null, city: s?.city || null, gstin: gst ? s?.gstin || null : null });
const docCustomer = (c, gst) => ({ name: c?.name || '', phone: c?.phone || null, address: c?.address || null, gstin: gst ? c?.gstin || null : null });

/** Same JSON for the same data, whatever the key order — used for the request fingerprint. */
export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/**
 * The khata data from api_khata_data in @srs/core's shape. Old-balance corrections are netted out
 * (an entry and its correction disappear together), so the ledger never sees a negative "bill".
 */
export function coreKhataFromDb(k) {
  const reversed = new Set((k.old_dues || []).filter((d) => d.reverses_id).map((d) => d.reverses_id));
  return {
    orders: (k.orders || []).map((o) => ({
      id: o.id, slipNo: o.slip_no, cust: o.customer_id, status: o.status, bill: o.bill, inKhata: o.in_khata,
      billTotal: o.total == null ? null : Number(o.total), doneAt: o.done_at, at: o.created_at,
    })),
    payments: (k.payments || []).map((p) => ({
      id: p.id, cust: p.customer_id, oid: p.order_id, amt: Number(p.amount), mode: p.mode, kind: p.kind, side: p.side, at: p.at, note: p.note,
    })),
    oldDues: (k.old_dues || []).filter((d) => !d.reverses_id && !reversed.has(d.id)).map((d) => ({
      id: d.id, cust: d.customer_id, side: d.side, date: d.date, amt: Number(d.amount), ref: d.ref,
    })),
  };
}

/**
 * Cancelled payments (25 Oct 2026): the payment shows crossed out with the reason, who and when; its cancellation
 * row is marked so the screen can leave it out (together they add up to nothing, so the totals don't change).
 */
export function markCancelled(entries, payments = []) {
  const byId = new Map(payments.map((p) => [p.id, p]));
  const undo = new Map(payments.filter((p) => p.reverses).map((p) => [p.reverses, p]));
  return entries.map((e) => {
    if (e.t !== 'pay' || !e.pid) return e;
    if (byId.get(e.pid)?.reverses) return { ...e, reversal: true };
    const u = undo.get(e.pid);
    return u ? { ...e, cancelled: { reason: u.note || '', by: u.by || null, at: u.at } } : e;
  });
}

/** A database order (from api_order_context / api_weighing_list) in @srs/core's shape. */
export function coreItemFromDb(i) {
  return {
    id: i.id, matId: i.material_id, shape: i.shape, unit: i.unit, d: i.dims,
    rows: (i.lengths || []).map((l) => ({ len: l.len ?? '', pcs: l.pcs, cuts: l.cuts ?? '' })),
    rate: Number(i.sell_rate ?? 0), cutRate: Number(i.cut_rate ?? 0), density: Number(i.density),
    aw: i.actual_weight == null ? null : Number(i.actual_weight),
  };
}

// ---------- stock and purchases ----------
const BILL_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

/** What the AI is asked (reading an Indian steel purchase bill). */
export const BILL_PROMPT = `You read purchase bills (tax invoices) of steel bought by a steel trading shop in India.
Return ONLY one JSON object, no other text, in exactly this shape:
{"supplier":{"name":string|null,"gstin":string|null,"city":string|null,"phone":string|null},
 "bill_no":string|null,"bill_date":"YYYY-MM-DD"|null,"has_gst":boolean,
 "lines":[{"description":string,"hsn":string|null,"qty":number|null,"qty_unit":"kg"|"mt"|"qtl","rate":number|null,"rate_unit":"kg"|"mt"|"qtl","amount":number|null}],
 "freight":number|null,"other_charges":number|null,"cgst":number|null,"sgst":number|null,"igst":number|null,"round_off":number|null,"total":number|null,
 "unsure":[string]}
Rules: one entry in "lines" per item row of the bill (material lines only; freight, loading, packing, TCS go into freight / other_charges).
Numbers without commas or ₹. qty_unit / rate_unit as printed (MT or tonne = "mt", quintal = "qtl", kg = "kg"). The supplier is the SELLER, not the buyer.
Dates as YYYY-MM-DD. If something is missing or unreadable use null. Never guess numbers: put the field in "unsure" instead,
e.g. "lines.0.qty", "bill_no", "total". Do not add any field that is not on the bill.`;

/** The model's answer → a plain object (it may wrap the JSON in ``` fences). */
export function parseBillJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{'); const end = t.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON in the answer');
  return JSON.parse(t.slice(start, end + 1));
}

/** The AI's reading in the app's shape: kg and ₹/kg per line (core.billLine), totals checked (core.billTotals). */
export function normalizeBill(core, x) {
  const n = (v) => (v == null || v === '' || !Number.isFinite(Number(String(v).replace(/[,₹\s]/g, ''))) ? null : Number(String(v).replace(/[,₹\s]/g, '')));
  const unsure = new Set(Array.isArray(x?.unsure) ? x.unsure.map(String) : []);
  const lines = (Array.isArray(x?.lines) ? x.lines : []).slice(0, 100).map((l, i) => {
    const b = core.billLine({ qty: l?.qty, qtyUnit: l?.qty_unit, rate: l?.rate, rateUnit: l?.rate_unit, amount: l?.amount });
    return { description: String(l?.description || '').slice(0, 200), hsn: core.cleanHsn(l?.hsn), qty_kg: b.kg, rate: b.rateKg, amount: b.amount,
      line_ok: b.ok, unsure: ['qty', 'rate', 'amount', 'hsn', 'description'].filter((f) => unsure.has(`lines.${i}.${f}`)) };
  });
  const gst = (n(x?.cgst) || 0) + (n(x?.sgst) || 0) + (n(x?.igst) || 0);
  const out = {
    supplier: { name: x?.supplier?.name ? String(x.supplier.name).slice(0, 120) : null, gstin: x?.supplier?.gstin ? String(x.supplier.gstin).replace(/\s/g, '').toUpperCase().slice(0, 15) : null,
      city: x?.supplier?.city ? String(x.supplier.city).slice(0, 80) : null, phone: x?.supplier?.phone ? String(x.supplier.phone).slice(0, 30) : null },
    bill_no: x?.bill_no ? String(x.bill_no).slice(0, 40) : null,
    bill_date: /^\d{4}-\d{2}-\d{2}$/.test(String(x?.bill_date || '')) ? x.bill_date : null,
    bill_type: x?.has_gst === false && gst === 0 ? 'kacha' : 'pakka',
    freight: n(x?.freight) || 0, other: n(x?.other_charges) || 0, gst: Math.round(gst * 100) / 100, round_off: n(x?.round_off) || 0, total: n(x?.total),
    lines, unsure: [...unsure].filter((f) => !f.startsWith('lines.')),
  };
  out.totals = core.billTotals({ lines, freight: out.freight, other: out.other, gst: out.gst, roundOff: out.round_off, total: out.total });
  return out;
}

/** Stock data in the app's shape, with what is already booked on open orders (expected weight, worked out with core). */
export function stockFromDb(core, raw) {
  const booked = new Map();
  const orders = new Map();
  for (const b of raw.booked || []) {
    const c = core.calcItem({ shape: b.shape, unit: b.unit, d: b.dims, rows: (b.lengths || []).map((l) => ({ len: l.len ?? '', pcs: l.pcs, cuts: l.cuts ?? '' })),
      rate: 0, cutRate: 0, density: Number(b.density) }, 'est', { minInch: b.min_inch ?? 1 });
    const kgv = c ? c.est : 0;
    booked.set(b.stock_item_id, Math.round(((booked.get(b.stock_item_id) || 0) + kgv) * 1000) / 1000);
    orders.set(b.stock_item_id, [...(orders.get(b.stock_item_id) || []), b.slip_no]);
  }
  return {
    can_cost: !!raw.can_cost,
    materials: raw.materials || [],
    items: (raw.items || []).map((it) => {
      const onHand = Number(it.on_hand || 0);
      const bk = booked.get(it.id) || 0;
      return { ...it, on_hand: onHand, booked: bk, free: Math.round((onHand - bk) * 1000) / 1000, booked_slips: [...new Set(orders.get(it.id) || [])] };
    }),
  };
}

/** The day's stock for the evening summary. */
/** A payment's parts from the database → [{ mode, amount }] for @srs/core (null when it has none). */
export const partsFromDb = (pp) => (Array.isArray(pp) && pp.length ? pp.map((x) => ({ mode: x.mode, amount: Number(x.amount) })) : null);

/** api_day_accounts → the evening tally's input (money.js accountTally). */
export function dayAccountsFromDb(d) {
  return {
    list: (d?.accounts || []).map((a) => ({ id: a.id, name: a.name, kind: a.kind, owner: a.owner, isDrawer: !!a.is_drawer, hidden: !!a.hidden })),
    parts: (d?.parts || []).map((x) => ({ accountId: x.account_id, amount: Number(x.amount), mode: x.mode, method: x.method || null,
      paymentId: x.payment_id, kind: x.kind, rev: !!x.rev, customer: x.customer, slipNo: x.slip_no || null, orderId: x.order_id || null, at: x.at })),
    checks: d?.checks || [],
  };
}

export function dayStockFromDb(s) {
  const groups = (s.groups || []).map((g) => ({ code: g.code, shape: g.shape, kg: Number(g.kg || 0), lowKg: g.low_kg == null ? null : Number(g.low_kg),
    value: g.value == null ? null : Number(g.value), negative: !!g.negative }));
  return {
    canCost: !!s.can_cost,
    bought: { n: Number(s.bought?.n || 0), kg: Number(s.bought?.kg || 0), amount: s.bought?.amount == null ? null : Number(s.bought.amount) },
    soldKg: Number(s.sold_kg || 0),
    onHandKg: Math.round(groups.reduce((a, g) => a + Math.max(0, g.kg), 0) * 1000) / 1000,
    value: s.can_cost ? Math.round(groups.reduce((a, g) => a + (g.value || 0), 0) * 100) / 100 : null,
    groups, noStock: s.no_stock || [],
  };
}

/** Show only the last 3 digits of a phone number: +91 ••••• ••321 */
export const maskPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 4) return '';
  return `${d.length > 10 ? `+${d.slice(0, d.length - 10)} ` : ''}••••• ••${d.slice(-3)}`;
};
const DELETE_MONEY = ['none', 'never', 'credit', 'refund'];

/**
 * otp (optional): the one-time SMS code for deleting slips — { send(caller) → { phone }, verify(caller, code) → true/false }.
 * It uses the same SMS as login (Supabase Auth); the api function passes the caller's own login in caller.token.
 */
/**
 * files (optional): the purchase bill files — { save(caller, base64, mime) → key, url(key) → a short-lived link }.
 * readBill (optional): the AI that reads a bill — (base64, mime) → the model's text (JSON as asked in BILL_PROMPT).
 */
export function makeOps({ core, rpc, companySettings, askModel, newKey = () => crypto.randomUUID(), push = null, otp = null, files = null, readBill = null, gstLookup = null }) {
  /** '' clears it; otherwise it must be a correct GST number (typing mistakes are caught). */
  const gstinValue = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return '';
    const g = core.checkGstin(s);
    if (!g.ok) throw bad('That GST number has a mistake. Please check it.');
    return g.gstin;
  };
  const need = (caller, ...perms) => { for (const p of perms) if (!core.can(caller.perms, p)) throw forbidden(p); };
  const orderIds = (v) => {
    const ids = [...new Set(Array.isArray(v) ? v : [])];
    if (!ids.length || ids.length > 50 || !ids.every(isUuid)) throw bad('Choose 1 to 50 slips.');
    return ids;
  };

  /** Customers to ASK about (unpaid slips older than the setting, not reminded recently), from api_khata_data. */
  function remindersFrom(caller, raw, lang) {
    const k = coreKhataFromDb(raw);
    const now = new Date().toISOString();
    const last = new Map((raw.last_reminders || []).map((r) => [`${r.customer_id}:${r.side}`, r.at]));
    const out = [];
    for (const c of raw.customers) {
      for (const side of core.visibleSides(caller.perms)) {
        const due = core.dueSlips({ custId: c.id, side, ...k, now, timeZone: raw.timezone });
        const opts = { afterDays: raw.settings.reminder_after_days, repeatDays: raw.settings.reminder_repeat_days,
          lastReminderAt: last.get(`${c.id}:${side}`) || null, now, timeZone: raw.timezone };
        if (!core.needsReminder(due, opts)) continue;
        out.push({ customer: { id: c.id, name: c.name, phone: c.phone }, side, due: due.due, slips: due.slips,
          oldest_days: due.oldestDays, has_phone: !!core.normalizeIndianMobile(c.phone),
          preview: core.reminderMessage({ lang, shop: raw.shop, customer: c.name, due }) });
      }
    }
    return out.sort((x, y) => y.oldest_days - x.oldest_days);
  }

  /** The phone notification for the evening summary, in the person's language. */
  function eveningNote(d, lang) {
    const L = { en: 0, hi: 1, hn: 2 }[lang] ?? 0;
    const w = (en, hi, hn) => [en, hi, hn][L];
    const m = (v) => `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Math.abs(v)))}`;
    const s = d.summary;
    const [y, mo, dd] = d.day.split('-').map(Number);
    const when = `${dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mo - 1]}`;
    const parts = [w(`Sales ${m(s.sales.total)} · ${s.sales.n} slips`, `बिक्री ${m(s.sales.total)} · ${s.sales.n} पर्चियां`, `Bikri ${m(s.sales.total)} · ${s.sales.n} parchiyan`),
      w(`money in ${m(s.money.total)}`, `आया ${m(s.money.total)}`, `aaya ${m(s.money.total)}`)];
    if (s.out?.total) parts.push(w(`expenses ${m(s.out.total)}`, `खर्च ${m(s.out.total)}`, `kharcha ${m(s.out.total)}`));
    if (s.cash.diff) parts.push(s.cash.diff < 0 ? w(`cash ${m(s.cash.diff)} short`, `कैश ${m(s.cash.diff)} कम`, `cash ${m(s.cash.diff)} kam`) : w(`cash ${m(s.cash.diff)} extra`, `कैश ${m(s.cash.diff)} ज़्यादा`, `cash ${m(s.cash.diff)} zyada`));
    if (s.look.length) parts.push(w(`${s.look.length} things need a look`, `${s.look.length} बातें देखनी हैं`, `${s.look.length} baatein dekhni hain`));
    return { title: `${w('Evening summary', 'शाम का हिसाब', 'Shaam ka hisaab')} · ${when}`, body: parts.join(' · '),
      url: `#/evening?day=${d.day}`, tag: `evening-${d.day}`, day: d.day, y };
  }

  /** Check the typed items and work out rate, density and weight for each — the same way the prototype does. */
  function buildItems(caller, ctx, rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw bad('Add at least one item.');
    if (rawItems.length > 200) throw bad('Too many items on one slip (max 200).');
    const mats = new Map((ctx.materials || []).map((m) => [m.id, m]));
    const familyDensity = { ...core.DEFAULT_FAMILY_DENSITY, ...(ctx.settings.family_density || {}) };
    const minInch = ctx.settings.min_inch;
    const mayPrice = core.can(caller.perms, 'price'); // owner decision 26 Sept: only people with "change rate on slip"
    return rawItems.map((it, i) => {
      const n = i + 1;
      const m = mats.get(it?.material_id);
      if (!m) throw bad(`Item ${n}: choose a grade from your list.`);
      if (!m.active) throw bad(`Item ${n}: ${m.code} is switched off in Rates.`);
      if (m.sell_rate == null) throw bad(`Item ${n}: ${m.code} has no rate yet.`);
      const sh = core.SHAPES[it.shape];
      if (!sh) throw bad(`Item ${n}: choose a shape.`);
      const unit = it.unit == null ? 'mm' : it.unit;
      if (unit !== 'mm' && unit !== 'in') throw bad(`Item ${n}: unit must be mm or inch.`);
      const d = (Array.isArray(it.d) ? it.d : []).slice(0, sh.dims.length).map((v) => String(v ?? '').trim());
      if (d.length !== sh.dims.length || d.some((v) => !v || v.length > 20)) throw bad(`Item ${n}: fill in all the sizes.`);
      const rowsIn = Array.isArray(it.rows) ? it.rows : [];
      if (!rowsIn.length || rowsIn.length > 50) throw bad(`Item ${n}: add the lengths and pieces.`);
      const rows = rowsIn.map((r) => {
        const cutsTyped = r?.cuts != null && r.cuts !== '';
        const cuts = cutsTyped ? Math.floor(Number(r.cuts)) : '';
        if (cutsTyped && !(cuts >= 0)) throw bad(`Item ${n}: cuts must be 0 or more.`);
        const len = sh.len ? String(r?.len ?? '').trim() : '';
        if (len.length > 20) throw bad(`Item ${n}: length is too long.`);
        return { len, pcs: Math.floor(Number(r?.pcs)), cuts };
      });
      let rate = m.special_rate != null ? Number(m.special_rate) : Number(m.sell_rate);
      let special = m.special_rate != null;
      let cutRate = Number(m.cut_rate);
      if (mayPrice && it.rate != null && it.rate !== '') {
        const typed = rateValue(it.rate, `rate for item ${n}`);
        if (typed !== rate) { rate = typed; special = false; }
      }
      if (mayPrice && it.cut_rate != null && it.cut_rate !== '') cutRate = rateValue(it.cut_rate, `cutting rate for item ${n}`);
      const density = m.density_override != null ? Number(m.density_override) : Number(familyDensity[m.family]);
      const coreItem = { matId: m.id, shape: it.shape, unit, d, rows, rate, cutRate, density, aw: null };
      const calc = core.calcItem(coreItem, 'est', { minInch });
      if (!calc) throw bad(`Item ${n}: fill in the sizes, lengths and pieces.`);
      return {
        coreItem, calc,
        db: {
          material_id: m.id, grade_code: m.code, shape: it.shape, unit, dims: d,
          sell_rate: rate, cut_rate: cutRate, density, special_rate: special,
          stock_item_id: isUuid(it.stock_item_id) ? it.stock_item_id : null, // which stock it comes from (checked by the database)
          lengths: rows.map((r) => ({ len: r.len, pcs: r.pcs, cuts: r.cuts === '' ? null : r.cuts })),
        },
      };
    });
  }

  const pricingRules = (ctx) => ({
    min_inch: ctx.settings.min_inch,
    family_density: { ...core.DEFAULT_FAMILY_DENSITY, ...(ctx.settings.family_density || {}) },
    timezone: ctx.timezone,
  });

  const estimateOf = (caller, built, minInch) => {
    if (!core.can(caller.perms, 'money')) return undefined;
    const T = core.orderTotals({ items: built.map((b) => b.coreItem) }, 'est', { bill: null, minInch });
    return { weight: r3(T.wt), material: T.mat, cutting: T.cut, amount: T.base };
  };

  const advanceArg = (caller, adv) => {
    if (!adv || adv.amount == null || adv.amount === '' || Number(adv.amount) === 0) return null;
    need(caller, 'money');
    const amt = amount(adv.amount, 'advance amount');
    return { amount: amt, mode: modeFor(adv.mode, placement(adv, amt)), note: text(adv.note) };
  };
  const advancePlace = (adv) => (adv ? placement(adv, Number(adv.amount)) : null);

  /**
   * Run an operation. With accounts chosen it goes through api_pay (all in one go, the split checked); an entry made
   * offline goes through api_run with the time it really happened (23 Oct 2026).
   */
  const payRpc = (fn, args, place, at = null) => (at
    ? rpc('api_run', { p_caller: args.p_caller, p_op: fn, p_args: args, p_parts: place?.parts ?? null, p_account: place?.account ?? null, p_at: at })
    : place
      ? rpc('api_pay', { p_caller: args.p_caller, p_op: fn, p_args: args, p_parts: place.parts, p_account: place.account })
      : rpc(fn, args));

  async function pricingContext(caller, customerId, items) {
    const matIds = [...new Set((Array.isArray(items) ? items : []).map((i) => i?.material_id).filter(isUuid))];
    return rpc('api_pricing_context', { p_caller: caller.id, p_customer: customerId, p_materials: matIds });
  }

  // ---------------------------------------------------------------------------------
  const ops = {
    // ---------- orders ----------
    async createOrder(caller, a, key, hash) {
      need(caller, 'new');
      const customer = uuid(a.customer_id, 'Choose a customer.');
      const ctx = await pricingContext(caller, customer, a.items);
      const built = buildItems(caller, ctx, a.items);
      const advance = a.accept ? advanceArg(caller, a.advance) : null;
      // a slip made offline chose its ids on the phone (so it could be weighed and finished offline too)
      const items = built.map((b, i) => (isUuid(a.items[i]?.id) ? { id: a.items[i].id, ...b.db } : b.db));
      const res = await payRpc('api_create_order', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_customer: customer, p_rules: pricingRules(ctx),
        p_items: items, p_accept: !!a.accept, p_advance: advance, ...(isUuid(a.order_id) ? { p_order_id: a.order_id } : {}),
      }, advance ? advancePlace(a.advance) : null, offlineAt(a.offline_at));
      return { ...res, estimate: estimateOf(caller, built, ctx.settings.min_inch) };
    },

    async updateOrder(caller, a, key, hash) {
      need(caller, 'new');
      const order = uuid(a.order_id, 'Which order?');
      const customer = uuid(a.customer_id, 'Choose a customer.');
      const ctx = await pricingContext(caller, customer, a.items);
      const built = buildItems(caller, ctx, a.items);
      const res = await rpc('api_update_order', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: order, p_customer: customer, p_items: built.map((b) => b.db),
      });
      return { ...res, estimate: estimateOf(caller, built, ctx.settings.min_inch) };
    },

    async acceptOrder(caller, a, key, hash) {
      need(caller, 'new');
      const advance = advanceArg(caller, a.advance);
      return payRpc('api_accept_order', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: uuid(a.order_id, 'Which order?'), p_advance: advance,
      }, advance ? advancePlace(a.advance) : null, offlineAt(a.offline_at));
    },

    async addAdvance(caller, a, key, hash) {
      need(caller, 'money');
      const amt = amount(a.amount, 'advance amount');
      const place = placement(a, amt);
      return payRpc('api_add_advance', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: uuid(a.order_id, 'Which order?'),
        p_amount: amt, p_mode: modeFor(a.mode, place), p_note: text(a.note),
      }, place, offlineAt(a.offline_at));
    },

    // ---------- weighing ----------
    async weighingList(caller, a) {
      need(caller, 'weigh');
      const list = await rpc('api_weighing_list', { p_caller: caller.id, p_order: a?.order_id && isUuid(a.order_id) ? a.order_id : null });
      // add the expected weight of each item (no rates or amounts ever go to the weigher)
      return list.map((o) => ({
        ...o,
        items: (o.items || []).map((i) => {
          const c = core.calcItem(coreItemFromDb(i), 'est', { minInch: o.min_inch });
          return { ...i, expected_weight: c ? r2(c.est) : null };
        }),
      }));
    },

    /**
     * weights: [{item_id, weight}] single items · batches: [{total_weight, item_ids:[…]}] weighed together
     * (split by expected weight with @srs/core — always adds up exactly to the reading).
     */
    async recordWeights(caller, a, key, hash) {
      need(caller, 'weigh');
      const orderId = uuid(a.order_id, 'Which order?');
      const [order] = await rpc('api_weighing_list', { p_caller: caller.id, p_order: orderId });
      if (!order) throw new ApiError(409, 'not_waiting', 'This order is not waiting to be weighed.');
      const items = new Map(order.items.map((i) => [i.id, i]));
      const expected = (id) => {
        const c = core.calcItem(coreItemFromDb(items.get(id)), 'est', { minInch: order.min_inch });
        return c ? c.est : 0;
      };
      const seen = new Set();
      const once = (id) => {
        if (!items.has(id)) throw bad('That item is not on this slip.');
        if (seen.has(id)) throw bad('An item was weighed twice in one go.');
        seen.add(id);
      };
      const weights = (Array.isArray(a.weights) ? a.weights : []).map((w) => {
        once(w?.item_id);
        return { item_id: w.item_id, weight: kg(w.weight, items.get(w.item_id).grade_code) };
      });
      const batches = (Array.isArray(a.batches) ? a.batches : []).map((b) => {
        const ids = Array.isArray(b?.item_ids) ? b.item_ids : [];
        if (ids.length < 2) throw bad('Weigh-together needs 2 or more items.');
        ids.forEach(once);
        if (!core.canWeighTogether(ids.map((id) => ({ matId: items.get(id).material_id })))) {
          throw bad('Only items of the same grade can be weighed together.');
        }
        const total = Math.round(kg(b.total_weight, 'the batch') * 100) / 100; // split works to 10 g
        const parts = core.splitBatchWeight(ids.map(expected), total);
        return { total_weight: total, parts: ids.map((id, k) => ({ item_id: id, weight: parts[k] })) };
      });
      if (!weights.length && !batches.length) throw bad('Enter at least one weight.');
      const res = await payRpc('api_record_weights', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: orderId,
        p_weights: weights, p_batches: batches, p_submit: !!a.submit,
      }, null, offlineAt(a.offline_at));
      // warn (never block) when a weight is far from what the sizes say — like the prototype
      const warnPct = Number((await companySettings(caller.company_id))?.weight_warn_pct ?? 5);
      const warnings = [];
      for (const w of res.weights || []) {
        if (w.weight == null || !seen.has(w.item_id)) continue;
        const e = expected(w.item_id);
        if (e > 0) {
          const pct = core.weightDeviationPct(e, Number(w.weight));
          if (pct > warnPct) warnings.push({ item_id: w.item_id, expected: r2(e), actual: Number(w.weight), pct: Math.round(pct * 10) / 10 });
        }
      }
      return { ...res, warnings };
    },

    // ---------- finishing at pickup ----------
    async finalizeOrder(caller, a, key, hash) {
      need(caller, 'money');
      const orderId = uuid(a.order_id, 'Which order?');
      if (!BILLS.includes(a.bill)) throw bad('Choose Pakka bill or Kacha.', 'choose_bill');
      if (a.bill === 'kacha') need(caller, 'kacha');
      if (a.pay_mode != null && !PAY_MODES.includes(a.pay_mode)) throw bad('Choose how the customer pays.');
      const ctx = await rpc('api_order_context', { p_caller: caller.id, p_order: orderId });
      const o = ctx.order;
      if (o.status !== 'weighed') throw new ApiError(409, 'not_weighed', o.status === 'done' ? 'This order is already finished.' : 'Weigh the order first.');
      const minInch = o.pricing_rules?.min_inch ?? ctx.settings.min_inch;
      const gstPct = Number(ctx.settings.gst_pct), kachaPct = Number(ctx.settings.kacha_pct);
      const advance = Number(ctx.paid.advance);
      const f = core.finishCalc({
        order: { items: ctx.items.map(coreItemFromDb) }, advance, bill: a.bill,
        payMode: a.pay_mode, paid: a.paid, gstPct, kachaPct, minInch,
      });
      const problem = core.finishProblem(f);
      if (problem === 'need_part') throw bad('Enter the part amount (more than 0 and less than the balance).', 'need_part');
      if (problem) throw bad('Choose Pakka bill or Kacha.', problem);
      const paidNow = r2(f.paidNow);
      const T = f.T;
      const place = paidNow > 0 ? placement(a, paidNow) : null;
      const res = await payRpc('api_finalize_order', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: orderId,
        p_final: {
          bill: f.bill, gst_pct: gstPct, kacha_pct: kachaPct, pay_mode: f.mode, paid_now: paidNow,
          pay_method: paidNow > 0 ? modeFor(a.pay_method, place) : null, note: text(a.note),
          in_khata: core.staysInKhata(advance + paidNow, T.total),
          basis: { advance, weights: Object.fromEntries(ctx.items.map((i) => [i.id, i.actual_weight == null ? null : Number(i.actual_weight)])) },
          totals: { weight: r3(T.wt), base: T.base, material: T.matK, cutting: T.cutK, gst: T.gst, total: T.total },
        },
      }, place, offlineAt(a.offline_at));
      return { ...res, breakdown: { material: T.matK, cutting: T.cutK, gst: T.gst, pct: T.pct, total: T.total, advance: f.A, balance: f.B, extra: f.extra, paid_now: paidNow, due: f.due } };
    },

    // ---------- khata ----------
    async recordPayment(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      if (!BILLS.includes(a.side)) throw bad('Choose Pakka or Kacha.');
      if (a.side === 'kacha') need(caller, 'kacha');
      const amt = amount(a.amount, 'amount received');
      const place = placement(a, amt);
      return payRpc('api_record_payment', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_customer: uuid(a.customer_id, 'Choose a customer.'),
        p_amount: amt, p_mode: modeFor(a.mode, place), p_side: a.side, p_note: text(a.note),
      }, place, offlineAt(a.offline_at));
    },

    async reversePayment(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      need(caller, 'delete');   // the owner's (25 Oct 2026): cancelling money is with the "delete" permission
      const note = text(a.note);
      if (!note) throw bad('Write why this payment is being cancelled.');
      return rpc('api_reverse_payment', { p_caller: caller.id, p_key: key, p_hash: hash, p_payment: uuid(a.payment_id, 'Which payment?'), p_note: note });
    },

    /**
     * The cash count at closing (cash book, 23 Oct 2026): counted = what is in the drawer; take = cash taken out now
     * (home / bank) into take_to (none given: "Cash at home", made the first time). The rest stays as tomorrow's opening.
     */
    async saveCashCount(caller, a, key, hash) {
      need(caller, 'money', 'today');
      const counted = Number(a.counted);
      if (!Number.isFinite(counted) || counted < 0 || counted > 1e9) throw bad('Enter the cash you counted.');
      const take = a.take == null || a.take === '' ? 0 : Number(a.take);
      if (!Number.isFinite(take) || take < 0) throw bad('Enter the cash taken out.');
      if (r2(take) > r2(counted)) throw bad("You can't take out more than you counted.");
      return rpc('api_close_cash', { p_caller: caller.id, p_key: key, p_hash: hash, p_counted: r2(counted), p_note: text(a.note),
        p_take: r2(take), p_take_to: take > 0 && a.take_to ? uuid(a.take_to, 'Choose where the cash went.') : null, p_at: offlineAt(a.offline_at) });
    },

    /** The drawer's cash book for a day (default today): opening, cash in, cash out, should be there, the counts. */
    async cashBook(caller, a) {
      need(caller, 'money', 'today');
      const day = DAY.test(a?.day || '') ? a.day : null;
      return rpc('api_cash_book', { p_caller: caller.id, p_day: day });
    },

    // ---------- money out: shop expenses and money moved between accounts (23 Oct 2026) ----------
    /**
     * Save an expense. a: { kind: expense | supplier | owner, category, amount, account_id, method, day?, paid_to, note,
     *   gst_bill, gst_amount, bill_no, seller_gstin, supplier_id, purchase_ids, file_key, replaces_id, offline_at }
     */
    async saveExpense(caller, a, key, hash) {
      const kind = a?.kind || 'expense';
      if (!core.EXPENSE_KINDS.includes(kind)) throw bad('Choose what the money was for.');
      if (kind === 'expense' && !core.can(caller.perms, 'expenses') && !core.can(caller.perms, 'settings')) throw forbidden('expenses');
      if (kind === 'supplier' && !core.can(caller.perms, 'stock') && !core.can(caller.perms, 'settings')) throw forbidden('stock');
      if (kind === 'owner') need(caller, 'settings');
      const amt = amount(a.amount, 'amount');
      const category = kind === 'expense' ? (core.isCategoryKey(a.category) ? a.category : 'other') : kind === 'supplier' ? 'supplier' : 'home';
      const gstBill = !!a.gst_bill;
      let gstAmt = null;
      if (gstBill && a.gst_amount != null && a.gst_amount !== '') {
        gstAmt = Number(a.gst_amount);
        if (!(gstAmt >= 0) || gstAmt >= amt) throw bad('The GST must be less than the amount.');
        gstAmt = r2(gstAmt);
      }
      const sellerGstin = gstBill ? gstinValue(a.seller_gstin) || null : null;
      const bills = Array.isArray(a.purchase_ids) ? [...new Set(a.purchase_ids)] : [];
      if (bills.length > 50 || !bills.every(isUuid)) throw bad('Choose the bills again.');
      return rpc('api_save_expense', { p_caller: caller.id, p_key: key, p_hash: hash, p: {
        kind, category, amount: amt, account_id: uuid(a.account_id, 'Choose where the money came from.'),
        method: BANK_METHODS.includes(a.method) ? a.method : null, at: entryAt(a), paid_to: text(a.paid_to, 80), note: text(a.note, 300),
        gst_bill: gstBill, gst_amount: gstAmt, bill_no: gstBill ? text(a.bill_no, 40) : null, seller_gstin: sellerGstin,
        supplier_id: kind === 'supplier' ? uuid(a.supplier_id, 'Choose the supplier.') : null, purchase_ids: kind === 'supplier' ? bills : [],
        file_key: typeof a.file_key === 'string' && a.file_key.startsWith(`${caller.company_id}/`) ? a.file_key.slice(0, 200) : null,
        replaces_id: a.replaces_id ? uuid(a.replaces_id, 'Which expense?') : null, offline: !!a.offline_at,
      } });
    },

    async cancelExpense(caller, a, key, hash) {
      if (!['expenses', 'settings', 'stock'].some((p) => core.can(caller.perms, p))) throw forbidden('expenses');
      const reason = text(a?.reason, 300);
      if (!reason) throw bad('Write why it is cancelled.');
      return rpc('api_cancel_expense', { p_caller: caller.id, p_key: key, p_hash: hash, p_id: uuid(a?.id, 'Which expense?'), p_reason: reason });
    },

    /** Expenses and money moves between two days (default: this month so far), with totals. */
    async expenses(caller, a) {
      if (!['expenses', 'settings', 'stock'].some((p) => core.can(caller.perms, p))) throw forbidden('expenses');
      const from = DAY.test(a?.from || '') ? a.from : null;
      const to = DAY.test(a?.to || '') ? a.to : null;
      if (!from || !to) throw bad('Choose the dates.');
      const r = await rpc('api_expenses', { p_caller: caller.id, p_from: from, p_to: to });
      const totals = core.expenseTotals((r.items || []).map((e) => ({ kind: e.kind, category: e.category, amount: Number(e.amount), accountId: e.account_id,
        isDrawer: !!e.is_drawer, gstAmount: e.gst_amount == null ? null : Number(e.gst_amount), status: e.status })));
      return { ...r, totals };
    },

    /** A photo of an expense's bill / receipt (base64, like a purchase bill). Returns the file key for saveExpense. */
    async uploadReceipt(caller, a) {
      if (!['expenses', 'settings', 'stock'].some((p) => core.can(caller.perms, p))) throw forbidden('expenses');
      const mime = String(a?.mime || '');
      if (!BILL_MIMES.includes(mime)) throw bad('Send a PDF or a photo (JPG / PNG).');
      const data = String(a?.data || '').replace(/^data:[^,]*,/, '');
      if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw bad('That file could not be read.');
      if (Math.floor(data.replace(/\s/g, '').length * 3 / 4) > 6 * 1024 * 1024) throw bad('The photo is too big (over 6 MB).');
      const fileKey = files ? await files.save(caller, data, mime) : null;
      if (!fileKey) throw new ApiError(502, 'upload_failed', 'The photo could not be saved. Please try again.');
      return { file_key: fileKey };
    },

    async expenseFile(caller, a) {
      if (!['expenses', 'settings', 'stock'].some((p) => core.can(caller.perms, p))) throw forbidden('expenses');
      const k = await rpc('api_expense_file', { p_caller: caller.id, p_id: uuid(a?.id, 'Which expense?') });
      return { url: k && files && k.startsWith(`${caller.company_id}/`) ? await files.url(k).catch(() => null) : null };
    },

    /** Move money between two of the shop's accounts: { from_account, to_account, amount, reason, method, note, day?, offline_at }. */
    async saveTransfer(caller, a, key, hash) {
      if (!core.can(caller.perms, 'expenses') && !core.can(caller.perms, 'settings')) throw forbidden('expenses');
      const amt = amount(a?.amount, 'amount');
      const from = uuid(a?.from_account, 'Choose where the money came from.');
      const to = uuid(a?.to_account, 'Choose where the money went.');
      if (from === to) throw bad('Choose two different accounts.');
      const reason = core.TRANSFER_REASONS.includes(a?.reason) ? a.reason : 'move';
      return rpc('api_save_transfer', { p_caller: caller.id, p_key: key, p_hash: hash, p: {
        from_account: from, to_account: to, amount: amt, reason, method: BANK_METHODS.includes(a.method) ? a.method : null,
        note: text(a.note, 300), at: entryAt(a), offline: !!a.offline_at } });
    },

    async cancelTransfer(caller, a, key, hash) {
      if (!core.can(caller.perms, 'expenses') && !core.can(caller.perms, 'settings')) throw forbidden('expenses');
      const reason = text(a?.reason, 300);
      if (!reason) throw bad('Write why it is cancelled.');
      return rpc('api_cancel_transfer', { p_caller: caller.id, p_key: key, p_hash: hash, p_id: uuid(a?.id, 'Which move?'), p_reason: reason });
    },

    /** Owners: every account with what should be in it now. */
    async accountBalances(caller) {
      need(caller, 'settings', 'money');
      return rpc('api_account_balances', { p_caller: caller.id });
    },

    /** Owners: one account's book between two days, with the running balance after every move. */
    async accountBook(caller, a) {
      need(caller, 'settings', 'money');
      const from = DAY.test(a?.from || '') ? a.from : null;
      const to = DAY.test(a?.to || '') ? a.to : null;
      if (!from || !to) throw bad('Choose the dates.');
      const r = await rpc('api_account_book', { p_caller: caller.id, p_account: uuid(a?.id, 'Which account?'), p_from: from, p_to: to });
      // the running balance: from the balance before the first day, reset at each balance point (count / passbook)
      const points = (r.points || []).map((x) => ({ ...x, at: x.at, point: true }));
      const start = r.opening?.known || r.account?.is_drawer ? Number(r.opening?.balance ?? 0) : null;
      let b = start;
      const rows = [...(r.moves || []).map((m) => ({ ...m, amount: Number(m.amount) })), ...points]
        .sort((x, y) => String(x.at).localeCompare(String(y.at)) || (x.point ? 1 : -1))
        .map((m) => {
          if (m.point) { const row = { ...m, before: b, balance: Number(m.balance) }; b = Number(m.balance); return row; }
          if (b != null) b = r2(b + m.amount);
          return { ...m, balance: b };
        });
      return { ...r, rows };
    },

    /** Owners: "the passbook / Paytm app says ₹…" (or the starting cash) → a balance point for that account. */
    async setBalance(caller, a, key, hash) {
      need(caller, 'settings', 'money');
      const bal = Number(a?.balance);
      if (!Number.isFinite(bal) || Math.abs(bal) > 1e10) throw bad('Enter the balance.');
      return rpc('api_set_balance', { p_caller: caller.id, p_key: key, p_hash: hash, p_account: uuid(a?.id, 'Which account?'), p_balance: r2(bal), p_note: text(a.note, 300) });
    },

    // ---------- rates, grades, customers, settings ----------
    async changeMaterialRate(caller, a, key, hash) {
      need(caller, 'rates');
      return rpc('api_change_material_rate', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_material: uuid(a.material_id, 'Which grade?'),
        p_sell: rateValue(a.sell_rate, 'rate per kg'), p_cut: rateValue(a.cut_rate, 'cutting rate'), p_note: text(a.note),
      });
    },

    async createMaterial(caller, a, key, hash) {
      need(caller, 'rates');
      const code = String(a.code ?? '').trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9 ._/-]{0,39}$/.test(code)) throw bad('Enter the grade name, e.g. EN8 or SS304.');
      if (!Object.keys(core.DEFAULT_FAMILY_DENSITY).includes(a.family)) throw bad('Choose the steel family.');
      const density = a.density == null || a.density === '' ? null : Number(a.density);
      if (density != null && !(density >= 1000 && density <= 25000)) throw bad('Density should be between 1000 and 25000 kg/m³.');
      return rpc('api_create_material', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_code: code, p_family: a.family,
        p_sell: rateValue(a.sell_rate, 'rate per kg'), p_cut: rateValue(a.cut_rate, 'cutting rate'),
        p_density: density, p_info: a.info && typeof a.info === 'object' ? a.info : null,
      });
    },

    async updateMaterial(caller, a, key, hash) {
      need(caller, 'rates');
      const ch = a.changes && typeof a.changes === 'object' ? a.changes : {};
      const changes = {};
      if ('active' in ch) changes.active = !!ch.active;
      if ('density_override' in ch) changes.density_override = ch.density_override === '' ? null : ch.density_override;
      if ('info' in ch) changes.info = ch.info;
      return rpc('api_update_material', { p_caller: caller.id, p_key: key, p_hash: hash, p_material: uuid(a.material_id, 'Which grade?'), p_changes: changes });
    },

    async createCustomer(caller, a, key, hash) {
      need(caller, 'new');
      const name = text(a.name, 200);
      if (!name) throw bad('Enter the customer’s name.');
      const extra = {};
      if (a.gstin) extra.gstin = gstinValue(a.gstin);
      if (a.address) extra.address = text(a.address, 300);
      const cu = await payRpc('api_create_customer', { p_caller: caller.id, p_key: key, p_hash: hash, p_name: name, p_phone: text(a.phone, 30), p_notes: text(a.notes),
        ...(isUuid(a.id) ? { p_id: a.id } : {}) }, null, offlineAt(a.offline_at));
      if (!Object.keys(extra).length) return cu;
      return rpc('api_update_customer', { p_caller: caller.id, p_key: newKey(), p_hash: hash, p_customer: cu.id, p_changes: extra });
    },

    async updateCustomer(caller, a, key, hash) {
      need(caller, 'new');
      const ch = a.changes && typeof a.changes === 'object' ? a.changes : {};
      const changes = {};
      for (const k of ['name', 'phone', 'notes', 'address']) if (k in ch) changes[k] = text(ch[k], k === 'name' ? 200 : k === 'phone' ? 30 : k === 'address' ? 300 : 500) ?? '';
      if ('gstin' in ch) changes.gstin = gstinValue(ch.gstin);
      if ('active' in ch) changes.active = !!ch.active;
      return rpc('api_update_customer', { p_caller: caller.id, p_key: key, p_hash: hash, p_customer: uuid(a.customer_id, 'Which customer?'), p_changes: changes });
    },

    async setCustomerRate(caller, a, key, hash) {
      need(caller, 'rates');
      return rpc('api_set_customer_rate', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_customer: uuid(a.customer_id, 'Which customer?'),
        p_material: uuid(a.material_id, 'Which grade?'), p_rate: a.rate == null || a.rate === '' ? null : rateValue(a.rate, 'special rate'),
      });
    },

    async changeSettings(caller, a, key, hash) {
      need(caller, 'settings');
      if (!a.changes || typeof a.changes !== 'object' || Array.isArray(a.changes)) throw bad('Nothing to change.');
      if ('upi_id' in a.changes && a.changes.upi_id && !UPI_ID.test(String(a.changes.upi_id).trim())) throw bad('That UPI ID doesn’t look right (like shopname@okaxis).');
      return rpc('api_change_settings', { p_caller: caller.id, p_key: key, p_hash: hash, p_changes: a.changes });
    },

    // ---------- cancelling, advances, old balances (owner decisions 26 Sept 2026) ----------
    async cancelOrder(caller, a, key, hash) {
      need(caller, 'new');
      const reason = text(a.reason);
      if (!reason) throw bad('Write why the order is cancelled.');
      return rpc('api_cancel_order', { p_caller: caller.id, p_key: key, p_hash: hash, p_order: uuid(a.order_id, 'Which order?'), p_reason: reason });
    },

    /** action: 'refund' (give money back) · 'move' (to target_order_id) · 'credit' (keep for the customer on side). */
    async adjustAdvance(caller, a, key, hash) {
      need(caller, 'money');
      const args = { p_caller: caller.id, p_key: key, p_hash: hash, p_order: uuid(a.order_id, 'Which order?'),
        p_action: a.action, p_amount: amount(a.amount, 'amount'), p_mode: null, p_target: null, p_side: null, p_note: text(a.note) };
      let place = null;
      if (a.action === 'refund') {
        need(caller, 'delete');   // giving money back is the owner's (25 Oct 2026)
        place = placement({ account_id: a.account_id, method: a.method }, null); // given back from one account
        args.p_mode = modeFor(a.mode, place);
        if (!args.p_note) throw bad('Write why the money is returned.');
      } else if (a.action === 'move') {
        args.p_target = uuid(a.target_order_id, 'Choose the order to move it to.');
      } else if (a.action === 'credit') {
        if (!BILLS.includes(a.side)) throw bad('Choose which account keeps the credit.');
        if (a.side === 'kacha') need(caller, 'kacha');
        args.p_side = a.side;
      } else {
        throw bad('Choose: return, move to another order, or keep as credit.');
      }
      return payRpc('api_adjust_advance', args, place);
    },

    /** Give back credit a customer holds in the khata (how much is available is worked out with @srs/core). */
    async refundCredit(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      need(caller, 'delete');   // giving money back is the owner's (25 Oct 2026)
      const customer = uuid(a.customer_id, 'Which customer?');
      if (!BILLS.includes(a.side)) throw bad('Choose the account.');
      if (a.side === 'kacha') need(caller, 'kacha');
      const k = coreKhataFromDb(await rpc('api_khata_data', { p_caller: caller.id, p_customer: customer }));
      const l = core.customerLedger({ custId: customer, ...k, sides: [a.side], allSides: ['pakka', 'kacha'] });
      const note = text(a.note);
      if (!note) throw bad('Write why the money is returned.');
      const place = placement({ account_id: a.account_id, method: a.method }, null);
      return payRpc('api_refund_credit', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_customer: customer, p_side: a.side,
        p_amount: amount(a.amount, 'amount'), p_mode: modeFor(a.mode, place), p_note: note, p_available: l.bySide[a.side]?.adv ?? 0,
      }, place);
    },

    /** An old balance from the paper khata: a lump sum (no ref) or one old slip (ref = its number). */
    async addOldDue(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      if (!BILLS.includes(a.side)) throw bad('Choose Pakka or Kacha.');
      if (a.side === 'kacha') need(caller, 'kacha');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(a.date ?? ''))) throw bad('Enter the date of the old balance.');
      return rpc('api_add_old_due', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_customer: uuid(a.customer_id, 'Which customer?'), p_side: a.side,
        p_ref: text(a.ref, 40), p_date: a.date, p_amount: amount(a.amount, 'amount owed'), p_note: text(a.note),
      });
    },

    async reverseOldDue(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      const note = text(a.note);
      if (!note) throw bad('Write why this is being corrected.');
      return rpc('api_reverse_old_due', { p_caller: caller.id, p_key: key, p_hash: hash, p_old_due: uuid(a.old_due_id, 'Which entry?'), p_note: note });
    },

    // ---------- khata and reminders ----------
    /** Every customer's account worked out with @srs/core (who owes, credit held, oldest due). */
    async khata(caller, a) {
      need(caller, 'money');
      const customer = a?.customer_id && isUuid(a.customer_id) ? a.customer_id : null;
      const raw = await rpc('api_khata_data', { p_caller: caller.id, p_customer: customer });
      const k = coreKhataFromDb(raw);
      const sides = core.visibleSides(caller.perms);
      return raw.customers.map((c) => {
        const l = core.customerLedger({ custId: c.id, ...k, sides, allSides: sides });
        return { customer: c, due: l.due, credit: l.adv, pending_advance: l.pend, oldest: l.oldest, by_side: l.bySide,
          entries: customer ? markCancelled(l.entries, raw.payments) : undefined,
          slips: customer ? Object.fromEntries(raw.orders.map((o) => [o.id, o.slip_no])) : undefined };
      }).filter((x) => customer || x.due > 0 || x.credit > 0);
    },

    /** Customers to ASK about (unpaid slips older than the setting, not reminded recently). Nothing is sent here. */
    async reminderList(caller, a) {
      need(caller, 'money', 'khata');
      const raw = await rpc('api_khata_data', { p_caller: caller.id, p_customer: null });
      return remindersFrom(caller, raw, a?.lang);
    },

    /** The message that WOULD be sent (nothing is logged or sent). */
    async reminderPreview(caller, a) {
      need(caller, 'money', 'khata');
      const customer = uuid(a.customer_id, 'Which customer?');
      if (!BILLS.includes(a.side)) throw bad('Which account?');
      if (a.side === 'kacha') need(caller, 'kacha');
      const raw = await rpc('api_khata_data', { p_caller: caller.id, p_customer: customer });
      const c = raw.customers[0];
      if (!c) throw bad('Customer not found.');
      const due = core.dueSlips({ custId: customer, side: a.side, ...coreKhataFromDb(raw), now: new Date().toISOString(), timeZone: raw.timezone });
      return { customer: { id: c.id, name: c.name, phone: c.phone }, side: a.side, due: due.due, slips: due.slips, oldest_days: due.oldestDays,
        has_phone: !!core.normalizeIndianMobile(c.phone), repeat_days: raw.settings.reminder_repeat_days,
        preview: core.reminderMessage({ lang: a.lang, shop: raw.shop, customer: c.name, due }) };
    },

    /**
     * The owner tapped "Yes, send". The message is rebuilt on the server from the real figures
     * (never taken from the phone), logged, and returned with a WhatsApp link that opens the chat.
     */
    async sendReminder(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      const customer = uuid(a.customer_id, 'Which customer?');
      if (!BILLS.includes(a.side)) throw bad('Which account?');
      if (a.side === 'kacha') need(caller, 'kacha');
      const raw = await rpc('api_khata_data', { p_caller: caller.id, p_customer: customer });
      const c = raw.customers[0];
      if (!c) throw bad('Customer not found.');
      const phone = core.normalizeIndianMobile(c.phone);
      if (!phone) throw new ApiError(400, 'no_phone', 'Add this customer’s WhatsApp number first.');
      const due = core.dueSlips({ custId: customer, side: a.side, ...coreKhataFromDb(raw), now: new Date().toISOString(), timeZone: raw.timezone });
      if (!(due.due > 0)) throw new ApiError(409, 'nothing_due', 'Nothing is pending for this customer now.');
      const message = core.reminderMessage({ lang: a.lang, shop: raw.shop, customer: c.name, due });
      const res = await rpc('api_record_reminder', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_customer: customer, p_side: a.side, p_channel: 'whatsapp_link',
        p_phone: phone, p_message: message, p_total_due: due.due, p_slip_refs: due.slips.map((s) => s.ref || 'old'),
      });
      return { ...res, message, whatsapp_link: core.whatsappLink(phone, message) };
    },

    // ---------- slips and statements for the customer (28 Sept 2026) ----------
    /**
     * The slip as the customer sees it — built here from the saved figures (never from the phone),
     * saved as a snapshot with a secret link. send=true marks it as sent on WhatsApp.
     * Never contains rates per kg, cutting rates, payment notes or the word "kacha".
     */
    async slipDoc(caller, a, key, hash) {
      need(caller, 'money');
      const orderId = uuid(a.order_id, 'Which slip?');
      const lang = LANGS.includes(a.lang) ? a.lang : 'en';
      const raw = await rpc('api_slip_data', { p_caller: caller.id, p_order: orderId });
      const o = raw.order;
      const gst = o.bill === 'pakka';
      const payments = (raw.payments || []).map((p) => ({ at: p.at, amount: Number(p.amount), mode: p.mode, kind: p.kind }));
      const paid = r2(payments.reduce((x, p) => x + p.amount, 0));
      const total = Number(o.total);
      const balance = r2(Math.max(0, total - paid));
      const doc = {
        v: 1, kind: 'slip', lang, timezone: raw.timezone,
        shop: docShop(raw.shop, gst),
        customer: docCustomer(raw.customer, gst),
        slip: {
          no: o.slip_no, at: o.done_at, gst, gst_pct: gst ? Number(o.gst_pct) : null,
          show_weight: raw.show_weight !== false,
          total_weight: raw.show_weight !== false ? Number(o.total_weight) : null,
          items: (raw.items || []).map((i) => ({
            grade: i.grade, shape: i.shape, unit: i.unit, dims: i.dims,
            lengths: (i.lengths || []).map((l) => ({ len: l.len, pcs: Number(l.pcs) })),
            pcs: (i.lengths || []).reduce((x, l) => x + Number(l.pcs), 0),
            weight: raw.show_weight !== false && i.weight != null ? Number(i.weight) : null,
            hsn: gst && i.hsn ? String(i.hsn) : null, // GST slips only, from the stock the item came from
          })),
          material: Number(o.material), cutting: Number(o.cutting), gst_amount: gst ? Number(o.gst) : 0, total,
          payments, paid, balance,
        },
        upi: a.upi !== false && raw.upi && balance > 0 ? { ...raw.upi, amount: balance, note: `Slip ${o.slip_no}` } : null,
      };
      const saved = await rpc('api_save_doc', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_kind: 'slip', p_order: orderId, p_customer: raw.customer.id,
        p_lang: lang, p_doc: doc, p_send: !!a.send, p_no_bill: !gst,
      });
      return { ...saved, doc };
    },

    /** Account statement for a period: same numbers as the khata, one snapshot + link per send. */
    async statementDoc(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      const customer = uuid(a.customer_id, 'Which customer?');
      const lang = LANGS.includes(a.lang) ? a.lang : 'en';
      const DAY = /^\d{4}-\d{2}-\d{2}$/;
      if (!DAY.test(a.from || '') || !DAY.test(a.to || '') || a.from > a.to) throw bad('Choose the dates.');
      const visible = core.visibleSides(caller.perms);
      const which = ['both', 'pakka', 'kacha'].includes(a.which) ? a.which : 'both';
      const sides = which === 'both' ? visible : visible.filter((s) => s === which);
      if (!sides.length) throw forbidden('kacha');
      const raw = await rpc('api_khata_data', { p_caller: caller.id, p_customer: customer });
      const head = await rpc('api_doc_header', { p_caller: caller.id, p_customer: customer });
      const k = coreKhataFromDb(raw);
      const l = core.customerLedger({ custId: customer, ...k, sides, allSides: visible });
      // slips paid in full at pickup are listed too (they add and take away the same amount)
      const entries = core.withPaidSlips(l.entries, core.paidSlipEntries({ custId: customer, ...k, sides }));
      const st = core.statementFor({ entries, from: a.from, to: a.to, timeZone: raw.timezone });
      const slipNo = Object.fromEntries(raw.orders.map((o) => [o.id, o.slip_no]));
      const gstAll = sides.length === 1 && sides[0] === 'pakka';
      const rows = st.rows.map((e) => (e.t === 'bill'
        ? { day: e.day, type: e.old ? 'old' : 'slip', slip: e.old ? (e.ref || null) : slipNo[e.oid] || null, gst: e.side === 'pakka', amount: e.amt, bal: e.bal }
        : { day: e.day, type: 'pay', mode: e.mode, kind: e.kind, pending: !!e.pending, slip: e.oid ? slipNo[e.oid] || null : null, amount: e.amt, bal: e.bal }));
      const doc = {
        v: 1, kind: 'statement', lang, timezone: raw.timezone,
        shop: docShop(head.shop, true), customer: docCustomer(head.customer, true),
        period: { from: a.from, to: a.to }, gst_only: gstAll,
        opening: st.opening, bought: st.bought, paid: st.paid, closing: st.closing, rows,
        upi: a.upi !== false && head.upi && st.closing > 0 ? { ...head.upi, amount: st.closing, note: 'Account balance' } : null,
      };
      if (a.preview === true) return { doc }; // just looking: nothing saved, no link
      const saved = await rpc('api_save_doc', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_kind: 'statement', p_order: null, p_customer: customer,
        p_lang: lang, p_doc: doc, p_send: !!a.send, p_no_bill: sides.includes('kacha'),
      });
      return { ...saved, doc };
    },


    // ---------- money accounts (6 Oct 2026) ----------
    /** Where money can go. all=true: the Settings list (owners) incl. hidden ones and account numbers. */
    async accounts(caller, a) {
      need(caller, 'money');
      const all = a?.all === true;
      if (all) need(caller, 'settings');
      return rpc('api_accounts', { p_caller: caller.id, p_all: all });
    },

    /** Add or change an account: {id?, name, kind (bank|upi|paytm|wallet|other), owner (firm|personal), number?, staff_can, hidden}. */
    async saveAccount(caller, a, key, hash) {
      need(caller, 'settings');
      const x = a?.account || {};
      if (x.id != null && !isUuid(x.id)) throw bad('Account not found.');
      const name = String(x.name ?? '').trim();
      if (!name || name.length > 40) throw bad('Give the account a name (up to 40 letters).');
      if (x.kind != null && !core.ACCOUNT_KINDS.includes(x.kind)) throw bad('Choose what kind of account it is.');
      if (x.owner != null && !core.ACCOUNT_OWNERS.includes(x.owner)) throw bad('Choose firm or personal.');
      const number = x.number == null ? null : String(x.number).trim().slice(0, 60) || null;
      return rpc('api_save_account', { p_caller: caller.id, p_key: key, p_hash: hash, p_account: {
        id: x.id || null, name, kind: x.kind || null, owner: x.owner || 'firm', number,
        ...(x.staff_can != null ? { staff_can: !!x.staff_can } : {}), ...(x.hidden != null ? { hidden: !!x.hidden } : {}),
      } });
    },

    /** New order of the list: ids top to bottom (the cash drawer stays first). */
    async orderAccounts(caller, a, key, hash) {
      need(caller, 'settings');
      const ids = Array.isArray(a?.ids) ? a.ids : [];
      if (!ids.length || ids.length > 100 || !ids.every(isUuid)) throw bad('Which accounts?');
      return rpc('api_order_accounts', { p_caller: caller.id, p_key: key, p_hash: hash, p_ids: ids });
    },

    /** Evening tally: tick an account as checked in the bank / Paytm app for that day (checked=false unticks). */
    async checkAccount(caller, a, key, hash) {
      need(caller, 'settings', 'money');
      const day = /^\d{4}-\d{2}-\d{2}$/.test(a?.day || '') ? a.day : null;
      if (!day) throw bad('Choose the day.');
      return rpc('api_check_account', { p_caller: caller.id, p_key: key, p_hash: hash, p_account: uuid(a.account_id, 'Which account?'), p_day: day, p_checked: a.checked !== false });
    },

    // ---------- evening summary for the owner (29 Sept 2026) ----------
    /** Everything about one shop day (default today), as this person may see it. */
    async daySummary(caller, a) {
      need(caller, 'money');
      const day = /^\d{4}-\d{2}-\d{2}$/.test(a?.day || '') ? a.day : null;
      const raw = await rpc('api_day_data', { p_caller: caller.id, p_day: day });
      // the rest is read at the same time (23 Oct 2026: one after another made the evening summary slow)
      const [deleted, stock, accRaw, mo, gstRaw, kraw] = await Promise.all([
        rpc('api_day_deleted', { p_caller: caller.id, p_day: raw.day }),
        rpc('api_day_stock', { p_caller: caller.id, p_day: raw.day }),
        // owners: each money account's day (who paid what into which account)
        core.can(caller.perms, 'settings') ? rpc('api_day_accounts', { p_caller: caller.id, p_day: raw.day }) : null,
        // money out that day (expenses, money moved) and the drawer's cash book (23 Oct 2026)
        rpc('api_day_money', { p_caller: caller.id, p_day: raw.day }),
        core.can(caller.perms, 'stock') ? rpc('api_gst_alerts', { p_caller: caller.id }) : null,
        core.can(caller.perms, 'khata') ? rpc('api_khata_data', { p_caller: caller.id, p_customer: null }) : null,
      ]);
      const acc = accRaw ? dayAccountsFromDb(accRaw) : null;
      const gstAlerts = (gstRaw || []).map((g) => ({ name: g.name, gstin: g.gstin, status: g.status, cancelDate: g.cancel_date || null }));
      const expenses = (mo?.expenses || []).map((e) => ({ id: e.id, kind: e.kind, category: e.category, amount: Number(e.amount), accountId: e.account_id,
        isDrawer: !!e.is_drawer, mode: e.mode, gstAmount: e.gst_amount == null ? null : Number(e.gst_amount), paidTo: e.paid_to || e.supplier || null,
        note: e.note || null, at: e.at, by: e.by || null }));
      const transfers = (mo?.transfers || []).map((x) => ({ amount: Number(x.amount), from: x.from, to: x.to, fromAccount: x.from_account, toAccount: x.to_account,
        fromDrawer: !!x.from_drawer, toDrawer: !!x.to_drawer, reason: x.reason, at: x.at, by: x.by || null }));
      if (acc) { // the account tally shows money out and moves too
        for (const e of expenses) acc.parts.push({ accountId: e.accountId, amount: -e.amount, mode: e.mode, kind: 'expense', at: e.at, customer: e.paidTo || '' });
        for (const x of transfers) {
          acc.parts.push({ accountId: x.fromAccount, amount: -x.amount, kind: 'transfer', at: x.at, customer: x.to });
          acc.parts.push({ accountId: x.toAccount, amount: x.amount, kind: 'transfer', at: x.at, customer: x.from });
        }
      }
      let reminders = []; let toReceive = 0;
      if (kraw) {
        const k = coreKhataFromDb(kraw);
        const sides = core.visibleSides(caller.perms);
        toReceive = r2(kraw.customers.reduce((x, c) => x + core.customerLedger({ custId: c.id, ...k, sides, allSides: sides }).due, 0));
        reminders = remindersFrom(caller, kraw).map((r) => ({ name: r.customer.name, due: r.due, days: r.oldest_days }));
      }
      const weighed = (raw.weighed || []).map((w) => {
        const c = core.calcItem({ shape: w.shape, unit: w.unit, d: w.dims, rows: (w.lengths || []).map((l) => ({ len: l.len ?? '', pcs: l.pcs, cuts: l.cuts ?? '' })),
          rate: 0, cutRate: 0, density: Number(w.density) }, 'est', { minInch: w.min_inch ?? raw.settings.min_inch ?? 1 });
        return { slipNo: w.slip_no, grade: w.grade, expected: c ? c.est : 0, actual: Number(w.actual) };
      });
      const summary = core.daySummary({
        orders: (raw.orders || []).map((o) => ({ id: o.id, slipNo: o.slip_no, customer: o.customer, bill: o.bill, total: Number(o.total), weight: Number(o.weight || 0),
          inKhata: o.in_khata, by: o.by, items: (o.items || []).map((i) => ({ grade: i.grade, rate: Number(i.rate), stdRate: i.std_rate == null ? null : Number(i.std_rate), special: i.special })),
          payments: (o.payments || []).map((p) => ({ amount: Number(p.amount), kind: p.kind, rev: p.rev, mode: p.mode, parts: partsFromDb(p.parts) })) })),
        payments: (raw.payments || []).map((p) => ({ amount: Number(p.amount), kind: p.kind, rev: p.rev, mode: p.mode, customer: p.customer, orderId: p.order_id, at: p.at,
          parts: partsFromDb(p.parts) })),
        accounts: acc ? { list: acc.list, parts: acc.parts, checks: acc.checks } : null,
        cashClose: raw.cash_close, weighed, reminders, toReceive,
        waiting: (raw.waiting || []).map((w) => ({ slipNo: w.slip_no, customer: w.customer })),
        cancelled: (raw.cancelled || []).map((x) => ({ slipNo: x.slip_no, customer: x.customer, reason: x.reason })),
        deleted: (deleted || []).map((x) => ({ slipNo: x.slip_no, customer: x.customer, reason: x.reason, by: x.by })),
        stock: stock ? dayStockFromDb(stock) : null,
        lastWeek: raw.last_week ? { total: Number(raw.last_week.total), n: Number(raw.last_week.n) } : null,
        weightWarnPct: Number(raw.settings.weight_warn_pct ?? 5), isToday: raw.day === raw.today,
        expenses, transfers, cashBook: mo?.cash_book || null, gstAlerts,
      });
      return { day: raw.day, today: raw.today, timezone: raw.timezone, shop: raw.shop, kacha: core.can(caller.perms, 'kacha'),
        khata: core.can(caller.perms, 'khata'), summary, account_parts: acc ? acc.parts : undefined };
    },

    async eveningGet(caller) {
      need(caller, 'money');
      return { ...(await rpc('api_evening_get', { p_caller: caller.id })), push_key: push?.vapid?.publicKey || null };
    },

    async eveningSet(caller, a, key, hash) {
      need(caller, 'settings');
      const ch = a?.changes && typeof a.changes === 'object' ? a.changes : {};
      const changes = {};
      if ('on' in ch) changes.on = !!ch.on;
      if ('time' in ch) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(ch.time))) throw bad('Choose a time like 20:00.'); changes.time = ch.time; }
      if ('days' in ch) {
        const days = (Array.isArray(ch.days) ? ch.days : []).map(Number);
        if (days.some((d) => !(d >= 1 && d <= 7))) throw bad('Choose the days.');
        changes.days = days;
      }
      if (ch.people && typeof ch.people === 'object') {
        changes.people = Object.fromEntries(Object.entries(ch.people).filter(([id]) => isUuid(id)).map(([id, v]) => [id, !!v]));
      }
      const r = await rpc('api_evening_set', { p_caller: caller.id, p_key: key, p_hash: hash, p_changes: changes });
      return { ...r, push_key: push?.vapid?.publicKey || null };
    },

    /** This phone: notifications on (sub = the phone's push subscription) or off. */
    async savePush(caller, a, key, hash) {
      const sub = a?.sub;
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) throw bad('This phone could not switch on notifications.');
      if (a.on !== false) need(caller, 'money');
      const clean = { endpoint: sub.endpoint.slice(0, 1000), keys: { p256dh: String(sub.keys?.p256dh || ''), auth: String(sub.keys?.auth || '') }, ua: text(a.ua, 300) };
      if (a.on !== false && (clean.keys.p256dh.length < 80 || clean.keys.auth.length < 16)) throw bad('This phone could not switch on notifications.');
      return rpc('api_save_push', { p_caller: caller.id, p_key: key, p_hash: hash, p_sub: clean, p_on: a.on !== false });
    },

    /** Send today's summary to my own phones now (to check it works). */
    async pushTest(caller, a) {
      need(caller, 'money');
      if (!push?.vapid) throw new ApiError(503, 'push_not_ready', 'Phone notifications are not set up on the server yet.');
      const subs = await rpc('api_my_push', { p_caller: caller.id });
      if (!subs.length) throw bad('Switch on notifications on this phone first.');
      const d = await ops.daySummary(caller, {});
      const msg = eveningNote(d, a?.lang);
      let sent = 0;
      for (const s of subs) {
        const res = await push.sendPush(s, msg, push.vapid).catch(() => ({ ok: false, gone: false }));
        await rpc('api_push_result', { p_endpoint: s.endpoint, p_ok: res.ok, p_gone: res.gone });
        if (res.ok) sent++;
      }
      return { sent, phones: subs.length };
    },

    // ---------- deleting slips (owner decision 30 Sept 2026) ----------
    /** What deleting these slips would undo (money taken, khata) — nothing is sent or changed. */
    async deletePreview(caller, a) {
      need(caller, 'delete');
      const check = await rpc('api_delete_check', { p_caller: caller.id, p_orders: orderIds(a?.order_ids) });
      return { orders: check.orders };
    },

    /** Step 1: check the slips and send the owner a one-time SMS code (same SMS as login). */
    async deleteCode(caller, a) {
      need(caller, 'delete');
      const ids = orderIds(a?.order_ids);
      const check = await rpc('api_delete_check', { p_caller: caller.id, p_orders: ids });
      if (!otp) throw new ApiError(503, 'sms_not_ready', 'SMS codes are not set up on the server yet.');
      const sent = await otp.send(caller);
      return { to: maskPhone(sent?.phone || check.phone), wait: 60, orders: check.orders };
    },

    /** Step 2: with the code, delete. money: never | credit | refund (+ mode) | none. */
    async deleteSlips(caller, a, key, hash) {
      need(caller, 'delete');
      const ids = orderIds(a?.order_ids);
      const reason = text(a?.reason);
      if (!reason) throw bad('Write why the slip is deleted.');
      const money = a?.money || 'none';
      if (!DELETE_MONEY.includes(money)) throw bad('Choose what happened to the money.');
      const place = money === 'refund' ? placement({ account_id: a?.account_id, method: a?.method }, null) : null;
      const mode = money === 'refund' ? modeFor(a?.mode, place) : null;
      // a retry after the code was used up gets the first answer back
      const before = await rpc('api_idem_answer', { p_caller: caller.id, p_key: key, p_op: 'deleteSlips' });
      if (before) return before;
      const code = String(a?.code ?? '').replace(/\D/g, '');
      if (code.length !== 6) throw bad('Type the 6-digit code from the SMS.', 'wrong_code');
      await rpc('api_delete_check', { p_caller: caller.id, p_orders: ids });
      if (!otp) throw new ApiError(503, 'sms_not_ready', 'SMS codes are not set up on the server yet.');
      if (!(await otp.verify(caller, code))) throw bad('That code is not right or has expired. Ask for a new code.', 'wrong_code');
      return payRpc('api_delete_orders', { p_caller: caller.id, p_key: key, p_hash: hash, p_orders: ids, p_reason: reason, p_money: money, p_mode: mode }, place);
    },

    /** Staff without the permission: ask the owners (they get a phone notification if they switched them on). */
    async requestDelete(caller, a, key, hash) {
      if (!core.can(caller.perms, 'orders') && !core.can(caller.perms, 'new')) throw forbidden('orders');
      const orderId = uuid(a?.order_id, 'Which slip?');
      const reason = text(a?.reason);
      if (!reason) throw bad('Write why the slip should be deleted.');
      const r = await rpc('api_request_delete', { p_caller: caller.id, p_key: key, p_hash: hash, p_order: orderId, p_reason: reason });
      let notified = 0;
      if (push?.vapid && !r.replayed) {
        for (const o of r.owners || []) {
          const L = { en: 0, hi: 1, hn: 2 }[o.lang] ?? 0;
          const msg = { title: `${['Delete request', 'डिलीट करने की मांग', 'Delete karne ki maang'][L]} · #${r.slip_no}`,
            body: `${r.asked_by}: ${r.reason}`, url: `#/slip/${r.order_id}`, tag: `delete-${r.request_id}` };
          for (const s of o.subs || []) {
            const res = await push.sendPush(s, msg, push.vapid).catch(() => ({ ok: false, gone: false }));
            await rpc('api_push_result', { p_endpoint: s.endpoint, p_ok: res.ok, p_gone: res.gone });
            if (res.ok) notified++;
          }
        }
      }
      return { request_id: r.request_id, order_id: r.order_id, slip_no: r.slip_no, notified, replayed: r.replayed || undefined };
    },

    /** Deleted slips (newest first) and open requests to delete — owners. order_id: only that slip's open request. */
    async deletedSlips(caller, a) {
      need(caller, 'delete');
      const orderId = a?.order_id && isUuid(a.order_id) ? a.order_id : null;
      return rpc('api_deleted_slips', { p_caller: caller.id, p_order: orderId });
    },

    /** Owner: a request that isn't needed. */
    async declineDelete(caller, a, key, hash) {
      need(caller, 'delete');
      return rpc('api_decline_delete', { p_caller: caller.id, p_key: key, p_hash: hash, p_request: uuid(a?.request_id, 'Which request?') });
    },

    // ---------- stock and purchases (30 Sept 2026) ----------
    /** All stock (for the stock screen and the "take from which stock?" picker). Buying rates only with "stock". */
    async stockData(caller) {
      const raw = await rpc('api_stock_data', { p_caller: caller.id });
      return stockFromDb(core, raw);
    },

    async stockItem(caller, a) {
      return rpc('api_stock_item', { p_caller: caller.id, p_item: uuid(a?.id, 'Which stock?') });
    },

    async purchaseContext(caller) {
      need(caller, 'stock');
      return { ...(await rpc('api_purchase_context', { p_caller: caller.id })), can_read: !!readBill };
    },

    /**
     * A bill file (PDF or photo, base64): kept privately with the bill, and read by the AI when it is
     * switched on. Nothing is saved as stock here — the person checks everything first (savePurchase).
     */
    async readPurchaseBill(caller, a) {
      need(caller, 'stock');
      const mime = String(a?.mime || '');
      if (!BILL_MIMES.includes(mime)) throw bad('Send a PDF or a photo (JPG / PNG).');
      const data = String(a?.data || '').replace(/^data:[^,]*,/, '');
      if (!data || !/^[A-Za-z0-9+/=\s]+$/.test(data)) throw bad('That file could not be read.');
      const bytes = Math.floor(data.replace(/\s/g, '').length * 3 / 4);
      if (bytes > 8 * 1024 * 1024) throw bad('The file is too big (over 8 MB). Send a smaller photo or the PDF.');
      const fileKey = files ? await files.save(caller, data, mime) : null;
      if (!readBill) return { file_key: fileKey, ai: false };
      const allowed = await rpc('api_ai_take', { p_caller: caller.id });
      if (!allowed) return { file_key: fileKey, ai: false, reason: 'daily_limit' };
      let parsed;
      try { parsed = parseBillJson(await readBill(data, mime)); } catch (e) { console.error('readBill:', e?.message); return { file_key: fileKey, ai: false, reason: 'unreadable' }; }
      return { file_key: fileKey, ai: true, bill: normalizeBill(core, parsed) };
    },

    /** Save a checked bill: every line into its stock item (grade + shape + HSN + rate). */
    async savePurchase(caller, a, key, hash) {
      need(caller, 'stock');
      const b = a?.bill || {};
      const kind = b.kind === 'opening' ? 'opening' : 'bill';
      const billType = kind === 'opening' ? 'kacha' : b.bill_type;
      if (!BILLS.includes(billType)) throw bad('Is it a GST bill or without bill?');
      if (billType === 'kacha') need(caller, 'kacha');
      const date = String(b.bill_date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw bad('Enter the bill date.');
      const linesIn = Array.isArray(b.lines) ? b.lines : [];
      if (!linesIn.length || linesIn.length > 100) throw bad('Add at least one line.');
      const lines = linesIn.map((l, i) => {
        const n = i + 1;
        const qty = Number(l.qty_kg);
        if (!(qty > 0 && qty <= 1e7)) throw bad(`Line ${n}: enter the weight.`);
        const rate = Number(l.rate);
        if (!(rate >= 0 && rate <= 1e6)) throw bad(`Line ${n}: enter the rate per kg.`);
        const amt = l.amount == null || l.amount === '' ? r2(qty * rate) : Number(l.amount);
        if (!(amt >= 0 && amt <= 1e10)) throw bad(`Line ${n}: enter the amount.`);
        if (!isUuid(l.material_id)) throw bad(`Line ${n}: choose the grade.`);
        if (l.shape != null && l.shape !== '' && !core.SHAPE_IDS.includes(l.shape)) throw bad(`Line ${n}: choose the shape.`);
        const description = text(l.description, 200) || `Line ${n}`;
        return { description, hsn: core.cleanHsn(l.hsn), qty_kg: Math.round(qty * 1000) / 1000, rate: Math.round(rate * 1000) / 1000, amount: r2(amt),
          material_id: l.material_id, shape: l.shape || null, label: text(l.label, 60), desc_key: core.descKey(description) };
      });
      const money = (v, what) => { const x = v == null || v === '' ? 0 : Number(v); if (!(x >= 0 && x <= 1e10)) throw bad(`Enter the ${what}.`); return r2(x); };
      const freight = money(b.freight, 'freight');
      const other = money(b.other, 'other charges');
      const gst = billType === 'kacha' ? 0 : money(b.gst, 'GST');
      const roundOff = Number(b.round_off || 0);
      if (!(Math.abs(roundOff) <= 100)) throw bad('Round-off is more than ₹100. Please check the bill.');
      const t = core.billTotals({ lines, freight, other, gst, roundOff, total: b.total == null || b.total === '' ? null : Number(b.total) });
      if (!t.ok && !a.accept_diff) throw new ApiError(400, 'totals_differ', `The lines add up to ${t.computed}, the bill says ${t.total} (difference ${t.diff}).`, { totals: t });
      const shares = core.landedCosts(lines.map((l) => ({ kg: l.qty_kg, rateKg: l.rate })), r2(freight + other));
      const supplier = kind === 'opening' ? null : (isUuid(b.supplier?.id) ? { id: b.supplier.id }
        : { name: text(b.supplier?.name, 120), gstin: gstinValue(b.supplier?.gstin) || null, phone: text(b.supplier?.phone, 30), city: text(b.supplier?.city, 80) });
      if (supplier && !supplier.id && !supplier.name) throw bad('Write who the bill is from.');
      return rpc('api_save_purchase', { p_caller: caller.id, p_key: key, p_hash: hash, p: {
        kind, bill_type: billType, bill_no: text(b.bill_no, 40), bill_date: date, supplier,
        freight, other, gst, round_off: r2(roundOff), total: t.total, pay_status: b.pay_status === 'paid' ? 'paid' : 'to_pay',
        // a bill file can only be one this company uploaded
        file_key: typeof b.file_key === 'string' && b.file_key.startsWith(`${caller.company_id}/`) ? b.file_key.slice(0, 200) : null,
        read_by_ai: !!b.read_by_ai, note: text(b.note),
        lines: lines.map((l, i) => ({ ...l, freight_share: shares[i].share })),
      } });
    },

    async purchases(caller, a) {
      need(caller, 'stock');
      return rpc('api_purchases', { p_caller: caller.id, p_limit: Math.min(500, Math.max(1, Number(a?.limit) || 100)) });
    },

    async purchase(caller, a) {
      need(caller, 'stock');
      const r = await rpc('api_purchase', { p_caller: caller.id, p_id: uuid(a?.id, 'Which bill?') });
      const fk = r?.purchase?.file_key;
      return { ...r, file_url: fk && files && fk.startsWith(`${caller.company_id}/`) ? await files.url(fk).catch(() => null) : null };
    },

    async purchasePaid(caller, a, key, hash) {
      need(caller, 'stock');
      return rpc('api_purchase_paid', { p_caller: caller.id, p_key: key, p_hash: hash, p_id: uuid(a?.id, 'Which bill?'), p_paid: !!a.paid });
    },

    async purchaseCancel(caller, a, key, hash) {
      need(caller, 'stock');
      const reason = text(a?.reason);
      if (!reason) throw bad('Write why the bill is cancelled.');
      return rpc('api_purchase_cancel', { p_caller: caller.id, p_key: key, p_hash: hash, p_id: uuid(a?.id, 'Which bill?'), p_reason: reason });
    },

    /** count = the kg really there; close = this stock is finished (what's left is scrap / weight difference). */
    async stockCount(caller, a, key, hash) {
      need(caller, 'stock');
      const count = Number(a?.count);
      if (!(count >= 0 && count <= 1e7)) throw bad('Enter the kg that are really there.');
      return rpc('api_stock_count', { p_caller: caller.id, p_key: key, p_hash: hash, p_item: uuid(a?.id, 'Which stock?'),
        p_count: Math.round(count * 1000) / 1000, p_close: !!a.close, p_note: text(a.note, 300) });
    },

    async setLowStock(caller, a, key, hash) {
      need(caller, 'stock');
      const kgv = a?.kg == null || a.kg === '' ? null : Number(a.kg);
      if (kgv != null && !(kgv >= 0 && kgv <= 1e7)) throw bad('Enter the kg.');
      return rpc('api_set_low_stock', { p_caller: caller.id, p_key: key, p_hash: hash, p_material: uuid(a?.material_id, 'Which grade?'), p_kg: kgv });
    },

    /** Which stock an order item comes from (until it is weighed). stock_item_id null = sell without stock. */
    async setItemStock(caller, a, key, hash) {
      if (!core.can(caller.perms, 'new') && !core.can(caller.perms, 'weigh')) throw forbidden('new');
      const stock = a?.stock_item_id == null || a.stock_item_id === '' ? null : uuid(a.stock_item_id, 'Which stock?');
      return rpc('api_set_item_stock', { p_caller: caller.id, p_key: key, p_hash: hash, p_item: uuid(a?.item_id, 'Which item?'), p_stock: stock });
    },

    // ---------- fingerprint phones (23 Oct 2026) ----------
    /** My fingerprint phones (person_id: someone else's — people managers). */
    async passkeys(caller, a) {
      const person = a?.person_id ? uuid(a.person_id, 'Who?') : null;
      if (person && person !== caller.id) need(caller, 'people');
      return rpc('api_passkeys', { p_caller: caller.id, p_person: person });
    },
    async passkeyRemove(caller, a, key, hash) {
      return rpc('api_passkey_remove', { p_caller: caller.id, p_key: key, p_hash: hash, p_id: uuid(a?.id, 'Which phone?') });
    },

    // ---------- is the supplier's GST number active? (23 Oct 2026) ----------
    /** Suppliers with their GST status; service = whether the automatic check is switched on. */
    async suppliers(caller) {
      need(caller, 'stock');
      return { suppliers: await rpc('api_suppliers', { p_caller: caller.id }), service: !!gstLookup, portal: core.GST_PORTAL_SEARCH };
    },

    /**
     * Check a GST number with the GST data service (when switched on). A check from the last 7 days is used again
     * (each check costs money) unless refresh. Returns { service, check } — check null when it couldn't be checked.
     */
    async gstCheck(caller, a, key, hash) {
      need(caller, 'stock');
      const g = core.checkGstin(a?.gstin);
      if (!g.ok) throw bad('That GST number has a mistake. Please check it.');
      if (!a.refresh) {
        const last = await rpc('api_gst_last', { p_caller: caller.id, p_gstin: g.gstin, p_days: 7 });
        if (last) return { service: !!gstLookup, check: last, cached: true };
      }
      if (!gstLookup) return { service: false, check: null };
      let ans;
      try { ans = core.readGstAnswer(await gstLookup(g.gstin)); } catch (e) { console.error('gstCheck:', e?.message); ans = null; }
      if (!ans) return { service: true, check: null, failed: true };
      const check = await rpc('api_gst_save', { p_caller: caller.id, p_key: key, p_hash: hash, p: {
        gstin: g.gstin, status: ans.status, legal_name: ans.legalName, trade_name: ans.tradeName, reg_date: ans.regDate,
        cancel_date: ans.cancelDate, taxpayer_type: ans.taxpayerType, source: 'service' } });
      return { service: true, check };
    },

    /** "I checked on the GST portal": status (+ cancelled since, the name shown there). */
    async gstMark(caller, a, key, hash) {
      need(caller, 'stock');
      const g = core.checkGstin(a?.gstin);
      if (!g.ok) throw bad('That GST number has a mistake. Please check it.');
      if (!core.GST_STATUSES.includes(a.status)) throw bad('Choose what the GST portal says.');
      const cancel = a.cancel_date && DAY.test(a.cancel_date) ? a.cancel_date : null;
      return rpc('api_gst_save', { p_caller: caller.id, p_key: key, p_hash: hash, p: {
        gstin: g.gstin, status: a.status, legal_name: text(a.legal_name, 200), cancel_date: a.status === 'active' ? null : cancel,
        source: 'portal', note: text(a.note, 300) } });
    },

    // ---------- Ask Claude (steel guide) ----------
    async askSteelQuestion(caller, a) {
      const q = text(a.question, 1000);
      if (!q) throw bad('Type your question.');
      if (!askModel) throw new ApiError(503, 'ai_not_configured', 'Ask Claude is not switched on yet.');
      const ctx = await rpc('api_ai_context', { p_caller: caller.id });
      const allowed = await rpc('api_ai_take', { p_caller: caller.id });
      if (!allowed) throw new ApiError(429, 'daily_limit', 'Today’s question limit is reached. Please try again tomorrow.');
      const lang = LANG_NAMES[a.lang] || LANG_NAMES[ctx.lang] || LANG_NAMES.en;
      const stock = (ctx.stock || []).map((m) => `${m.code} (${FAMILY_NAMES[m.family] || m.family})`).join(', ');
      const answer = await askModel(steelPrompt({ lang, stock, question: q }));
      return { answer };
    },
  };

  /** The evening job (called every 10 minutes by pg_cron through the api function): send what is due. */
  async function runEvening(now = new Date().toISOString()) {
    if (!push?.vapid) return { skipped: 'no_vapid_keys' };
    const due = await rpc('api_evening_due', { p_now: now });
    let sent = 0;
    for (const co of due || []) {
      let n = 0;
      for (const r of co.recipients || []) {
        let msg;
        try { msg = eveningNote(await ops.daySummary({ id: r.person_id, company_id: co.company_id, perms: r.perms || {} }, { day: co.day }), r.lang); } catch { continue; }
        for (const s of r.subs || []) {
          const res = await push.sendPush(s, msg, push.vapid).catch(() => ({ ok: false, gone: false }));
          await rpc('api_push_result', { p_endpoint: s.endpoint, p_ok: res.ok, p_gone: res.gone });
          if (res.ok) n++;
        }
      }
      await rpc('api_evening_sent', { p_company: co.company_id, p_day: co.day, p_sent: n });
      sent += n;
    }
    return { companies: (due || []).length, sent };
  }

  /** The GST data service checks suppliers again (every 30 days, those with bills in the last 6 months), a few per run. */
  async function runGstChecks(limit = 5) {
    if (!gstLookup) return { skipped: 'no_gst_service' };
    const due = (await rpc('api_gst_due', { p_limit: limit })) || [];
    let checked = 0;
    for (const d of due) {
      let ans = null;
      try { ans = core.readGstAnswer(await gstLookup(d.gstin)); } catch (e) { console.error('gst job:', e?.message); }
      if (!ans) continue;
      await rpc('api_gst_save_job', { p_company: d.company_id, p: { gstin: d.gstin, status: ans.status, legal_name: ans.legalName, trade_name: ans.tradeName,
        reg_date: ans.regDate, cancel_date: ans.cancelDate, taxpayer_type: ans.taxpayerType } });
      checked++;
    }
    return { due: due.length, checked };
  }

  return { ops, buildItems, runEvening, runGstChecks, eveningNote };
}

/**
 * The GST data service (switched on when the owner adds its key). provider: 'sandbox' (sandbox.co.in — POST /authenticate
 * with x-api-key + x-api-secret → data.access_token, 24 h, sent as Authorization without "Bearer"; then
 * POST /gst/compliance/public/gstin/search {gstin} → data.data {sts, lgnm, tradeNam, rgdt, cxdt}, checked 23 Oct 2026), 'cashfree', or
 * 'custom' (url with {gstin}, method, headers as JSON). Returns (gstin) → the service's JSON, or null when not set up.
 */
export function makeGstLookup({ provider, key, secret, url, method, headers, fetchFn = fetch } = {}) {
  if (!provider || !key) return null;
  const json = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { message: t.slice(0, 200) }; } };
  if (provider === 'sandbox') {
    let token = null; let until = 0;
    const base = url || 'https://api.sandbox.co.in';
    return async (gstin) => {
      if (!token || Date.now() > until) {
        const r = await fetchFn(`${base}/authenticate`, { method: 'POST', headers: { 'x-api-key': key, 'x-api-secret': secret || '', 'x-api-version': '1.0' } });
        const b = await json(r);
        token = b.access_token || b.data?.access_token || null;
        if (!token) throw new Error(`gst auth ${r.status}`);
        until = Date.now() + 20 * 3600 * 1000;
      }
      const r = await fetchFn(`${base}/gst/compliance/public/gstin/search`, { method: 'POST',
        headers: { Authorization: token, 'x-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ gstin }) });
      return json(r);
    };
  }
  if (provider === 'cashfree') {
    const endpoint = url || 'https://api.cashfree.com/verification/gstin';
    return async (gstin) => json(await fetchFn(endpoint, { method: 'POST',
      headers: { 'x-client-id': key, 'x-client-secret': secret || '', 'Content-Type': 'application/json' }, body: JSON.stringify({ GSTIN: gstin, gstin }) }));
  }
  if (provider === 'custom' && url) {
    let extra = {};
    try { extra = headers ? JSON.parse(headers) : {}; } catch { extra = {}; }
    const m = (method || 'GET').toUpperCase();
    return async (gstin) => json(await fetchFn(url.replace('{gstin}', encodeURIComponent(gstin)), {
      method: m, headers: { ...extra, ...(m === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(m === 'POST' ? { body: JSON.stringify({ gstin }) } : {}) }));
  }
  return null;
}

// ---------- fingerprint / face unlock (passkeys, 23 Oct 2026) ----------
/** The app's own addresses that may use fingerprint unlock (the server checks the phone's answer came from one of them). */
export const PASSKEY_ORIGINS = ['https://srs-trading-app.bansalparth12345.workers.dev', 'http://localhost:8173', 'http://localhost:8174', 'http://localhost:5173'];

/**
 * These run before the PIN unlock (unlocking with the finger IS the unlock). who: { user, session, unlocked, person }.
 *   passkeyBegin  { purpose: 'unlock' | 'register' } → challenge (+ for register: the details the phone needs)
 *   passkeyRegister { challenge, clientDataJSON, attestationObject, label } — needs a PIN unlock in the last 10 minutes
 *   passkeyUnlock { challenge, credential_id, clientDataJSON, authenticatorData, signature } → { ok, credential_id, jwk, alg }
 *     (the public key comes back so a phone that already has the key but forgot it can keep it again — "Use it with Face ID")
 */
export function makePasskeyOps({ core, rpc, origins = PASSKEY_ORIGINS, appName = 'SRS Trading' }) {
  const strOf = (v, max) => { const x = String(v ?? ''); if (!x || x.length > max || !/^[A-Za-z0-9_-]+$/.test(x)) throw bad('Please try again.'); return x; };
  const toApi = (e) => { if (e instanceof core.WebAuthnError) return new ApiError(401, 'passkey_failed', 'The fingerprint could not be checked. Use your PIN.', { reason: e.code }); return e; };
  return {
    async passkeyBegin(who, a) {
      const purpose = a?.purpose === 'register' ? 'register' : 'unlock';
      if (purpose === 'register' && !who.unlocked) throw new ApiError(401, 'pin_required', 'Enter your PIN.');
      const r = await rpc('api_passkey_begin', { p_user: who.user, p_session: who.session, p_purpose: purpose });
      const ids = (r.credentials || []).map((k) => k.id);
      if (purpose === 'unlock') return { challenge: r.challenge, credentials: ids };
      return { challenge: r.challenge, exclude: ids, user: { id: core.b64uEncode(new TextEncoder().encode(r.person_id)), name: who.phone || r.name, displayName: r.name }, rp: { name: appName } };
    },
    async passkeyRegister(who, a) {
      if (!who.unlocked) throw new ApiError(401, 'pin_required', 'Enter your PIN.');
      const challenge = strOf(a?.challenge, 100);
      let v;
      try { v = await core.verifyRegistration({ clientDataJSON: strOf(a.clientDataJSON, 4000), attestationObject: strOf(a.attestationObject, 6000) }, { challenge, origins }); }
      catch (e) { throw toApi(e); }
      return rpc('api_passkey_save', { p_user: who.user, p_session: who.session, p_challenge: challenge, p_credential_id: v.credentialId,
        p_public_key: v.jwk, p_alg: v.alg, p_sign_count: v.signCount, p_label: text(a.label, 60) });
    },
    async passkeyUnlock(who, a) {
      const challenge = strOf(a?.challenge, 100);
      const credId = strOf(a?.credential_id, 1400);
      const k = await rpc('api_passkey_key', { p_user: who.user, p_credential_id: credId });
      if (!k) throw new ApiError(401, 'passkey_failed', 'Fingerprint is not switched on for this phone any more. Use your PIN.', { reason: 'unknown_key' });
      let v;
      try {
        v = await core.verifyAssertion({ clientDataJSON: strOf(a.clientDataJSON, 4000), authenticatorData: strOf(a.authenticatorData, 2000), signature: strOf(a.signature, 2000) },
          { challenge, origins, jwk: k.public_key, alg: k.alg });
      } catch (e) { throw toApi(e); }
      const r = await rpc('api_passkey_unlock', { p_user: who.user, p_session: who.session, p_challenge: challenge, p_credential_id: credId, p_sign_count: v.signCount });
      if (!r?.ok) throw new ApiError(401, 'passkey_failed', r?.reason === 'blocked' ? 'Too many wrong PINs. Log in again with an SMS code.' : 'The fingerprint could not be checked. Use your PIN.', { reason: r?.reason });
      // the key's public half (not secret): a phone that forgot it (logged out, "forgot PIN") keeps it again — 25 Oct 2026
      return { ok: true, credential_id: credId, jwk: k.public_key, alg: k.alg };
    },
  };
}
export const PASSKEY_OPS = new Set(['passkeyBegin', 'passkeyRegister', 'passkeyUnlock']);

/** Same instructions as the prototype's Ask Claude screen. */
export function steelPrompt({ lang, stock, question }) {
  return `You are the helper inside the app of a steel trading shop in India. The shop sells and cuts (bandsaw) steel bars, flats and plates. A shopkeeper or worker asks you a question so they can advise a customer.
Grades in stock: ${stock}.
Rules:
- Answer in ${lang}. Very simple words, no jargon. Maximum 8 short lines. No headings, no markdown symbols, no tables.
- Say what to use and why. If useful, say how to work it (machining, welding, heat treatment) and what to watch out for.
- Prefer grades from the stock list. If nothing in stock fits, say so and name the closest option. Do not invent grades or facts.
- Never give prices. If unsure, or if safety is involved (lifting, pressure, structures), tell them to check with a senior person or an engineer.
Question: ${question}`;
}

/** Operations that change something need a request key; readers don't. */
export const READ_OPS = new Set(['accounts', 'weighingList', 'askSteelQuestion', 'khata', 'reminderList', 'reminderPreview', 'daySummary', 'eveningGet', 'deletedSlips', 'deletePreview',
  'stockData', 'stockItem', 'purchaseContext', 'purchases', 'purchase', 'readPurchaseBill',
  'cashBook', 'expenses', 'uploadReceipt', 'expenseFile', 'accountBalances', 'accountBook', 'suppliers', 'passkeys']);

/** Database error code → HTTP answer the app can show. */
export function mapDbError(code, message) {
  if (code === '42501') return new ApiError(403, 'not_allowed', message);
  if (code === '40001') return new ApiError(409, 'changed', message);
  if (code === '23505') return new ApiError(409, 'duplicate', message);
  if (code === '23001') return new ApiError(409, 'not_allowed_now', message);
  if (code === '23503') return new ApiError(400, 'not_found', 'That record is not in your company.');
  if (code === '23514' || code === '23502' || (code && code.startsWith('22'))) return new ApiError(400, 'invalid', message);
  return null;
}
