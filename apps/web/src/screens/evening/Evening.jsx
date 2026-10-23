// Evening summary: the whole shop day on one screen — sales (GST / no bill), money in, cash drawer,
// where today's slips went, khata, "needs a look", top customers — plus WhatsApp and a detailed PDF.
// Address: #/evening?day=YYYY-MM-DD (no day = today). The 8 pm notification opens this screen.
import { useEffect, useState } from 'preact/hooks';
import { t, lang } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { money, kg, time } from '../../lib/format.js';
import { route, go, replace } from '../../lib/router.js';
import { fmtDay, waLink, openWhatsApp } from '../../lib/docs.js';
import { loadDay, addDays, weekdayName, lookLine, eveningText } from '../../lib/evening.js';
import { drawOffscreen, paperToPdf, shareOrSave, printPaper } from '../../lib/paper.js';
import { toast } from '../../ui/toast.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { Preview } from '../../ui/docs/Preview.jsx';
import { DayReport } from '../../ui/docs/DayReport.jsx';
import { call } from '../../lib/api.js';
import { accName, kindOf, modeText } from '../../lib/accounts.js';
import { catOf, catWord, moveWord } from '../../lib/expenses.js';
import '../../ui/money/money.css';
import './evening.css';

const slipsKg = (n, w) => (n === 1 ? t('eve_slip1_kg', w) : t('eve_slips_kg', n, w));

