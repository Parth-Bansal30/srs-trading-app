// Khata: who owes money (and who holds an advance), how old it is, and each customer's account.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { businessDate } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
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
      <TopBar title={t('who_owes')} onBack={null} right={can('khata') && <button class="pill" onClick={() => go('/reminders')}><Icon name="BellRing" size={16} />{t('nav_reminders')}</button>} />
      <div class="page">
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
      </div>
    </>
  );
}
