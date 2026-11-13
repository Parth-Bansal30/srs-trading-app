// The quick list (13 Nov 2026, Parth + his father: a big order must be as quick as the paper parchi). One short line per
// item — grade · size · length · pieces — written with the shop's own keypad: the shop's most-sold grades, the shapes,
// numbers and mm / inch / ft (each number keeps its own unit: 2 inch thick × 50 mm wide × 10 ft long). Grade, shape,
// units and rates carry down to the next line like ditto marks (〃). Every line shows its rate per kg and its cutting
// (worked out by the usual formula) — never our cost or other customers' rates. The same items as the Full screen.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SHAPES, splitUnit, sizeText, lenText } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { money, kg } from '../../lib/format.js';
import { SHAPE_LOOK } from '../../config/options.js';
import { Icon } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { GradePicker } from './GradePicker.jsx';
import './quick.css';

const UNITS = ['mm', 'in', 'ft'];
const newKeyLocal = () => Math.random().toString(36).slice(2);
/** The boxes of one line, in typing order: the sizes, the length (if the shape has one), the pieces. */
const fieldsOf = (it) => [...SHAPES[it.shape].dims.map((_, k) => `d${k}`), ...(SHAPES[it.shape].len ? ['len'] : []), 'pcs'];
const getV = (it, f, r) => (f === 'pcs' ? it.rows[r]?.pcs ?? '' : f === 'len' ? it.rows[r]?.len ?? '' : it.d[Number(f.slice(1))] ?? '');
/** The unit a box is in: its own (typed) unit, else the one carried for this box, else the item's unit. */
const unitOfBox = (it, f, v) => splitUnit(v).unit || it.qu?.[f] || it.unit || 'mm';
/** A number with its unit, kept plain when the unit is the item's own (so old screens read it exactly as before). */
const compose = (num, u, it) => (num === '' ? '' : u === (it.unit || 'mm') ? num : `${num}${u}`);
export const blankLine = (from, unit = 'mm') => ({
  key: newKeyLocal(), material_id: from?.material_id ?? null, shape: from?.shape ?? 'round', unit: from?.unit ?? unit,
  qu: { ...(from?.qu || {}) }, d: [''], rows: [{ len: '', pcs: '', cuts: '' }],
  rate: from?.rate ?? null, cut_rate: from?.cut_rate ?? null,
});
export const isBlankLine = (it) => !it.material_id && (it.d || []).every((v) => !String(v ?? '').trim())
  && (it.rows || []).every((r) => !String(r.len ?? '').trim() && !String(r.pcs ?? '').trim());

/** The 5 grades this shop sells most (from recent slips), then the rest of the list. */
function topGrades(materials, recent) {
  const n = new Map();
  for (const i of recent || []) n.set(i.material_id, (n.get(i.material_id) || 0) + 1);
  const act = materials.filter((m) => m.active);
  const best = [...act].sort((a, b) => (n.get(b.id) || 0) - (n.get(a.id) || 0) || a.code.localeCompare(b.code));
  return best.slice(0, 5);
}

