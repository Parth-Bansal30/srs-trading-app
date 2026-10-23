// Close the day (8 Oct 2026): three steps at the end of the day — count the cash drawer, tick each
// bank / UPI account (owners), see what is still open — then the evening summary.
// 23 Oct 2026: the drawer is a cash book (rokad): what was left last night + cash in − cash out (expenses,
// money moved) = what should be there. After counting, say how much stays for tomorrow; the rest is taken
// out (home / bank) and tomorrow starts from what stayed.
// Address: #/close-day
import { useEffect, useState } from 'preact/hooks';
import { r2, suggestKeep } from '@srs/core';
import { t } from '../lib/i18n.js';
import { can, me, company } from '../lib/session.js';
import { call } from '../lib/api.js';
import { useAction } from '../lib/action.js';
import { loadToday } from '../lib/data.js';
import { money, longDay, time } from '../lib/format.js';
import { go } from '../lib/router.js';
import { toast } from '../ui/toast.js';
import { accName, forgetAccounts } from '../lib/accounts.js';
import { online } from '../lib/net.js';
import { pendingOf, outboxVersion } from '../lib/offline/outbox.js';
import { ExpenseSheet, expenseKinds } from '../ui/money/ExpenseSheet.jsx';
import { Icon, TopBar, Skeleton } from '../ui/kit.jsx';
import { HelpButton } from '../ui/easy/Help.jsx';
import '../ui/easy/easy.css';
import '../ui/money/money.css';

export function CloseDay() {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null);
  const [err, setErr] = useState(null);
  const [ticks, setTicks] = useState(new Set());
  const [cb, setCb] = useState(null);           // the drawer's cash book (moves + where cash can be taken)
  const [addExp, setAddExp] = useState(false);
  const tz = company.value?.timezone || 'Asia/Kolkata';
  const load = () => {
    call('daySummary', {}).then((x) => { setD(x); setTicks(new Set((x.summary.accounts?.rows || []).filter((r) => r.checked).map((r) => r.id))); })
      .catch((e) => setErr(e.message));
    call('cashBook', {}).then(setCb).catch(() => setCb(null));
    loadToday({ perms: me.value?.perms || {}, tz }).then(setOpen).catch(() => setOpen({ counts: {} }));
  };
  useEffect(() => { if (!can('today') || !can('money')) { go('/'); return; } load(); }, [outboxVersion.value]);

  if (err) return <><TopBar title={t('close_title')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!d) return <><TopBar title={t('close_title')} /><div class="page"><Skeleton h={140} /><Skeleton h={140} style="margin-top:10px" /></div></>;
  const s = d.summary;
  const waitCount = pendingOf(['saveCashCount']).find((e) => e.meta?.count);
  const cashDone = s.cash.counted != null || !!waitCount;
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
          <CashBook s={s} cb={cb} waiting={waitCount} onAddExpense={expenseKinds().includes('expense') ? () => setAddExp(true) : null} onSaved={load} />
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
      <ExpenseSheet open={addExp} onClose={() => setAddExp(false)} onDone={(r) => { setAddExp(false); forgetAccounts(); toast(r?.pending ? t('off_saved_phone') : t('exp_saved')); load(); }} />
    </>
  );
}

/**
 * The cash drawer as a cash book: opening + in − out = should be there; count it; say what stays for tomorrow.
 * s = the day's summary (s.cash from the cash book), cb = api cashBook (moves, safes, counted_before).
 */
