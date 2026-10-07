// Today's summary: sales (GST / no bill), money received by kind and mode, cash count at closing, weight check.
import { useEffect, useState } from 'preact/hooks';
import { calcItem, r2, modeAmounts } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company, me } from '../../lib/session.js';
import { db } from '../../lib/backend.js';
import { useAction } from '../../lib/action.js';
import { money, kg, time, dayStartISO, longDay } from '../../lib/format.js';
import { toast } from '../../ui/toast.js';
import { PAY_METHODS } from '../../config/options.js';
import { TopBar, Skeleton } from '../../ui/kit.jsx';

const q = async (p) => { const { data, error } = await p; if (error) throw error; return data; };

export function Summary() {
  const tz = company.value?.timezone || 'Asia/Kolkata';
  const [d, setD] = useState(null);
  const [counted, setCounted] = useState('');
  const cash = useAction('saveCashCount');
  const load = async () => {
    const since = dayStartISO(tz);
    const [done, pays, closes, weighed] = await Promise.all([
      q(db.from('orders').select('id,bill_type,total_amount').eq('status', 'done').gte('done_at', since)),
      q(db.from('payments').select('amount,mode,kind,order_id,reverses_payment_id,parts:payment_parts(mode,amount)').gte('received_at', since)),
      can('today') ? q(db.from('cash_closes').select('counted_cash,expected_cash,closed_at,people(display_name)').gte('closed_at', since).order('closed_at', { ascending: false }).limit(1)).catch(() => []) : [],
      q(db.from('order_items').select('shape,unit,dims,density,actual_weight,order_item_lengths(len,pcs,cuts),orders!inner(weighed_at,pricing_rules)').gte('orders.weighed_at', since).not('actual_weight', 'is', null)).catch(() => []),
    ]);
    const ids = new Set(done.map((o) => o.id));
    const sum = (xs) => r2(xs.reduce((a, x) => a + Number(x.amount ?? x.total_amount), 0));
    const byBill = (b) => done.filter((o) => o.bill_type === b);
    const spot = sum(pays.filter((p) => p.kind === 'pickup' && ids.has(p.order_id)));
    const salesTotal = sum(done);
    const allPaidOnToday = await (ids.size ? q(db.from('payments').select('amount,kind,order_id').in('order_id', [...ids])) : []);
    const fromAdv = sum(allPaidOnToday.filter((p) => ['advance', 'refund', 'transfer'].includes(p.kind)));
    const inKinds = { pickup: sum(pays.filter((p) => p.kind === 'pickup')), advance: sum(pays.filter((p) => p.kind === 'advance' && p.mode !== 'Adjust')),
      khata: sum(pays.filter((p) => p.kind === 'khata' && p.mode !== 'Adjust')), out: sum(pays.filter((p) => p.kind === 'refund' || p.kind === 'reversal')) };
    // a payment split across accounts counts in each of its modes; the drawer only expects the cash part
    const pieces = pays.flatMap((p) => modeAmounts(p));
    const byMode = PAY_METHODS.map((m) => ({ ...m, v: sum(pieces.filter((x) => x.mode === m.id)) }));
    let est = 0; let act = 0; let flags = 0;
    weighed.forEach((i) => {
      const c = calcItem({ shape: i.shape, unit: i.unit, d: i.dims, rows: i.order_item_lengths.map((l) => ({ len: l.len ?? '', pcs: l.pcs, cuts: l.cuts ?? '' })), rate: 0, cutRate: 0, density: Number(i.density) }, 'est', { minInch: i.orders.pricing_rules?.min_inch ?? 1 });
      if (!c) return;
      est += c.est; act += Number(i.actual_weight);
      if (Math.abs(Number(i.actual_weight) - c.est) / c.est > 0.05) flags++;
    });
    setD({ sales: { total: salesTotal, pakka: sum(byBill('pakka')), kacha: sum(byBill('kacha')), n: done.length, spot, fromAdv, khata: r2(Math.max(0, salesTotal - spot - fromAdv)) },
      inKinds, byMode, cashExpected: byMode.find((m) => m.id === 'Cash').v, last: closes[0], weight: { est, act, flags, n: weighed.length } });
  };
  useEffect(() => { load().catch(() => setD({ error: true })); }, []);

  if (!d) return <><TopBar title={t('tile_today')} /><div class="page"><Skeleton h={160} /><Skeleton h={160} style="margin-top:12px" /></div></>;
  if (d.error) return <><TopBar title={t('tile_today')} /><div class="page muted">{t('err_generic')}</div></>;
  const diff = counted === '' ? null : r2(Number(counted) - d.cashExpected);
  const L = ({ a, s, b, strong }) => <div class="li"><div class="grow"><div class={strong ? 't' : ''}>{a}</div>{s && <div class="s">{s}</div>}</div><div class="num" style={`font-weight:${strong ? 800 : 700}`}>{b}</div></div>;

  return (
    <>
      <TopBar title={t('tile_today')} sub={longDay(new Date().toISOString(), tz)} />
      <div class="page">
        <div class="hero">
          <div class="hero-cap">{t('sales_today')}</div>
          <div class="hero-num num">{money(d.sales.total, false)}</div>
          <div class="hero-row">
            <div class="hero-box"><div class="cap">{t('gst_bills')}</div><div class="num v">{money(d.sales.pakka, false)}</div></div>
            {can('kacha') && <div class="hero-box"><div class="cap">{t('no_bills')}</div><div class="num v">{money(d.sales.kacha, false)}</div></div>}
          </div>
        </div>
        <div class="card" style="margin-top:12px">
          <L a={t('paid_spot')} s={t('paid_spot_s')} b={money(d.sales.spot)} />
          <L a={t('from_adv')} s={t('from_adv_s')} b={money(d.sales.fromAdv)} />
          <L a={t('went_khata')} b={money(d.sales.khata)} />
        </div>

        <div class="sec"><h3>{t('money_in')}</h3></div>
        <div class="card">
          <L a={t('paid_spot')} b={money(d.inKinds.pickup)} />
          <L a={t('adv_taken')} s={t('adv_taken_s')} b={money(d.inKinds.advance)} />
          <L a={t('old_collected')} b={money(d.inKinds.khata)} />
          {d.inKinds.out !== 0 && <L a={t('kind_refund')} b={money(d.inKinds.out)} />}
          <div class="li" style="flex-wrap:wrap;gap:8px">{d.byMode.filter((m) => m.v !== 0).map((m) => <span class="chip tone-neutral">{t(m.word)} {money(m.v)}</span>)}</div>
          <L a={t('total_in')} b={money(r2(d.inKinds.pickup + d.inKinds.advance + d.inKinds.khata + d.inKinds.out))} strong />
        </div>

        {can('today') && (
          <>
            <div class="sec"><h3>{t('cash_close_title')}</h3></div>
            <div class="card pad">
              <div class="row" style="justify-content:space-between"><span class="muted">{t('cash_expected')}</span><b class="num" style="font-size:20px">{money(d.cashExpected)}</b></div>
              <div class="lbl" style="margin-top:14px">{t('cash_counted')}</div>
              <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={counted} onInput={(e) => setCounted(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
              {diff != null && <div class="row" style="justify-content:space-between;margin-top:10px"><span class="muted">{t('cash_diff')}</span>
                <b class="num" style={`color:${diff === 0 ? 'var(--ok)' : 'var(--bad)'}`}>{diff > 0 ? '+' : ''}{money(diff)}</b></div>}
              <button class="btn btn-brand btn-block" style="margin-top:14px" disabled={cash.busy || counted === ''}
                onClick={() => cash.run({ counted: Number(counted) }).then(() => { toast(t('cash_saved')); setCounted(''); load(); }).catch(() => {})}>{t('cash_save')}</button>
              {d.last && <div class="faint" style="font-size:13px;margin-top:10px">{t('cash_saved_at', time(d.last.closed_at, tz), money(d.last.counted_cash), d.last.people?.display_name || me.value?.name)}</div>}
              {cash.error && <div class="error">{cash.error.message}</div>}
            </div>
          </>
        )}

        <div class="sec"><h3>{t('wastage_title')}</h3></div>
        <div class="card">
          {d.weight.n === 0 ? <div class="li muted">{t('wastage_none')}</div> : <>
            <L a={t('wastage_est')} b={kg(d.weight.est)} />
            <L a={t('wastage_act')} b={kg(d.weight.act)} />
            <L a={t('wastage_diff')} s={t('wastage_diff_s')} b={`${kg(d.weight.act - d.weight.est)} (${d.weight.est ? ((d.weight.act / d.weight.est - 1) * 100).toFixed(1) : 0}%)`} />
            {d.weight.flags > 0 && <div class="li" style="color:var(--warn);font-weight:600">{t('wastage_flag', d.weight.flags)}</div>}
          </>}
        </div>
      </div>
    </>
  );
}
