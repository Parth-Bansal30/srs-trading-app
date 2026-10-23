// All slips with a quick filter by stage and a search by slip number.
// Owners can switch to "Select" to delete several slips (e.g. test slips) with one SMS code.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { listOrders } from '../../lib/orders.js';
import { outbox, outboxVersion } from '../../lib/offline/outbox.js';
import { localOrders, patchOrder } from '../../lib/offline/overlay.js';
import { money, shortDate, time } from '../../lib/format.js';
import { go, route } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { STAGES, BILLS } from '../../config/options.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { DeleteSheet } from './DeleteSheet.jsx';
import './slips.css';

const FILTERS = [['all', 'f_all'], ['open', 'f_open'], ['accepted', 'st_accepted'], ['weighed', 'st_weighed'], ['done', 'st_done']];

export function Slips() {
  const [stage, setStage] = useState(route.value.query.stage || 'all');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState([]);
  const [confirm, setConfirm] = useState(false);
  const [tick, setTick] = useState(0);
  const tz = company.value?.timezone;
  useEffect(() => { setRows(null); const id = setTimeout(() => listOrders({ stage, search: search.trim() }).then(setRows).catch(() => setRows([])), 200); return () => clearTimeout(id); }, [stage, search, tick, outboxVersion.value]);
  // slips made on this phone without internet come first; waiting weights / pickups show on the server's slips
  const fits = (o) => stage === 'all' || (stage === 'open' ? ['estimate', 'accepted', 'weighed'].includes(o.status) : o.status === stage);
  const mine = rows ? localOrders(outbox.value).filter((o) => fits(o) && (!search.trim() || String(o.slip_no).includes(search.trim())))
    .map((o) => ({ ...o, order_items: [{ count: o.order_items.length }] })) : [];
  const shown = rows ? [...mine, ...rows.map((o) => { const p = patchOrder({ ...o, order_items: [], payments: [] }, outbox.value); return p.pending ? { ...o, status: p.status, pending: true } : o; }).filter(fits)] : null;

  const toggle = (id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : picked.length >= 50 ? picked : [...picked, id]);
  const stop = () => { setPicking(false); setPicked([]); };
  const right = can('delete') && (picking
    ? <button class="pill" onClick={stop}>{t('cancel')}</button>
    : <button class="pill" onClick={() => setPicking(true)}><Icon name="ListChecks" size={16} />{t('sel_select')}</button>);

  return (
    <>
      <TopBar title={picking ? (picked.length ? t('sel_n', picked.length) : t('sel_select')) : t('nav_slips')} onBack={null} right={right} />
      <div class="page" style={picking ? 'padding-bottom:calc(var(--tabbar-h) + 110px)' : ''}>
        {picking && <div class="muted" style="font-size:14px;margin:-2px 2px 10px">{t('sel_none')}</div>}
        <div class="field" style="background:var(--surface)"><Icon name="Search" size={18} /><input inputmode="search" value={search} onInput={(e) => setSearch(e.currentTarget.value)} placeholder={t('search_slip')} /></div>
        <div class="chips-scroll">
          {FILTERS.map(([id, w]) => <button class={`fchip ${stage === id ? 'on' : ''}`} onClick={() => setStage(id)}>{t(w)}</button>)}
        </div>
        <div class="card">
          {!rows ? <div class="pad"><Skeleton h={18} /><Skeleton h={18} w="70%" style="margin-top:12px" /></div>
            : shown.length === 0 ? <div class="li muted">{t('no_slips_yet')}</div>
              : shown.map((o) => (
                <button class="li" onClick={() => (picking ? !o.local && toggle(o.id) : go(`/slip/${o.id}`))}>
                  {picking && <div class={`sel-box ${picked.includes(o.id) ? 'on' : ''}`}>{picked.includes(o.id) && <Icon name="Check" size={16} stroke={3} />}</div>}
                  <div class="grow">
                    <div class="t num ellip">#{o.slip_no} · {o.customers?.name}</div>
                    <div class="s">{o.pending && <><Icon name="CloudUpload" size={12} /> {t('off_waiting')} · </>}{shortDate(o.created_at, tz)} · {time(o.created_at, tz)} · {t('n_items', o.order_items?.[0]?.count ?? 0)}</div>
                  </div>
                  {o.status === 'done'
                    ? <div style="text-align:right"><div class="num" style="font-weight:700">{money(o.total_amount)}</div><Chip tone={BILLS[o.bill_type]?.tone}>{t(BILLS[o.bill_type]?.word)}</Chip></div>
                    : <Chip tone={STAGES[o.status]?.tone}>{t(STAGES[o.status]?.word)}</Chip>}
                </button>
              ))}
        </div>
      </div>
      {picking && (
        <div class="actionbar">
          <button class="btn btn-bad btn-block" disabled={!picked.length} onClick={() => setConfirm(true)}>
            <Icon name="Trash2" size={19} stroke={2.3} />{picked.length === 1 ? t('del_do_1') : t('del_do_n', picked.length)}
          </button>
        </div>
      )}
      <DeleteSheet open={confirm} ids={picked} onClose={() => setConfirm(false)}
        onDone={(r) => { const n = r?.deleted?.length || picked.length; setConfirm(false); stop(); setTick(tick + 1);
          toast(n === 1 ? t('del_done_1', r?.deleted?.[0]?.slip_no || '') : t('del_done_n', n)); }} />
    </>
  );
}
