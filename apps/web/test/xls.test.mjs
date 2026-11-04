// Old Excel (.xls) statements read on the phone (4 Nov 2026). The fixtures are MADE-UP statements in real Indian bank
// layouts, written as .xls by LibreOffice (like net banking does); every cell was checked against xlrd when they were made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { xlsSheets, isOle } from '../src/lib/xls.js';
import { readStatementRows } from '../../../packages/core/src/bankStatement.js';

const read = (f, opts) => readStatementRows(xlsSheets(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url)))[0].rows, { today: '2026-10-12', ...opts });

test('old Excel: HDFC / ICICI / PNB (date cells) / Kotak (one amount + Dr/Cr) all read and add up', () => {
  for (const f of ['hdfc.xls', 'icici.xls', 'pnb.xls', 'kotak.xls']) {
    const r = read(f);
    assert.equal(r.lines.length, 11, f); assert.equal(r.adds_up, true, f);
    assert.equal(r.opening, 152400, f); assert.equal(r.closing, 101288.3, f);
    assert.equal(r.lines.filter((l) => l.doubts?.length).length, 0, f);
  }
  assert.equal(read('pnb.xls').lines[0].day, '2026-10-01', 'a real Excel date cell becomes the day');
});

test('a layout never seen: columns found from what is in them, proved by the balance', () => {
  const r = read('unknown.xls');
  assert.equal(r.layout, 'content'); assert.equal(r.adds_up, true); assert.equal(r.lines.length, 11);
  assert.equal(r.lines.find((l) => /BSES/.test(l.narration)).amount, -4820);
});

test('never a guess: dates both ways → ask; no direction → each line flagged; an unreadable amount → shown, not saved', () => {
  const a = read('ambiguous.xls');
  assert.equal(a.dateStyle.sure, false); assert.ok(a.lines.every((l) => l.doubts.includes('date_style'))); assert.equal(a.adds_up, false);
  const b = read('ambiguous.xls', { dateStyle: 'dmy' });
  assert.equal(b.lines[0].day, '2025-05-04'); assert.equal(b.adds_up, true);
  const n = read('nodirection.xls');
  assert.ok(n.lines.every((l) => l.doubts.includes('direction'))); assert.equal(n.adds_up, false);
  const u = read('unreadable.xls');
  assert.equal(u.unreadable.length, 1); assert.match(u.unreadable[0].text, /10,O00\.00/); assert.equal(u.adds_up, false);
});

test('not an old Excel file → xls_bad', () => {
  assert.equal(isOle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), false);
  assert.throws(() => xlsSheets(new Uint8Array(600)), /xls_bad/);
});
