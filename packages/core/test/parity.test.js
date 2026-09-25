/**
 * PARITY: @srs/core must give exactly the same answers as the approved prototype (v6).
 * Runs the real prototype code in a sandbox and compares on the sample data plus
 * thousands of generated cases. If any number differs, the test fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.js';
import { loadPrototype, plain, rng } from './helpers/prototype.js';

const P = loadPrototype();
const SET = P.dbData().set; // prototype defaults: gstPct 18, kachaPct 10, minInch 1
const opts = (minInch = SET.minInch) => ({ gstPct: SET.gstPct, kachaPct: SET.kachaPct, minInch });

/* ---------- generated items: every shape, both units, awkward inputs ---------- */
function genItem(r) {
  const shape = r.pick(core.SHAPE_IDS);
  const unit = r.pick(['mm', 'mm', 'in']);
  const mmVal = () => r.pick([r.int(1, 400), r.num(0.5, 300, 1), String(r.int(5, 250)), r.num(3, 13, 2)]);
  const inVal = () => r.pick([r.num(0.25, 16, 2), r.int(1, 12), `${r.int(1, 9)} 1/2`, `${r.int(1, 5)}-3/4`, '3/4', '1/8']);
  const val = unit === 'in' ? inVal : mmVal;
  const bad = () => r.pick(['', 0, -5, 'abc', null]);
  const nd = core.SHAPES[shape].dims.length;
  const d = Array.from({ length: nd }, () => (r.chance(0.04) ? bad() : val()));
  const lenVal = () => (unit === 'in' ? r.pick([r.num(0.5, 240, 2), `${r.int(2, 120)} 1/4`, r.int(1, 200)]) : r.pick([r.int(5, 6000), r.num(10, 3000, 1), String(r.int(20, 1500))]));
  const rows = Array.from({ length: r.int(1, 3) }, () => ({
    len: r.chance(0.03) ? bad() : lenVal(),
    pcs: r.chance(0.03) ? r.pick([0, '', '3.7', -2]) : r.pick([r.int(1, 60), String(r.int(1, 20))]),
    cuts: r.pick(['', '', '', r.int(0, 80), String(r.int(0, 30))]),
  }));
  return {
    matId: r.pick(['MS', 'EN8', 'EN19', 'EN24', 'SS304']),
    shape, unit, d, rows,
    rate: r.pick([r.num(30, 400, 2), r.int(40, 350), String(r.num(50, 120, 1))]),
    cutRate: r.pick([r.num(0, 10, 2), r.int(0, 8), 0]),
    density: r.chance(0.03) ? null : r.pick([7850, 7930, 7700, 7980, r.num(7600, 8100, 0)]),
    aw: r.pick([null, null, '', 0, r.num(0.1, 900, 2), r.num(1, 50, 1)]),
  };
}

test('calcItem: sample orders (est + final) match the prototype', () => {
  const db = P.dbData();
  let n = 0;
  db.orders.forEach((o, oi) => o.items.forEach((it, ii) => {
    for (const mode of ['est', 'final']) {
      const want = P.call(`calcItem(db.orders[${oi}].items[${ii}], '${mode}')`);
      assert.deepEqual(plain(core.calcItem(it, mode, opts())), want, `order ${o.id} item ${ii} ${mode}`);
      n++;
    }
  }));
  assert.ok(n >= 20);
});

test('calcItem: 5,000 generated items match the prototype exactly (all shapes, mm/inch, fractions, bad input, minInch 0/1/2)', () => {
  const r = rng(20260925);
  let valid = 0;
  for (let k = 0; k < 5000; k++) {
    const it = genItem(r);
    const minInch = r.pick([0, 1, 1, 2]);
    P.run(`db.set.minInch=${minInch}`);
    for (const mode of ['est', 'final']) {
      const want = P.call(`calcItem(IN, '${mode}')`, it);
      const got = plain(core.calcItem(it, mode, { minInch }));
      assert.deepEqual(got, want, `case ${k} ${mode}: ${JSON.stringify(it)} minInch=${minInch}`);
      if (want) valid++;
    }
  }
  P.run(`db.set.minInch=${SET.minInch}`);
  assert.ok(valid > 6000, `enough complete items were priced (${valid})`);
});

test('orderTotals: 2,000 generated orders × every bill type match the prototype', () => {
  const r = rng(7);
  for (let k = 0; k < 2000; k++) {
    const o = {
      id: 9000 + k,
      items: Array.from({ length: r.int(1, 4) }, () => genItem(r)),
      bill: r.pick([null, 'pakka', 'kacha']),
      gstPct: r.pick([null, null, 18, 12, 5, 28]),
      kachaPct: r.pick([null, null, 10, 8, 12.5]),
    };
    for (const mode of ['est', 'final']) {
      assert.deepEqual(plain(core.orderTotals(o, mode, opts())), P.call(`orderTotals(IN,'${mode}')`, o), `order ${k} ${mode}`);
      for (const b of [null, 'pakka', 'kacha']) {
        assert.deepEqual(
          plain(core.orderTotals(o, mode, { ...opts(), bill: b })),
          P.call(`orderTotals(IN,'${mode}',${JSON.stringify(b)})`, o),
          `order ${k} ${mode} override ${b}`,
        );
      }
    }
  }
});

