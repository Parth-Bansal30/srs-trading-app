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
const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;

/** Same JSON for the same data, whatever the key order — used for the request fingerprint. */
export function stableStringify(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
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

export function makeOps({ core, rpc, companySettings, askModel }) {
  const need = (caller, ...perms) => { for (const p of perms) if (!core.can(caller.perms, p)) throw forbidden(p); };

  /** Check the typed items and work out rate, density and weight for each — the same way the prototype does. */
  function buildItems(caller, ctx, rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) throw bad('Add at least one item.');
    if (rawItems.length > 200) throw bad('Too many items on one slip (max 200).');
    const mats = new Map((ctx.materials || []).map((m) => [m.id, m]));
    const familyDensity = { ...core.DEFAULT_FAMILY_DENSITY, ...(ctx.settings.family_density || {}) };
    const minInch = ctx.settings.min_inch;
    const mayPrice = core.can(caller.perms, 'money'); // like the prototype: only money people see and change rates
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
    return { amount: amount(adv.amount, 'advance amount'), mode: payMethod(adv.mode), note: text(adv.note) };
  };

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
      const res = await rpc('api_create_order', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_customer: customer, p_rules: pricingRules(ctx),
        p_items: built.map((b) => b.db), p_accept: !!a.accept, p_advance: advance,
      });
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
      return rpc('api_accept_order', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: uuid(a.order_id, 'Which order?'), p_advance: advanceArg(caller, a.advance),
      });
    },

    async addAdvance(caller, a, key, hash) {
      need(caller, 'money');
      return rpc('api_add_advance', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: uuid(a.order_id, 'Which order?'),
        p_amount: amount(a.amount, 'advance amount'), p_mode: payMethod(a.mode), p_note: text(a.note),
      });
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
      const res = await rpc('api_record_weights', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: orderId,
        p_weights: weights, p_batches: batches, p_submit: !!a.submit,
      });
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
      const res = await rpc('api_finalize_order', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_order: orderId,
        p_final: {
          bill: f.bill, gst_pct: gstPct, kacha_pct: kachaPct, pay_mode: f.mode, paid_now: paidNow,
          pay_method: paidNow > 0 ? payMethod(a.pay_method) : null, note: text(a.note),
          in_khata: core.staysInKhata(advance + paidNow, T.total),
          basis: { advance, weights: Object.fromEntries(ctx.items.map((i) => [i.id, i.actual_weight == null ? null : Number(i.actual_weight)])) },
          totals: { weight: r3(T.wt), base: T.base, material: T.matK, cutting: T.cutK, gst: T.gst, total: T.total },
        },
      });
      return { ...res, breakdown: { material: T.matK, cutting: T.cutK, gst: T.gst, pct: T.pct, total: T.total, advance: f.A, balance: f.B, extra: f.extra, paid_now: paidNow, due: f.due } };
    },

    // ---------- khata ----------
    async recordPayment(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      if (!BILLS.includes(a.side)) throw bad('Choose Pakka or Kacha.');
      if (a.side === 'kacha') need(caller, 'kacha');
      return rpc('api_record_payment', {
        p_caller: caller.id, p_key: key, p_hash: hash, p_customer: uuid(a.customer_id, 'Choose a customer.'),
        p_amount: amount(a.amount, 'amount received'), p_mode: payMethod(a.mode), p_side: a.side, p_note: text(a.note),
      });
    },

    async reversePayment(caller, a, key, hash) {
      need(caller, 'money', 'khata');
      const note = text(a.note);
      if (!note) throw bad('Write why this payment is being cancelled.');
      return rpc('api_reverse_payment', { p_caller: caller.id, p_key: key, p_hash: hash, p_payment: uuid(a.payment_id, 'Which payment?'), p_note: note });
    },

    async saveCashCount(caller, a, key, hash) {
      need(caller, 'money', 'today');
      const counted = Number(a.counted);
      if (!Number.isFinite(counted) || counted < 0 || counted > 1e9) throw bad('Enter the cash you counted.');
      return rpc('api_save_cash_count', { p_caller: caller.id, p_key: key, p_hash: hash, p_counted: r2(counted), p_note: text(a.note) });
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
      return rpc('api_create_customer', { p_caller: caller.id, p_key: key, p_hash: hash, p_name: name, p_phone: text(a.phone, 30), p_notes: text(a.notes) });
    },

    async updateCustomer(caller, a, key, hash) {
      need(caller, 'new');
      const ch = a.changes && typeof a.changes === 'object' ? a.changes : {};
      const changes = {};
      for (const k of ['name', 'phone', 'notes']) if (k in ch) changes[k] = text(ch[k], k === 'name' ? 200 : k === 'phone' ? 30 : 500) ?? '';
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
      return rpc('api_change_settings', { p_caller: caller.id, p_key: key, p_hash: hash, p_changes: a.changes });
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

  return { ops, buildItems };
}

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
export const READ_OPS = new Set(['weighingList', 'askSteelQuestion']);

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
