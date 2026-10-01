// One stock item: how much is there, what it cost, every move in and out (with the bill or slip),
// and the owner's corrections: count it, close it when finished, low-stock warning for the grade.
// Address: #/stock/:id
import { useEffect, useState } from 'preact/hooks';
import { r2 } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { useAction } from '../../lib/action.js';
import { call } from '../../lib/api.js';
import { money, shortDate, time } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { loadStock, forgetStock, stockName, kgTxt } from '../../lib/stock.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import './stock.css';

const MOVE = {
  purchase: ['mv_purchase', 'PackagePlus', 'ok'], purchase_undo: ['mv_purchase_undo', 'Undo2', 'neutral'],
  sale: ['mv_sale', 'PackageMinus', 'neutral'], sale_undo: ['mv_sale_undo', 'Undo2', 'ok'],
  adjust: ['mv_adjust', 'ClipboardCheck', 'warn'], scrap: ['mv_scrap', 'Minus', 'warn'],
};

export function StockItem({ id }) {
  const [d, setD] = useState(null);
  const [extra, setExtra] = useState(null); // booked on open orders, from the stock list
  const [err, setErr] = useState(null);
  const [sheet, setSheet] = useState(null); // 'count' | 'close' | 'low'
  const tz = company.value?.timezone;
  const load = () => {
    call('stockItem', { id }).then(setD).catch((e) => setErr(e.message));
    loadStock(true).then((s) => setExtra(s.items.find((x) => x.id === id) || null)).catch(() => {});
  };
  useEffect(load, [id]);
  const done = (msg) => { setSheet(null); forgetStock(); toast(msg || t('st_saved')); load(); };

  if (err) return <><TopBar title={t('nav_stock')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!d) return <><TopBar title={t('nav_stock')} /><div class="page"><Skeleton h={120} /><Skeleton h={200} style="margin-top:12px" /></div></>;
  const it = d.item;
  const onHand = Number(it.on_hand);
  const booked = extra?.booked || 0;
  const sold = d.moves.filter((m) => m.kind === 'sale' || m.kind === 'sale_undo');
  const soldKg = r2(-sold.reduce((a, m) => a + Number(m.kg), 0));
  const inKg = r2(d.moves.filter((m) => m.kind === 'purchase' || m.kind === 'purchase_undo').reduce((a, m) => a + Number(m.kg), 0));
  const soldValue = d.can_cost ? r2(-sold.reduce((a, m) => a + Number(m.kg) * Number(m.sell_rate || 0), 0)) : null;
  const pct = inKg > 0 ? Math.max(0, Math.min(100, (onHand / inKg) * 100)) : 0;

  return (
    <>
      <TopBar title={stockName(it)} sub={[it.rate != null ? `${money(it.rate)}/kg` : null, it.hsn ? t('st_hsn', it.hsn) : null, it.label].filter(Boolean).join(' · ')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        <div class="card pad">
          <div class="row" style="justify-content:space-between"><span class="faint cap">{t('st_on_hand')}</span>
            {it.closed ? <Chip tone="neutral">{t('st_finished')}</Chip> : onHand < 0 ? <Chip tone="bad">{t('st_below_zero')}</Chip>
              : it.low_kg != null ? <span class="faint" style="font-size:12.5px;font-weight:600">{t('st_low_now', kgTxt(it.low_kg))}</span> : null}</div>
          <div class={`num stock-big ${onHand < 0 ? 'bad' : ''}`}>{kgTxt(onHand)}</div>
          {inKg > 0 && <div class="stock-bar"><div style={`width:${pct}%`} /></div>}
          <div class="row muted" style="justify-content:space-between;font-size:13px;font-weight:600;margin-top:6px">
            <span>{t('mv_purchase')} {kgTxt(inKg)}</span><span>{t('mv_sale')} {kgTxt(soldKg)}</span>
          </div>
          {booked > 0 && <div class="notice tone-warn" style="margin-top:10px">{t('st_booked', kgTxt(booked))} · {t('st_free', kgTxt(onHand - booked))}</div>}
        </div>

        {d.can_cost && (
          <div class="card" style="margin-top:10px;padding:4px 16px">
            <Row a={t('pu_rate')} b={`${money(it.rate)}/kg`} />
            <Row a={t('st_cost')} b={`${money(it.cost)}/kg`} />
            {soldKg > 0 && <Row a={t('mv_sale')} b={`${kgTxt(soldKg)} · ${money(soldValue, false)}`} top />}
          </div>
        )}

        {can('stock') && (
          <div class="row" style="gap:10px;margin-top:12px">
            <button class="btn btn-ghost grow" style="font-size:15px" onClick={() => setSheet('count')}><Icon name="ClipboardCheck" size={18} />{t('st_count')}</button>
            {!it.closed && <button class="btn btn-ghost grow" style="font-size:15px" onClick={() => setSheet('close')}><Icon name="CircleCheck" size={18} />{t('st_finished')}</button>}
          </div>
        )}
        {can('stock') && <button class="link" style="margin-top:6px" onClick={() => setSheet('low')}><Icon name="Bell" size={16} />{t('st_low_set', it.code)}{it.low_kg != null ? ` · ${kgTxt(it.low_kg)}` : ''}</button>}

        <div class="sec"><h3>{t('st_history')}</h3></div>
        <div class="card">
          {d.moves.map((m) => {
            const [w, ic, tone] = MOVE[m.kind] || [m.kind, 'Info', 'neutral'];
            const link = m.order_id ? `/slip/${m.order_id}` : m.purchase_id ? `/purchase/${m.purchase_id}` : null;
            return (
              <button class="li" onClick={() => link && go(link)} style={link ? '' : 'cursor:default'}>
                <div class={`iconbox tone-${tone}`} style="width:36px;height:36px"><Icon name={ic} size={17} /></div>
                <div class="grow">
                  <div class="t" style="font-size:14.5px">{t(w)}{m.slip_no ? ` · #${m.slip_no}` : ''}{m.bill_no ? ` · ${t('pu_bill_no')} ${m.bill_no}` : ''}</div>
                  <div class="s">{[m.customer || m.supplier, `${shortDate(m.at, tz)} ${time(m.at, tz)}`, m.by, m.note].filter(Boolean).join(' · ')}</div>
                  {m.sell_rate != null && <div class="s num">{money(m.sell_rate)}/kg</div>}
                </div>
                <b class={`num ${Number(m.kg) < 0 ? '' : 'ok'}`}>{Number(m.kg) > 0 ? '+' : '−'}{kgTxt(Math.abs(Number(m.kg)))}</b>
              </button>
            );
          })}
        </div>
      </div>
      <CountSheet open={sheet === 'count' || sheet === 'close'} close={sheet === 'close'} it={it} onClose={() => setSheet(null)} onDone={done} />
      <LowSheet open={sheet === 'low'} it={it} onClose={() => setSheet(null)} onDone={done} />
    </>
  );
}

const Row = ({ a, b, top }) => <div class="row" style={`justify-content:space-between;padding:9px 0;${top ? 'border-top:1px solid var(--line)' : ''}`}><span class="muted">{a}</span><span class="num" style="font-weight:700">{b}</span></div>;

function CountSheet({ open, close, it, onClose, onDone }) {
  const [v, setV] = useState('');
  const [note, setNote] = useState('');
  const a = useAction('stockCount');
  useEffect(() => { if (open) { setV(close ? '0' : String(Math.max(0, Number(it.on_hand)))); setNote(''); a.setError(null); } }, [open]);
  const count = Number(v);
  const diff = r2(count - Number(it.on_hand));
  return (
    <Sheet open={open} onClose={onClose} title={close ? t('st_close') : t('st_count')}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !(count >= 0) || v === ''}
        onClick={() => a.run({ id: it.id, count, close, note: note || undefined }).then(() => onDone()).catch(() => {})}>{close ? t('st_close_do') : t('st_count_save')}</button>}>
      {close
        ? <div class="muted" style="font-size:14.5px;line-height:1.45">{t('st_close_s', kgTxt(it.on_hand))}</div>
        : <>
          <div class="lbl">{t('st_count_s')}</div>
          <div class="field num"><input inputmode="decimal" value={v} onInput={(e) => setV(e.currentTarget.value.replace(/[^\d.]/g, ''))} autofocus /><span class="faint unit">kg</span></div>
          <div class="row muted" style="justify-content:space-between;margin-top:8px;font-size:14px"><span>{t('st_count_app', kgTxt(it.on_hand))}</span>
            {v !== '' && <b class="num" style={diff < 0 ? 'color:var(--bad)' : ''}>{t('st_count_diff', `${diff > 0 ? '+' : ''}${kgTxt(diff)}`)}</b>}</div>
        </>}
      <div class="lbl" style="margin-top:14px">{t('pu_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      {a.error && <div class="error" style="margin-top:10px">{a.error.message}</div>}
    </Sheet>
  );
}

function LowSheet({ open, it, onClose, onDone }) {
  const [v, setV] = useState('');
  const a = useAction('setLowStock');
  useEffect(() => { if (open) { setV(it.low_kg == null ? '' : String(Number(it.low_kg))); a.setError(null); } }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={t('st_low_set', it.code)}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy} onClick={() => a.run({ material_id: it.material_id, kg: v === '' ? null : Number(v) }).then(() => onDone()).catch(() => {})}>{t('btn_save')}</button>}>
      <div class="field num"><input inputmode="decimal" value={v} onInput={(e) => setV(e.currentTarget.value.replace(/[^\d.]/g, ''))} autofocus placeholder="500" /><span class="faint unit">kg</span></div>
      <div class="faint" style="font-size:13px;font-weight:600;margin-top:8px">{t('st_low_kg')}</div>
      {a.error && <div class="error" style="margin-top:10px">{a.error.message}</div>}
    </Sheet>
  );
}
