// Files the person picks or photographs (bills, receipts) → { mime, data (base64) } for the api.
/** A photo is made smaller before it is sent (max px, JPEG) — quicker on a weak network. A PDF goes as it is. */
export async function fileToData(file, max = 2000) {
  if (file.type.startsWith('image/')) {
    const img = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.82);
    return { mime: 'image/jpeg', data: url.split(',')[1] };
  }
  const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
  return { mime: file.type || 'application/pdf', data: String(url).split(',')[1] };
}