test('finishing (bill, advance, paid now/later/part) matches the prototype for every sample order', () => {
  const db = P.dbData();
  let n = 0;
  db.orders.forEach((o, oi) => {
    const advance = core.advanceOf(o.id, db.pays);
    for (const bill of [null, 'pakka', 'kacha'])
      for (const mode of [undefined, 'now', 'later', 'part'])
        for (const paid of [undefined, '', 0, 500, 2000.5, 99999999]) {
          const p = { bill, mode, paid };
          const want = P.call(`finCalc(db.orders[${oi}], IN)`, p);
          const got = core.finishCalc({ order: o, advance, bill, payMode: mode, paid, gstPct: SET.gstPct, kachaPct: SET.kachaPct, minInch: SET.minInch });
          assert.deepEqual(plain(got), want, `order ${o.id} ${JSON.stringify(p)}`);
          n++;
        }
  });
  assert.ok(n > 500);
});

test('khata ledger matches the prototype: sample data, every customer, every side view', () => {
  const db = P.dbData();
  const all = ['pakka', 'kacha'];
  for (const c of db.cust)
    for (const sides of [all, ['pakka'], ['kacha']]) {
      const want = P.call(`ledger(${JSON.stringify(c.id)}, ${JSON.stringify(sides)})`);
      const got = core.customerLedger({ custId: c.id, orders: db.orders, payments: db.pays, sides, allSides: all, totals: opts() });
      assert.deepEqual(plain(got), want, `${c.name} ${sides}`);
    }
});

test('khata ledger matches the prototype: 300 random scenarios of extra payments and overpayments', () => {
  const r = rng(99);
  const all = ['pakka', 'kacha'];
  for (let k = 0; k < 300; k++) {
    P.reseed();
    const base = P.dbData();
    const extra = Array.from({ length: r.int(1, 6) }, (_, j) => ({
      id: `px${k}_${j}`,
      cust: r.pick(base.cust).id,
      at: new Date(Date.now() - r.int(0, 60) * 86400000 - r.int(0, 86399) * 1000).toISOString(),
      amt: r.pick([r.num(1, 60000, 2), r.int(100, 20000), 0.01]),
      mode: r.pick(['Cash', 'UPI', 'Bank', 'Cheque']),
      side: r.pick(['pakka', 'kacha']),
      oid: r.chance(0.3) ? r.pick(base.orders).id : null,
      kind: r.pick(['due', 'due', 'advance', 'pay']),
    }));
    P.call('(db.pays.push(...IN), true)', extra);
    const db = P.dbData();
    for (const c of db.cust)
      for (const sides of [all, ['pakka'], ['kacha']]) {
        const want = P.call(`ledger(${JSON.stringify(c.id)}, ${JSON.stringify(sides)})`);
        const got = core.customerLedger({ custId: c.id, orders: db.orders, payments: db.pays, sides, allSides: all, totals: opts() });
        assert.deepEqual(plain(got), want, `scenario ${k} ${c.name} ${sides}`);
      }
  }
  P.reseed();
});

// The prototype reads the device clock; compare only when this machine runs on Indian time (+5:30).
const inIndia = new Date('2026-01-15T00:00:00Z').getTimezoneOffset() === -330 && new Date('2026-07-15T00:00:00Z').getTimezoneOffset() === -330;
test('slip numbers (keys, date tags, formats) match the prototype on Indian time', { skip: !inIndia && 'prototype reads the device clock; run with TZ=Asia/Kolkata' }, () => {
  const r = rng(3);
  const edges = ['2026-03-31T18:29:59Z', '2026-03-31T18:30:00Z', '2026-09-22T18:29:59.999Z', '2026-09-22T18:30:00Z', '2025-12-31T18:30:00Z', '2028-02-28T19:00:00Z'];
  const dates = [...edges, ...Array.from({ length: 3000 }, () => new Date(Date.UTC(2024, 0, 1) + Math.floor(r.next() * 7 * 365 * 86400000)).toISOString())];
  for (const iso of dates)
    for (const s of ['never', 'daily', 'monthly', 'yearly']) {
      assert.equal(core.slipKeyFor(s, iso), P.call(`slipKeyFor(${JSON.stringify(s)}, IN)`, iso), `key ${s} ${iso}`);
      assert.equal(core.slipTagFor(s, iso), P.call(`slipTagFor(${JSON.stringify(s)}, IN)`, iso), `tag ${s} ${iso}`);
      assert.equal(core.formatSlipNo(s, iso, 7), P.call(`formatSlipNo(${JSON.stringify(s)}, IN, 7)`, iso), `format ${s} ${iso}`);
    }
});
