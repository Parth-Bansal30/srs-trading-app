// Money accounts (owners, 23 Oct 2026): what should be in each account right now — the cash drawer,
// cash at home, every bank / UPI / Paytm account — and each account's book with the running balance.
// "Check with passbook / app" sets a balance point; from then on the app keeps the balance.
// Addresses: #/money   #/money/<account id>
import { useEffect, useState } from 'preact/hooks';
import { r2 } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money, time } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go } from '../../lib/router.js';
import { addDays } from '../../lib/evening.js';
import { toast } from '../../ui/toast.js';
import { online } from '../../lib/net.js';
import { kindOf, accName, accSub, forgetAccounts } from '../../lib/accounts.js';
import { catWord, shopToday, monthOf, prevMonth, moveWord } from '../../lib/expenses.js';
import { outboxVersion } from '../../lib/offline/outbox.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { TransferSheet } from '../../ui/money/TransferSheet.jsx';
import '../../ui/money/money.css';
import './money-screens.css';

const owner = () => can('settings') && can('money');
const dayName = (x, today) => (x === today ? t('exp_today') : x === addDays(today, -1) ? t('exp_yesterday') : fmtDay(x));

export function Balances() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [move, setMove] = useState(false);
  const [setting, setSetting] = useState(null);
  const load = () => call('accountBalances', {}).then((x) => { setList(x || []); setErr(null); }).catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!owner()) { go('/'); return; } load(); }, [outboxVersion.value]);

  // a hidden account shows only while it still holds money (as far as the app knows)
  const shown = (list || []).filter((a) => !a.hidden || (a.known && Number(a.balance) !== 0));
  const known = shown.filter((a) => a.known);
  const firm = r2(known.filter((a) => a.owner !== 'personal').reduce((s, a) => s + Number(a.balance), 0));
  const personal = r2(known.filter((a) => a.owner === 'personal').reduce((s, a) => s + Number(a.balance), 0));
  return (
    <>
      <TopBar title={t('nav_money')} sub={t('bal_title_s')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 110px)">
        {err && <div class="error">{err}</div>}
        {!list ? <><Skeleton h={130} /><Skeleton h={260} style="margin-top:12px" /></> : <>
          <div class="hero">
            <div class="hero-glow" />
            <div class="hero-cap">{t('bal_total')}</div>
            <div class="hero-num num">{money(r2(firm + personal), false)}</div>
            <div class="hero-row">
              <div class="hero-box"><div class="cap">{t('acc_firm')}</div><div class="v num">{money(firm, false)}</div></div>
              <div class="hero-box"><div class="cap">{t('acc_personal')}</div><div class="v num">{money(personal, false)}</div></div>
            </div>
          </div>
          {shown.some((a) => !a.known) && <div class="notice tone-warn" style="margin-top:12px;font-size:13.5px">{t('bal_some_unknown')}</div>}
          <button class="card li" style="margin-top:12px" onClick={() => go('/bank')}>
            <div class="iconbox tone-accent"><Icon name="FileSpreadsheet" /></div>
            <div class="grow"><div class="t">{t('bk_from_money')}</div><div class="s">{t('bk_from_money_s')}</div></div>
            <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
          </button>
          <div class="sec"><h3>{t('bal_accounts')}</h3><button class="link" onClick={() => go('/settings/accounts')}>{t('bal_edit')}</button></div>
          <div class="card">{shown.map((a) => {
            const k = kindOf(a);
            return (
              <button class={`li bal-row ${a.hidden ? 'acc-hidden' : ''}`} onClick={() => go(`/money/${a.id}`)}>
                <span class="acc-ic" style={`background:${k.tone}`}><Icon name={k.icon} size={18} stroke={2.2} /></span>
                <span class="grow" style="min-width:0">
                  <span class="t ellip" style="display:block">{accName(a)}{a.owner === 'personal' && <span class="acc-own">{t('acc_personal')}</span>}</span>
                  <span class="s ellip" style="display:block">{a.known && a.since ? t('bal_checked', fmtDay(String(a.since).slice(0, 10), false)) : accSub(a)}</span>
                </span>
                {a.known ? (
                  <span class="bal-amt"><b class={`num ${Number(a.balance) < 0 ? 'bal-neg' : ''}`}>{money(Number(a.balance), false)}</b><span>{t('bal_now')}</span></span>
                ) : (
                  <span class="link" style="min-height:0" onClick={(e) => { e.stopPropagation(); setSetting(a); }}>{t('bal_unknown')}</span>
                )}
              </button>
            );
          })}</div>
          <div class="faint" style="font-size:12.5px;margin-top:10px;line-height:1.45">{t('bal_how')}</div>
        </>}
      </div>
      <div class="actionbar">
        <button class="btn btn-brand btn-block" onClick={() => setMove(true)}><Icon name="ArrowRightLeft" size={20} />{t('tr_title')}</button>
      </div>
      <TransferSheet open={move} onClose={() => setMove(false)} onDone={(r) => { setMove(false); toast(r?.pending ? t('off_saved_phone') : t('tr_saved')); load(); }} />
      <BalanceSheet account={setting} onClose={() => setSetting(null)} onDone={() => { setSetting(null); load(); }} />
    </>
  );
}

