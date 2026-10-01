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
            <div class="muted num eve-s">{t('eve_expected', money(s.cash.expected, false))}{s.cash.counted != null ? <><br />{t('eve_counted', money(s.cash.counted, false))}</> : <><br /><span style="color:var(--accent);font-weight:700">{t('eve_count_now')} →</span></>}</div>
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
