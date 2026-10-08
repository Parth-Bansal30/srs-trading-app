// Close the day (8 Oct 2026): three steps at the end of the day — count the cash drawer, tick each
// bank / UPI account (owners), see what is still open — then the evening summary.
// Address: #/close-day
import { useEffect, useState } from 'preact/hooks';
import { r2 } from '@srs/core';
import { t } from '../lib/i18n.js';
import { can, me, company } from '../lib/session.js';
import { call } from '../lib/api.js';
import { useAction } from '../lib/action.js';
import { loadToday } from '../lib/data.js';
import { money, longDay } from '../lib/format.js';
import { go } from '../lib/router.js';
import { toast } from '../ui/toast.js';
import { accName } from '../lib/accounts.js';
import { Icon, TopBar, Skeleton } from '../ui/kit.jsx';
import { HelpButton } from '../ui/easy/Help.jsx';
import '../ui/easy/easy.css';
import '../ui/money/money.css';

export function CloseDay() {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState(null);
  const [counted, setCounted] = useState('');
  const [ticks, setTicks] = useState(new Set());
  const cash = useAction('saveCashCount');
  const tz = company.value?.timezone || 'Asia/Kolkata';
  const load = () => {
    call('daySummary', {}).then((x) => { setD(x); setTicks(new Set((x.summary.accounts?.rows || []).filter((r) => r.checked).map((r) => r.id))); })
      .catch((e) => setErr(e.message));
    loadToday({ perms: me.value?.perms || {}, tz }).then(setOpen).catch(() => setOpen({ counts: {} }));
  };
  useEffect(() => { if (!can('today') || !can('money')) { go('/'); return; } load(); }, []);

  if (err) return <><TopBar title={t('close_title')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!d) return <><TopBar title={t('close_title')} /><div class="page"><Skeleton h={140} /><Skeleton h={140} style="margin-top:10px" /></div></>;
  const s = d.summary;
  const cashDone = s.cash.counted != null;
  const rows = (s.accounts?.rows || []).filter((r) => r.n > 0 && !r.isDrawer);
  const left = rows.filter((r) => !ticks.has(r.id)).length;
  const c = open?.counts || {};
  const openItems = [
    c.toWeigh > 0 && t('easy_weigh', c.toWeigh), c.readyForPickup > 0 && t('easy_pickup', c.readyForPickup), c.reminders > 0 && t('close_reminders', c.reminders),
  ].filter(Boolean);
  const tick = (r) => {
    const on = !ticks.has(r.id);
    const next = new Set(ticks); on ? next.add(r.id) : next.delete(r.id); setTicks(next);
    call('checkAccount', { account_id: r.id, day: d.day, checked: on }).catch((e) => { toast(e.message || t('err_generic')); load(); });
  };
  const saveCash = () => cash.run({ counted: r2(Number(counted)) }).then(() => { setCounted(''); load(); }).catch(() => {});
  const diffTxt = cashDone ? (s.cash.diff === 0 ? t('close_cash_ok') : t(s.cash.diff < 0 ? 'close_short' : 'close_over', money(Math.abs(s.cash.diff), false))) : null;
  const Step = ({ n, state, title, en, children }) => (
    <div class={`card cstep ${state === 'now' ? 'now' : ''}`}>
      <div class="row" style="gap:12px"><div class={`cstep-n ${state}`}>{state === 'done' ? <Icon name="Check" size={17} stroke={3} /> : n}</div>
        <div class="grow"><div class="cstep-t">{title}</div>{en && <div class="muted" style="font-size:12.5px">{en}</div>}</div></div>
      {children}
    </div>
  );
  let step = 1;
  return (
    <>
      <TopBar title={t('close_title')} sub={longDay(`${d.day}T12:00:00+05:30`, tz)} right={<HelpButton always />} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        <Step n={step++} state={cashDone ? 'done' : 'now'} title={t('close_cash')}>
          <div class="row" style="justify-content:space-between;font-size:15px;margin-top:8px"><span class="muted">{t('close_cash_app')}</span><b class="num">{money(s.cash.expected, false)}</b></div>
          {cashDone ? <>
            <div class="row" style="justify-content:space-between;font-size:15px;margin-top:2px"><span class="muted">{t('close_cash_count')}</span><b class="num">{money(s.cash.counted, false)}</b></div>
            <div style={`font-weight:800;font-size:15px;margin-top:6px;color:var(--${s.cash.diff === 0 ? 'ok' : s.cash.diff < 0 ? 'bad' : 'warn'})`}>{diffTxt}</div>
          </> : <div class="row" style="gap:8px;margin-top:10px">
            <div class="field num grow"><span class="faint">₹</span><input inputmode="decimal" value={counted} placeholder={t('close_cash_count')} onInput={(e) => setCounted(e.currentTarget.value.replace(/[^\d.]/g, ''))} /></div>
            <button class="btn btn-accent" style="min-height:52px" disabled={cash.busy || counted === ''} onClick={saveCash}>{t('close_cash_save')}</button>
          </div>}
          {cash.error && <div class="error" style="margin-top:8px">{cash.error.message}</div>}
        </Step>

        {can('settings') && rows.length > 0 && (
          <Step n={step++} state={left === 0 ? 'done' : cashDone ? 'now' : 'next'} title={t('close_accounts')}>
            <div class="card tally" style="margin-top:10px;box-shadow:none">
              {rows.map((r) => (
                <button class="li" onClick={() => tick(r)}>
                  <span class={`acc-tick ${ticks.has(r.id) ? 'on' : ''}`}>{ticks.has(r.id) && <Icon name="Check" size={16} stroke={3} />}</span>
                  <span class="grow t">{accName({ name: r.name, is_drawer: r.isDrawer })}</span><b class="num">{money(r.net, false)}</b>
                </button>
              ))}
            </div>
            {left > 0 && <div class="muted" style="font-size:13.5px;margin-top:8px;font-weight:600">{t('close_accounts_left', left)}</div>}
          </Step>
        )}

        <Step n={step++} state={openItems.length ? 'next' : 'done'} title={t('close_open')}>
          <div class="muted" style="font-size:14.5px;line-height:1.55;margin-top:6px">{openItems.length ? openItems.join(' · ') : t('close_nothing')}</div>
        </Step>

        <button class="btn btn-brand btn-block" style="margin-top:14px" onClick={() => go('/evening')}><Icon name="Moon" size={19} />{t('close_done')}</button>
      </div>
    </>
  );
}
