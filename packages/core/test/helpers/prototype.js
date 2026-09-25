/**
 * Loads the frozen prototype (prototype/v6) in an isolated sandbox so tests can call
 * its real functions and compare them with @srs/core. Values cross the sandbox
 * boundary as JSON, so comparisons are plain data.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROTO_DIR = path.resolve(here, '../../../../prototype/v6');
const read = (f) => fs.readFileSync(path.join(PROTO_DIR, f), 'utf8');

/** Pull one top-level function out of p3.js (screens file) by its source text. */
function extract(src, start, endMarker) {
  const i = src.indexOf(start);
  const j = src.indexOf(endMarker, i);
  if (i < 0 || j < 0) throw new Error(`prototype function not found: ${start}`);
  return src.slice(i, j);
}

export function loadPrototype() {
  const p3 = read('p3.js');
  const src = [read('p0.js'), read('p2.js'), extract(p3, 'function finCalc(o,p){', '\nconst finNote')].join('\n;\n');
  const store = {};
  const ctx = vm.createContext({
    console,
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: { querySelector: () => null },
    navigator: {},
  });
  vm.runInContext(`${src}\n;seedDb();`, ctx, { filename: 'prototype-v6' });
  const run = (code) => vm.runInContext(code, ctx);
  /** Call a prototype expression with a JSON input bound to `IN`; returns plain data. */
  const call = (expr, input) => {
    ctx.__in = JSON.stringify(input ?? null);
    const out = run(`JSON.stringify((()=>{const IN=JSON.parse(__in);return (${expr});})())`);
    return out === undefined ? undefined : JSON.parse(out);
  };
  const reseed = () => run('seedDb()');
  const dbData = () => JSON.parse(run('JSON.stringify(db)'));
  return { run, call, reseed, dbData };
}

/** Same data through the same JSON trip, so both sides compare fairly. */
export const plain = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

/** Small deterministic random generator, so every run tests the same cases. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    num: (lo, hi, dp = 2) => +(lo + next() * (hi - lo)).toFixed(dp),
    chance: (p) => next() < p,
  };
}