export function Evening() {
  const asked = route.value.query.day;
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [allSlips, setAllSlips] = useState(false);
  useEffect(() => { setD(null); setErr(null); loadDay(asked).then(setD).catch((e) => setErr(e.message || t('err_generic'))); }, [asked]);
  const l = lang.value;

  const right = (
    <div class="row" style="gap:6px">
      <button class="round" disabled={!d} onClick={() => replace(`/evening?day=${addDays(d.day, -1)}`)} aria-label="previous day"><Icon name="ChevronLeft" size={18} /></button>
      <button class="round" disabled={!d || d.day >= d.today} style={!d || d.day >= d.today ? 'opacity:.35' : ''} onClick={() => replace(`/evening?day=${addDays(d.day, 1)}`)} aria-label="next day"><Icon name="ChevronRight" size={18} /></button>
      <button class="round" onClick={() => go('/evening/settings')} aria-label={t('eset_title')}><Icon name="Settings" size={18} /></button>
    </div>
  );
  if (err) return <><TopBar title={t('nav_evening')} right={right} /><div class="page"><div class="error">{err}</div></div></>;
  if (!d) return <><TopBar title={t('nav_evening')} right={right} /><div class="page"><Skeleton h={170} /><Skeleton h={120} style="margin-top:12px" /><Skeleton h={200} style="margin-top:12px" /></div></>;

  const s = d.summary;
  const url = `${location.origin}${location.pathname}#/evening?day=${d.day}`;
  const sendWa = () => { if (!openWhatsApp(waLink(null, eveningText(d, l, url)))) toast(t('popup_blocked')); };
  const pdf = async () => {
    setBusy('pdf');
    const { node, cleanup } = drawOffscreen(<DayReport d={d} />);
    try {
      const file = await paperToPdf(node, { name: `Day-report-${d.day}.pdf`, size: 'a4' });
      const res = await shareOrSave(file);
      if (res === 'saved') toast(t('pdf_saved'));
    } catch (e) { toast(e.message || t('err_generic')); } finally { cleanup(); setBusy(null); }
  };
  const cashTone = s.cash.counted == null ? 'neutral' : s.cash.diff < 0 ? 'bad' : s.cash.diff > 0 ? 'warn' : 'ok';
  const Row = ({ a, b, top, strong }) => <div class="row" style={`justify-content:space-between;padding:8px 0;${top ? 'border-top:1px solid var(--line);' : ''}`}><span class={strong ? '' : 'muted'}>{strong ? <b>{a}</b> : a}</span><span class="num" style={`font-weight:${strong ? 800 : 700}`}>{b}</span></div>;

  return (
    <>
      <TopBar title={t('nav_evening')} right={right} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        <div class="row eve-date">
          <b>{weekdayName(d.day, l)}, {fmtDay(d.day, false)}</b>
          <span class="faint">{s.cash.at ? t('eve_counted_by', time(s.cash.at, d.timezone), s.cash.by || '') : ''}</span>
        </div>

        <div class="eve-hero">
          <div class="row" style="justify-content:space-between">
            <span class="eve-cap">{t('eve_sales')}</span>
            {s.sales.vsLastWeek != null && <span class={`eve-vs ${s.sales.vsLastWeek >= 0 ? 'up' : 'down'}`}>{t('eve_vs_last', `${s.sales.vsLastWeek >= 0 ? '↑' : '↓'} ${Math.abs(s.sales.vsLastWeek)}%`, weekdayName(d.day, l))}</span>}
          </div>
          <div class="num eve-big">{money(s.sales.total, false)}</div>
          <div class="eve-sub">{slipsKg(s.sales.n, kg(s.sales.kg, 0))}</div>
          {d.kacha && s.sales.total > 0 && <>
            <div class="eve-split"><div style={`flex:${s.sales.pakka.total || 0.0001};background:#7FA2F2`} /><div style={`flex:${s.sales.kacha.total || 0.0001};background:#E7B266`} /></div>
            <div class="row eve-legend"><span style="color:#9fb9f5">● {t('bill_gst_short')} {money(s.sales.pakka.total, false)} ({s.sales.pakka.n})</span><span style="color:#eec48a">● {t('bill_none_short')} {money(s.sales.kacha.total, false)} ({s.sales.kacha.n})</span></div>
          </>}
        </div>

        <div class="eve-grid">
          <div class="card eve-tile">
            <div class="eve-k">{t('eve_money_in')}</div>
            <div class="num eve-v">{money(s.money.total, false)}</div>
            <div class="muted num eve-s">{['Cash', 'UPI', 'Bank', 'Cheque'].filter((k) => s.money.byMode[k]).map((k) => `${t(`pm_${k.toLowerCase()}`)} ${money(s.money.byMode[k], false)}`).join(' · ') || '—'}</div>
          </div>
          <button class={`card eve-tile tone-${cashTone}`} onClick={() => go('/reports')}>
            <div class="eve-k">{t('eve_cash')}</div>
            <div class="num eve-v">{s.cash.counted == null ? t('eve_not_counted') : s.cash.diff === 0 ? t('eve_matches') : t(s.cash.diff < 0 ? 'eve_short' : 'eve_over', money(Math.abs(s.cash.diff), true))}</div>
            <div class="muted num eve-s">{s.cash.book ? <>{t('eve_opening', money(s.cash.opening, false))}<br /></> : null}{t('eve_expected', money(s.cash.expected, false))}{s.cash.counted != null ? <><br />{t('eve_counted', money(s.cash.counted, false))}</> : <><br /><span style="color:var(--accent);font-weight:700">{t('eve_count_now')} →</span></>}</div>
          </button>
        </div>

        {s.sales.n > 0 && (
          <div class="card" style="margin-top:10px;padding:4px 16px">
            <div class="eve-k" style="padding-top:10px">{t('eve_where')}</div>
            <Row a={t('eve_pickup')} b={money(s.sales.pickup, false)} />
            <Row a={t('eve_adv_before')} b={money(s.sales.advance, false)} />
            <Row a={t('eve_to_khata')} b={money(s.sales.toKhata, false)} />
            {s.sales.extra < 0 && <Row a={t('eve_extra_paid')} b={money(-s.sales.extra, false)} />}
            <Row a={t('eve_slips_total')} b={money(s.sales.total, false)} top strong />
          </div>
        )}

        <div class="card" style="margin-top:10px;padding:4px 16px">
          <Row a={t('eve_old_dues')} b={money(s.money.oldDues, false)} />
          <Row a={t('eve_new_adv')} b={money(s.money.advances, false)} />
          {s.money.out > 0 && <Row a={t('eve_out')} b={money(s.money.out, false)} />}
          {d.khata && <Row a={t('eve_to_receive')} b={money(s.khata.toReceive, false)} top strong />}
        </div>

        {(s.out?.n > 0 || s.moved?.length > 0) && <MoneyOut s={s} tz={d.timezone} />}

        {can('settings') && <AccountTally d={d} />}

        {s.look.length > 0 && <div class="sec"><h3>{t('eve_look', s.look.length)}</h3></div>}
        {s.look.length > 0 ? (
          <div class="card">
            {s.look.map((x) => {
              const [a, b, icon, tone, link] = lookLine(x, l);
              return (
                <button class="li" onClick={() => link && go(link)} style={link ? '' : 'cursor:default'}>
                  <div class={`iconbox tone-${tone}`}><Icon name={icon} size={18} /></div>
                  <div class="grow"><div class="t">{a}</div>{b && <div class="s">{b}</div>}</div>
                  {link && <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />}
                </button>
              );
            })}
          </div>
        ) : <div class="card pad row" style="gap:10px;color:var(--ok);font-weight:700;margin-top:12px"><Icon name="CircleCheck" size={20} />{t('eve_all_good')}</div>}

        {s.top.length > 0 && <>
          <div class="sec"><h3>{t('eve_top')}</h3></div>
          <div class="card">
            {s.top.map((c) => <div class="li"><div class="grow"><div class="t">{c.customer}</div><div class="s">{slipsKg(c.n, kg(c.kg, 0))}</div></div><b class="num">{money(c.total, false)}</b></div>)}
          </div>
        </>}

        {s.slips.length > 0 && <>
          <button class="sec link" style="width:100%" onClick={() => setAllSlips(!allSlips)}><h3>{t('eve_all_slips', s.slips.length)}</h3><Icon name={allSlips ? 'ChevronLeft' : 'ChevronRight'} size={16} style={allSlips ? 'transform:rotate(90deg)' : 'transform:rotate(90deg)'} /></button>
          {allSlips && <div class="card">
            {s.slips.map((x) => (
              <button class="li" onClick={() => go(`/slip/${x.id}`)}>
                <div class="grow"><div class="t num">#{x.no} · {x.customer}</div><div class="s">{d.kacha ? `${t(x.bill === 'pakka' ? 'bill_gst_short' : 'bill_none_short')} · ` : ''}{kg(x.weight)}{x.toKhata ? ` · ${t('nav_khata')} ${money(x.toKhata, false)}` : ''}</div></div>
                <b class="num">{money(x.total, false)}</b>
              </button>
            ))}
          </div>}
        </>}

        <div class="sec"><h3>{t('eve_stock')}</h3>{s.stock?.groups.length > 0 && <button class="link" style="min-height:0" onClick={() => go('/stock')}>{t('pu_view_stock')}</button>}</div>
        {!s.stock || !s.stock.groups.length
          ? <div class="card pad faint" style="border-style:dashed;font-size:14px">{t('eve_no_stock_yet')}{can('stock') && <><br /><button class="link" onClick={() => go('/purchases/new')}>{t('st_add_bill')}</button></>}</div>
          : <>
            <div class="eve-grid">
              <div class="card eve-tile"><div class="eve-k">{t('eve_bought')}</div><div class="num eve-v">{kg(s.stock.bought.kg, 0)}</div>
                <div class="muted num eve-s">{t('eve_bills_n', s.stock.bought.n)}{s.stock.bought.amount != null ? ` · ${money(s.stock.bought.amount, false)}` : ''}</div></div>
              <div class="card eve-tile"><div class="eve-k">{t('eve_sold_kg')}</div><div class="num eve-v">{kg(s.stock.soldKg, 0)}</div></div>
            </div>
            <div class="card" style="margin-top:10px;padding:4px 16px">
              {[...s.stock.groups].sort((a, b) => b.kg - a.kg).slice(0, 8).map((g) => (
                <Row a={`${g.code} · ${g.shape ? t(`sh_${g.shape}`) : t('st_any_shape')}`} b={<span style={g.negative || g.kg < 0 ? 'color:var(--bad)' : g.lowKg != null && g.kg < g.lowKg ? 'color:var(--warn)' : ''}>{kg(g.kg, 0)}</span>} />
              ))}
              <Row a={t('eve_in_stock')} b={`${kg(s.stock.onHandKg, 0)}${s.stock.value != null ? ` · ${money(s.stock.value, false)}` : ''}`} top strong />
            </div>
          </>}

        <div class="eve-actions">
          <button class="btn btn-wa" onClick={sendWa}><Icon name="MessageCircle" size={20} stroke={2.4} />{t('eve_wa')}</button>
          <button class="btn btn-brand" onClick={() => setPdfOpen(true)}><Icon name="FileText" size={19} stroke={2.3} />{t('eve_pdf')}</button>
        </div>
      </div>

      <Sheet open={pdfOpen} onClose={() => setPdfOpen(false)} title={t('rep_title')}
        footer={<div class="row" style="gap:10px">
          <button class="btn btn-ghost grow" disabled={!!busy} onClick={() => printPaper(<DayReport d={d} />, 'a4')}><Icon name="Printer" size={18} />{t('print')}</button>
          <button class="btn btn-brand grow" disabled={!!busy} onClick={pdf}><Icon name="FileDown" size={18} />{busy === 'pdf' ? t('making_pdf') : t('download')}</button>
        </div>}>
        {pdfOpen && <Preview><DayReport d={d} /></Preview>}
      </Sheet>
    </>
  );
}


