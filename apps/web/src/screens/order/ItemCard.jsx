// One item on an order: grade, shape, sizes (mm/inch), cut lengths × pieces, rates, and its live price.
import { useEffect, useState } from 'preact/hooks';
import { SHAPES } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { lastSold } from '../../lib/catalog.js';
import { money, kg, shortDate } from '../../lib/format.js';
import { SHAPE_LOOK } from '../../config/options.js';
import { Icon, Chip } from '../../ui/kit.jsx';
import { GradePicker } from './GradePicker.jsx';
import { GradeInfo, InfoButton } from '../../ui/grades/GradeInfo.jsx';
import { StockLine, StockPick } from '../../ui/stock/StockPick.jsx';
import { usualFor } from '../../lib/habitsMath.js';
import '../stock/stock.css';

export function ItemCard({ index, item, r, cat, customer, editingId, stock, recent = [], onChange, onUnit, onRemove }) {
  const [pickGrade, setPickGrade] = useState(false);
  const [pickStock, setPickStock] = useState(false);
  const [info, setInfo] = useState(false);
  const [hint, setHint] = useState(null);
  const sh = SHAPES[item.shape];
  const m = r.m;
  const tz = company.value?.timezone;

  useEffect(() => {
    setHint(null);
    if (m && can('money')) lastSold(customer?.id, m.id, editingId).then(setHint);
  }, [m?.id, customer?.id]);

  const setD = (k, v) => { const d = [...item.d]; d[k] = v; onChange({ d }); };
  // the shop's usual sizes and cut lengths for this grade + shape (26 Oct 2026)
  const usual = m ? usualFor(recent, m.id, item.shape, item.unit, { dims: item.d }) : { sizes: [], lengths: [] };
  const sameSize = (dims) => dims.length === sh.dims.length && dims.every((x, k) => String(item.d[k] ?? '').trim() === x);
  const useLen = (v) => {
    const k = item.rows.findIndex((x) => !String(x.len).trim());
    onChange({ rows: k >= 0 ? item.rows.map((x, j) => (j === k ? { ...x, len: v } : x)) : [...item.rows, { len: v, pcs: '', cuts: '' }] });
  };
  const setRow = (k, patch) => onChange({ rows: item.rows.map((x, j) => (j === k ? { ...x, ...patch } : x)) });
  const u = item.unit === 'in' ? t('u_in') : t('u_mm');
  const h = hint?.mine || hint?.any;
  const diff = h ? Math.round((r.rate - h.rate) * 100) / 100 : 0;

  return (
    <div class="card item">
      <div class="row">
        <button class="grade" onClick={() => setPickGrade(true)}>{m ? m.code : <span style="color:var(--accent)">{t('choose_grade')}</span>}<Icon name="ChevronRight" size={16} /></button>
        {m && <InfoButton onClick={() => setInfo(true)} label={`${m.code} info`} />}
        {m && <Chip tone="neutral">{t(`fam_${m.family}`)}</Chip>}
        <div class="grow" />
        <span class="faint" style="font-size:13px;font-weight:600">{t('item')} {index + 1}</span>
        {onRemove && <button class="round sm" onClick={onRemove} aria-label={t('remove')}><Icon name="X" size={16} /></button>}
      </div>

      <div class="shapes">
        {Object.keys(SHAPE_LOOK).map((id) => (
          <button class={item.shape === id ? 'on' : ''} onClick={() => onChange({ shape: id, d: item.d.slice(0, SHAPES[id].dims.length), stock_item_id: undefined })}>
            <Icon name={SHAPE_LOOK[id].icon} size={20} stroke={item.shape === id ? 2.2 : 1.8} /><span>{t(SHAPE_LOOK[id].word)}</span>
          </button>
        ))}
      </div>

      <div class="row" style="align-items:flex-end;margin-top:12px;gap:8px">
        {sh.dims.map((dim, k) => (
          <div class="grow">
            <div class="lbl">{t(`d_${dim}`)}</div>
            <div class="field num"><input inputmode="decimal" value={item.d[k] ?? ''} onInput={(e) => setD(k, e.currentTarget.value)} placeholder="0" /><span class="faint unit">{u}</span></div>
          </div>
        ))}
        <div class="seg unitseg">
          <button class={item.unit === 'mm' ? 'on' : ''} onClick={() => onUnit('mm')}>{t('u_mm')}</button>
          <button class={item.unit === 'in' ? 'on' : ''} onClick={() => onUnit('in')}>{t('u_in')}</button>
        </div>
      </div>

      {usual.sizes.filter((x) => x.length === sh.dims.length).length > 0 && (
        <div class="usual"><span class="faint">{t('usual_sizes')}</span>{usual.sizes.filter((x) => x.length === sh.dims.length).map((dims) => (
          <button class={sameSize(dims) ? 'on' : ''} onClick={() => onChange({ d: dims })}>{dims.join(' × ')}</button>))}</div>
      )}
      <div class="lbl" style="margin-top:14px">{sh.len ? t('lengths_title') : t('pieces')}</div>
      {item.rows.map((row, k) => (
        <div class={`lenrow ${sh.len ? '' : 'nolen'}`}>
          {sh.len && <div class="field num"><input inputmode="decimal" value={row.len} onInput={(e) => setRow(k, { len: e.currentTarget.value })} placeholder={t('cut_len')} /><span class="faint unit">{u}</span></div>}
          {sh.len && <span class="faint">×</span>}
          <div class="field num pcs"><input inputmode="numeric" value={row.pcs} onInput={(e) => setRow(k, { pcs: e.currentTarget.value.replace(/\D/g, '') })} placeholder="0" /><span class="faint unit">{t('pcs')}</span></div>
          <div class="field num cutsf" title={t('cuts')}><input inputmode="numeric" value={row.cuts} onInput={(e) => setRow(k, { cuts: e.currentTarget.value.replace(/\D/g, '') })} placeholder={row.pcs || '–'} /><span class="faint unit">{t('cuts_word')}</span></div>
          {item.rows.length > 1 ? <button class="round sm" onClick={() => onChange({ rows: item.rows.filter((_, j) => j !== k) })} aria-label={t('remove')}><Icon name="X" size={14} /></button> : <span />}
        </div>
      ))}
      {sh.len && usual.lengths.length > 0 && (
        <div class="usual"><span class="faint">{t('usual_lengths')}</span>{usual.lengths.map((v) => <button onClick={() => useLen(v)}>{v}</button>)}</div>
      )}
      {sh.len && <button class="link" onClick={() => onChange({ rows: [...item.rows, { len: '', pcs: '', cuts: '' }] })}><Icon name="Plus" size={16} stroke={2.4} />{t('add_length')}</button>}

      {m && can('money') && (
        <>
          <div class="row" style="gap:8px;margin-top:10px">
            <label class="ratebox grow">
              <span class="lbl" style="margin:0">{t('rate_kg')} {r.isSpecial && <Chip tone="accent">{t('special')}</Chip>}</span>
              <span class="row" style="gap:4px"><span class="num">₹</span>
                <input class="num" inputmode="decimal" disabled={!can('price')} value={item.rate ?? r.rate} onInput={(e) => onChange({ rate: e.currentTarget.value })} /></span>
            </label>
            <label class="ratebox grow">
              <span class="lbl" style="margin:0">{t('cut_rate')}</span>
              <span class="row" style="gap:4px"><span class="num">₹</span>
                <input class="num" inputmode="decimal" disabled={!can('price')} value={item.cut_rate ?? r.cutRate} onInput={(e) => onChange({ cut_rate: e.currentTarget.value })} /></span>
            </label>
          </div>
          {hint && (
            <div class={`hint ${h ? (diff > 0 ? 'tone-warn' : diff < 0 ? 'tone-pakka' : 'tone-ok') : 'tone-neutral'}`}>
              <Icon name="Info" size={15} stroke={2.2} />
              <span class="grow">{hint.mine ? t('last_cust', hint.mine.name, hint.mine.rate, hint.mine.cut, shortDate(hint.mine.at, tz), hint.mine.slip)
                : hint.any ? t('last_any', hint.any.name, hint.any.rate, shortDate(hint.any.at, tz)) : t('never_sold')}
                {h && <b> · {diff > 0 ? t('diff_up', diff) : diff < 0 ? t('diff_down', -diff) : t('diff_same')}</b>}</span>
              {h && can('price') && diff !== 0 && <button class="link" onClick={() => onChange({ rate: h.rate, cut_rate: h.cut })}>{t('use_last')}</button>}
            </div>
          )}
        </>
      )}

      {m && stock && <StockLine stock={stock} value={r.stockId} need={r.need} sellRate={r.rate} onOpen={() => setPickStock(true)} />}

      <div class="itemfoot">
        {r.calc ? (
          <>
            <span class="muted">≈ <b class="num" style="color:var(--ink)">{kg(r.calc.est)}</b> · {r.calc.cuts} {t('cuts_word')}</span>
            {can('money') && <span class="num" style="font-weight:800">{money(r.calc.total, true)}</span>}
          </>
        ) : <span class="faint">{t('fill_hint')}</span>}
      </div>

      <GradePicker open={pickGrade} materials={cat.materials} onClose={() => setPickGrade(false)}
        onPick={(mat) => { onChange({ material_id: mat.id, rate: null, cut_rate: null, stock_item_id: undefined }); setPickGrade(false); }} />
      {m && stock && <StockPick open={pickStock} stock={stock} need={r.need} value={r.stockId} onClose={() => setPickStock(false)}
        onPick={(id) => { onChange({ stock_item_id: id }); setPickStock(false); }} />}
      <GradeInfo m={m} materials={cat.materials} open={info && !!m} onClose={() => setInfo(false)}
        onUse={(alt) => { onChange({ material_id: alt.id, rate: null, cut_rate: null, stock_item_id: undefined }); setInfo(false); }} />
    </div>
  );
}
