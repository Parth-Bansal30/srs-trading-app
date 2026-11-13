// 13 Nov 2026 (Parth): each number can carry its own unit — "2 inch thick, 50 mm wide, 10 ft long".
// Plain numbers must work exactly as before (the prototype comparison stays green).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toMm, splitUnit, valueText, sizeText, lenText, convLen, parseLen, calcItem } from '../src/index.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} ≠ ${b}`);

test('plain numbers: as before', () => {
  near(toMm('50', 'mm'), 50); near(toMm('2', 'in'), 50.8); near(toMm('2 1/2', 'in'), 63.5); near(toMm(3, 'in'), 76.2);
  assert.ok(Number.isNaN(toMm('', 'mm'))); assert.ok(Number.isNaN(toMm('abc', 'mm')));
  assert.equal(sizeText(['40', '20'], 'mm'), '40 × 20 mm'); assert.equal(sizeText(['2'], 'in'), '2"');
  assert.equal(lenText('300', 'mm'), '300mm'); assert.equal(lenText('12', 'in'), '12"');
  assert.equal(convLen('25.4', 'mm', 'in'), '1');
});

test('each number with its own unit', () => {
  near(toMm('2in', 'mm'), 50.8); near(toMm('2"', 'mm'), 50.8); near(toMm('50mm', 'in'), 50);
  near(toMm('10ft', 'mm'), 3048); near(toMm("10'", 'mm'), 3048); near(toMm('2ft6in', 'mm'), 762); near(toMm('2 ft 6', 'mm'), 762);
  near(toMm('1½in', 'mm'), 38.1); near(toMm('½in', 'mm'), 12.7); near(toMm('5cm', 'mm'), 50);
  assert.deepEqual(splitUnit('10 feet'), { num: '10', unit: 'ft' });
  assert.equal(parseLen('2in'), 2);
  assert.equal(valueText('1½in', 'mm'), '1½"'); assert.equal(valueText('2ft6in', 'mm'), '2ft 6"');
  assert.equal(sizeText(['50', '2in'], 'mm'), '50 mm × 2"'); assert.equal(lenText('10ft', 'mm'), '10ft');
  assert.equal(convLen('10ft', 'mm', 'in'), '10ft', 'a value with its own unit is never converted');
});

test('weight and cutting: 2 inch thick × 50 mm wide flat, 10 ft long — same as typing it all in mm', () => {
  const base = { shape: 'flat', unit: 'mm', rate: 72, cutRate: 4, density: 7850 };
  const mixed = calcItem({ ...base, d: ['50', '2in'], rows: [{ len: '10ft', pcs: 1, cuts: '' }] }, 'est', { minInch: 1 });
  const mm = calcItem({ ...base, d: ['50', '50.8'], rows: [{ len: '3048', pcs: 1, cuts: '' }] }, 'est', { minInch: 1 });
  near(mixed.est, mm.est); assert.equal(mixed.total, mm.total); near(mixed.est, 60.77, 0.01);
  const rd = calcItem({ shape: 'round', unit: 'mm', d: ['20'], rows: [{ len: '2ft', pcs: 4, cuts: '' }], rate: 98, cutRate: 4, density: 7850 }, 'est', { minInch: 1 });
  near(rd.est, 6.01, 0.01); assert.equal(rd.cut, 12.57);
});

test('each line of a slip: amounts that add up exactly to the saved slip', async () => {
  const { lineShares } = await import('../src/index.js');
  const items = [
    { shape: 'round', unit: 'mm', d: ['20'], rows: [{ len: '2ft', pcs: 4, cuts: '' }], rate: 98, cutRate: 4, density: 7850, aw: 6.1 },
    { shape: 'flat', unit: 'mm', d: ['50', '2in'], rows: [{ len: '10ft', pcs: 1, cuts: '' }], rate: 72, cutRate: 4, density: 7850, aw: 61 },
  ];
  const s = lineShares(items, { material: 4989.8, cutting: 28.57, minInch: 1 });
  assert.equal(s.length, 2);
  assert.equal(Math.round((s[0].amount + s[1].amount) * 100) / 100, Math.round((4989.8 + 28.57) * 100) / 100);
  assert.equal(s[0].material, 597.8); assert.equal(s[1].material, 4392);
  assert.equal(s[0].cutting, 12.57); assert.equal(s[1].cutting, 16);
  // a no-bill slip saved with its extra %: the lines carry it in the same share
  const k = lineShares(items, { material: 5488.78, cutting: 31.43, minInch: 1 });
  assert.equal(Math.round((k[0].amount + k[1].amount) * 100) / 100, 5520.21);
});
