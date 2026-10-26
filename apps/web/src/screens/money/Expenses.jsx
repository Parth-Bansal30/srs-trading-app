// Shop expenses (kharcha): this month (or last month) — how much went, on what, from which account,
// GST on bills for the CA, every entry day by day, and money moved between accounts.
// Address: #/expenses   (#/expenses?add=1 opens "Add expense" at once, e.g. from easy mode)
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money, time } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { route, go, replace } from '../../lib/router.js';
import { addDays } from '../../lib/evening.js';
import { toast } from '../../ui/toast.js';
import { forgetAccounts, accName, modeText } from '../../lib/accounts.js';
import { catOf, catWord, shopToday, monthOf, prevMonth, moveWord } from '../../lib/expenses.js';
import { outboxVersion, pendingOf } from '../../lib/offline/outbox.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { ExpenseSheet, expenseKinds } from '../../ui/money/ExpenseSheet.jsx';
import { TransferSheet } from '../../ui/money/TransferSheet.jsx';
import '../../ui/money/money.css';
import './money-screens.css';

export function Expenses() {
  const today = shopToday();
  const [which, setWhich] = useState('this');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [add, setAdd] = useState(route.value.query.add === '1');
  const startMove = route.value.query.move === '1';
  const [edit, setEdit] = useState(null);
  const [open, setOpen] = useState(null);       // an expense, for details
  const [move, setMove] = useState(false);
  const range = which === 'this' ? monthOf(today) : prevMonth(today);
  const tz = company.value?.timezone || 'Asia/Kolkata';
  const load = () => call('expenses', { from: range.from, to: range.to > today ? today : range.to })
    .then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!expenseKinds().length) { go('/'); return; } setD(null); load(); }, [which, outboxVersion.value]);
  useEffect(() => { if (route.value.query.add === '1' || startMove) replace('/expenses'); if (startMove) setMove(true); }, []);
  const saved = (msg) => { setAdd(false); setEdit(null); setMove(false); setOpen(null); forgetAccounts(); toast(msg); load(); };

  const inRange = (day) => day >= range.from && day <= range.to;
  const waiting = pendingOf(['saveExpense']).filter((x) => x.meta?.expense && inRange(x.meta.expense.day));
  const waitingMoves = pendingOf(['saveTransfer']).filter((x) => x.meta?.transfer && inRange(x.meta.transfer.day));
  const changing = new Set(waiting.map((x) => x.meta.expense.replaces).filter(Boolean));
  const items = d ? [...waiting.map((x) => ({ ...x.meta.expense, id: x.id, pending: true })), ...d.items.filter((e) => !changing.has(e.id))] : [];
  const moves = d ? [...waitingMoves.map((x) => ({ ...x.meta.transfer, id: x.id, pending: true })), ...(d.transfers || [])] : [];
  const days = [...new Set(items.map((e) => e.day))].sort().reverse();
  const tot = d?.totals;
  const maxCat = Math.max(1, ...(tot?.byCategory || []).map((c) => c.amount));
  const dayName = (x) => (x === today ? t('exp_today') : x === addDays(today, -1) ? t('exp_yesterday') : fmtDay(x));

  return (
    <>
      <TopBar title={t('exp_title')} sub={which === 'this' ? t('exp_month') : t('exp_last_month')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 110px)">
        <div class="seg"><button class={which === 'this' ? 'on' : ''} onClick={() => setWhich('this')}>{t('exp_month')}</button>
          <button class={which === 'last' ? 'on' : ''} onClick={() => setWhich('last')}>{t('exp_last_month')}</button></div>
        {err && <div class="error">{err}</div>}
        {!d ? <><Skeleton h={150} style="margin-top:12px" /><Skeleton h={220} style="margin-top:12px" /></> : <>
          <div class="hero" style="margin-top:12px">
            <div class="hero-glow" />
            <div class="hero-cap">{t('exp_total')}</div>
            <div class="hero-num num">{money(tot.total, false)}</div>
            <div style="font-size:13px;opacity:.75;font-weight:600;position:relative">{t('exp_total_s', tot.n, money(tot.fromDrawer, false))}</div>
            {tot.gst > 0 && <div style="font-size:13px;margin-top:6px;font-weight:700;color:var(--accent);position:relative">{t('exp_gst_ca', money(tot.gst, false))}</div>}
          </div>

          {tot.byCategory.length > 0 && <>
            <div class="sec"><h3>{t('exp_by_category')}</h3></div>
            <div class="card pad exp-bars">
              {tot.byCategory.map((c) => {
                const look = catOf(c.category);
                return (
                  <div class="exp-bar">
                    <div class="row" style="justify-content:space-between"><span class="row" style="gap:8px;font-weight:600;font-size:14.5px"><Icon name={look.icon} size={16} style={`color:${look.tone}`} />{t(look.word)}<span class="faint" style="font-weight:600;font-size:12.5px">{c.n}</span></span><b class="num">{money(c.amount, false)}</b></div>
                    <div class="exp-track"><div style={`width:${Math.max(2, Math.round((c.amount / maxCat) * 100))}%;background:${look.tone}`} /></div>
                  </div>
                );
              })}
            </div>
          </>}

          <div class="sec"><h3>{t('exp_list')}</h3></div>
          {items.length === 0 ? (
            <div class="card pad"><div style="font-weight:700">{t('exp_none')}</div><div class="muted" style="font-size:14px;margin-top:4px;line-height:1.45">{t('exp_none_s')}</div></div>
          ) : days.map((day) => (
            <>
              <div class="exp-day">{dayName(day)}</div>
              <div class="card">{items.filter((e) => e.day === day).map((e) => {
                const look = catOf(e);
                const off = e.status === 'cancelled';
                return (
                  <button class={`li ${off ? 'exp-off' : ''}`} onClick={() => !e.pending && setOpen(e)}>
                    <span class="acc-ic" style={`background:${look.tone}`}><Icon name={look.icon} size={18} stroke={2.2} /></span>
                    <span class="grow" style="min-width:0">
                      <span class="t ellip" style="display:block">{e.kind === 'supplier' ? e.supplier || catWord(e) : catWord(e)}{e.paid_to ? ` · ${e.paid_to}` : ''}</span>
                      <span class="s ellip" style="display:block">{e.pending ? <><Icon name="CloudUpload" size={12} /> {t('off_waiting')}</> : [time(e.at, tz), accName({ name: e.account, is_drawer: e.is_drawer }), e.by].filter(Boolean).join(' · ')}
                        {off ? ` · ${e.cancel_reason === 'Changed' ? t('exp_changed') : t('exp_cancelled')}` : ''}</span>
                    </span>
                    <b class="num" style={off ? 'text-decoration:line-through;opacity:.5' : ''}>{money(e.amount, false)}</b>
                  </button>
                );
              })}</div>
            </>
          ))}

          {moves.length > 0 && <>
            <div class="sec"><h3>{t('tr_list')}</h3></div>
            <div class="card">{moves.map((x) => (
              <div class={`li ${x.status === 'cancelled' ? 'exp-off' : ''}`}>
                <span class="acc-ic" style="background:#5B6472"><Icon name="ArrowRightLeft" size={17} stroke={2.2} /></span>
                <span class="grow" style="min-width:0">
                  <span class="t ellip" style="display:block">{accName({ name: x.from, is_drawer: x.from_drawer })} → {accName({ name: x.to, is_drawer: x.to_drawer })}</span>
                  <span class="s ellip" style="display:block">{x.pending ? <><Icon name="CloudUpload" size={12} /> {t('off_waiting')} · </> : ''}{[dayName(x.day), time(x.at, tz), moveWord(x.reason), x.by].filter(Boolean).join(' · ')}</span>
                </span>
                <b class="num">{money(x.amount, false)}</b>
              </div>
            ))}</div>
          </>}
        </>}
      </div>

      <div class="actionbar row" style="gap:10px">
        {(can('expenses') || can('settings')) && <button class="btn btn-ghost" style="flex:none;padding:0 14px" onClick={() => setMove(true)} aria-label={t('tr_title')}><Icon name="ArrowRightLeft" size={20} /></button>}
        <button class="btn btn-accent grow" onClick={() => setAdd(true)}><Icon name="Plus" size={22} stroke={2.6} />{t('exp_add')}</button>
      </div>

      <ExpenseSheet open={add || !!edit} edit={edit} suppliers={d?.suppliers || []} onClose={() => { setAdd(false); setEdit(null); }}
        onDone={(r) => saved(r?.pending ? t('off_saved_phone') : t('exp_saved'))} />
      <TransferSheet open={move} onClose={() => setMove(false)} onDone={(r) => saved(r?.pending ? t('off_saved_phone') : t('tr_saved'))} />
      <ExpenseDetail e={open} tz={tz} onClose={() => setOpen(null)} onChange={(e) => { setOpen(null); setEdit(e); }} onCancelled={() => saved(t('exp_cancelled'))} />
    </>
  );
}

