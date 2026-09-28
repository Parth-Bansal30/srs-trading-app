// Compare grades side by side: type, what's in them, strength, shocks, wear, machining, welding, rust, today's rate.
// Address: #/compare?g=EN8,EN19,EN24  (tap a grade name to change it).
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { loadCatalog } from '../../lib/catalog.js';
import { money } from '../../lib/format.js';
import { route, replace } from '../../lib/router.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { GradeInfo, InfoButton, tri, triList, pct } from '../../ui/grades/GradeInfo.jsx';
import '../../ui/grades/grades.css';

const DEFAULTS = { EN8: ['EN8', 'EN19', 'EN24'], EN9: ['EN9', 'EN8', 'EN19'], EN19: ['EN19', 'EN8', 'EN24'], EN24: ['EN24', 'EN19', 'EN8'], EN31: ['EN31', 'D2', 'EN24'], EN36: ['EN36', 'EN19', 'EN24'], D2: ['D2', 'EN31'], SS304: ['SS304', 'SS316'], SS316: ['SS316', 'SS304'], MS: ['MS', 'EN8', 'EN19'] };
const MAX = typeof innerWidth !== 'undefined' && innerWidth >= 700 ? 5 : 3;

export function Compare() {
  const [cat, setCat] = useState(null);
  const [info, setInfo] = useState(null);
  useEffect(() => { loadCatalog().then(setCat); }, []);
  if (!cat) return <><TopBar title={t('cmp_title')} /><div class="page"><Skeleton h={300} /></div></>;

  const mats = cat.materials.filter((m) => m.active);
  const byCode = new Map(mats.map((m) => [m.code, m]));
  const asked = (route.value.query.g || '').split(',').map((x) => x.trim()).filter((c) => byCode.has(c));
  let codes = asked.length > 1 ? asked : (DEFAULTS[asked[0]] || [asked[0] || 'EN8', 'EN19', 'EN24']).filter((c) => byCode.has(c));
  if (codes.length < 2) codes = mats.slice(0, 2).map((m) => m.code);
  codes = [...new Set(codes)].slice(0, MAX);
  const set = (list) => replace(`/compare?g=${list.map(encodeURIComponent).join(',')}`);
  const G = codes.map((c) => byCode.get(c));
  const I = G.map((m) => m.info || {});
  const els = [...new Set(I.flatMap((i) => (i.comp || []).map((c) => c[0])))].filter((e) => !['S', 'P'].includes(e));
  const elOf = (i, e) => { const c = (i.comp || []).find((x) => x[0] === e); return c ? pct(c[1], c[2]) : '—'; };
  const lvl = (n) => (n ? t(`lvl_${n}`) : '—');
  const best = (vals) => { const m = Math.max(...vals.map((v) => v || 0)); return (v) => (v && v === m && vals.filter((x) => x === m).length < vals.length ? 'best' : ''); };
  const cols = `grid-template-columns:${MAX > 3 ? 130 : 78}px repeat(${G.length}, minmax(0, 1fr))`;

  const Row = ({ k, vals, cls = () => '' }) => <><div class="k">{k}</div>{vals.map((v, i) => <div class={`num ${cls(i)}`}>{v}</div>)}</>;
  const scoreRow = (k, get) => { const v = I.map(get); const b = best(v); return <Row k={k} vals={v.map(lvl)} cls={(i) => b(v[i])} />; };

  return (
    <>
      <TopBar title={t('cmp_title')} sub={t('cmp_sub')} />
      <div class="page">
        <div class="cmp" style={cols}>
          <div class="h k" />
          {G.map((m, idx) => (
            <div class="h">
              <select value={m.code} onChange={(e) => set(codes.map((c, j) => (j === idx ? e.currentTarget.value : c)))} aria-label={m.code}>
                {mats.map((x) => <option value={x.code} disabled={x.code !== m.code && codes.includes(x.code)}>{x.code}</option>)}
              </select>
            </div>
          ))}
          <Row k={t('cmp_type')} vals={G.map((m, i) => <span style="font-size:12px;line-height:1.3">{tri(I[i].kind) || t(`fam_${m.family}`)}</span>)} />
          {els.map((e) => <Row k={t(`el_${e}`)} vals={I.map((i) => elOf(i, e))} />)}
          <Row k={`${t('gi_tensile')} N/mm²`} vals={I.map((i) => i.str?.tensile || '—')} />
          <Row k={t('gi_hard')} vals={I.map((i) => <span style="font-size:12px;line-height:1.3">{i.str?.hard || '—'}</span>)} />
          {scoreRow(t('cmp_shock'), (i) => i.score?.shock)}
          {scoreRow(t('cmp_wear'), (i) => i.score?.wear)}
          {scoreRow(t('gi_machine'), (i) => i.work?.machine?.[0])}
          {scoreRow(t('gi_weld'), (i) => i.work?.weld?.[0])}
          {scoreRow(t('gi_rust'), (i) => i.work?.rust?.[0])}
          <Row k={t('gi_best')} vals={I.map((i) => <span style="font-size:12px;line-height:1.35">{triList(i.good).slice(0, 3).join(', ') || '—'}</span>)} />
          {can('money') && <Row k={t('cmp_rate')} vals={G.map((m) => (m.sell_rate != null ? `${money(m.sell_rate)}` : '—'))} />}
          <div class="k" />
          {G.map((m, idx) => (
            <div style="gap:6px">
              <InfoButton onClick={() => setInfo(m)} label={m.code} />
              {codes.length > 2 && <button class="gi-i" style="font-family:inherit;font-style:normal;font-size:16px" onClick={() => set(codes.filter((_, j) => j !== idx))} aria-label="remove">×</button>}
            </div>
          ))}
        </div>
        <div class="faint" style="font-size:12px;font-weight:600;margin-top:8px">{t('cmp_t_note')}</div>
        {codes.length < MAX && mats.length > codes.length && (
          <button class="btn btn-ghost btn-block" style="margin-top:12px" onClick={() => set([...codes, mats.find((x) => !codes.includes(x.code)).code])}>
            <Icon name="Plus" size={18} stroke={2.4} />{t('cmp_add')}</button>
        )}
      </div>
      <GradeInfo m={info} materials={cat.materials} open={!!info} onClose={() => setInfo(null)} />
    </>
  );
}