/** Owners: each money account's day — tick it once checked in the bank / Paytm app; tap to see each payment. */
function AccountTally({ d }) {
  const acc = d.summary.accounts;
  const [ticks, setTicks] = useState(() => new Set((acc?.rows || []).filter((r) => r.checked).map((r) => r.id)));
  const [open, setOpen] = useState(null);
  if (!acc) return null;
  const rows = acc.rows.filter((r) => r.n > 0);
  const others = acc.rows.some((r) => !r.isDrawer);
  const tick = (r) => {
    const on = !ticks.has(r.id);
    const next = new Set(ticks); on ? next.add(r.id) : next.delete(r.id); setTicks(next);
    call('checkAccount', { account_id: r.id, day: d.day, checked: on }).catch((e) => {
      toast(e.message || t('err_generic'));
      setTicks((cur) => { const back = new Set(cur); on ? back.delete(r.id) : back.add(r.id); return back; });
    });
  };
  const unticked = rows.filter((r) => !ticks.has(r.id)).length;
  const parts = (id) => (d.account_parts || []).filter((x) => x.accountId === id);
  const sel = open && acc.rows.find((r) => r.id === open);
  return (
    <>
      <div class="sec"><h3>{t('eve_tally')}</h3>{rows.length > 0 && <span class="faint" style="font-size:13px;font-weight:600">{t('eve_tally_s')}</span>}</div>
      {!others && rows.length <= 1 && acc.notPlaced === 0 ? (
        <div class="card pad faint" style="border-style:dashed;font-size:14px">{t('eve_no_accounts')}<br /><button class="link" onClick={() => go('/settings/accounts')}>{t('acc_setup_hint')}</button></div>
      ) : <>
        <div class="card tally">
          {rows.map((r) => {
            const k = kindOf({ kind: r.kind, is_drawer: r.isDrawer });
            const n = r.n === 1 ? t('acc_part1') : t('acc_parts', r.n);
            return (
              <div class="li">
                <button class={`acc-tick ${ticks.has(r.id) ? 'on' : ''}`} onClick={() => tick(r)} aria-pressed={ticks.has(r.id)} aria-label={r.name}>{ticks.has(r.id) && <Icon name="Check" size={16} stroke={3} />}</button>
                <button class="grow row" style="gap:10px;min-width:0;text-align:left" onClick={() => setOpen(r.id)}>
                  <span class="grow" style="min-width:0">
                    <span class="acc-name">{accName({ name: r.name, is_drawer: r.isDrawer })}<span style={`font-size:11.5px;font-weight:700;margin-left:6px;color:${r.owner === 'personal' ? 'var(--warn)' : 'var(--pakka)'}`}>{t(r.owner === 'personal' ? 'acc_personal' : 'acc_firm')}</span></span>
                    <span class="acc-sub">{n}{r.out > 0 ? ` · ${t('acc_out', money(r.out, false))}` : ''}</span>
                  </span>
                  <b class="num" style={r.net < 0 ? 'color:var(--bad)' : ''}>{money(r.net, false)}</b>
                </button>
              </div>
            );
          })}
          {acc.notPlaced !== 0 && (
            <div class="li"><div class="iconbox tone-warn" style="width:26px;height:26px;border-radius:8px"><Icon name="CircleDashed" size={15} /></div>
              <div class="grow"><div class="t" style="font-size:14.5px">{t('eve_not_placed')}</div><div class="s">{t('eve_not_placed_s')}</div></div><b class="num">{money(acc.notPlaced, false)}</b></div>
          )}
          <div class="li" style="border-top:1.5px solid var(--line-2)"><div class="grow t">{d.day === d.today ? t('eve_money_today') : t('eve_money_on')}</div><b class="num" style="font-size:17px">{money(acc.total, false)}</b></div>
        </div>
        <div class="tally-tot">
          <div class="card"><div class="k" style="color:var(--pakka)">{t('acc_firm')}</div><div class="v num">{money(acc.firm, false)}</div></div>
          <div class="card"><div class="k" style="color:var(--warn)">{t('acc_personal')}</div><div class="v num">{money(acc.personal, false)}</div></div>
        </div>
        {rows.length > 0 && (
          <div class={`notice ${unticked ? 'tone-warn' : 'tone-ok'} row`} style="gap:10px;margin-top:10px">
            <Icon name={unticked ? 'CircleDashed' : 'CircleCheck'} size={18} />
            <span class="grow">{unticked ? (unticked === 1 ? t('eve_unchecked1') : t('eve_unchecked', unticked)) : t('eve_all_ticked')}
              {unticked > 0 && <span style="display:block;font-weight:500;font-size:12.5px">{t('eve_unchecked_s')}</span>}</span>
          </div>
        )}
      </>}
      <Sheet open={!!sel} onClose={() => setOpen(null)} title={sel ? accName({ name: sel.name, is_drawer: sel.isDrawer }) : ''}>
        {sel && (parts(sel.id).length === 0 ? <div class="muted">{t('eve_acc_none')}</div> : (
          <div class="card">
            {parts(sel.id).map((x) => (
              <button class="li" onClick={() => x.orderId && go(`/slip/${x.orderId}`)} style={x.orderId ? '' : 'cursor:default'}>
                <div class="grow"><div class="t" style="font-size:14.5px">{x.kind === 'expense' ? [t('bal_m_expense'), x.customer].filter(Boolean).join(' · ') : x.kind === 'transfer' ? `${t('tr_move')} · ${x.amount < 0 ? '→' : '←'} ${accName({ name: x.customer, is_drawer: x.customer === 'Shop cash' })}` : x.customer}{x.slipNo ? ` · #${x.slipNo}` : ''}</div>
                  <div class="s">{[time(x.at, d.timezone), modeText(x.mode), x.method].filter(Boolean).join(' · ')}</div></div>
                <b class="num" style={x.amount < 0 ? 'color:var(--bad)' : ''}>{money(x.amount, false)}</b>
              </button>
            ))}
          </div>
        ))}
      </Sheet>
    </>
  );
}