/** "My passbook / app shows ₹…" for one account (or the starting balance the first time). */
export function BalanceSheet({ account, onClose, onDone }) {
  const [v, setV] = useState('');
  const save = useAction('setBalance');
  useEffect(() => { setV(''); save.setError(null); }, [account?.id]);
  if (!account) return null;
  const first = !account.known && !account.is_drawer;
  const n = Number(v);
  const ok = v !== '' && Number.isFinite(n) && !(account.is_drawer && n < 0);
  const submit = () => save.run({ id: account.id, balance: r2(n) }).then((r) => {
    const diff = r.expected == null ? null : r2(r.balance - Number(r.expected));
    toast(diff == null || diff === 0 ? t('bal_saved') : t('bal_diff', money(Math.abs(diff), true)));
    onDone?.(r);
  }).catch(() => {});
  return (
    <Sheet open={!!account} onClose={onClose} title={accName(account)}
      footer={<>
        {save.error && <div class="error" style="margin:0 0 8px">{save.error.message}</div>}
        <button class="btn btn-accent btn-block" disabled={!ok || save.busy || !online.value} onClick={submit}><Icon name="Check" size={20} stroke={2.6} />{save.busy ? '…' : t('bal_save')}</button>
        {!online.value && <div class="faint" style="font-size:12.5px;margin-top:6px;text-align:center">{t('off_needs_net')}</div>}
      </>}>
      <div class="muted" style="font-size:14px;line-height:1.5;margin-bottom:14px">{first ? t('bal_start_s') : t('bal_check_s')}</div>
      {account.known && <div class="row" style="justify-content:space-between;margin-bottom:12px"><span class="muted">{t('bal_now')}</span><b class="num">{money(Number(account.balance), true)}</b></div>}
      <div class="lbl">{t('bal_shows')}</div>
      <div class="field num exp-amount"><span class="faint">₹</span>
        <input inputmode="decimal" value={v} placeholder="0" autofocus onInput={(e) => setV(e.currentTarget.value.replace(/[^\d.-]/g, ''))} /></div>
      {ok && account.known && (() => {
        const d = r2(n - Number(account.balance));
        return <div style={`font-weight:800;margin-top:10px;color:var(--${d === 0 ? 'ok' : 'warn'})`}>{d === 0 ? t('bal_matches') : t('bal_diff', money(Math.abs(d), true))}</div>;
      })()}
    </Sheet>
  );
}

/** What one line of an account's book was. */
function moveText(m, kacha) {
  const w = m.what || {};
  if (m.src === 'payment') return w.customer ? `${w.customer}${w.slip_no ? ` · #${w.slip_no}` : ''}` : t('bal_m_payment');
  if (m.src === 'expense') return [catWord({ kind: w.kind, category: w.category }), w.paid_to].filter(Boolean).join(' · ');
  const dir = m.src === 'transfer_out' ? '→' : '←';
  return `${moveWord(w.reason)} ${dir} ${accName({ name: w.other, is_drawer: w.other === 'Shop cash' })}`;
}
const moveIcon = (m) => (m.src === 'payment' ? 'HandCoins' : m.src === 'expense' ? 'Receipt' : 'ArrowRightLeft');

