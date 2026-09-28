// Turning a drawn slip / statement into a PDF file, sharing it, or printing it.
// The PDF tools are loaded only when first used, so the app stays quick to open.
import { h, render } from 'preact';

/**
 * Draw a paper component off-screen at full size and hand back the element.
 * Call the returned cleanup() when done.
 */
export function drawOffscreen(vnode) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;z-index:-1;pointer-events:none';
  document.body.appendChild(host);
  render(vnode, host);
  return { node: host.firstElementChild, cleanup: () => { render(null, host); host.remove(); } };
}

let fontCss = null;
/** Paper → PDF file. size: 'page' (A5 slip), 'a4' (statement) or 'roll' (80 mm). */
export async function paperToPdf(node, { name, size = 'page' }) {
  const [{ toPng, getFontEmbedCSS }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);
  await document.fonts?.ready;
  if (fontCss === null) fontCss = await getFontEmbedCSS(node).catch(() => '');
  const w = node.offsetWidth; const hgt = node.offsetHeight;
  const png = await toPng(node, { pixelRatio: 2.5, backgroundColor: '#ffffff', fontEmbedCSS: fontCss || undefined });
  const pw = size === 'roll' ? 80 : size === 'a4' ? 210 : 148;
  const imgH = (pw * hgt) / w;
  const pageH = size === 'roll' ? imgH : Math.max(imgH, size === 'a4' ? 297 : 210);
  const pdf = new jsPDF({ unit: 'mm', format: [pw, pageH], orientation: 'portrait', compress: true });
  pdf.addImage(png, 'PNG', 0, 0, pw, imgH, undefined, 'FAST');
  const blob = pdf.output('blob');
  return new File([blob], name, { type: 'application/pdf' });
}

/** Can this phone share a file straight into WhatsApp etc.? */
export const canShareFile = (file) => !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));

/** Share the file (phone) or save it (laptop). Returns 'shared' | 'saved' | 'cancelled' | 'needs_tap'. */
export async function shareOrSave(file, text) {
  if (canShareFile(file)) {
    try { await navigator.share({ files: [file], text }); return 'shared'; } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      if (e?.name === 'NotAllowedError') return 'needs_tap'; // the tap was too long ago — ask for one more tap
    }
  }
  saveFile(file);
  return 'saved';
}

export function saveFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Print one paper on A4 (or the 80 mm roll). Works with any printer the phone or laptop knows (e.g. the shop's HP). */
export function printPaper(vnode, size = 'page') {
  document.getElementById('print-root')?.remove();
  document.getElementById('print-page')?.remove();
  const root = document.createElement('div'); root.id = 'print-root';
  document.body.appendChild(root);
  render(vnode, root);
  const style = document.createElement('style'); style.id = 'print-page';
  style.textContent = size === 'roll' ? '@page{size:80mm 297mm;margin:0}' : '@page{size:A4;margin:10mm}';
  document.head.appendChild(style);
  document.body.classList.add('printing');
  const done = () => { render(null, root); root.remove(); style.remove(); document.body.classList.remove('printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => window.print(), 80);
}

export { h };
