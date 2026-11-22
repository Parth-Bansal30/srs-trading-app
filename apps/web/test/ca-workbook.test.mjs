// The CA's Excel file (22 Nov 2026): every sheet the returns need, numbers kept as numbers, totals that agree.
// Made-up data, worked out by the server's own month maths (ops.gstMonth with a fake database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import * as core from '../../../packages/core/src/index.js';
import { makeOps } from '../../../supabase/functions/api/ops.js';
import { WORDS } from '../src/content/words.js';
import { caWorkbook } from '../src/screens/ca/caWorkbook.js';

const w = (k, ...a) => (WORDS[k]?.[0] || k).replace(/\{(\d)\}/g, (_, i) => String(a[Number(i)] ?? ''));
const day = (d) => `2026-10-${String(d).padStart(2, '0')}`;
const item = (kg, rate) => ({ id: 'x', grade_code: 'EN8', shape: 'round', unit: 'mm', dims: ['40'], sell_rate: rate, cut_rate: 0, density: 7850, actual_weight: kg, by_weight: true, lengths: [] });
const det = (no, extra = {}) => ({ delivery: 'pickup', dest_state: '07', pos: { from: '07', to: '07', kind: 'local', sure: true }, tally_no: no, tally_date: day(5),
  items: [{ item_id: 'x', hsn: '7214', gst_rate: 18, hsn_checked: true }], ...extra });
const raw = {
  shop: { name: 'Test Steels', gstin: '07AABCS1429B1ZW', state: '07' }, settings: { gst_pct: 18, min_inch: 1 },
  slips: [
    { id: 's1', slip_no: 701, date: day(2), customer: 'Laxmi', gstin: '07AABCS1429B1ZW', gst_pct: 18, base: 7400, gst: 1332, total: 8732, status: 'done', has_address: true,
      gst_details: det('SRS/26-27/0131', { tally_total: 8732 }), items: [item(100, 74)] },
    { id: 's2', slip_no: 702, date: day(3), customer: 'Walk-in', gstin: null, gst_pct: 18, base: 74000, gst: 13320, total: 87320, status: 'done', has_address: false,
      gst_details: det('SRS/26-27/0133', { pos: { from: '07', to: '06', kind: 'inter', sure: true } }), items: [item(1000, 74)] },
  ],
  cancelled: [], purchases: [{ bill_no: 'PK/1', date: day(1), supplier: 'P K', gstin: '06AABCS1429B1ZY', gst_status: 'active', gst: 1800, freight: 0, other: 0, round_off: 0,
    total: 11800, stock_effect: 'stock', lines: [{ hsn: '7214', description: 'MS', kg: 150, amount: 10000 }] }],
  expenses: [{ date: day(5), bill_no: 'B-1', paid_to: 'Blades', seller_gstin: '07AABCS1429B1ZW', category: 'blade', amount: 1180, gst_amount: 180 }],
  supplier_notes: [], unpaid180: [], pending_before: [], sent: [],
};

test('the CA file: eleven sheets; the sales register, HSN summary and GSTR-3B agree', async () => {
  const { ops } = makeOps({ core, rpc: async () => structuredClone(raw), companySettings: async () => ({}), askModel: null });
  const owner = { id: 'p', company_id: 'c', perms: core.ROLE_PRESETS.owner() };
  const m = await ops.gstMonth(owner, { month: '2026-10' });
  const bytes = caWorkbook(m, { w, flagText: (f) => (f || []).join('; '), monthName: () => 'October 2026' });
  const files = unzipSync(bytes);
  const book = strFromU8(files['xl/workbook.xml']);
  const names = [...book.matchAll(/<sheet name="([^"]+)"/g)].map((x) => x[1]);
  assert.deepEqual(names, ['Summary', 'Checks', 'Sales register', 'HSN summary', 'Tally bill numbers', 'Purchase register', 'GST expenses', 'Supplier credit notes',
    'Deleted after Tally bill', 'GSTR-3B (rough)', 'Unpaid 180 days']);
  const sheet = (n) => strFromU8(files[`xl/worksheets/sheet${names.indexOf(n) + 1}.xml`]);
  assert.match(sheet('Sales register'), /B2B \(Table 4\)/);
  assert.match(sheet('Sales register'), /B2C \(Table 7\)/, '₹87,320 to another state is not over ₹1 lakh: B2C others');
  assert.match(sheet('Sales register'), /<v>96052<\/v>/, 'the total as a number');
  assert.match(sheet('HSN summary'), /Matches the sales register/);
  assert.match(sheet('Tally bill numbers'), /SRS\/26-27\/0132/, 'the number missing from the app is listed');
  assert.match(sheet('GSTR-3B (rough)'), /<v>14652<\/v>/, 'tax on sales 1,332 + 13,320');
  assert.match(sheet('GSTR-3B (rough)'), /<v>1980<\/v>/, 'GST on our bills 1,800 + 180');
  assert.match(sheet('GSTR-3B (rough)'), /Haryana/, 'Table 3.2: the inter-state sale without a GST no., by state');
  assert.match(sheet('Summary'), /s="1"/, 'section rows are bold');
  assert.equal(m.gst3b.to_pay, 12672);
});