export function QuickList({ items, setItems, resolved, cat, recent, unit, onKeypad, onFull }) {
  const [cur, setCurState] = useState(null);      // { i, r, f } — the box being typed in
  // the latest lines and box, read by every key: quick taps (or a laptop keyboard) never lose a digit between redraws
  const live = useRef({ items, cur });
  live.current.items = items;
  const setCur = (c) => { live.current.cur = c; setCurState(c); };
  live.current.cur = cur;
  const [pickGrade, setPickGrade] = useState(false);
  const [rateFor, setRateFor] = useState(null);   // line index whose rates are being changed
  const grades = useMemo(() => topGrades(cat.materials, recent), [cat, recent]);
  const money_ = can('money');
  useEffect(() => { onKeypad(!!cur); }, [!!cur]);
  useEffect(() => () => onKeypad(false), []);
  // keep the line being written above the keypad
  useEffect(() => {
    if (!cur) return;
    const el = document.querySelector('.ql-line.act .ql-r'); const kp = document.querySelector('.ql-kp');
    if (!el || !kp) return;
    const over = el.getBoundingClientRect().bottom - kp.getBoundingClientRect().top + 16;
    const under = 80 - el.getBoundingClientRect().top;
    if (over > 0) window.scrollBy({ top: over, behavior: 'smooth' }); else if (under > 0) window.scrollBy({ top: -under, behavior: 'smooth' });
  }, [cur?.i, cur?.r, !!cur]);

  const matOf = (id) => cat.materials.find((m) => m.id === id);
  const commit = (list) => { live.current.items = list; setItems(list); };
  const put = (i, patch) => commit(live.current.items.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const setV = (it, f, r, v) => (f === 'pcs' || f === 'len'
    ? { rows: it.rows.map((x, j) => (j === r ? { ...x, [f]: v } : x)) }
    : { d: Object.assign([...it.d], { [Number(f.slice(1))]: v }) });

  /** Open a line for typing: its first empty box (or the pieces). */
  const open = (i, r = 0, f = null) => {
    const it = live.current.items[i];
    const fs = fieldsOf(it);
    setCur({ i, r, f: f || fs.find((x) => !String(getV(it, x, r)).trim()) || 'pcs' });
  };
  /** Next box; after the pieces a new line (grade, shape, units and rates carried down). */
  const next = (dimOnly = false) => {
    const { items, cur } = live.current;
    if (!cur) return;
    const it = items[cur.i];
    const fs = fieldsOf(it);
    const k = fs.indexOf(cur.f);
    if (dimOnly && !cur.f.startsWith('d')) return;
    if (k >= 0 && k < fs.length - 1) return setCur({ ...cur, f: fs[k + 1] });
    if (cur.r < it.rows.length - 1) return setCur({ i: cur.i, r: cur.r + 1, f: SHAPES[it.shape].len ? 'len' : 'pcs' });
    // the last box of the last line: a new line below (an empty last line is left as it is)
    if (cur.i === items.length - 1 && isBlankLine(it)) return;
    const after = items.slice(cur.i + 1);
    if (after.length && isBlankLine(after[0])) return setCur({ i: cur.i + 1, r: 0, f: 'd0' });
    const nl = blankLine(it, unit);
    commit([...items.slice(0, cur.i + 1), nl, ...items.slice(cur.i + 1)]);
    setCur({ i: cur.i + 1, r: 0, f: 'd0' });
  };
  const type = (key) => {
    const { items, cur } = live.current;
    if (!cur) return;
    const it = items[cur.i];
    const v = String(getV(it, cur.f, cur.r));
    if (cur.f === 'pcs') {
      if (!/^\d$/.test(key)) return;
      if (v.length >= 5) return;
      return put(cur.i, setV(it, 'pcs', cur.r, (v === '0' ? '' : v) + key));
    }
    const { num } = splitUnit(v);
    const u = unitOfBox(it, cur.f, v);
    if (key === '.' && (num.includes('.') || num.includes('½'))) return;
    if (key === '½' && (num.includes('½') || num.includes('.'))) return;
    if (num.length >= 8) return;
    put(cur.i, setV(it, cur.f, cur.r, compose(num + key, u, it)));
  };
  const back = () => {
    const { items, cur } = live.current;
    if (!cur) return;
    const it = items[cur.i];
    const v = String(getV(it, cur.f, cur.r));
    if (!v) {   // an empty box: back to the box before
      const fs = fieldsOf(it); const k = fs.indexOf(cur.f);
      if (k > 0) setCur({ ...cur, f: fs[k - 1] });
      return;
    }
    if (cur.f === 'pcs') return put(cur.i, setV(it, 'pcs', cur.r, v.slice(0, -1)));
    const { num } = splitUnit(v);
    put(cur.i, setV(it, cur.f, cur.r, compose([...num].slice(0, -1).join('').trim(), unitOfBox(it, cur.f, v), it)));
  };
  const setUnit = (u) => {
    const { items, cur } = live.current;
    if (!cur || cur.f === 'pcs') return;
    const it = items[cur.i];
    const v = String(getV(it, cur.f, cur.r));
    const { num } = splitUnit(v);
    put(cur.i, { ...setV(it, cur.f, cur.r, compose(num, u, it)), qu: { ...(it.qu || {}), [cur.f]: u } });
  };
  const setGrade = (m) => {
    const { items, cur } = live.current;
    const i = cur ? cur.i : items.length - 1;
    put(i, { material_id: m.id, rate: null, cut_rate: null, stock_item_id: undefined });
    if (!cur) open(i);
  };
  const setShape = (s) => {
    const { items, cur } = live.current;
    if (!cur) return;
    const it = items[cur.i];
    put(cur.i, { shape: s, d: it.d.slice(0, SHAPES[s].dims.length), stock_item_id: undefined });
    const fs = fieldsOf({ ...it, shape: s });
    if (!fs.includes(cur.f)) setCur({ ...cur, f: 'd0' });
  };

  // a laptop: type straight on the keyboard (Enter = next, x = next size, m / i / f = mm / inch / ft, Esc = done)
  useEffect(() => {
    if (!cur) return undefined;
    const h = (e) => {
      if (e.target?.closest?.('input,textarea,select,.sheet')) return;
      const k = e.key;
      if (/^\d$/.test(k) || k === '.') { type(k); e.preventDefault(); } else if (k === 'Backspace') { back(); e.preventDefault(); }
      else if (k === 'Enter' || k === 'Tab') { next(); e.preventDefault(); } else if (k === 'x' || k === '*' || k === 'X') { next(true); e.preventDefault(); }
      else if (k === 'm') setUnit('mm'); else if (k === 'i' || k === '"') setUnit('in'); else if (k === 'f' || k === "'") setUnit('ft');
      else if (k === 'Escape') setCur(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const it0 = cur ? items[cur.i] : null;
  const curUnit = cur && cur.f !== 'pcs' ? unitOfBox(it0, cur.f, String(getV(it0, cur.f, cur.r))) : null;
  const filled = items.filter((x) => !isBlankLine(x));
  const kgAll = resolved.reduce((a, r) => a + (r.calc ? r.calc.est : 0), 0);
  const amtAll = resolved.reduce((a, r) => a + (r.calc ? r.calc.total : 0), 0);

  return (
    <>
      <div class="card ql">
        <div class="ql-h"><span>#</span><span>{t('ql_grade')}</span><span>{t('ql_size')}</span><span>{t('ql_len')}</span><span>{t('pcs')}</span><span class="r">{money_ ? '₹' : 'kg'}</span></div>
        {items.map((it, i) => {
          const r = resolved[i] || {};
          const m = matOf(it.material_id);
          const ditto = i > 0 && it.material_id && items[i - 1].material_id === it.material_id;
          const sh = SHAPES[it.shape];
          const active = cur?.i === i;
          const box = (f, rr, text, cls = '') => (
            <span class={`ql-c ${cls} ${active && cur.f === f && cur.r === rr ? 'on' : ''}`} onClick={(e) => { e.stopPropagation(); open(i, rr, f); }}>
              {text || <span class="ql-ph">{active && cur.f === f && cur.r === rr ? '' : '·'}</span>}{active && cur.f === f && cur.r === rr && <i class="ql-cur" />}</span>);
          const dims = it.d.slice(0, sh.dims.length);
          const sizeShown = dims.some((x) => String(x).trim()) ? sizeText(dims, it.unit) : '';
          return (
            <div class={`ql-line ${active ? 'act' : ''}`} key={it.key} onClick={() => open(i)}>
              <div class="ql-r">
                <span class="ql-n">{i + 1}</span>
                <span class="ql-g">{ditto ? <span class="ql-ditto" title={m?.code}>〃</span> : m ? m.code : <span class="ql-ph">{t('ql_pick')}</span>}</span>
                <span class="ql-size"><Icon name={SHAPE_LOOK[it.shape].icon} size={14} stroke={2.2} />
                  {active && cur.f.startsWith('d') ? dims.map((v, k) => <>{k > 0 && <span class="faint">×</span>}{box(`d${k}`, cur.r, String(v).trim() ? sizeText([v], it.unit).replace(/ mm$/, 'mm') : '')}</>)
                    : <span class="ql-c" onClick={(e) => { e.stopPropagation(); open(i, 0, 'd0'); }}>{sizeShown || <span class="ql-ph">·</span>}</span>}</span>
                {sh.len ? box('len', 0, String(it.rows[0]?.len ?? '').trim() ? lenText(it.rows[0].len, it.unit) : '') : <span class="faint">—</span>}
                {box('pcs', 0, it.rows[0]?.pcs ?? '', 'num')}
                <span class="ql-amt num">{r.calc ? (money_ ? money(Math.round(r.calc.total)) : kg(r.calc.est, 1)) : ''}</span>
              </div>
              {it.rows.slice(1).map((row, j) => (
                <div class="ql-r ql-more"><span /><span class="faint">+</span><span />
                  {sh.len ? box('len', j + 1, String(row.len ?? '').trim() ? lenText(row.len, it.unit) : '') : <span />}{box('pcs', j + 1, row.pcs, 'num')}<span /></div>))}
              {(r.calc || (m && money_)) && (
                <div class="ql-sub num">
                  {m && money_ && <button class={`ql-rt ${r.isSpecial ? 'own' : ''}`} onClick={(e) => { e.stopPropagation(); if (can('price')) setRateFor(i); }}>
                    ₹{r.rate}/kg<small>{it.rate != null && it.rate !== '' ? t('ql_typed') : r.isSpecial ? t('ql_own_rate') : t('ql_list_rate')}</small></button>}
                  {m && money_ && r.calc && r.calc.cut > 0 && <span class="ql-rt"><Icon name="Scissors" size={12} stroke={2.4} />{money(r.calc.cut, true)}</span>}
                  {r.calc && <span class="faint">≈ {kg(r.calc.est, 1)}</span>}
                </div>)}
              {active && (
                <div class="ql-acts" onClick={(e) => e.stopPropagation()}>
                  {sh.len && <button onClick={() => { put(i, { rows: [...it.rows, { len: '', pcs: '', cuts: '' }] }); setCur({ i, r: it.rows.length, f: 'len' }); }}><Icon name="Ruler" size={15} />{t('ql_more_len')}</button>}
                  <button onClick={() => { const c = { ...it, key: newKeyLocal(), stock_item_id: undefined, rows: it.rows.map((x) => ({ ...x })), d: [...it.d], qu: { ...(it.qu || {}) } }; commit([...live.current.items.slice(0, i + 1), c, ...live.current.items.slice(i + 1)]); setCur({ i: i + 1, r: 0, f: 'pcs' }); }}><Icon name="Copy" size={15} />{t('ql_copy')}</button>
                  <button onClick={() => onFull(i)}><Icon name="SlidersHorizontal" size={15} />{t('ql_full')}</button>
                  {items.length > 1 && <button class="bad" onClick={() => { commit(live.current.items.filter((_, k) => k !== i)); setCur(null); }}><Icon name="X" size={15} />{t('ql_delete')}</button>}
                </div>)}
            </div>
          );
        })}
        <div class="ql-tot num">
          <span>{t('ql_lines', filled.length)} · ≈ {kg(kgAll, 1)}</span>
          {money_ && <b>{money(amtAll)}</b>}
        </div>
      </div>
      {!cur && <button class="add-item" onClick={() => { const last = items[items.length - 1]; if (last && isBlankLine(last)) open(items.length - 1); else { commit([...items, blankLine(items[items.length - 1], unit)]); setCur({ i: items.length, r: 0, f: 'd0' }); } }}>
        <Icon name="Keyboard" size={18} />{t('ql_write')}</button>}
      {money_ && <div class="ql-note"><Icon name="Lock" size={14} />{t('ql_private')}</div>}

      {cur && (
        <div class="ql-kp" onClick={(e) => e.stopPropagation()}>
          <div class="ql-grades">{grades.map((m) => <button class={it0?.material_id === m.id ? 'on' : ''} onClick={() => setGrade(m)}>{m.code}</button>)}
            <button class="more" onClick={() => setPickGrade(true)}>{t('ql_more')}</button></div>
          <div class="ql-shapes">{Object.keys(SHAPE_LOOK).map((s) => <button class={it0?.shape === s ? 'on' : ''} onClick={() => setShape(s)}><Icon name={SHAPE_LOOK[s].icon} size={16} />{t(SHAPE_LOOK[s].word)}</button>)}</div>
          <div class="ql-keys">
            {['1', '2', '3'].map((k) => <button onClick={() => type(k)}>{k}</button>)}<button class={`u ${curUnit === 'mm' ? 'on' : ''}`} disabled={cur.f === 'pcs'} onClick={() => setUnit('mm')}>mm</button>
            {['4', '5', '6'].map((k) => <button onClick={() => type(k)}>{k}</button>)}<button class={`u ${curUnit === 'in' ? 'on' : ''}`} disabled={cur.f === 'pcs'} onClick={() => setUnit('in')}>{t('u_in')}</button>
            {['7', '8', '9'].map((k) => <button onClick={() => type(k)}>{k}</button>)}<button class={`u ${curUnit === 'ft' ? 'on' : ''}`} disabled={cur.f === 'pcs'} onClick={() => setUnit('ft')}>ft</button>
            <button disabled={cur.f === 'pcs'} onClick={() => type('½')}>½</button><button onClick={() => type('0')}>0</button><button onClick={() => type('.')} disabled={cur.f === 'pcs'}>.</button>
            <button class="nx" onClick={() => next()}>{cur.f === 'pcs' ? t('ql_next_line') : t('ql_next')}<Icon name="CornerDownLeft" size={18} /></button>
            <button class="done" onClick={() => setCur(null)}><Icon name="Check" size={18} stroke={2.6} />{t('ql_done')}</button>
            <button onClick={back} aria-label={t('remove')}><Icon name="Delete" size={22} /></button>
            <button class="by" disabled={!cur.f.startsWith('d')} onClick={() => next(true)}>× {t('ql_by')}</button>
          </div>
          <div class="ql-hint">{t(`ql_box_${cur.f === 'pcs' ? 'pcs' : cur.f === 'len' ? 'len' : 'size'}`, SHAPES[it0.shape].dims.length > 1 && cur.f.startsWith('d') ? t(`d_${SHAPES[it0.shape].dims[Number(cur.f.slice(1))]}`) : '')}</div>
        </div>
      )}

      <GradePicker open={pickGrade} materials={cat.materials} onClose={() => setPickGrade(false)} onPick={(m) => { setGrade(m); setPickGrade(false); }} />
      <RateSheet open={rateFor != null} i={rateFor} items={items} resolved={resolved} matOf={matOf} onClose={() => setRateFor(null)}
        onSave={(rate, cut, all) => {
          const mid = items[rateFor].material_id;
          commit(items.map((x, k) => ((all ? x.material_id === mid : k === rateFor) ? { ...x, rate, cut_rate: cut } : x)));
          setRateFor(null);
        }} />
    </>
  );
}

/** Change the rate per kg and the cutting rate (per sq inch) — for this line or every line of the grade. */
function RateSheet({ open, i, items, resolved, matOf, onClose, onSave }) {
  const it = i != null ? items[i] : null;
  const r = i != null ? resolved[i] : null;
  const m = it ? matOf(it.material_id) : null;
  const [rate, setRate] = useState('');
  const [cut, setCut] = useState('');
  const [all, setAll] = useState(true);
  useEffect(() => { if (open && r) { setRate(String(r.rate ?? '')); setCut(String(r.cutRate ?? '')); setAll(true); } }, [open, i]);
  const same = it ? items.filter((x) => x.material_id === it.material_id).length : 0;
  const ok = Number(rate) >= 0 && rate !== '' && Number(cut) >= 0 && cut !== '';
  return (
    <Sheet open={open && !!it} onClose={onClose} title={m ? t('ql_rates_for', m.code) : ''}
      footer={<button class="btn btn-accent btn-block" disabled={!ok} onClick={() => onSave(Number(rate), Number(cut), all && same > 1)}><Icon name="Check" size={20} stroke={2.6} />{t('save')}</button>}>
      <div class="row" style="gap:10px">
        <label class="ratebox grow"><span class="lbl" style="margin:0">{t('rate_kg')}</span>
          <span class="row" style="gap:4px"><span class="num">₹</span><input class="num" inputmode="decimal" value={rate} onInput={(e) => setRate(e.currentTarget.value.replace(/[^\d.]/g, ''))} /></span></label>
        <label class="ratebox grow"><span class="lbl" style="margin:0">{t('ql_cut_sq')}</span>
          <span class="row" style="gap:4px"><span class="num">₹</span><input class="num" inputmode="decimal" value={cut} onInput={(e) => setCut(e.currentTarget.value.replace(/[^\d.]/g, ''))} /></span></label>
      </div>
      <div class="faint" style="font-size:13px;font-weight:600;margin-top:8px">{t('ql_cut_formula')}</div>
      {same > 1 && <label class="cash-taken" style="margin-top:12px"><input type="checkbox" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} /><span>{t('ql_rates_all', same, m?.code || '')}</span></label>}
    </Sheet>
  );
}
