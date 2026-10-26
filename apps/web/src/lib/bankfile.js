// Reading a bank statement file on the phone (25 Oct 2026): Excel (.xlsx), CSV / text, the ".xls" files many Indian banks
// send (often a web page or tab text inside), and PDF (with its password when the bank locked it). The rows / text lines
// go to @srs/core (readStatementRows / readStatementText); the file itself never leaves the phone.
// The PDF and Excel readers load only when a statement is opened (they are big).
import { readStatementRows, readStatementText, csvRows } from '@srs/core';

export class StatementError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const ext = (name) => (String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';

/** Read a statement file → { lines, opening, closing, from, to, adds_up, checked, problems, kind }. password: for a locked PDF. */
export async function readStatementFile(file, password = null) {
  const e = ext(file.name);
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;   // %PDF
  const isZip = head[0] === 0x50 && head[1] === 0x4b;                                            // PK (xlsx)
  const isOle = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;   // old Excel (.xls)
  let r;
  if (isPdf || e === 'pdf') r = { ...readStatementText(await pdfLines(file, password)), kind: 'pdf' };
  else if (isZip || e === 'xlsx') r = { ...readStatementRows(await xlsxRows(file)), kind: 'xlsx' };
  else if (isOle) throw new StatementError('xls_old');
  else {
    const text = await file.text();
    r = /^\s*</.test(text) ? { ...readStatementRows(htmlRows(text)), kind: 'html' } : { ...readStatementRows(csvRows(text)), kind: 'csv' };
  }
  if (!r.lines.length) throw new StatementError(r.problems?.includes('no_header') ? 'no_header' : 'no_lines');
  return r;
}

// ---------- PDF ----------
async function pdfLines(file, password) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password: password || undefined, isEvalSupported: false }).promise;
  } catch (err) {
    if (err?.name === 'PasswordException') throw new StatementError(err.code === 2 ? 'password_wrong' : 'password');
    throw new StatementError('pdf_bad');
  }
  const out = [];
  for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    // group the text pieces into lines by their height on the page (a little tolerance), left to right
    const rows = [];
    for (const it of tc.items) {
      const s = String(it.str || '');
      if (!s.trim()) continue;
      const y = it.transform[5]; const x = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ str: s, x, w: it.width || 0 });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) out.push({ items: mergeClose(r.items.sort((a, b) => a.x - b.x)) });
  }
  if (!out.length) throw new StatementError('pdf_scan');   // a photo / scan: no text inside
  return out;
}
/** Pieces of one word or one amount printed side by side ("1,25,", "000.00") become one. */
function mergeClose(items) {
  const res = [];
  for (const it of items) {
    const prev = res[res.length - 1];
    if (prev && it.x - (prev.x + prev.w) < 1.5 && !/\s$/.test(prev.str)) { prev.str += it.str; prev.w = it.x + it.w - prev.x; } else res.push({ ...it });
  }
  return res;
}

// ---------- Excel (.xlsx) ----------
async function xlsxRows(file) {
  const { unzipSync, strFromU8 } = await import('fflate');
  let files;
  try { files = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => /^xl\/(sharedStrings|workbook)\.xml$|^xl\/worksheets\/sheet\d+\.xml$|^xl\/_rels\/workbook\.xml\.rels$/.test(f.name) }); }
  catch { throw new StatementError('xlsx_bad'); }
  const xml = (name) => (files[name] ? new DOMParser().parseFromString(strFromU8(files[name]), 'application/xml') : null);
  const shared = [];
  const ss = xml('xl/sharedStrings.xml');
  if (ss) for (const si of ss.getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  // the first sheet of the workbook
  let sheet = 'xl/worksheets/sheet1.xml';
  const wb = xml('xl/workbook.xml'); const rels = xml('xl/_rels/workbook.xml.rels');
  const first = wb?.getElementsByTagName('sheet')[0];
  const rid = first?.getAttribute('r:id') || first?.getAttributeNS?.('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  if (rid && rels) {
    const rel = [...rels.getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
    const target = rel?.getAttribute('Target');
    if (target) sheet = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  const doc = xml(sheet) || xml(Object.keys(files).find((f) => f.startsWith('xl/worksheets/')) || '');
  if (!doc) throw new StatementError('xlsx_bad');
  const colNo = (ref) => { const m = String(ref || '').match(/^([A-Z]+)/); return m ? [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : -1; };
  const rows = [];
  for (const row of doc.getElementsByTagName('row')) {
    const cells = [];
    let k = 0;
    for (const c of row.getElementsByTagName('c')) {
      const at = colNo(c.getAttribute('r')); const i = at >= 0 ? at : k;
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0]?.textContent ?? '';
      let val = v;
      if (type === 's') val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = [...c.getElementsByTagName('t')].map((t) => t.textContent).join('');
      else if (type !== 'str' && type !== 'b' && v !== '' && !Number.isNaN(Number(v))) val = Number(v);
      cells[i] = val; k = i + 1;
    }
    rows.push(Array.from(cells, (x) => (x == null ? '' : x)));
  }
  return rows;
}

// ---------- a web page saved as ".xls" ----------
function htmlRows(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const rows = [];
  for (const tr of doc.querySelectorAll('tr')) rows.push([...tr.querySelectorAll('th,td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
  return rows;
}
