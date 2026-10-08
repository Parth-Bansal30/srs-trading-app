// The ▶ help button (easy mode): what this screen is for, in the person's language, and who to call.
// A short video per screen will be added here (help videos); until then the words.
import { useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { company } from '../../lib/session.js';
import { route } from '../../lib/router.js';
import { easy } from '../../lib/easy.js';
import { Icon } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';
import './easy.css';

// screen address → help words (and later a video)
const HELP = [
  ['/', 'help_today'], ['/new', 'help_new'], ['/slips', 'help_slips'], ['/slip/', 'help_slip'], ['/weigh', 'help_weigh'],
  ['/pickup/', 'help_pickup'], ['/khata', 'help_khata'], ['/customer/', 'help_customer'], ['/evening', 'help_evening'],
  ['/stock', 'help_stock'], ['/purchases/new', 'help_purchase'], ['/settings/accounts', 'help_accounts'], ['/close-day', 'help_close'],
];
export const helpFor = (path) => [...HELP].sort((x, y) => y[0].length - x[0].length)
  .find(([p]) => path === p || (p !== '/' && path.startsWith(p.endsWith('/') ? p : `${p}/`)))?.[1] || null;

export function HelpButton({ always = false }) {
  const [open, setOpen] = useState(false);
  const key = helpFor(route.value.path);
  if (!key || (!always && !easy.value.on)) return null;
  const phone = company.value?.phone;
  return (
    <>
      <button class="round help-btn" onClick={() => setOpen(true)} aria-label={t('help_title')}><Icon name="CirclePlay" size={21} stroke={2.2} /></button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('help_title')}>
        <div class="help-text">{t(key)}</div>
        <div class="faint help-soon"><Icon name="CirclePlay" size={16} />{t('help_video_soon')}</div>
        {phone && <a class="btn btn-ghost btn-block" style="margin-top:12px" href={`tel:${phone}`}><Icon name="Phone" size={18} />{t('help_call')}</a>}
      </Sheet>
    </>
  );
}
