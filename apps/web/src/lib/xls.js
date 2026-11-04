/**
 * The OLD Excel format (.xls, Excel 97–2003 "BIFF8", and Excel 95 "BIFF5") read on the phone (4 Nov 2026, plan v2 F4).
 * HDFC, ICICI, SBI, BoB, PNB and many other Indian banks give statements in it. No library: the file is a "compound
 * file" (a small FAT file system) holding a "Workbook" (or "Book") stream of records; we read the cells we need —
 * shared strings, text, numbers, RK numbers, formula results — and turn date-formatted numbers into 'YYYY-MM-DD'.
 * Returns [{ name, rows: [[cell…]…] }] (one per sheet). Throws Error('xls_bad') when it isn't a readable .xls.
 */

const SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ENDOFCHAIN = 0xfffffffe; const FREESECT = 0xffffffff;
const bad = () => { const e = new Error('xls_bad'); e.code = 'xls_bad'; return e; };

/** Is this an OLE compound file (an old .xls / .doc)? */
export const isOle = (u8) => SIG.every((b, i) => u8[i] === b);

// ---------------------------------------------------------------- the compound file
function cfbStream(u8, wanted) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (!isOle(u8)) throw bad();
  const secSize = 1 << dv.getUint16(0x1e, true);
  const miniSize = 1 << dv.getUint16(0x20, true);
  const nFat = dv.getUint32(0x2c, true);
  const dirStart = dv.getUint32(0x30, true);
  const cutoff = dv.getUint32(0x38, true);
  const miniFatStart = dv.getUint32(0x3c, true);
  let difatSec = dv.getUint32(0x44, true);
  const off = (s) => (s + 1) * secSize;
  if (secSize !== 512 && secSize !== 4096) throw bad();
  // the FAT's own sectors: 109 in the header, then the DIFAT chain
  const fatSecs = [];
  for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(0x4c + i * 4, true));
  let guard = 0;
  while (fatSecs.length < nFat && difatSec !== ENDOFCHAIN && difatSec !== FREESECT && guard++ < 10000) {
    const o = off(difatSec);
    for (let i = 0; i < secSize / 4 - 1 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(o + i * 4, true));
    difatSec = dv.getUint32(o + secSize - 4, true);
  }
  const per = secSize / 4;
  const fat = new Uint32Array(fatSecs.length * per);
  fatSecs.forEach((s, k) => { const o = off(s); if (o + secSize > u8.length) throw bad(); for (let i = 0; i < per; i++) fat[k * per + i] = dv.getUint32(o + i * 4, true); });
  const chain = (start, table, max) => {
    const out = []; let s = start; let n = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < table.length && n++ < max) { out.push(s); s = table[s]; }
    return out;
  };
  const readChain = (start, size) => {
    const secs = chain(start, fat, (u8.length / secSize) + 2);
    const buf = new Uint8Array(secs.length * secSize);
    secs.forEach((s, i) => buf.set(u8.subarray(off(s), Math.min(off(s) + secSize, u8.length)), i * secSize));
    return size == null ? buf : buf.subarray(0, size);
  };
  // the directory
  const dir = readChain(dirStart, null);
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = ddv.getUint16(o + 0x40, true);
    let name = '';
    for (let i = 0; i < Math.max(0, nameLen / 2 - 1); i++) name += String.fromCharCode(ddv.getUint16(o + i * 2, true));
    entries.push({ name, type: dir[o + 0x42], start: ddv.getUint32(o + 0x74, true), size: ddv.getUint32(o + 0x78, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const want = entries.find((e) => e.type === 2 && wanted.includes(e.name));
  if (!root || !want) throw bad();
  if (want.size >= cutoff) return readChain(want.start, want.size);
  // a small stream lives in the mini stream
  const miniStream = readChain(root.start, root.size);
  const mfRaw = readChain(miniFatStart, null);
  const mdv = new DataView(mfRaw.buffer, mfRaw.byteOffset, mfRaw.byteLength);
  const miniFat = new Uint32Array(mfRaw.length / 4);
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = mdv.getUint32(i * 4, true);
  const secs = chain(want.start, miniFat, miniStream.length / miniSize + 2);
  const buf = new Uint8Array(secs.length * miniSize);
  secs.forEach((s, i) => buf.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
  return buf.subarray(0, want.size);
}

// ---------------------------------------------------------------- the workbook records
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const looksDateFormat = (f) => {
  const s = String(f || '').replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /[dy]/i.test(s) && !/^[#0.,%\s]*$/.test(s);
};
const pad = (n) => String(n).padStart(2, '0');
function serialDay(v, mode1904) {
  const days = Math.floor(v) + (mode1904 ? 1462 : 0);
  if (!(days > 0 && days < 80000)) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function rkValue(rk) {
  let v;
  if (rk & 2) v = rk >> 2;                        // a 30-bit integer
  else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, rk & 0xfffffffc, true); b.setUint32(0, 0, true); v = b.getFloat64(0, true); }
  return rk & 1 ? v / 100 : v;
}
const latin1 = (u8, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[o + i]); return s; };
const utf16 = (u8, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[o + i * 2] | (u8[o + i * 2 + 1] << 8)); return s; };

/** A BIFF8 "unicode string" at o (with a 2-byte length when long, else 1). → { s, end } */
function ustr(u8, o, longLen = true) {
  const n = longLen ? u8[o] | (u8[o + 1] << 8) : u8[o];
  let p = o + (longLen ? 2 : 1);
  const flags = u8[p++];
  const wide = flags & 1; const rich = flags & 8; const ext = flags & 4;
  let runs = 0; let extLen = 0;
  if (rich) { runs = u8[p] | (u8[p + 1] << 8); p += 2; }
  if (ext) { extLen = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24); p += 4; }
  const s = wide ? utf16(u8, p, n) : latin1(u8, p, n);
  p += n * (wide ? 2 : 1);
  return { s, end: p + runs * 4 + extLen };
}

