// Stock and purchase bills: loading (through the api — buying rates only for people with "stock")
// and how a stock item is written. Every change goes through useAction / call.
import { signal } from '@preact/signals';
import { call } from './api.js';
import { t } from './i18n.js';
import { money, kg, shortDate } from './format.js';
import { SHAPE_LOOK } from '../config/options.js';

/** Last loaded stock (so screens and the order picker share one copy). Refreshed by loadStock(). */
export const stockCache = signal(null);
let at = 0;

export async function loadStock(force = false) {
  if (!force && stockCache.value && Date.now() - at < 20000) return stockCache.value;
  const d = await call('stockData', {});
  stockCache.value = d; at = Date.now();
  return d;
}
export const forgetStock = () => { at = 0; };

export const shapeWord = (s) => (s ? t(SHAPE_LOOK[s]?.word || s) : t('st_any_shape'));
/** "EN19 · Round" (and the shop's own name, if it gave one). */
export const stockName = (it) => `${it.code} · ${shapeWord(it.shape)}`;
/** Second line: ₹75/kg (owners) · HSN 722830 · supplier · first in. */
export function stockLine(it, tz, { rate = true } = {}) {
  return [
    rate && it.rate != null ? `${money(it.rate)}/kg` : null,
    it.hsn ? t('st_hsn', it.hsn) : null,
    it.label || null,
    it.supplier || null,
    it.first_in ? shortDate(it.first_in, tz) : null,
  ].filter(Boolean).join(' · ');
}
/** core.stockChoices wants camelCase. */
export const forChoices = (items) => (items || []).map((s) => ({ ...s, materialId: s.material_id, onHand: s.on_hand, booked: s.booked, firstIn: s.first_in }));
export const kgTxt = (v) => kg(v, 0);
