// The "i" sheet for a grade: what it is, best uses, what it's made of, strength, how to work it,
// heat treatment, what to watch out for, what to give instead, and a line for the customer.
// Text comes from the grade's own info (the shop can edit it); shown in the person's language.
import { useState } from 'preact/hooks';
import { t, lang } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { money } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { toast } from '../toast.js';
import { Icon } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';
import './grades.css';

const IDX = { en: 0, hi: 1, hn: 2 };
/** One of [en, hi, hn] in the person's language (falls back to English). */
export const tri = (v) => (Array.isArray(v) ? (v[IDX[lang.value]] ?? v[0]) : v || '');
/** A list stored per language: [[en…], [hi…], [hn…]]. */
export const triList = (v) => (Array.isArray(v) && Array.isArray(v[0]) ? (v[IDX[lang.value]]?.length ? v[IDX[lang.value]] : v[0]) : []);
export const pct = (min, max) => (min == null ? `≤ ${max}%` : `${min}–${max}%`);

export function Dots({ n }) {
  return <span class="gi-dots">{[1, 2, 3, 4, 5].map((i) => <span class={i <= n ? 'on' : ''} />)}</span>;
}

function Composition({ comp }) {
  const max = Math.max(...comp.map((c) => c[2]));
  const scale = max <= 1.2 ? 1.2 : max <= 2.2 ? 2.2 : Math.ceil(max / 5) * 5;
  const total = comp.reduce((a, c) => a + (c[1] == null ? c[2] / 2 : (c[1] + c[2]) / 2), 0);
  return (
    <div class="card gi-comp">
      {comp.map(([el, min, mx]) => (
        <div class="gi-bar">
          <div class="gi-el">{t(`el_${el}`)} <span class="faint">{el}</span></div>
          <div class="gi-track"><div style={`left:${((min ?? 0) / scale) * 100}%;width:${Math.max(2, ((mx - (min ?? 0)) / scale) * 100)}%;${min == null ? 'opacity:.45' : ''}`} /></div>
          <div class="num gi-pct">{pct(min, mx)}</div>
        </div>
      ))}
      <div class="gi-iron"><span class="muted">{t('gi_iron')}</span><b class="num">{t('gi_rest')} (≈ {Math.floor(100 - total)}%)</b></div>
    </div>
  );
}

/**
 * m: the grade (from loadCatalog: code, family, info, sell_rate, density_override).
 * materials: all grades (for alternatives). onUse(material): put another grade on the order (optional).
 */
