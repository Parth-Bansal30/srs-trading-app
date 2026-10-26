// #/search — one box for everything (26 Oct 2026): customers, slips, grades in stock, payments, purchase bills, expenses.
// Type a name, a slip number (#553), a grade and size (32 EN8), an amount (5000) or a phone number.
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n.js';
import { can, company } from '../lib/session.js';
import { go, route, replace, back } from '../lib/router.js';
import { runSearch } from '../lib/search.js';
import { money, shortDate, kg } from '../lib/format.js';
import { modeText, modeIcon } from '../lib/accounts.js';
import { catOf } from '../lib/expenses.js';
import { store } from '../lib/store.js';
import { online } from '../lib/net.js';
import { STAGES } from '../config/options.js';
import { avatarColour, firstLetter } from '../lib/customers.js';
import { Icon, Chip, Skeleton } from '../ui/kit.jsx';

const RECENT = 'search:recent';
const recent = () => { try { return JSON.parse(store.get(RECENT) || '[]'); } catch { return []; } };
const remember = (q) => { const s = q.trim(); if (s.length < 2) return; store.set(RECENT, JSON.stringify([s, ...recent().filter((x) => x !== s)].slice(0, 6))); };
const KIND = { advance: 'kind_adv', pickup: 'kind_pick', khata: 'kind_khata', refund: 'kind_refund' };