function ExpenseDetail({ e, tz, onClose, onChange, onCancelled }) {
  const [why, setWhy] = useState('');
  const [asking, setAsking] = useState(false);
  const [photo, setPhoto] = useState(null);
  const cancel = useAction('cancelExpense');
  useEffect(() => { setWhy(''); setAsking(false); setPhoto(null); cancel.setError(null); }, [e?.id]);
  if (!e) return null;
  const look = catOf(e);
  const mayChange = e.status === 'ok' && (can('settings') || e.mine_today);
  const showPhoto = () => call('expenseFile', { id: e.id }).then((r) => (r.url ? window.open(r.url, '_blank') : toast(t('err_generic')))).catch((x) => toast(x.message));
  const Row = ({ a, b }) => <div class="row" style="justify-content:space-between;padding:9px 0;border-top:1px solid var(--line)"><span class="muted">{a}</span><span style="font-weight:600;text-align:right">{b}</span></div>;
  return (
    <Sheet open={!!e} onClose={onClose} title={e.kind === 'supplier' ? e.supplier || catWord(e) : catWord(e)}
      footer={mayChange && (asking ? (
        <div class="row" style="gap:8px">
          <div class="field grow"><input value={why} maxLength={300} placeholder={t('exp_cancel_why')} autofocus onInput={(x) => setWhy(x.currentTarget.value)} /></div>
          <button class="btn btn-ghost" style="color:var(--bad)" disabled={!why.trim() || cancel.busy} onClick={() => cancel.run({ id: e.id, reason: why.trim() }).then(onCancelled).catch(() => {})}>{t('exp_cancel')}</button>
        </div>
      ) : (
        <div class="row" style="gap:10px">
          <button class="btn btn-ghost grow" style="color:var(--bad)" onClick={() => setAsking(true)}><Icon name="X" size={18} />{t('exp_cancel')}</button>
          <button class="btn btn-brand grow" onClick={() => onChange(e)}><Icon name="Pencil" size={18} />{t('exp_change')}</button>
        </div>
      ))}>
      <div class="row" style="gap:12px">
        <span class="acc-ic" style={`background:${look.tone};width:44px;height:44px`}><Icon name={look.icon} size={22} stroke={2.2} /></span>
        <div class="grow"><div class="num" style={`font-size:30px;font-weight:800;letter-spacing:-.03em;${e.status === 'cancelled' ? 'text-decoration:line-through;opacity:.5' : ''}`}>{money(e.amount)}</div>
          <div class="muted" style="font-size:13.5px">{fmtDay(e.day)} · {time(e.at, tz)}</div></div>
      </div>
      {e.status === 'cancelled' && <div class="notice tone-bad" style="margin-top:12px">{t('exp_cancelled_s', e.cancelled_by || '', e.cancel_reason === 'Changed' ? t('exp_changed') : e.cancel_reason)}</div>}
      <div style="margin-top:12px">
        <Row a={t('exp_from')} b={`${accName({ name: e.account, is_drawer: e.is_drawer })}${e.method ? ` · ${e.method}` : ''}`} />
        {e.paid_to && <Row a={t('exp_to')} b={e.paid_to} />}
        {e.note && <Row a={t('exp_note')} b={e.note} />}
        {e.gst_bill && <Row a={t('exp_gst_amt')} b={`${e.gst_amount != null ? money(e.gst_amount, true) : '—'}${e.bill_no ? ` · ${e.bill_no}` : ''}`} />}
        {e.seller_gstin && <Row a={t('exp_seller_gstin')} b={e.seller_gstin} />}
        <Row a={t('exp_by', '')} b={e.by || '—'} />
        {e.offline && <Row a={t('off_entered')} b={<Icon name="WifiOff" size={15} />} />}
      </div>
      {e.has_file && <button class="btn btn-ghost btn-block" style="margin-top:12px" onClick={showPhoto}><Icon name="Image" size={18} />{t('exp_photo_view')}</button>}
      {!mayChange && e.status === 'ok' && <div class="faint" style="font-size:12.5px;margin-top:12px">{t('exp_only_owner')}</div>}
      {cancel.error && <div class="error">{cancel.error.message}</div>}
    </Sheet>
  );
}