export function GradeInfo({ m, materials = [], open, onClose, onUse }) {
  const [copied, setCopied] = useState(false);
  if (!m) return null;
  const i = m.info || {};
  const good = triList(i.good);
  const byCode = new Map(materials.map((x) => [x.code, x]));
  const alts = (i.alts || []).filter(([code]) => byCode.get(code)?.active !== false);
  const dens = m.density_override ? m.density_override / 1000 : { carbon: 7.85, alloy: 7.85, stainless: 7.93, tool: 7.7 }[m.family];
  const copy = async () => {
    try { await navigator.clipboard.writeText(tri(i.tell)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* not allowed */ }
  };
  const WORK = [['cut', 'gi_cut'], ['machine', 'gi_machine'], ['weld', 'gi_weld'], ['harden', 'gi_harden'], ['rust', 'gi_rust']];
  return (
    <Sheet open={open} onClose={onClose} title={`${m.code} · ${t(`fam_${m.family}`)}`}>
      <div class="gi">
        <div class="row" style="gap:12px;align-items:center">
          <div class="gi-badge">{m.code}</div>
          <div class="grow" style="min-width:0">
            <div style="font-weight:800;font-size:16px">{tri(i.kind) || t(`fam_${m.family}`)}</div>
            {i.eq && <div class="faint" style="font-size:13px;font-weight:600">{t('gi_also', i.eq.replace(/^≈\s*/, ''))}</div>}
          </div>
          {can('money') && m.sell_rate != null && <span class="chip tone-neutral num" style="height:30px;padding:0 10px">{money(m.sell_rate)}/kg</span>}
        </div>

        {!i.what ? <div class="muted" style="margin-top:14px">{t('gi_none')}</div> : <>
          <p class="gi-what">{tri(i.what)}</p>

          {good.length > 0 && <>
            <div class="lbl" style="margin-top:16px">{t('gi_best')}</div>
            <div class="gi-chips">{good.map((g) => <span class="chip tone-ok">{g}</span>)}</div>
          </>}

          {i.comp?.length > 0 && <>
            <div class="lbl" style="margin-top:18px">{t('gi_made')}</div>
            <Composition comp={i.comp} />
          </>}

          {i.str && <>
            <div class="lbl" style="margin-top:18px">{t('gi_strength')}</div>
            <div class="gi-boxes">
              {i.str.tensile && i.str.tensile !== '—' && <div class="card"><div class="faint gi-k">{t('gi_tensile')}</div><div class="num gi-v">{i.str.tensile}</div><div class="faint gi-u">N/mm²</div></div>}
              <div class="card"><div class="faint gi-k">{t('gi_hard')}</div><div class="num gi-v gi-small">{i.str.hard}</div></div>
              {dens && <div class="card"><div class="faint gi-k">{t('gi_weight')}</div><div class="num gi-v">{dens.toFixed(2)}</div><div class="faint gi-u">{t('gi_per_litre')}</div></div>}
            </div>
            <div class="faint" style="font-size:12px;font-weight:600;margin-top:8px">{t('gi_typical', tri(i.str.cond))}</div>
          </>}

          {i.work && <>
            <div class="lbl" style="margin-top:18px">{t('gi_working')}</div>
            <div class="card" style="padding:2px 14px">
              {WORK.filter(([k]) => i.work[k]).map(([k, w]) => (
                <div class="gi-work"><div class="grow"><div style="font-weight:600;font-size:14px">{t(w)}</div><div class="faint" style="font-size:12.5px;font-weight:600">{tri(i.work[k][1])}</div></div><Dots n={i.work[k][0]} /></div>
              ))}
            </div>
          </>}

          {i.heat && <><div class="lbl" style="margin-top:16px">{t('gi_heat')}</div><div class="card pad" style="font-size:14px;line-height:1.45">{tri(i.heat)}</div></>}
          {i.watch && <div class="gi-warn"><Icon name="TriangleAlert" size={18} stroke={2.2} /><span>{tri(i.watch)}</span></div>}

          {alts.length > 0 && <>
            <div class="lbl" style="margin-top:16px">{t('gi_alts', m.code)}</div>
            <div class="card">
              {alts.map(([code, why]) => {
                const a = byCode.get(code);
                return (
                  <div class="li">
                    <div class="gi-alt">{code}</div>
                    <div class="grow"><div class="t num">{code}{a && can('money') && a.sell_rate != null ? ` · ${money(a.sell_rate)}/kg` : ''}</div><div class="s">{tri(why)}</div></div>
                    {onUse && a && <button class="btn btn-accent gi-use" onClick={() => { onUse(a); toast(t('gi_used', code)); }}>{t('gi_use')}</button>}
                  </div>
                );
              })}
            </div>
          </>}

          {i.tell && <>
            <div class="lbl" style="margin-top:16px">{t('gi_tell')}</div>
            <div class="card pad" style="font-size:14.5px;line-height:1.45">“{tri(i.tell)}”
              <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
                <button class="chip tone-neutral gi-act" onClick={copy}><Icon name={copied ? 'Check' : 'Copy'} size={14} stroke={2.3} />{copied ? t('gi_copied') : t('gi_copy')}</button>
                <button class="chip tone-accent gi-act" onClick={() => { onClose?.(); go(`/compare?g=${encodeURIComponent(m.code)}`); }}><Icon name="GitCompare" size={14} stroke={2.3} />{t('gi_compare')}</button>
              </div>
            </div>
          </>}
        </>}
      </div>
    </Sheet>
  );
}

/** The small round "i" button. */
export const InfoButton = ({ onClick, label }) => (
  <button class="gi-i" onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label={label || 'info'}>i</button>
);