/** Money that went out of the shop that day (expenses, supplier payments, owner's own) and money moved between accounts. */
function MoneyOut({ s, tz }) {
  const [all, setAll] = useState(false);
  const o = s.out;
  const list = all ? o.list : o.list.slice(0, 5);
  return (
    <>
      <div class="sec"><h3>{t('eve_out_title')}</h3>{can('expenses') && <button class="link" style="min-height:0" onClick={() => go('/expenses')}>{t('nav_expenses')}</button>}</div>
      {o.n > 0 ? (
        <div class="card" style="padding:4px 0">
          <div class="row" style="justify-content:space-between;padding:10px 16px 4px"><span class="muted">{t('exp_total')}</span><b class="num" style="font-size:20px">{money(o.total, false)}</b></div>
          {o.fromDrawer > 0 && <div class="faint" style="font-size:12.5px;font-weight:600;padding:0 16px 6px">{t('eve_out_drawer', money(o.fromDrawer, false))}</div>}
          {list.map((e) => {
            const look = catOf(e);
            return (
              <div class="li" style="padding:9px 16px">
                <span class="acc-ic" style={`background:${look.tone};width:30px;height:30px;border-radius:9px`}><Icon name={look.icon} size={15} stroke={2.2} /></span>
                <span class="grow" style="min-width:0"><span class="t ellip" style="display:block;font-size:14.5px">{catWord(e)}{e.paidTo ? ` · ${e.paidTo}` : ''}</span>
                  <span class="s">{[time(e.at, tz), e.by].filter(Boolean).join(' · ')}</span></span>
                <b class="num">{money(e.amount, false)}</b>
              </div>
            );
          })}
          {o.list.length > 5 && <button class="link" style="padding:0 16px" onClick={() => setAll(!all)}>{all ? t('eve_less') : t('eve_all_n', o.list.length)}</button>}
        </div>
      ) : <div class="card pad faint" style="font-size:14px">{t('eve_out_none')}</div>}
      {s.moved?.length > 0 && <>
        <div class="sec"><h3>{t('eve_moved')}</h3></div>
        <div class="card">{s.moved.map((x) => (
          <div class="li" style="padding:9px 16px">
            <span class="acc-ic" style="background:#5B6472;width:30px;height:30px;border-radius:9px"><Icon name="ArrowRightLeft" size={15} stroke={2.2} /></span>
            <span class="grow" style="min-width:0"><span class="t ellip" style="display:block;font-size:14.5px">{accName({ name: x.from, is_drawer: x.fromDrawer })} → {accName({ name: x.to, is_drawer: x.toDrawer })}</span>
              <span class="s">{[time(x.at, tz), moveWord(x.reason), x.by].filter(Boolean).join(' · ')}</span></span>
            <b class="num">{money(x.amount, false)}</b>
          </div>
        ))}</div>
      </>}
    </>
  );
}