export function Search() {
  const [q, setQ] = useState(route.value.query.q || '');
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const n = useRef(0);
  const tz = company.value?.timezone;
  useEffect(() => { setTimeout(() => box.current?.focus(), 60); }, []);
  useEffect(() => {
    const s = q.trim();
    if (!s) { setR(null); setBusy(false); return undefined; }
    const my = ++n.current;
    setBusy(true);
    const tm = setTimeout(() => runSearch(s).then((x) => { if (my === n.current) { setR(x); setBusy(false); } }).catch(() => { if (my === n.current) { setR(null); setBusy(false); } }), 250);
    return () => clearTimeout(tm);
  }, [q]);
  const open = (path) => { remember(q); replace(`/search?q=${encodeURIComponent(q.trim())}`); go(path); };
  const total = r ? r.customers.length + r.grades.length + r.slips.length + r.payments.length + r.purchases.length + r.expenses.length : 0;

  return (
    <>
      <div class="topbar search-top">
        <button class="round" onClick={() => back()} aria-label={t('back')}><Icon name="ChevronLeft" size={20} stroke={2.2} /></button>
        <div class="field grow search-field">
          <Icon name="Search" size={18} style="color:var(--ink-3)" />
          <input ref={box} type="search" enterkeyhint="search" value={q} placeholder={t('search_ph')} autocomplete="off"
            onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && remember(q)} aria-label={t('search_title')} />
          {q && <button class="round sm" onClick={() => { setQ(''); box.current?.focus(); }} aria-label={t('search_clear')}><Icon name="X" size={16} /></button>}
        </div>
      </div>
      <div class="page search-page">
        {!q.trim() && (
          <>
            {recent().length > 0 && <><div class="lbl">{t('search_recent')}</div>
              <div class="chips">{recent().map((x) => <button class="pill" onClick={() => setQ(x)}><Icon name="History" size={14} />{x}</button>)}</div></>}
            <div class="lbl" style="margin-top:14px">{t('search_try')}</div>
            <div class="card">
              {[['Users', 'search_ex_name', 'Sharma'], ['ReceiptText', 'search_ex_slip', '#553'], ['Boxes', 'search_ex_grade', '32 EN8'], ['IndianRupee', 'search_ex_amount', '5000'], ['Phone', 'search_ex_phone', '98100 00001']].map(([ic, w, ex]) => (
                <button class="li" onClick={() => setQ(ex)}><div class="iconbox tone-neutral"><Icon name={ic} size={18} /></div>
                  <div class="grow"><div class="t">{t(w)}</div><div class="s num">{ex}</div></div></button>))}
            </div>
          </>
        )}
        {q.trim() && busy && !r && <><Skeleton h={64} /><Skeleton h={160} style="margin-top:12px" /></>}
        {q.trim() && r && (
          <>
            {!online.value && <div class="notice tone-warn row" style="gap:8px;font-size:13.5px;margin-bottom:10px"><Icon name="WifiOff" size={16} />{t('search_offline')}</div>}
            {total === 0 && !busy && <div class="empty-note"><Icon name="SearchX" size={34} /><div>{t('search_none', q.trim())}</div></div>}

            <Sec title={t('sr_customers')} n={r.customers.length}>{r.customers.map((c) => (
              <button class="li" onClick={() => open(`/customer/${c.id}`)}>
                <div class="cav" style={`background:${avatarColour(c.id)}`}>{firstLetter(c.name)}</div>
                <div class="grow"><div class="t">{c.name}</div><div class="s num">{c.phone || t('no_phone')}</div></div>
                <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
              </button>))}</Sec>

            <Sec title={t('sr_stock')} n={r.grades.length}>{r.grades.map((g) => (
              <button class="li" onClick={() => open(g.stock_id ? `/stock/${g.stock_id}` : '/stock')}>
                <div class="iconbox tone-accent"><Icon name="Boxes" size={18} /></div>
                <div class="grow"><div class="t">{g.code}{r.p.dims.length ? ` · ${r.p.dims.join(' × ')}` : ''}</div>
                  <div class="s num">{[g.on_hand != null ? t('sr_in_stock', kg(g.on_hand, 0)) : null, can('money') && g.sell_rate != null ? `${money(g.sell_rate)}/kg` : null].filter(Boolean).join(' · ') || t(`fam_${g.family}`)}</div></div>
                <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
              </button>))}</Sec>

            <Sec title={t('sr_slips')} n={r.slips.length}>{r.slips.map((o) => (
              <button class="li" onClick={() => open(`/slip/${o.id}`)}>
                <div class={`iconbox tone-${o.bill_type === 'kacha' ? 'kacha' : 'pakka'}`}><Icon name="ReceiptText" size={18} /></div>
                <div class="grow" style="min-width:0"><div class="t num">#{o.slip_no} · {o.customer || '—'}</div>
                  <div class="s">{shortDate(o.created_at, tz)}{o.why === 'grade' ? ` · ${r.grades[0]?.code || ''}${r.p.dims.length ? ` ${r.p.dims.join('×')}` : ''}` : ''}</div></div>
                <div style="text-align:right">{o.total_amount != null && <div class="num" style="font-weight:700">{money(o.total_amount)}</div>}
                  <Chip tone={STAGES[o.status]?.tone || 'neutral'}>{t(STAGES[o.status]?.word || o.status)}</Chip></div>
              </button>))}</Sec>

            <Sec title={t('sr_payments')} n={r.payments.length}>{r.payments.map((x) => (
              <button class="li" onClick={() => open(x.customer_id ? `/customer/${x.customer_id}` : x.order_id ? `/slip/${x.order_id}` : '/khata')}>
                <div class="iconbox tone-ok"><Icon name={modeIcon(x.mode)} size={18} /></div>
                <div class="grow" style="min-width:0"><div class="t ellip">{x.customer || '—'}</div>
                  <div class="s">{shortDate(x.received_at, tz)} · {t(KIND[x.kind] || 'payment')} · {modeText(x.mode)}</div></div>
                <b class="num" style="color:var(--ok)">{money(x.amount)}</b>
              </button>))}</Sec>

            <Sec title={t('sr_purchases')} n={r.purchases.length}>{r.purchases.map((b) => (
              <button class="li" onClick={() => open(`/purchase/${b.id}`)}>
                <div class="iconbox tone-neutral"><Icon name="Truck" size={18} /></div>
                <div class="grow" style="min-width:0"><div class="t ellip">{b.suppliers?.name || t('sr_bill')}{b.bill_no ? ` · ${b.bill_no}` : ''}</div>
                  <div class="s">{shortDate(b.bill_date, tz)}</div></div>
                <b class="num">{money(b.total_amount)}</b>
              </button>))}</Sec>

            <Sec title={t('sr_expenses')} n={r.expenses.length}>{r.expenses.map((e) => (
              <button class="li" onClick={() => open('/expenses')}>
                <div class="iconbox tone-bad"><Icon name={catOf(e.category).icon} size={18} /></div>
                <div class="grow" style="min-width:0"><div class="t ellip">{t(catOf(e.category).word)}{e.paid_to ? ` · ${e.paid_to}` : ''}</div>
                  <div class="s">{shortDate(e.business_date || e.paid_at, tz)}{e.note ? ` · ${e.note}` : ''}</div></div>
                <b class="num" style="color:var(--bad)">{money(e.amount)}</b>
              </button>))}</Sec>
          </>
        )}
      </div>
    </>
  );
}

function Sec({ title, n, children }) {
  if (!n) return null;
  return <><div class="sec"><h3>{title} <span class="faint">({n})</span></h3></div><div class="card">{children}</div></>;
}
