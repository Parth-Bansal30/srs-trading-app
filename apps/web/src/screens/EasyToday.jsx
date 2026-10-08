// Today in easy mode (Papa mode): big words, today's sale and cash, four big tiles, what's waiting.
import { useState } from 'preact/hooks';
import { t, tIn, lang } from '../lib/i18n.js';
import { me, company, can } from '../lib/session.js';
import { money, longDay } from '../lib/format.js';
import { go } from '../lib/router.js';
import { loadCatalog } from '../lib/catalog.js';
import { Icon, Skeleton } from '../ui/kit.jsx';
import { HelpButton } from '../ui/easy/Help.jsx';
import { CustomerPicker } from './order/CustomerPicker.jsx';
import '../ui/easy/easy.css';

export function EasyToday({ d }) {
  const [pick, setPick] = useState(null); // customers, while choosing who paid
  const tz = company.value?.timezone || 'Asia/Kolkata';
  const first = (me.value?.name || '').split(' ')[0];
  const sub = (k) => (lang.value === 'en' ? '' : tIn('en', k));
  const Tile = ({ icon, w, s, bg, fg = '#fff', onClick, show = true }) => show && (
    <button class="etile" style={`background:${bg};color:${fg}`} onClick={onClick}>
      <Icon name={icon} size={36} stroke={2.1} />
      <div><div class="w">{t(w)}</div>{s && <div class="s">{s}</div>}</div>
    </button>
  );
  const payWho = () => loadCatalog().then((c) => setPick(c.customers || [])).catch(() => go('/khata'));
  return (
    <div class="page today">
      <div class="row" style="gap:10px;align-items:flex-start">
        <div class="grow"><div class="ehello">{t('easy_hello')}{first ? `, ${first} ${lang.value === 'en' ? '' : 'जी'}`.trimEnd() : ''}</div>
          <div class="muted" style="font-size:14px;font-weight:600">{longDay(new Date().toISOString(), tz)}</div></div>
        <HelpButton />
        <button class="avatar" onClick={() => go('/more')} aria-label={t('nav_more')}>{first.slice(0, 1)}</button>
      </div>

      {can('money') && (
        <div class="card pad row" style="justify-content:space-between;margin-top:12px">
          <div><div class="muted" style="font-size:15px;font-weight:600">{t('easy_sales')}</div>
            <div class="num" style="font-size:32px;font-weight:800;letter-spacing:-.02em">{d?.sales ? money(d.sales.total, false) : <Skeleton h={34} w={150} />}</div></div>
          {can('today') && <div style="text-align:right"><div class="muted" style="font-size:15px;font-weight:600">{t('easy_cash')}</div>
            <div class="num" style="font-size:24px;font-weight:800">{d?.cash != null ? money(d.cash, false) : '–'}</div></div>}
        </div>
      )}

      <div class="etiles">
        <Tile show={can('new')} icon="Plus" w="etile_new" s={sub('etile_new')} bg="var(--accent)" fg="var(--accent-ink)" onClick={() => go('/new')} />
        <Tile show={can('money') && can('khata')} icon="IndianRupee" w="etile_money" s={sub('etile_money')} bg="#1C8456" onClick={payWho} />
        <Tile show={can('money')} icon="BookOpenText" w="etile_khata" s={sub('etile_khata')} bg="#2C5CC5" onClick={() => go('/khata')} />
        <Tile show={can('today')} icon="ClipboardCheck" w="etile_close" s={sub('etile_close')} bg="#1B2130" onClick={() => go('/close-day')} />
        <Tile show={!can('money') && can('weigh')} icon="Scale" w="nav_weigh" bg="#1C8456" onClick={() => go('/weigh')} />
      </div>

      {d && (d.counts.toWeigh > 0 || d.counts.readyForPickup > 0) && (
        <div class="card" style="margin-top:12px">
          {d.counts.toWeigh > 0 && <button class="li" onClick={() => go('/weigh')}><div class="iconbox tone-warn"><Icon name="Scale" /></div>
            <div class="grow t" style="font-size:17px">{t('easy_weigh', d.counts.toWeigh)}</div><Icon name="ChevronRight" size={20} /></button>}
          {d.counts.readyForPickup > 0 && <button class="li" onClick={() => go('/slips?stage=weighed')}><div class="iconbox tone-ok"><Icon name="PackageCheck" /></div>
            <div class="grow t" style="font-size:17px">{t('easy_pickup', d.counts.readyForPickup)}</div><Icon name="ChevronRight" size={20} /></button>}
        </div>
      )}
      <CustomerPicker open={!!pick} customers={pick || []} onClose={() => setPick(null)} onPick={(c) => { setPick(null); go(`/customer/${c.id}?pay=1`); }} />
    </div>
  );
}
