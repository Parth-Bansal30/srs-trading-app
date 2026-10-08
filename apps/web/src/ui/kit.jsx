// Small shared pieces used by every screen.
import { ICONS } from './icons.js';
import { t, lang, setLang } from '../lib/i18n.js';
import { APP } from '../config/app.js';
import { back } from '../lib/router.js';
import { HelpButton } from './easy/Help.jsx';

export function Icon({ name, size = 20, stroke = 1.9, ...rest }) {
  const C = ICONS[name];
  if (!C) { if (import.meta.env.DEV) console.warn(`[icons] add "${name}" to ui/icons.js`); return null; }
  return <C size={size} strokeWidth={stroke} {...rest} />;
}

export const Chip = ({ tone = 'neutral', children }) => <span class={`chip tone-${tone}`}>{children}</span>;

export function TopBar({ title, sub, onBack = back, right }) {
  return (
    <div class="topbar">
      {onBack && <button class="round" onClick={onBack} aria-label={t('back')}><Icon name="ChevronLeft" size={20} stroke={2.2} /></button>}
      <div class="grow"><div class="title">{title}</div>{sub && <div class="sub num">{sub}</div>}</div>
      {right}
      {!right && <HelpButton />}
    </div>
  );
}

/** Language switch: tap to go to the next language. */
export function LangPill() {
  const i = APP.languages.findIndex((l) => l.id === lang.value);
  const next = APP.languages[(i + 1) % APP.languages.length];
  return <button class="pill" onClick={() => setLang(next.id)} aria-label="language"><Icon name="Languages" size={16} />{t('language_short')}</button>;
}

export function Skeleton({ h = 20, w = '100%', r = 10, style = '' }) {
  return <div class="skeleton" style={`height:${h}px;width:${typeof w === 'number' ? w + 'px' : w};border-radius:${r}px;${style}`} />;
}
