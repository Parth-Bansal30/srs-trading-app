// All slips with a quick filter by stage and a search by slip number.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { company } from '../../lib/session.js';
import { listOrders } from '../../lib/orders.js';
import { money, shortDate, time } from '../../lib/format.js';
import { go, route } from '../../lib/router.js';
import { STAGES, BILLS } from '../../config/options.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';

const FILTERS = [['all', 'f_all'], ['open', 'f_open'], ['accepted', 'st_accepted'], ['weighed', 'st_weighed'], ['done', 'st_done']];

export function Slips() {
  const [stage, setStage] = useState(route.value.query.stage || 'all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null);
  const tz = company.value?.timezone;
  useEffect(() => { setRows(null); const id = setTimeout(() => listOrders({ stage, search: search.trim() }).then(setRows).catch(() => setRows([])), 200); return () => clearTimeout(id); }, [stage, search]);

  return (
    <>
      <TopBar title={t('nav_slips')} onBack={null} />
      <div class="page">
        <div class="field" style="background:var(--surface)"><Icon name="Search" size={18} /><input inputmode="search" value={search} onInput={(e) => setSearch(e.currentTarget.value)} placeholder={t('search_slip')} /></div>
        <div class="chips-scroll">
          {FILTERS.map(([id, w]) => <button class={`fchip ${stage === id ? 'on' : ''}`} onClick={() => setStage(id)}>{t(w)}</button>)}
        </div>
        <div class="card">
          {!rows ? <div class="pad"><Skeleton h={18} /><Skeleton h={18} w="70%" style="margin-top:12px" /></div>
            : rows.length === 0 ? <div class="li muted">{t('no_slips_yet')}</div>
              : rows.map((o) => (
                <button class="li" onClick={() => go(`/slip/${o.id}`)}>
                  <div class="grow">
                    <div class="t num ellip">#{o.slip_no} · {o.customers?.name}</div>
                    <div class="s">{shortDate(o.created_at, tz)} · {time(o.created_at, tz)} · {t('n_items', o.order_items?.[0]?.count ?? 0)}</div>
                  </div>
                  {o.status === 'done'
                    ? <div style="text-align:right"><div class="num" style="font-weight:700">{money(o.total_amount)}</div><Chip tone={BILLS[o.bill_type]?.tone}>{t(BILLS[o.bill_type]?.word)}</Chip></div>
                    : <Chip tone={STAGES[o.status]?.tone}>{t(STAGES[o.status]?.word)}</Chip>}
                </button>
              ))}
        </div>
      </div>
    </>
  );
}
