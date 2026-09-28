// Khata: who owes money (and who holds an advance), how old it is, and each customer's account.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { businessDate } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { money, shortDate } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { store } from '../../lib/store.js';
import { loadCustomers, avatarColour, firstLetter } from '../../lib/customers.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { CustomerEdit } from './CustomerEdit.jsx';
import './khata.css';

export const daysSince = (date, tz) => {
  if (!date) return 0;
  const a = Date.parse(`${/^\d{4}-\d{2}-\d{2}$/.test(date) ? date : businessDate(date, tz)}T00:00:00Z`);
  const b = Date.parse(`${businessDate(new Date().toISOString(), tz)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
};
const BUCKETS = [['fresh', 'due_fresh', (d) => d < 10, 'ok'], ['mid', 'due_mid', (d) => d >= 10 && d < 30, 'warn'], ['old', 'due_old', (d) => d >= 30, 'bad']];

export function Khata() {
  const [rows, setRows] = useState(null);
  const [view, setView] = useState(store.get('khata-view') || 'owe'); // owe | all
  const [all, setAll] = useState(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { loadCustomers().then(setAll).catch(() => setAll([])); }, []);
  const pickView = (x) => { store.set('khata-view', x); setView(x); };
  const [bucket, setBucket] = useState(null);
  const [sort, setSort] = useState('oldest');
  const [q, setQ] = useState('');
  const tz = company.value?.timezone;
  useEffect(() => { call('khata', {}).then(setRows).catch(() => setRows([])); }, []);

  const withAge = useMemo(() => (rows || []).map((r) => ({ ...r, days: r.oldest ? daysSince(r.oldest, tz) : null })), [rows]);
  const owing = withAge.filter((r) => r.due > 0);
  const list = withAge
    .filter((r) => !bucket || (r.due > 0 && BUCKETS.find((b) => b[0] === bucket)[2](r.days)))
    .filter((r) => !q.trim() || r.customer.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => (sort === 'oldest' ? (b.days ?? -1) - (a.days ?? -1) : b.due - a.due));
  const total = owing.reduce((a, r) => a + r.due, 0);
  const held = withAge.reduce((a, r) => a + r.credit, 0);

  return (
    <>
      <TopBar title={view === 'all' ? t('customers') : t('who_owes')} onBack={null}
        right={view === 'all'
          ? can('new') && <button class="pill" onClick={() => setAdding(true)}><Icon name="UserPlus" size={16} />{t('cust_add')}</button>
          : can('khata') && <button class="pill" onClick={() => go('/reminders')}><Icon name="BellRing" size={16} />{t('nav_reminders')}</button>} />
      <div class="page">
        <div class="seg" style="margin-bottom:12px">
          <button class={view === 'owe' ? 'on' : ''} onClick={() => pickView('owe')}>{t('cust_tab_owe', owing.length)}</button>
          <button class={view === 'all' ? 'on' : ''} onClick={() => pickView('all')}>{t('cust_tab_all', all ? all.filter((c) => c.active).length : '…')}</button>
        </div>
        {view === 'all' ? <AllCustomers all={all} khata={withAge} tz={tz} /> : <>
        <div class="hero" style="padding:16px 18px">
          <div class="hero-cap">{t('to_receive_cap')}</div>
          <div class="hero-num num" style="margin:4px 0 8px">{rows ? money(total, false) : '…'}</div>
          <div class="row" style="gap:8px;opacity:.85;font-size:13px;font-weight:600"><span>{t('n_customers', owing.length)}</span>{held > 0 && <span>· {t('advances_held')} {money(held, false)}</span>}</div>
        </div>

        <div class="buckets">
          {BUCKETS.map(([id, w, test, tone]) => {
            const xs = owing.filter((r) => test(r.days));
            return (
              <button class={`bucket tone-${tone} ${bucket === id ? 'on' : ''}`} onClick={() => setBucket(bucket === id ? null : id)}>
                <div class="bw">{t(w)}</div><div class="num bv">{money(xs.reduce((a, r) => a + r.due, 0), false)}</div><div class="bn">{t('n_customers', xs.length)}</div>
              </button>
            );
          })}
        </div>

        <div class="row" style="margin:12px 0">
          <div class="field grow" style="background:var(--surface);min-height:46px"><Icon name="Search" size={18} /><input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('search_cust')} /></div>
          <div class="seg" style="width:auto"><button class={sort === 'oldest' ? 'on' : ''} onClick={() => setSort('oldest')}><Icon name="Clock" size={16} /></button><button class={sort === 'big' ? 'on' : ''} onClick={() => setSort('big')}>₹</button></div>
        </div>

        <div class="card">
          {!rows ? <div class="pad"><Skeleton h={18} /><Skeleton h={18} w="60%" style="margin-top:12px" /></div>
            : list.length === 0 ? <div class="li muted">{t('all_clear')}</div>
              : list.map((r) => (
                <button class="li" onClick={() => go(`/customer/${r.customer.id}`)}>
                  <div class="grow">
                    <div class="t ellip">{r.customer.name}</div>
                    <div class="s">{r.due > 0 ? t('oldest_bill', r.days) : t('advance_held')}</div>
                  </div>
                  <div style="text-align:right">
                    <div class="num" style={`font-weight:800;color:${r.due > 0 ? 'var(--ink)' : 'var(--ok)'}`}>{money(r.due > 0 ? r.due : r.credit, false)}</div>
                    {r.due > 0 && r.days >= 30 ? <Chip tone="bad">{t('n_days', r.days)}</Chip> : r.due > 0 && r.days >= 10 ? <Chip tone="warn">{t('n_days', r.days)}</Chip> : null}
                  </div>
                </button>
              ))}
        </div>
        <div class="faint" style="font-size:13px;margin:12px 4px">{t('khata_note')}</div>
        </>}
      </div>
      <CustomerEdit open={adding} c={null} onClose={() => setAdding(false)} onSaved={(c) => { setAdding(false); go(`/customer/${c.id}`); }} />
    </>
  );
}

/** Every customer (not only those who owe): search by name, mobile or GST number; quick filters. */
function AllCustomers({ all, khata, tz }) {
  const [q, setQ] = useState('');
  const [f, setF] = useState(null); // adv | nomob | gst
  const acc = useMemo(() => new Map(khata.map((r) => [r.customer.id, r])), [khata]);
  if (!all) return <div class="card pad"><Skeleton h={18} /><Skeleton h={18} w="60%" style="margin-top:12px" /></div>;
  const active = all.filter((c) => c.active);
  const s = q.trim().toLowerCase(); const digits = s.replace(/\D/g, '');
  const tests = { adv: (c) => (acc.get(c.id)?.credit || 0) > 0 && !(acc.get(c.id)?.due > 0), nomob: (c) => !c.phone, gst: (c) => !!c.gstin };
  const list = active
    .filter((c) => !s || c.name.toLowerCase().includes(s) || (digits.length >= 3 && (c.phone || '').replace(/\D/g, '').includes(digits)) || (c.gstin || '').toLowerCase().includes(s))
    .filter((c) => !f || tests[f](c))
    .sort((a, b) => (acc.get(b.id)?.due || 0) - (acc.get(a.id)?.due || 0) || a.name.localeCompare(b.name));
  const chip = (id, label) => <button class={`fchip ${f === id ? 'on' : ''}`} onClick={() => setF(f === id ? null : id)}>{label}</button>;
  return (
    <>
      <div class="field" style="background:var(--surface);min-height:46px"><Icon name="Search" size={18} /><input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('cust_search')} /></div>
      <div class="row" style="gap:8px;margin:10px 0 12px;overflow-x:auto">
        {chip('adv', t('cust_f_adv', active.filter(tests.adv).length))}{chip('nomob', t('cust_f_nomob', active.filter(tests.nomob).length))}{chip('gst', t('cust_f_gst'))}
      </div>
      <div class="card">
        {list.length === 0 ? <div class="li muted">{t('g_none')}</div> : list.map((c) => {
          const r = acc.get(c.id);
          const days = c.last ? daysSince(c.last.done_at, tz) : null;
          return (
            <button class="li" onClick={() => go(`/customer/${c.id}`)}>
              <div class="cav" style={`background:${avatarColour(c.id)}`}>{firstLetter(c.name)}</div>
              <div class="grow" style="min-width:0">
                <div class="t ellip">{c.name}</div>
                <div class="s">{!c.phone ? <Chip tone="warn">{t('cust_no_mobile')}</Chip>
                  : c.last ? `${t('cust_last_slip', days === 0 ? t('f_today').toLowerCase() : shortDate(c.last.done_at, tz))}${days > 0 ? ` · ${t('n_days', days)}` : ` · #${c.last.slip_no}`}` : t('cust_no_slips')}</div>
              </div>
              <div style="text-align:right">
                {r?.due > 0 ? <><div class="num" style={`font-weight:800;color:var(--${r.days >= 30 ? 'bad' : r.days >= 10 ? 'warn' : 'ink'})`}>{money(r.due, false)}</div><div class="faint" style="font-size:12px;font-weight:600">{t('cust_to_receive')}</div></>
                  : r?.credit > 0 ? <><div class="num" style="font-weight:800;color:var(--ok)">{money(r.credit, false)}</div><div class="faint" style="font-size:12px;font-weight:600">{t('cust_adv_held')}</div></>
                    : c.last ? <div class="faint" style="font-size:13px;font-weight:700">{t('cust_paid_up')}</div> : null}
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}
