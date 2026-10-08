// Today — what's happening and what needs you, right now.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n.js';
import { me, company, can } from '../lib/session.js';
import { loadToday } from '../lib/data.js';
import { money, longDay, time } from '../lib/format.js';
import { go } from '../lib/router.js';
import { NEEDS } from '../config/navigation.js';
import { STAGES, BILLS } from '../config/options.js';
import { Icon, Chip, LangPill, Skeleton } from '../ui/kit.jsx';
import { startDone } from './start/Start.jsx';
import { easy } from '../lib/easy.js';
import { EasyToday } from './EasyToday.jsx';
import './today.css';

export function Today() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const tz = company.value?.timezone || 'Asia/Kolkata';
  const perms = me.value?.perms || {};

  const load = () => loadToday({ perms, tz }).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e));
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, []);

  const needs = d ? NEEDS.filter((n) => (!n.perm || can(n.perm)) && (d.counts[n.count] || 0) > 0) : [];
  const first = (me.value?.name || '').split(' ')[0];

  if (easy.value.on) return <EasyToday d={d} />;

  return (
    <div class="page today">
      <div class="today-head">
        <div class="grow">
          <div class="faint" style="font-size:13px;font-weight:600">{company.value?.name} · {longDay(new Date().toISOString(), tz)}</div>
          <div class="hello">{t('greet', first)}</div>
        </div>
        <LangPill />
        <button class="avatar" onClick={() => go('/more')} aria-label={t('nav_more')}>{first.slice(0, 1)}</button>
      </div>

      {err && (
        <div class="card pad row" style="margin-bottom:12px">
          <Icon name="WifiOff" size={20} /><div class="grow muted">{t('err_generic')}</div>
          <button class="link" onClick={load}>{t('retry')}</button>
        </div>
      )}

      {can('people') && company.value?.trial_ends_at && !startDone() && (
        <button class="card li" style="margin-bottom:12px;border:1.5px solid var(--accent)" onClick={() => go('/start')}>
          <div class="iconbox tone-accent"><Icon name="PartyPopper" /></div>
          <div class="grow"><div class="t">{t('ready_steps')}</div><div class="s">{t('ready_rates')} · {t('ready_team')} · {t('ready_slip')}</div></div>
          <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
        </button>
      )}

      {can('money') && (
        <div class="hero">
          <div class="hero-glow" />
          <div class="row" style="justify-content:space-between">
            <div class="hero-cap">{t('sales_today_cap')}</div>
          </div>
          <div class="hero-num num">{d?.sales ? money(d.sales.total, false) : <Skeleton h={40} w={180} style="opacity:.2" />}</div>
          <div class="hero-row">
            <div class="hero-box"><div class="cap">{t('bills_n', t('gst_bills'), d?.sales?.nPakka ?? '–')}</div><div class="num v">{d?.sales ? money(d.sales.pakka, false) : '–'}</div></div>
            {can('kacha') && <div class="hero-box"><div class="cap">{t('bills_n', t('no_bills'), d?.sales?.nKacha ?? '–')}</div><div class="num v">{d?.sales ? money(d.sales.kacha, false) : '–'}</div></div>}
            {can('today') && <div class="hero-box"><div class="cap">{t('in_drawer')}</div><div class="num v">{d?.cash != null ? money(d.cash, false) : '–'}</div></div>}
          </div>
        </div>
      )}

      {can('money') && new Date().getHours() >= 17 && (
        <button class="card li" style="margin-top:12px" onClick={() => go('/evening')}>
          <div class="iconbox tone-brand-soft"><Icon name="Moon" /></div>
          <div class="grow"><div class="t">{t('eve_card')}</div><div class="s">{t('eve_where')}</div></div>
          <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
        </button>
      )}

      <div class="sec"><h3>{t('needs_you')}</h3>{needs.length > 0 && <span class="link">{needs.length}</span>}</div>
      {!d ? <div class="card pad"><Skeleton h={18} /><Skeleton h={18} w="60%" style="margin-top:12px" /></div> :
        needs.length === 0 ? (
          <div class="card li"><div class="iconbox tone-ok"><Icon name="CircleCheck" /></div>
            <div class="grow"><div class="t">{t('all_done')}</div><div class="s">{t('all_done_s')}</div></div></div>
        ) : (
          <div class="card">
            {needs.map((n) => {
              const c = d.counts[n.count];
              const sub = n.id === 'remind' && d.reminders ? t('need_remind_s', money(d.reminders.due, false), d.reminders.days) : null;
              return (
                <button class="li" onClick={() => go(n.route)}>
                  <div class={`iconbox tone-${n.tone}`}><Icon name={n.icon} /></div>
                  <div class="grow"><div class="t">{c === 1 && n.one ? t(n.one) : t(n.word, c)}</div>{sub && <div class="s">{sub}</div>}</div>
                  <Icon name="ChevronRight" size={18} stroke={2} style="color:var(--ink-3)" />
                </button>
              );
            })}
          </div>
        )}

      <button class="field ask" onClick={() => go('/guide')}>
        <Icon name="Sparkles" size={18} stroke={2} style="color:var(--accent)" /><span class="faint ellip" style="font-size:15px">{t('ask_steel')}</span>
      </button>

      {can('money') && (
        <>
          <div class="sec"><h3>{t('recent')}</h3><button class="link" onClick={() => go('/slips')}>{t('see_all')}</button></div>
          <div class="card">
            {!d ? <div class="pad"><Skeleton h={18} /></div> : d.recent.length === 0 ? <div class="li muted">{t('no_slips_yet')}</div> :
              d.recent.map((o) => (
                <button class="li" onClick={() => go(`/slip/${o.id}`)}>
                  <div class="grow">
                    <div class="t num ellip">#{o.slip_no} · {o.customers?.name}</div>
                    <div class="s">{t('n_items', o.order_items?.[0]?.count ?? 0)} · {time(o.created_at, tz)}</div>
                  </div>
                  {o.status === 'done'
                    ? <div style="text-align:right"><div class="num" style="font-weight:700">{money(o.total_amount)}</div><Chip tone={BILLS[o.bill_type]?.tone}>{t(BILLS[o.bill_type]?.word)}</Chip></div>
                    : <Chip tone={STAGES[o.status]?.tone}>{t(STAGES[o.status]?.word)}</Chip>}
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
