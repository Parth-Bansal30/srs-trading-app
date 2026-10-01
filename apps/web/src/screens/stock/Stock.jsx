// Stock: every stock item grouped by grade + shape, with what is free (on hand − booked on open orders).
// Address: #/stock. Buying rates and value only for people with "stock".
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { money } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { loadStock, stockName, stockLine, kgTxt } from '../../lib/stock.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import './stock.css';

export function Stock() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState(false);
  const tz = company.value?.timezone;
  useEffect(() => { loadStock(true).then(setD).catch((e) => setErr(e.message)); }, []);

  const items = (d?.items || []).filter((s) => (closed || !s.closed) && (!q.trim() || s.code.toLowerCase().includes(q.trim().toLowerCase()) || (s.label || '').toLowerCase().includes(q.trim().toLowerCase())));
  const groups = [];
  for (const s of items) {
    const k = `${s.code}|${s.shape || ''}`;
    let g = groups.find((x) => x.k === k);
    if (!g) { g = { k, s, items: [], kg: 0 }; groups.push(g); }
    g.items.push(s); g.kg += Number(s.on_hand);
  }
  const lowOf = (mid) => d?.materials.find((m) => m.id === mid)?.low_kg;
  const kgByMat = new Map();
  for (const s of d?.items || []) if (!s.closed) kgByMat.set(s.material_id, (kgByMat.get(s.material_id) || 0) + Number(s.on_hand));
  const total = (d?.items || []).filter((s) => !s.closed).reduce((a, s) => a + Math.max(0, Number(s.on_hand)), 0);
  const value = d?.can_cost ? (d.items || []).filter((s) => !s.closed).reduce((a, s) => a + Math.max(0, Number(s.on_hand)) * Number(s.cost || 0), 0) : null;

  return (
    <>
      <TopBar title={t('nav_stock')} sub={d ? `${kgTxt(total)}${value != null ? ` · ${t('st_value')} ${money(value, false)}` : ''}` : ''}
        right={can('stock') && <button class="round" onClick={() => go('/purchases')} aria-label={t('nav_purchases')}><Icon name="Truck" size={19} /></button>} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        {err && <div class="error">{err}</div>}
        {can('stock') && (
          <div class="row" style="gap:10px;margin-bottom:12px">
            <button class="btn btn-accent grow" onClick={() => go('/purchases/new')}><Icon name="FileUp" size={19} stroke={2.3} />{t('st_add_bill')}</button>
          </div>
        )}
        <div class="field" style="background:var(--surface)"><Icon name="Search" size={18} /><input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('st_search')} /></div>
        {!d && !err && <><Skeleton h={70} style="margin-top:12px" /><Skeleton h={70} style="margin-top:12px" /></>}
        {d && !d.items.length && (
          <div class="card pad" style="margin-top:14px;text-align:center">
            <Icon name="Boxes" size={30} />
            <div style="font-weight:800;font-size:17px;margin-top:8px">{t('st_empty_t')}</div>
            <div class="muted" style="margin-top:6px;font-size:14px;line-height:1.45">{t('st_empty_s')}</div>
            {can('stock') && <button class="btn btn-ghost btn-block" style="margin-top:12px" onClick={() => go('/purchases/new?kind=opening')}>{t('st_opening')}</button>}
          </div>
        )}
        {groups.map((g) => {
          const low = lowOf(g.s.material_id);
          const matKg = kgByMat.get(g.s.material_id) || 0;
          return (
            <>
              <div class="sec stock-sec">
                <h3>{stockName(g.s)}</h3>
                <span class="row" style="gap:6px">
                  {low != null && matKg < Number(low) && <Chip tone="bad">{t('st_low')}</Chip>}
                  <span class="faint" style="font-size:13px;font-weight:600">{g.items.length === 1 ? t('st_item1') : t('st_items', g.items.length)} · <b class="num">{kgTxt(g.kg)}</b></span>
                </span>
              </div>
              <div class="card">
                {g.items.map((s) => (
                  <button class="li" onClick={() => go(`/stock/${s.id}`)} style={s.closed ? 'opacity:.55' : ''}>
                    <div class="grow">
                      <div class="t num">{s.rate != null ? t('st_bought_at', money(s.rate)) : (s.label || stockName(s))}</div>
                      <div class="s">{stockLine(s, tz, { rate: false })}</div>
                      {s.booked > 0 && <div class="s">{t('st_booked', kgTxt(s.booked))}</div>}
                    </div>
                    <div style="text-align:right">
                      <b class={`num ${s.on_hand < 0 ? 'bad' : ''}`} style="font-size:15.5px">{kgTxt(s.on_hand)}</b>
                      {s.closed ? <div><Chip tone="neutral">{t('st_finished')}</Chip></div> : s.on_hand < 0 ? <div><Chip tone="bad">{t('st_below_zero')}</Chip></div> : null}
                    </div>
                  </button>
                ))}
              </div>
            </>
          );
        })}
        {d && d.items.some((s) => s.closed) && (
          <button class="link" style="margin-top:12px" onClick={() => setClosed(!closed)}>{closed ? '−' : '+'} {t('st_show_closed')}</button>
        )}
        {d && d.items.length > 0 && can('stock') && (
          <button class="link" style="margin-top:6px" onClick={() => go('/purchases/new?kind=opening')}><Icon name="PackagePlus" size={16} />{t('st_opening')}</button>
        )}
      </div>
    </>
  );
}
