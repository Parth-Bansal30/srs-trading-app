// #/daybook — the Day book (7 Nov 2026, plan v2 step 11). One day, a week, a month or any dates at a glance: sales
// (GST bill / no bill — no-bill only for people who may see it), money in and out, what was bought, a rough profit,
// GST for the CA and the stock as it was on that day. Read-only: every number comes from the server (@srs/core sums).
// #/daybook?day=2026-11-04 or ?month=2026-10 opens on that day / month.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { dayBookPeriod, dayBookShift, businessDate } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { money, kg, time } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go, route, replace } from '../../lib/router.js';
import { shapeName, dimText } from '../../lib/orders.js';
import { catOf } from '../../lib/expenses.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import '../money/money-screens.css';
import '../../ui/gst/gst.css';
import './daybook.css';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const parts = (s) => s.split('-').map(Number);
const addDays = (s, k) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const dayNo = (s) => Date.parse(`${s}T00:00:00Z`) / 86400000;
const weekday = (s) => WEEK[new Date(`${s}T00:00:00Z`).getUTCDay()];
const monthName = (m) => { const [y, mo] = parts(m); return `${MONTH[mo - 1]} ${y}`; };
const shortDay = (s) => { const [, m, d] = parts(s); return `${d} ${MON[m - 1]}`; };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const tz = () => company.value?.timezone || 'Asia/Kolkata';
const todayNow = () => businessDate(new Date().toISOString(), tz());

/** "Wed, 4 Nov 2026" · "2 – 8 Nov 2026" · "November 2026" · "28 Oct – 3 Nov 2026". */
function periodTitle(p) {
  if (p.kind === 'day') return `${weekday(p.from)}, ${fmtDay(p.from)}`;
  if (p.kind === 'month') return monthName(p.from.slice(0, 7));
  const [y1, m1, d1] = parts(p.from); const [y2, m2, d2] = parts(p.to);
  if (p.from === p.to) return `${weekday(p.from)}, ${fmtDay(p.from)}`;
  if (y1 === y2 && m1 === m2) return `${d1} – ${d2} ${MON[m2 - 1]} ${y2}`;
  return `${shortDay(p.from)}${y1 !== y2 ? ` ${y1}` : ''} – ${fmtDay(p.to)}`;
}
function periodSub(p, today) {
  const n = dayNo(p.to) - dayNo(p.from) + 1;
  if (p.kind === 'day') return p.from === today ? t('dbk_today') : p.from === addDays(today, -1) ? t('dbk_yesterday') : t('dbk_days_ago', dayNo(today) - dayNo(p.from));
  if (p.kind === 'week') return p.to === today ? t('dbk_week_so_far', n) : t('dbk_week');
  if (p.kind === 'month') return p.to === today ? t('dbk_month_so_far', n) : t('dbk_whole_month');
  return t('dbk_n_days', n);
}
function compareWord(p) {
  if (p.kind === 'day') return t('dbk_vs_day', `${weekday(p.prevFrom)} ${shortDay(p.prevFrom)}`);
  if (p.kind === 'week') return t('dbk_vs_week');
  if (p.kind === 'month') return t('dbk_vs_month', MONTH[parts(p.prevFrom)[1] - 1]);
  return t('dbk_vs_range', dayNo(p.to) - dayNo(p.from) + 1);
}
const steelText = (it) => `${it.g} ${shapeName(it.sh)} ${dimText({ shape: it.sh, d: it.d, unit: it.u })}`;

function firstPeriod(today) {
  const q = route.value.query;
  if (DAY.test(q.day || '')) return dayBookPeriod(q.week === '1' ? 'week' : 'day', q.day, today);
  if (/^\d{4}-\d{2}$/.test(q.month || '')) return dayBookPeriod('month', `${q.month}-01`, today);
  if (DAY.test(q.from || '') && DAY.test(q.to || '') && q.from <= q.to) return rangeOf(q.from, q.to, today);
  return dayBookPeriod('day', today, today);
}
function rangeOf(from, to, today) {
  const end = to > today ? today : to; const n = dayNo(end) - dayNo(from);
  const prevTo = addDays(from, -1);
  return { kind: 'range', from, to: end, prevFrom: addDays(prevTo, -n), prevTo };
}