export function AccountBook({ id }) {
  const today = shopToday();
  const tz = company.value?.timezone || 'Asia/Kolkata';
  const [which, setWhich] = useState('this');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [setting, setSetting] = useState(false);
  const [move, setMove] = useState(false);
  const range = which === 'this' ? monthOf(today) : prevMonth(today);
  const load = () => call('accountBook', { id, from: range.from, to: range.to > today ? today : range.to })
    .then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!owner()) { go('/'); return; } setD(null); load(); }, [id, which, outboxVersion.value]);

  const a = d?.account;
  const now = d?.now;
  // the drawer before its first count has no balance yet (every day started at zero)
  const known = !!now?.known;
  const showBal = known || !!d?.opening?.known;
  const rows = d ? [...(d.rows || [])].reverse() : [];
  const dayOf = (r) => new Date(r.at).toLocaleDateString('en-CA', { timeZone: tz });   // the shop's own date
  const byDay = new Map();
  for (const r of rows) { const k = dayOf(r); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(r); }
  return (
    <>
      <TopBar title={a ? accName(a) : t('nav_money')} sub={a ? accSub(a) : ''} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 110px)">
        {err && <div class="error">{err}</div>}
        {!d ? <><Skeleton h={130} /><Skeleton h={260} style="margin-top:12px" /></> : <>
          <div class="hero">
            <div class="hero-glow" />
            <div class="hero-cap">{t('bal_now')}</div>
            <div class="hero-num num">{known ? money(Number(now.balance), true) : '—'}</div>
            {known && now.since && <div style="font-size:13px;opacity:.75;font-weight:600;position:relative">{t('bal_checked', `${fmtDay(new Date(now.since).toLocaleDateString('en-CA', { timeZone: tz }), false)} · ${time(now.since, tz)}`)}</div>}
            {!known && <div style="font-size:13px;opacity:.8;font-weight:600;position:relative">{a.is_drawer ? t('bal_drawer_first') : t('bal_start_s')}</div>}
          </div>
          <div class="row" style="gap:10px;margin-top:12px">
            {!a.is_drawer && <button class="btn btn-ghost grow" onClick={() => setSetting(true)}><Icon name="ClipboardCheck" size={18} />{known ? t('bal_check') : t('bal_unknown')}</button>}
            {a.is_drawer && <button class="btn btn-ghost grow" onClick={() => go('/close-day')}><Icon name="ClipboardCheck" size={18} />{t('close_cash')}</button>}
          </div>

          <div class="sec"><h3>{t('bal_book')}</h3></div>
          <div class="seg"><button class={which === 'this' ? 'on' : ''} onClick={() => setWhich('this')}>{t('exp_month')}</button>
            <button class={which === 'last' ? 'on' : ''} onClick={() => setWhich('last')}>{t('exp_last_month')}</button></div>
          {d.opening?.known && <div class="faint" style="font-size:13px;font-weight:600;margin-top:10px">{t('bal_opening', money(Number(d.opening.balance), true))}</div>}
          {!rows.length ? <div class="card pad" style="margin-top:10px"><div class="muted">{t('bal_book_none')}</div></div> : [...byDay].map(([day, list]) => (
            <>
              <div class="exp-day">{dayName(day, today)}</div>
              <div class="card">{list.map((r) => r.point ? (
                <div class="li bal-point">
                  <span class="acc-ic" style="background:var(--ink-2)"><Icon name="ClipboardCheck" size={17} stroke={2.2} /></span>
                  <span class="grow" style="min-width:0">
                    <span class="t ellip" style="display:block">{r.source === 'count' ? t('bal_point_count', money(Number(r.counted), false), money(Number(r.balance), false)) : t('bal_point', money(Number(r.balance), false))}</span>
                    <span class="s ellip" style="display:block">{[time(r.at, tz), r.by, r.expected != null && r.before != null ? (r2(Number(r.source === 'count' ? r.counted : r.balance) - Number(r.expected)) === 0 ? t('bal_matches') : t('bal_diff', money(Math.abs(r2(Number(r.source === 'count' ? r.counted : r.balance) - Number(r.expected))), true))) : null].filter(Boolean).join(' · ')}</span>
                  </span>
                </div>
              ) : (
                <div class="li">
                  <span class="acc-ic" style={`background:${r.amount > 0 ? 'var(--ok)' : 'var(--ink-3)'}`}><Icon name={moveIcon(r)} size={17} stroke={2.2} /></span>
                  <span class="grow" style="min-width:0">
                    <span class="t ellip" style="display:block">{moveText(r, d.kacha)}</span>
                    <span class="s ellip" style="display:block">{time(r.at, tz)}</span>
                  </span>
                  <span class="bal-amt"><b class={`num ${r.amount > 0 ? 'book-in' : 'book-out'}`} style="font-size:15.5px">{r.amount > 0 ? '+' : '−'}{money(Math.abs(r.amount), true)}</b>
                    {showBal && r.balance != null && <span class="num">{money(r.balance, true)}</span>}</span>
                </div>
              ))}</div>
            </>
          ))}
        </>}
      </div>
      <div class="actionbar">
        <button class="btn btn-brand btn-block" onClick={() => setMove(true)}><Icon name="ArrowRightLeft" size={20} />{t('tr_title')}</button>
      </div>
      <TransferSheet open={move} from={id} onClose={() => setMove(false)} onDone={(r) => { setMove(false); forgetAccounts(); toast(r?.pending ? t('off_saved_phone') : t('tr_saved')); load(); }} />
      <BalanceSheet account={setting && a ? { ...a, known: !!now?.known, balance: now?.balance } : null} onClose={() => setSetting(false)} onDone={() => { setSetting(false); load(); }} />
    </>
  );
}