function CashBook({ s, cb, waiting, onAddExpense, onSaved }) {
  const c = s.cash;
  const [counted, setCounted] = useState('');
  const [keep, setKeep] = useState(null);       // what stays in the drawer (null = all of it)
  const [to, setTo] = useState(null);           // where the cash taken out goes
  const [again, setAgain] = useState(false);
  const [moves, setMoves] = useState(false);
  const [saved, setSaved] = useState(null);     // the answer to the count just saved (shown until the day reloads)
  const save = useAction('saveCashCount');
  const n = counted === '' ? null : r2(Number(counted));
  const safes = cb?.safes || [];
  const lastLeft = cb?.counted_before ? Number(c.opening ?? cb.opening ?? 0) : null;
  const keepNow = n == null ? 0 : keep == null ? n : Math.min(n, r2(Number(keep) || 0));
  const take = n == null ? 0 : r2(n - keepNow);
  const toId = take > 0 ? (to || safes[0]?.id || null) : null;
  const should = c.book ? (c.counted != null && !again ? c.expected : c.now ?? c.expected) : c.expected;
  const diff = n == null ? null : r2(n - should);
  const done = (c.counted != null || !!saved) && !again;
  // what the last count said: the one just saved, else the day's last count
  const last = saved ? { counted: Number(saved.counted), diff: r2(Number(saved.difference)), left: Number(saved.left), takenOut: Number(saved.taken_out || 0), to: saved.taken_to_name || null, expected: Number(saved.expected) }
    : { counted: c.counted, diff: c.diff, left: c.left ?? c.counted, takenOut: c.takenOut || 0, to: accName(safes.find((a) => a.id === cb?.counts?.at(-1)?.taken_to)) || null, expected: c.expected };
  const diffTxt = (x) => (x === 0 ? t('close_cash_ok') : t(x < 0 ? 'close_short' : 'close_over', money(Math.abs(x), false)));
  const submit = () => save.run({ counted: n, take: take || undefined, take_to: toId || undefined }, {
    local: { meta: { count: { counted: n, take, keep: keepNow } } },
  }).then((r) => { toast(r?.pending ? t('off_saved_phone') : t('cb_saved', money(keepNow, false))); if (!r?.pending) setSaved(r); setCounted(''); setKeep(null); setAgain(false); onSaved?.(); }).catch(() => {});
  const Line = ({ a, b, strong, tone }) => (
    <div class="row" style={`justify-content:space-between;font-size:${strong ? 16 : 15}px;margin-top:${strong ? 8 : 4}px${strong ? ';padding-top:8px;border-top:1px solid var(--line)' : ''}`}>
      <span class={strong ? '' : 'muted'} style={strong ? 'font-weight:700' : ''}>{a}</span><b class="num" style={tone ? `color:var(--${tone})` : ''}>{b}</b>
    </div>
  );
  return (
    <>
      {c.book ? <>
        <Line a={t('cb_opening')} b={money(c.opening, false)} />
        <Line a={t('cb_in')} b={`+ ${money(c.in, false)}`} tone="ok" />
        <Line a={t('cb_out')} b={`− ${money(c.out, false)}`} />
        <Line a={t('cb_should')} b={money(done ? last.expected : c.now ?? c.expected, false)} strong />
        {cb && !cb.counted_before && <div class="faint" style="font-size:12.5px;margin-top:6px;line-height:1.45">{t('cb_first')}</div>}
        {cb?.moves?.length > 0 && <>
          <button class="link" onClick={() => setMoves(!moves)}><Icon name={moves ? 'ChevronUp' : 'ChevronDown'} size={16} />{t('cb_moves')} · {cb.moves.length}</button>
          {moves && <div class="card" style="box-shadow:none">{cb.moves.map((m) => (
            <div class="li" style="padding:9px 12px;min-height:0">
              <span class="grow" style="font-size:14px">{t(`cb_m_${m.src}`)}</span><span class="faint" style="font-size:12.5px">{time(m.at, company.value?.timezone || 'Asia/Kolkata')}</span>
              <b class="num" style={`min-width:84px;text-align:right;color:var(--${m.amount > 0 ? 'ok' : 'ink'})`}>{m.amount > 0 ? '+' : '−'}{money(Math.abs(m.amount), false)}</b>
            </div>
          ))}</div>}
        </>}
      </> : <Line a={t('close_cash_app')} b={money(c.expected, false)} />}

      {waiting ? (
        <div class="notice tone-accent" style="margin-top:10px"><Icon name="CloudUpload" size={15} /> {t('cb_counted_now', money(waiting.meta.count.counted, false), t('off_waiting'))}</div>
      ) : done ? <>
        <Line a={t('close_cash_count')} b={money(last.counted, false)} />
        <div style={`font-weight:800;font-size:15px;margin-top:6px;color:var(--${last.diff === 0 ? 'ok' : last.diff < 0 ? 'bad' : 'warn'})`}>{diffTxt(last.diff)}</div>
        {(c.book || saved) && <div class="muted" style="font-size:13.5px;margin-top:4px;font-weight:600">{t('cb_kept', money(last.left, false))}{last.takenOut > 0 ? ` · ${t('cb_took', money(last.takenOut, false), last.to || t('acc_k_safe'))}` : ''}</div>}
        <button class="link" onClick={() => { setSaved(null); setAgain(true); }}><Icon name="RotateCcw" size={15} />{t('cb_count_again')}</button>
      </> : <>
        {onAddExpense && <button class="link" onClick={onAddExpense}><Icon name="Receipt" size={16} />{t('cb_missing_exp')}</button>}
        <div class="field num exp-amount" style="margin-top:8px"><span class="faint">₹</span>
          <input inputmode="decimal" value={counted} placeholder={t('close_cash_count')} onInput={(e) => { setCounted(e.currentTarget.value.replace(/[^\d.]/g, '')); }} /></div>
        {n != null && <div style={`font-weight:800;font-size:15px;margin-top:8px;color:var(--${diff === 0 ? 'ok' : diff < 0 ? 'bad' : 'warn'})`}>{diffTxt(diff)}</div>}
        {n != null && n > 0 && c.book && <>
          <div class="lbl" style="margin-top:14px">{t('cb_keep')}</div>
          <div class="pick">
            {lastLeft != null && lastLeft > 0 && lastLeft < n && <button class={keep != null && Number(keep) === suggestKeep(n, lastLeft) ? 'on' : ''} onClick={() => setKeep(String(suggestKeep(n, lastLeft)))}>{t('cb_keep_same', money(suggestKeep(n, lastLeft), false))}</button>}
            <button class={keep == null ? 'on' : ''} onClick={() => setKeep(null)}>{t('cb_keep_all')}</button>
            <button class={keep != null && Number(keep) === 0 ? 'on' : ''} onClick={() => setKeep('0')}>{t('cb_take_all')}</button>
          </div>
          <div class="field num" style="margin-top:8px"><span class="faint">₹</span>
            <input inputmode="decimal" value={keep == null ? String(n) : keep} onInput={(e) => setKeep(e.currentTarget.value.replace(/[^\d.]/g, ''))} /></div>
          {take > 0 && <>
            <Line a={t('cb_take')} b={money(take, false)} />
            <div class="lbl" style="margin-top:12px">{t('cb_take_to')}</div>
            <div class="pick">
              {safes.length ? safes.map((a) => <button class={toId === a.id ? 'on' : ''} onClick={() => setTo(a.id)}><Icon name={a.kind === 'safe' ? 'Vault' : 'Landmark'} size={16} />{accName(a)}</button>)
                : <button class="on"><Icon name="Vault" size={16} />{t('cb_home_new')}</button>}
            </div>
          </>}
        </>}
        <button class="btn btn-accent btn-block" style="margin-top:12px" disabled={save.busy || n == null || keepNow > n} onClick={submit}>{save.busy ? '…' : t('close_cash_save')}</button>
        {!online.value && <div class="faint" style="font-size:12.5px;margin-top:6px">{t('off_cash_note_short')}</div>}
        {again && <button class="link" onClick={() => setAgain(false)}>{t('cancel')}</button>}
      </>}
      {save.error && <div class="error" style="margin-top:8px">{save.error.message}</div>}
    </>
  );
}