export function DayBook() {
  const today = todayNow();
  const [p, setP] = useState(() => firstPeriod(today));
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('sales');
  const [cal, setCal] = useState(false);
  const wrote = useRef('');
  useEffect(() => { if (!can('money')) go('/'); }, []);
  // opened again with other days in the address (a link from another screen): show those days
  useEffect(() => { const cur = location.hash.slice(1); if (wrote.current && cur !== wrote.current) setP(firstPeriod(todayNow())); }, [route.value]);
  useEffect(() => {
    setD(null); setErr(null);
    const q = p.kind === 'day' ? `?day=${p.from}` : p.kind === 'month' ? `?month=${p.from.slice(0, 7)}` : p.kind === 'range' ? `?from=${p.from}&to=${p.to}` : `?day=${p.from}&week=1`;
    wrote.current = `/daybook${p.kind === 'day' && p.from === today ? '' : q}`;
    replace(wrote.current);
    let live = true;   // only the answer for the days on screen (an older, slower answer is dropped)
    call('dayBook', p.kind === 'range' ? { from: p.from, to: p.to } : { kind: p.kind, at: p.from })
      .then((x) => live && setD(x)).catch((e) => live && setErr(e.message || t('err_generic')));
    return () => { live = false; };
  }, [p.kind, p.from, p.to]);

  const prev = dayBookShift(p, -1, today);
  const next = p.kind === 'range' ? null : dayBookShift(p, 1, today);
  const quick = [
    ['today', t('dbk_today'), () => dayBookPeriod('day', today, today)],
    ['yesterday', t('dbk_yesterday'), () => dayBookPeriod('day', addDays(today, -1), today)],
    ['week', t('dbk_this_week'), () => dayBookPeriod('week', today, today)],
    ['month', t('dbk_this_month'), () => dayBookPeriod('month', today, today)],
    ['last', t('dbk_last_month'), () => dayBookPeriod('month', addDays(`${today.slice(0, 7)}-01`, -1), today)],
  ];
  const same = (a, b) => a.kind === b.kind && a.from === b.from && a.to === b.to;
  const s = d?.summary;
  const tabs = [['sales', t('dbk_t_sales')], d?.can_stock && ['bought', t('dbk_t_bought')], ['money', t('dbk_t_money')], can('orders') && ['stock', t('dbk_t_stock')]].filter(Boolean);

  return (
    <>
      <TopBar title={t('dbk_title')} right={<button class="round" onClick={() => setCal(true)} aria-label={t('dbk_choose')}><Icon name="CalendarDays" size={19} /></button>} />
      <div class="page" style="padding-bottom:110px">
        <div class="dbk-nav">
          <button class="round" disabled={!prev} onClick={() => prev && setP(prev)} aria-label={t('dbk_before')}><Icon name="ChevronLeft" size={20} /></button>
          <button class="dbk-when" onClick={() => setCal(true)}><div class="t">{periodTitle(p)}</div><div class="s">{periodSub(p, today)}</div></button>
          <button class="round" disabled={!next} onClick={() => next && setP(next)} aria-label={t('dbk_after')}><Icon name="ChevronRight" size={20} /></button>
        </div>
        <div class="chips-scroll" style="margin-top:4px">
          {quick.map(([id, w, mk]) => { const x = mk(); return <button class={`fchip ${same(x, p) ? 'on' : ''}`} onClick={() => setP(x)} data-q={id}>{w}</button>; })}
          <button class={`fchip ${p.kind === 'range' ? 'on' : ''}`} onClick={() => setCal(true)}><Icon name="CalendarRange" size={15} style="vertical-align:-2px;margin-right:5px" />{t('dbk_choose_short')}</button>
        </div>

        {err && <div class="error">{err}</div>}
        {!d && !err && <><Skeleton h={190} /><div class="dbk-grid"><Skeleton h={110} /><Skeleton h={110} /></div></>}
        {d && <>
          <Hero d={d} p={p} />
          <div class="dbk-grid">
            <div class="card dbk-stat"><div class="cap"><Icon name="ArrowDownLeft" size={14} />{t('dbk_in')}</div>
              <div class="v num" style="color:var(--ok)">{money(s.money_in.total, false)}</div>
              <div class="s">{t('dbk_cash_bank', money(s.money_in.cash, false), money(s.money_in.bank, false))}</div></div>
            {s.money_out ? <div class="card dbk-stat"><div class="cap"><Icon name="ArrowUpRight" size={14} />{t('dbk_out')}</div>
              <div class="v num" style="color:var(--bad)">{money(s.money_out.total, false)}</div>
              <div class="s">{t('dbk_out_s', money(s.money_out.supplier, false), money(s.money_out.other, false))}</div>
              {s.money_out.home > 0 && <div class="s faint">{t('dbk_home', money(s.money_out.home, false))}</div>}</div>
              : <div class="card dbk-stat"><div class="cap"><Icon name="BookOpenText" size={14} />{t('dbk_left')}</div>
                <div class="v num" style="color:var(--warn)">{money(s.sales.left, false)}</div><div class="s">{t('dbk_left_s', s.sales.left_slips)}</div></div>}
            {s.bought && <div class="card dbk-stat"><div class="cap"><Icon name="Truck" size={14} />{t('dbk_bought')}</div>
              <div class="v num" style="color:var(--pakka)">{money(s.bought.total, false)}</div>
              <div class="s">{t('dbk_bought_s', s.bought.bills, kg(s.bought.kg, 0))}</div></div>}
            {d.can_stock && <div class="card dbk-stat"><div class="cap"><Icon name="TrendingUp" size={14} />{t('dbk_profit')}</div>
              <div class="v num">{s.profit.known ? money(s.profit.amount, false) : '—'}</div>
              <div class="s">{s.profit.known ? t('dbk_profit_s') : t('dbk_profit_none')}</div>
              {s.profit.known > 0 && s.profit.unknown > 0 && <div class="s faint">{t('dbk_profit_left_out', s.profit.unknown)}</div>}</div>}
          </div>
          {p.kind !== 'day' && (s.gst.sales > 0 || (s.gst.purchases || 0) > 0) && <GstCard s={s} p={p} />}

          <div class="seg dbk-tabs">{tabs.map(([id, w]) => <button class={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{w}</button>)}</div>
          {tab === 'sales' && <SalesTab d={d} p={p} />}
          {tab === 'bought' && d.bought && <BoughtTab d={d} today={today} />}
          {tab === 'money' && <MoneyTab d={d} p={p} today={today} />}
          {tab === 'stock' && <StockTab p={p} />}
        </>}
      </div>
      <Calendar open={cal} onClose={() => setCal(false)} today={today} p={p} onPick={(x) => { setP(x); setCal(false); }} />
    </>
  );
}

function Hero({ d, p }) {
  const s = d.summary;
  const many = p.from !== p.to;
  const bars = useMemo(() => {
    if (!many) return null;
    const by = new Map(s.days.map((x) => [x.day, x.total]));
    const out = []; for (let x = p.from; x <= p.to && out.length < 400; x = addDays(x, 1)) out.push({ day: x, total: by.get(x) || 0 });
    return out;
  }, [d]);
  const max = bars ? Math.max(...bars.map((b) => b.total), 1) : 1;
  return (
    <div class="hero dbk-hero">
      <div class="hero-glow" />
      <div class="hero-cap" style="position:relative">{t('dbk_sales')}</div>
      <div class="hero-num num" style="margin-bottom:4px">{money(s.sales.total, false)}</div>
      <div class="dbk-hero-s num">{t('dbk_slips_kg', s.sales.slips, kg(s.sales.kg, 0))}{s.prev != null && s.change == null && s.prev === 0 && s.sales.total > 0 ? ` · ${t('dbk_prev_none')}` : ''}</div>
      {s.change != null && <div class={`dbk-cmp ${s.change >= 0 ? 'up' : 'down'}`}><Icon name={s.change >= 0 ? 'TrendingUp' : 'TrendingDown'} size={14} />
        <b class="num">{s.change >= 200 ? t('dbk_times', s.change >= 900 ? Math.round(s.change / 100 + 1) : Math.round((s.change / 100 + 1) * 10) / 10) : `${s.change > 0 ? '+' : ''}${s.change}%`}</b> {compareWord(d.period || p)}</div>}
      {bars && bars.length > 1 && <div class="dbk-bars" aria-hidden="true">{bars.map((b) => <i class={s.best && b.day === s.best.day ? 'best' : ''} style={`height:${b.total ? Math.max(6, Math.round((b.total / max) * 100)) : 2}%`} title={`${shortDay(b.day)} ${money(b.total, false)}`} />)}</div>}
      {many && s.best && <div class="dbk-hero-s" style="margin:8px 0 12px">{t('dbk_best', `${weekday(s.best.day)} ${shortDay(s.best.day)}`, money(s.best.total, false))}</div>}
      <div class="hero-row" style={many && s.best ? '' : 'margin-top:12px'}>
        <div class="hero-box"><div class="cap">{t('gst_bills')}</div><div class="num v">{money(s.sales.gst_bills, false)}</div></div>
        {d.kacha && <div class="hero-box"><div class="cap">{t('no_bills')}</div><div class="num v">{money(s.sales.no_bill, false)}</div></div>}
      </div>
    </div>
  );
}

function GstCard({ s, p }) {
  return (
    <div class="card pad dbk-gst">
      <div class="row"><div class="iconbox tone-pakka"><Icon name="Percent" size={17} /></div><div class="grow"><div class="t" style="font-weight:800">{t('dbk_gst_title')}</div>
        <div class="s faint" style="font-size:12.5px">{t('dbk_gst_s')}</div></div></div>
      <div class="ca-tot" style="margin-top:10px">
        <div><span>{t('dbk_gst_sales')}</span><b class="num">{money(s.gst.sales, false)}</b></div>
        {s.gst.purchases != null && <div><span>{t('dbk_gst_buys')}</span><b class="num">{money(s.gst.purchases, false)}</b></div>}
        {s.gst.expenses != null && s.gst.expenses > 0 && <div><span>{t('dbk_gst_exp')}</span><b class="num">{money(s.gst.expenses, false)}</b></div>}
        {s.gst.to_pay != null && <div><span>{s.gst.to_pay >= 0 ? t('dbk_gst_to_pay') : t('dbk_gst_credit')}</span><b class="num">{money(Math.abs(s.gst.to_pay), false)}</b></div>}
      </div>
      {can('khata') && <button class="btn btn-ghost btn-block" style="margin-top:12px" onClick={() => go(p.kind === 'month' ? `/ca?month=${p.from.slice(0, 7)}` : '/ca')}>
        <Icon name="FileSpreadsheet" size={18} />{p.kind === 'month' ? t('dbk_to_ca', MONTH[parts(p.from)[1] - 1]) : t('dbk_to_ca_any')}</button>}
    </div>
  );
}

function SalesTab({ d, p }) {
  const [f, setF] = useState('all');
  const [all, setAll] = useState(false);
  const s = d.summary;
  const list = d.slips.filter((o) => f === 'all' || (f === 'gst' ? o.bill === 'pakka' : f === 'none' ? o.bill === 'kacha' : o.total - o.paid > 0.004));
  const shown = all ? list : list.slice(0, 30);
  const many = p.from !== p.to;
  const dayTot = useMemo(() => new Map(s.days.map((x) => [x.day, x])), [d]);
  const filters = [['all', t('dbk_f_all', d.slips.length)], ['gst', t('bill_gst_short')], d.kacha && ['none', t('bill_none_short')], ['left', t('dbk_f_left')]].filter(Boolean);
  let lastDay = null;
  return (
    <>
      <div class="chips-scroll">{filters.map(([id, w]) => <button class={`fchip ${f === id ? 'on' : ''}`} onClick={() => { setF(id); setAll(false); }}>{w}</button>)}</div>
      {f === 'left' && s.sales.left > 0 && <div class="notice" style="margin-bottom:10px">{t('dbk_left_note', money(s.sales.left, false), s.sales.left_slips)}</div>}
      <div class="card">
        {list.length === 0 && <div class="li muted">{d.slips.length ? t('dbk_none_here') : t('dbk_no_sales')}</div>}
        {shown.map((o) => {
          const head = many && o.day !== lastDay ? (lastDay = o.day, dayTot.get(o.day)) : null;
          const left = Math.max(0, Math.round((o.total - o.paid) * 100) / 100);
          return (<>
            {head && <div class="dbk-dayhead"><span>{weekday(o.day)}, {shortDay(o.day)}</span><span class="num">{t('dbk_day_tot', money(head.total, false), head.slips)}</span></div>}
            <button class="li dbk-slip" onClick={() => go(`/slip/${o.id}`)}>
              <div class="grow" style="min-width:0"><div class="t">#{o.slip_no} · {o.customer}</div>
                <div class="s">{o.items.length === 1 ? steelText(o.items[0]) : t('dbk_items_n', o.items.length)} · {kg(o.kg, 0)} · {time(o.at, tz())}</div></div>
              <div class="dbk-right"><b class="num">{money(o.total, false)}</b>
                <div class="dbk-chips">{d.kacha && <span class={`chip tone-${o.bill === 'pakka' ? 'pakka' : 'kacha'}`}>{t(o.bill === 'pakka' ? 'bill_gst_short' : 'bill_none_short')}</span>}
                  {o.direct && <span class="chip tone-neutral">{t('dbk_direct')}</span>}</div>
                {left > 0 && <span class="chip tone-bad">{t('dbk_in_khata', money(left, false))}</span>}</div>
            </button></>);
        })}
        {!all && list.length > 30 && <button class="li" onClick={() => setAll(true)}><span class="grow link" style="min-height:0">{t('dbk_see_all', list.length)}</span><Icon name="ChevronDown" size={16} /></button>}
      </div>
      {s.top.length > 0 && f === 'all' && <>
        <div class="sec"><h3>{t('dbk_top')}</h3></div>
        <div class="card pad exp-bars">{s.top.map((x) => (
          <div class="exp-bar"><div class="row" style="justify-content:space-between;gap:10px"><span style="font-weight:600;font-size:14.5px">{steelText(x)} <span class="faint" style="font-size:12.5px">{t('dbk_top_slips', x.slips)}</span></span><b class="num">{kg(x.kg, 0)}</b></div>
            <div class="exp-track"><div style={`width:${Math.max(3, Math.round((x.kg / s.top[0].kg) * 100))}%;background:var(--accent)`} /></div></div>))}</div>
      </>}
    </>
  );
}

function BoughtTab({ d, today }) {
  const [f, setF] = useState('all');
  const list = d.bought.filter((b) => f === 'all' || (f === 'pay' ? !b.paid && b.left > 0 : b.paid || b.left <= 0));
  const tp = d.summary.to_pay;
  return (
    <>
      <div class="chips-scroll">{[['all', t('dbk_f_all', d.bought.length)], ['pay', t('dbk_f_to_pay')], ['paid', t('dbk_f_paid')]].map(([id, w]) => <button class={`fchip ${f === id ? 'on' : ''}`} onClick={() => setF(id)}>{w}</button>)}</div>
      <div class="card">
        {list.length === 0 && <div class="li muted">{d.bought.length ? t('dbk_none_here') : t('dbk_no_buys')}</div>}
        {list.map((b) => {
          const late = !b.paid && b.left > 0 && b.due && b.due < today;
          return (
            <button class="li dbk-slip" onClick={() => go(`/purchase/${b.id}`)}>
              <div class="grow" style="min-width:0"><div class="t">{b.supplier || t('dbk_no_supplier')}{b.bill_no ? ` · ${b.bill_no}` : ''}</div>
                <div class="s">{[b.first, b.kg ? kg(b.kg, 0) : null, fmtDay(b.date, false)].filter(Boolean).join(' · ')}</div></div>
              <div class="dbk-right"><b class="num">{money(b.total, false)}</b>
                {b.effect === 'opening' ? <span class="chip tone-neutral">{t('pu_eff_opening')}</span>
                  : b.paid || b.left <= 0 ? <span class="chip tone-ok">{t('dbk_paid')}</span>
                    : <span class={`chip tone-${late ? 'bad' : 'warn'}`}>{t('dbk_to_pay', money(b.left, false))}</span>}
                {!b.paid && b.left > 0 && b.due && <span class={`dbk-due ${late ? 'late' : ''}`}>{late ? t('dbk_due_late', fmtDay(b.due, false)) : t('dbk_due', fmtDay(b.due, false))}</span>}</div>
            </button>);
        })}
      </div>
      {tp && <>
        <div class="sec"><h3>{t('dbk_to_pay_all')}</h3></div>
        <button class="card li" onClick={() => go('/suppliers')}><div class="iconbox tone-warn"><Icon name="Truck" size={18} /></div>
          <div class="grow"><div class="t num">{money(tp.amount, false)}</div><div class="s">{Number(tp.bills) ? t('dbk_to_pay_s', tp.bills, fmtDay(tp.oldest, false)) : t('dbk_to_pay_none')}</div></div>
          <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" /></button>
      </>}
    </>
  );
}

function MoneyTab({ d, p, today }) {
  const s = d.summary;
  const sum = (k) => d.money_in.filter((x) => x.kind === k).reduce((a, x) => a + x.amount, 0);
  const kinds = [['pickup', t('paid_spot')], ['advance', t('adv_taken')], ['khata', t('old_collected')]].map(([k, w]) => [k, w, Math.round(sum(k) * 100) / 100]).filter((x) => x[2] !== 0);
  const other = Math.round((s.money_in.total - kinds.reduce((a, x) => a + x[2], 0)) * 100) / 100;
  const mo = s.money_out;
  const maxCat = mo ? Math.max(1, ...mo.by_category.map((c) => c.amount)) : 1;
  return (
    <>
      <div class="sec"><h3>{t('dbk_in')}</h3><b class="num" style="color:var(--ok)">{money(s.money_in.total, false)}</b></div>
      <div class="card">
        {s.money_in.count === 0 && <div class="li muted">{t('dbk_no_money_in')}</div>}
        {kinds.map(([, w, v]) => <div class="li"><span class="grow">{w}</span><b class="num">{money(v, false)}</b></div>)}
        {Math.abs(other) > 0.004 && <div class="li"><span class="grow">{t('dbk_in_other')}</span><b class="num">{money(other, false)}</b></div>}
        {s.money_in.count > 0 && <div class="li" style="gap:8px;flex-wrap:wrap"><span class="chip tone-ok"><Icon name="Banknote" size={14} />{t('dbk_cash', money(s.money_in.cash, false))}</span>
          <span class="chip tone-pakka"><Icon name="Landmark" size={14} />{t('dbk_bank', money(s.money_in.bank, false))}</span></div>}
      </div>
      {mo && <>
        <div class="sec"><h3>{t('dbk_out')}</h3><b class="num" style="color:var(--bad)">{money(mo.total, false)}</b></div>
        <div class="card pad exp-bars">
          {mo.total === 0 && <div class="muted">{t('dbk_no_money_out')}</div>}
          {mo.supplier > 0 && <OutBar look={catOf('supplier')} amount={mo.supplier} max={Math.max(maxCat, mo.supplier)} n={mo.supplier_n} />}
          {mo.by_category.map((c) => <OutBar look={catOf(c.category)} amount={c.amount} max={Math.max(maxCat, mo.supplier)} />)}
          {mo.cash > 0 && <div class="faint" style="font-size:12.5px;font-weight:600">{t('dbk_out_cash', money(mo.cash, false))}</div>}
        </div>
        {mo.home > 0 && <div class="card li" style="margin-top:10px"><div class="iconbox" style="background:var(--sunk)"><Icon name="House" size={18} /></div>
          <div class="grow"><div class="t">{t('ec_home')}</div><div class="s">{t('dbk_home_s')}</div></div><b class="num">{money(mo.home, false)}</b></div>}
      </>}
      <div class="dbk-links">
        {can('expenses') && <button class="btn btn-ghost" onClick={() => go('/expenses')}><Icon name="Receipt" size={17} />{t('nav_expenses')}</button>}
        {p.kind === 'day' && p.from === today && <button class="btn btn-ghost" onClick={() => go('/reports')}><Icon name="ChartColumn" size={17} />{t('tile_today')}</button>}
        {p.kind === 'day' && p.from === today && can('today') && <button class="btn btn-ghost" onClick={() => go('/close-day')}><Icon name="ClipboardCheck" size={17} />{t('close_title')}</button>}
      </div>
    </>
  );
}
const OutBar = ({ look, amount, max, n }) => (
  <div class="exp-bar"><div class="row" style="justify-content:space-between"><span class="row" style="gap:8px;font-weight:600;font-size:14.5px"><Icon name={look.icon} size={16} style={`color:${look.tone}`} />{t(look.word)}{n ? <span class="faint" style="font-weight:600;font-size:12.5px">{n}</span> : null}</span><b class="num">{money(amount, false)}</b></div>
    <div class="exp-track"><div style={`width:${Math.max(2, Math.round((amount / max) * 100))}%;background:${look.tone}`} /></div></div>
);

function StockTab({ p }) {
  const [st, setSt] = useState(null);
  const [err, setErr] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    setSt(null); setErr(null); let live = true;
    call('stockOn', { day: p.to, from: p.from }).then((x) => live && setSt(x)).catch((e) => live && setErr(e.message || t('err_generic')));
    return () => { live = false; };
  }, [p.from, p.to]);
  if (err) return <div class="error">{err}</div>;
  if (!st) return <Skeleton h={200} style="margin-top:12px" />;
  const items = all ? st.items : st.items.slice(0, 25);
  return (
    <>
      <div class="sec"><h3>{t('dbk_stock_on', fmtDay(st.day))}</h3></div>
      <div class="dbk-grid" style="margin-top:0">
        <div class="card dbk-stat"><div class="cap">{t('dbk_stock_kg')}</div><div class="v num">{kg(st.kg, 0)}</div><div class="s">{t('dbk_stock_items', st.items.length)}</div></div>
        {st.worth != null ? <div class="card dbk-stat"><div class="cap">{t('dbk_stock_worth')}</div><div class="v num">{money(st.worth, false)}</div><div class="s">{t('dbk_stock_worth_s')}</div></div>
          : <div class="card dbk-stat"><div class="cap">{t('dbk_stock_low')}</div><div class="v num" style={st.low ? 'color:var(--warn)' : ''}>{st.low}</div><div class="s">{t('dbk_stock_low_s')}</div></div>}
      </div>
      <div class="card pad exp-bars" style="margin-top:10px">
        {st.items.length === 0 && <div class="muted">{t('dbk_stock_none')}</div>}
        {items.map((x) => {
          const low = x.then < 200;
          return (
            <div class="exp-bar">
              <div class="row" style="justify-content:space-between;gap:10px"><span style="font-weight:700;font-size:14.5px">{x.code} {shapeName(x.shape)}</span><b class="num" style={low ? 'color:var(--warn)' : ''}>{kg(x.then, 0)}</b></div>
              <div class="exp-track"><div style={`width:${Math.max(2, Math.round((Math.max(0, x.then) / Math.max(1, st.max)) * 100))}%;background:${low ? 'var(--warn)' : 'var(--pakka)'}`} /></div>
              <div class="dbk-moves num">{x.in > 0 && <span class="in">+{kg(x.in, 0)} {t('dbk_m_in')}</span>}{x.out > 0 && <span class="out">−{kg(x.out, 0)} {t('dbk_m_out')}</span>}
                {Math.abs(x.now - x.then) > 0.5 && <span>{t('dbk_m_now', kg(x.now, 0))}</span>}</div>
            </div>);
        })}
        {!all && st.items.length > 25 && <button class="link" onClick={() => setAll(true)}>{t('dbk_see_all_stock', st.items.length)}</button>}
      </div>
      <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:10px">{p.from === p.to ? t('dbk_stock_note_day') : t('dbk_stock_note', shortDay(p.from), shortDay(p.to))}</div>
    </>
  );
}