/** The shared string table: its strings may run on into CONTINUE records (with a fresh flags byte at each start). */
function readSst(parts) {
  const out = [];
  let k = 0; let buf = parts[0]; let p = 8;
  const total = buf.length >= 8 ? (buf[4] | (buf[5] << 8) | (buf[6] << 16) | (buf[7] << 24)) >>> 0 : 0;
  const need = (n) => { while (p + n > buf.length && k + 1 < parts.length && p >= buf.length) { k++; buf = parts[k]; p = 0; } };
  while (out.length < total) {
    need(3);
    if (p + 3 > buf.length) break;
    const n = buf[p] | (buf[p + 1] << 8);
    let flags = buf[p + 2]; p += 3;
    let runs = 0; let extLen = 0;
    if (flags & 8) { runs = buf[p] | (buf[p + 1] << 8); p += 2; }
    if (flags & 4) { extLen = (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0; p += 4; }
    let s = ''; let left = n;
    while (left > 0) {
      if (p >= buf.length) { if (k + 1 >= parts.length) break; k++; buf = parts[k]; p = 0; flags = buf[p++]; }
      const wide = flags & 1;
      const can = Math.min(left, Math.floor((buf.length - p) / (wide ? 2 : 1)));
      s += wide ? utf16(buf, p, can) : latin1(buf, p, can);
      p += can * (wide ? 2 : 1); left -= can;
      if (can === 0 && left > 0) { if (k + 1 >= parts.length) break; k++; buf = parts[k]; p = 0; flags = buf[p++]; }
    }
    // skip formatting runs / extended data (they may also cross into the next CONTINUE)
    let skip = runs * 4 + extLen;
    while (skip > 0) { const take = Math.min(skip, buf.length - p); p += take; skip -= take; if (skip > 0) { if (k + 1 >= parts.length) break; k++; buf = parts[k]; p = 0; } }
    out.push(s);
  }
  return out;
}

/** An .xls file (bytes) → [{ name, rows }]. */
export function xlsSheets(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  let wb;
  try { wb = cfbStream(u8, ['Workbook', 'Book', 'WORKBOOK', 'BOOK']); } catch { throw bad(); }
  const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  const rec = (o) => ({ type: dv.getUint16(o, true), len: dv.getUint16(o + 2, true) });
  // pass 1: the workbook globals (version, sheets, strings, number formats, date mode)
  let o = 0; let biff = 8; let mode1904 = false;
  const sheets = []; const formats = new Map(); const xfFmt = []; let sstParts = null; let inSst = false;
  while (o + 4 <= wb.length) {
    const { type, len } = rec(o); const d = o + 4;
    if (d + len > wb.length) break;
    const body = wb.subarray(d, d + len);
    if (type === 0x0809 && o === 0) biff = dv.getUint16(d, true) === 0x0500 ? 5 : 8;
    else if (type === 0x0085) {                       // BOUNDSHEET
      const pos = dv.getUint32(d, true); const kind = body[5];
      const name = biff === 8 ? ustr(body, 6, false).s : latin1(body, 7, body[6]);
      if (kind === 0) sheets.push({ name, pos });
    } else if (type === 0x00fc) { sstParts = [body]; inSst = true; }
    else if (type === 0x003c && inSst) sstParts.push(body);
    else if (type === 0x041e || type === 0x001e) {     // FORMAT
      const id = dv.getUint16(d, true);
      formats.set(id, biff === 8 ? ustr(body, 2, true).s : latin1(body, 3, body[2]));
    } else if (type === 0x00e0) xfFmt.push(dv.getUint16(d + 2, true));
    else if (type === 0x0022) mode1904 = dv.getUint16(d, true) === 1;
    else if (type === 0x000a) break;                   // end of the globals
    if (type !== 0x003c && type !== 0x00fc) inSst = false;
    o = d + len;
  }
  const sst = sstParts ? readSst(sstParts) : [];
  const isDateXf = (xf) => { const f = xfFmt[xf]; return f != null && (BUILTIN_DATE.has(f) || (formats.has(f) && looksDateFormat(formats.get(f)))); };
  const num = (xf, v) => (isDateXf(xf) ? serialDay(v, mode1904) || v : v);
  // pass 2: every worksheet's cells
  return sheets.map((sh) => {
    const rows = [];
    const put = (r, c, v) => { if (r > 65535 || c > 255) return; (rows[r] ||= [])[c] = v; };
    let p = sh.pos; let pendingString = null;
    while (p + 4 <= wb.length) {
      const { type, len } = rec(p); const d = p + 4;
      if (d + len > wb.length) break;
      const body = wb.subarray(d, d + len);
      const r = len >= 4 ? dv.getUint16(d, true) : 0; const c = len >= 4 ? dv.getUint16(d + 2, true) : 0;
      if (type === 0x00fd) put(r, c, sst[dv.getUint32(d + 6, true)] ?? '');                               // LABELSST
      else if (type === 0x0203) put(r, c, num(dv.getUint16(d + 4, true), dv.getFloat64(d + 6, true)));      // NUMBER
      else if (type === 0x027e) put(r, c, num(dv.getUint16(d + 4, true), rkValue(dv.getInt32(d + 6, true)))); // RK
      else if (type === 0x00bd) {                                                                          // MULRK
        const last = dv.getUint16(d + len - 2, true);
        for (let k = 0, col = c; col <= last && 4 + k * 6 + 6 <= len - 2; k++, col++) put(r, col, num(dv.getUint16(d + 4 + k * 6, true), rkValue(dv.getInt32(d + 6 + k * 6, true))));
      } else if (type === 0x0204 || type === 0x00d6) {                                                     // LABEL / RSTRING
        put(r, c, biff === 8 ? ustr(body, 6, true).s : latin1(body, 8, dv.getUint16(d + 6, true)));
      } else if (type === 0x0006) {                                                                        // FORMULA (its result)
        const xf = dv.getUint16(d + 4, true);
        if (dv.getUint16(d + 12, true) === 0xffff) {
          const k = body[6];
          if (k === 0) pendingString = [r, c];
          else if (k === 1) put(r, c, body[8] ? 'TRUE' : 'FALSE');
        } else put(r, c, num(xf, dv.getFloat64(d + 6, true)));
      } else if (type === 0x0207 && pendingString) {                                                       // STRING (a formula's text)
        put(pendingString[0], pendingString[1], biff === 8 ? ustr(body, 0, true).s : latin1(body, 2, dv.getUint16(d, true)));
        pendingString = null;
      } else if (type === 0x0205) put(r, c, body[7] ? '' : (body[6] ? 'TRUE' : 'FALSE'));                  // BOOLERR
      else if (type === 0x000a) break;                                                                      // EOF
      p = d + len;
    }
    const width = rows.reduce((m, x) => Math.max(m, x ? x.length : 0), 0);
    return { name: sh.name, rows: Array.from(rows, (x) => Array.from({ length: width }, (_, i) => (x && x[i] != null ? x[i] : ''))) };
  });
}
