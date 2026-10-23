// Smart checks on a purchase bill (8 Oct 2026): a warning under the field, with one-tap fixes.
// Checks come from @srs/core purchaseChecks and only warn — "It's correct" always lets you save.
import { t } from '../../lib/i18n.js';
import { money, shortDate } from '../../lib/format.js';
import { Icon } from '../kit.jsx';
import { gstWords } from './GstStatus.jsx';

const LOOK = { bad: 'CircleAlert', warn: 'TriangleAlert' };

/** Title + text for one check (also used in the "before saving" list). */
export function checkWords(c, tz) {
  switch (c.type) {
    case 'billno_gstin': return [t('chk_billno_t'), t('chk_billno_s', c.state ? `${c.state}, ${c.stateCode}` : c.stateCode)];
    case 'gstin_typo': return [t('chk_gstin_t'), t('chk_gstin_s')];
    case 'hsn_not_steel': return [t('chk_hsn_t', c.hsn), t('chk_hsn_s')];
    case 'hsn_family': return [t('chk_hsnfam_t', c.hsn, c.code || ''), t('chk_hsnfam_s')];
    case 'rate_far': return [c.times >= 1 ? t('chk_rate_t', money(c.rate), c.times, c.code || '') : t('chk_rate_low_t', money(c.rate), c.code || ''),
      t('chk_rate_s', c.n, c.code || '', money(c.low), money(c.high), c.last.supplier || '—', money(c.last.rate), shortDate(c.last.date, tz))];
    case 'duplicate': return [t('chk_dup_t', c.billNo || '—', c.date ? shortDate(c.date, tz) : ''), t('chk_dup_s')];
    default: return c.type.startsWith('gst_') ? gstWords(c) : [c.type, ''];
  }
}

/**
 * One warning box. actions: [[label, onClick, primary?]]; onOk = "It's correct".
 */
export function CheckNote({ c, tz, actions = [], onOk, okWord }) {
  const [title, text] = checkWords(c, tz);
  return (
    <div class={`chk chk-${c.level}`} role="alert">
      <Icon name={LOOK[c.level] || 'Info'} size={17} stroke={2.4} />
      <div class="grow">
        <div class="chk-t">{title}</div>
        {text && <div class="chk-s">{text}</div>}
        <div class="chk-a">
          {actions.map(([label, fn, primary]) => <button class={primary ? 'on' : ''} onClick={fn}>{label}</button>)}
          {onOk && <button onClick={onOk}>{okWord || t('chk_correct')}</button>}
        </div>
      </div>
    </div>
  );
}