/** "Choose a day or dates": a month calendar coloured by that day's sales; one day, or a first and a last day. */
function Calendar({ open, onClose, today, p, onPick }) {
  const [m, setM] = useState(p.from.slice(0, 7));
  const [mode, setMode] = useState(p.kind === 'range' ? 'range' : 'day');
  const [start, setStart] = useState(null);
  const [days, setDays] = useState(null);
  useEffect(() => { if (open) { setM(p.from.slice(0, 7)); setStart(null); } }, [open]);
  useEffect(() => {
    if (!open) return undefined; setDays(null); let live = true;
    call('salesDays', { month: m }).then((x) => live && setDays(x)).catch(() => live && setDays({ days: [], max: 0 }));
    return () => { live = false; };
  }, [open, m]);
  const [y, mo] = parts(m);
  const first = `${m}-01`;
  const len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const by = new Map((days?.days || []).map((x) => [x.day, x]));
  const total = (days?.days || []).reduce((a, x) => a + x.total, 0);
  const shift = (k) => { const d = new Date(Date.UTC(y, mo - 1 + k, 1)).toISOString().slice(0, 7); if (`${d}-01` <= today) setM(d); };
  const tap = (day) => {
    if (mode === 'day') return onPick(dayBookPeriod('day', day, today));
    if (!start) return setStart(day);
    const [a, b] = start <= day ? [start, day] : [day, start];
    onPick(a === b ? dayBookPeriod('day', a, today) : rangeOf(a, b, today));
  };
  const sel = (day) => (start ? day === start : (p.kind === 'day' || p.kind === 'range') && p.from <= day && day <= p.to);
  return (
    <Sheet open={open} onClose={onClose} title={t('dbk_choose')}
      footer={<button class="btn btn-ghost btn-block" onClick={() => onPick(dayBookPeriod('month', first, today))}><Icon name="CalendarDays" size={18} />{t('dbk_whole', monthName(m))}</button>}>
      <div class="seg" style="margin-bottom:12px"><button class={mode === 'day' ? 'on' : ''} onClick={() => { setMode('day'); setStart(null); }}>{t('dbk_one_day')}</button>
        <button class={mode === 'range' ? 'on' : ''} onClick={() => { setMode('range'); setStart(null); }}>{t('dbk_from_to')}</button></div>
      <div class="row" style="margin-bottom:8px">
        <button class="round" onClick={() => shift(-1)} aria-label={t('dbk_before')}><Icon name="ChevronLeft" size={18} /></button>
        <div class="grow" style="text-align:center"><div style="font-weight:800;font-size:16px">{monthName(m)}</div>
          <div class="faint num" style="font-size:12.5px;font-weight:600">{days ? t('dbk_cal_total', money(total, false)) : '…'}</div></div>
        <button class="round" disabled={`${m}-01` >= `${today.slice(0, 7)}-01`} onClick={() => shift(1)} aria-label={t('dbk_after')}><Icon name="ChevronRight" size={18} /></button>
      </div>
      <div class="dbk-cal">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w) => <div class="wd">{w}</div>)}
        {Array.from({ length: lead }, () => <div />)}
        {Array.from({ length: len }, (_, i) => {
          const day = `${m}-${String(i + 1).padStart(2, '0')}`; const x = by.get(day);
          const future = day > today;
          return <button class={`dbk-d h${x ? x.step : 0} ${sel(day) ? 'sel' : ''} ${day === today ? 'now' : ''}`} disabled={future} onClick={() => tap(day)}
            aria-label={`${fmtDay(day)} ${x ? money(x.total, false) : ''}`}><span>{i + 1}</span>{x && <small class="num">{x.total >= 100000 ? `${Math.round(x.total / 10000) / 10}L` : x.total >= 1000 ? `${Math.round(x.total / 1000)}k` : Math.round(x.total)}</small>}</button>;
        })}
      </div>
      <div class="dbk-key"><span>{t('dbk_less')}</span>{[0, 1, 2, 3, 4].map((h) => <i class={`h${h}`} />)}<span>{t('dbk_more')}</span></div>
      <div class="faint" style="font-size:13px;font-weight:600;margin-top:10px;text-align:center">{mode === 'range' ? (start ? t('dbk_tap_last', fmtDay(start, false)) : t('dbk_tap_first')) : t('dbk_tap_day')}</div>
    </Sheet>
  );
}
