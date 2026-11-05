// #/direct/:purchaseId — the customer's slip for a delivery straight to a customer (5 Nov 2026, plan v2 F7).
// The supplier billed us and sent the steel to the customer: the steel never comes into our stock. The slip has the
// same steel with the bill's weights (they can be corrected), the rate for this customer, no weighing. It is finished
// like any slip (GST bill or not, how it is paid) from the slip's own page.
import { useEffect, useState } from 'preact/hooks';
import { SHAPES } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { loadCatalog, customerRates } from '../../lib/catalog.js';
import { kgTxt } from '../../lib/stock.js';
import { SHAPE_LOOK } from '../../config/options.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { CustomerPicker } from '../order/CustomerPicker.jsx';
import './stock.css';

/** "MS ROUND 40MM" → ['40'] (only a hint — the person checks it). */
const sizeHint = (desc, n) => {
  const nums = (String(desc || '').match(/\d+(?:\.\d+)?/g) || []).filter((x) => Number(x) > 2 && Number(x) < 2000);
  return Array.from({ length: n }, (_, i) => nums[i] || '');
};

export function DirectSlip({ id }) {
  const [d, setD] = useState(null);
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState(null);
  const [cust, setCust] = useState(null);
  const [picking, setPicking] = useState(false);
  const [lines, setLines] = useState([]);
  const a = useAction('directSlip');
  useEffect(() => {
    if (!can('new') || !can('money')) { go('/'); return; }
    Promise.all([call('purchase', { id }), loadCatalog()]).then(([p, c]) => {
      setD(p); setCat(c);
      setLines((p.lines || []).map((l) => {
        const shape = l.shape || 'round';
        const m = c.materials.find((x) => x.id === l.material_id);
        return { material_id: l.material_id, code: l.code, description: l.description, shape, unit: 'mm', size: sizeHint(l.description, SHAPES[shape]?.dims.length || 1),
          kg: String(Number(l.kg)), rate: m?.sell_rate != null ? String(Number(m.sell_rate)) : '', hsn: l.hsn };
      }));
    }).catch((e) => setErr(e.message || t('err_generic')));
  }, [id]);
  useEffect(() => { if (cust && cat) customerRates(cust.id).then((r) => setLines((ls) => ls.map((l) => (r.has(l.material_id) ? { ...l, rate: String(r.get(l.material_id)) } : l)))).catch(() => {}); }, [cust?.id]);
  if (err) return <><TopBar title={t('dd_title')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!d || !cat) return <><TopBar title={t('dd_title')} /><div class="page"><Skeleton h={120} /><Skeleton h={220} style="margin-top:12px" /></div></>;
  const p = d.purchase;
  if (d.direct_order) {
    return (<><TopBar title={t('dd_title')} /><div class="page">
      <div class="notice tone-ok">{t('dd_has_slip', d.direct_order.slip_no, d.direct_order.customer || '')}</div>
      <button class="btn btn-brand btn-block" style="margin-top:12px" onClick={() => go(`/slip/${d.direct_order.id}`)}><Icon name="ReceiptText" size={18} />{t('dd_open_slip')}</button></div></>);
  }
  const setLine = (k, patch) => setLines(lines.map((l, i) => (i === k ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + (Number(l.kg) || 0) * (Number(l.rate) || 0), 0);
  const bad = !cust ? 'dd_need_customer' : lines.some((l) => !(Number(l.kg) > 0)) ? 'dd_need_kg' : lines.some((l) => !(Number(l.rate) > 0)) ? 'dd_need_rate'
    : lines.some((l) => l.size.some((x) => !String(x).trim())) ? 'dd_need_size' : null;
  const save = () => a.run({ purchase_id: p.id, customer_id: cust.id, lines: lines.map((l) => ({ material_id: l.material_id, shape: l.shape, unit: l.unit, size: l.size, kg: Number(l.kg), rate: Number(l.rate) })) })
    .then((r) => { toast(t('dd_saved', r.slip_no)); go(`/slip/${r.order_id}`); }).catch(() => {});
  return (
    <>
      <TopBar title={t('dd_title')} sub={`${d.supplier?.name || ''} · ${p.bill_no || ''} · ${fmtDay(p.bill_date, false)}`} />
      <div class="page" style="padding-bottom:150px">
        <div class="notice tone-accent" style="font-size:13.5px">{t('dd_s')}</div>
        <div class="lbl" style="margin-top:14px">{t('dd_customer')}</div>
        <button class="field" style="width:100%;text-align:left" onClick={() => setPicking(true)}><Icon name="UserSearch" size={18} />
          <span class="grow" style={cust ? 'font-weight:700' : 'color:var(--ink-3)'}>{cust ? cust.name : t('choose_customer')}</span><Icon name="ChevronRight" size={16} /></button>

        <div class="sec"><h3>{t('dd_steel')}</h3><span class="faint" style="font-size:12.5px;font-weight:600">{t('dd_steel_s')}</span></div>
        {lines.map((l, k) => {
          const sh = SHAPES[l.shape];
          return (
            <div class="card pad" style="margin-bottom:10px">
              <div class="t" style="font-weight:800">{l.code} · <span class="muted" style="font-weight:600">{l.description}</span></div>
              <div class="dd-shapes">{Object.keys(SHAPES).map((s) => <button class={l.shape === s ? 'on' : ''} onClick={() => setLine(k, { shape: s, size: sizeHint(l.description, SHAPES[s].dims.length) })}>{t(SHAPE_LOOK[s]?.word || s)}</button>)}</div>
              <div class="row" style="gap:8px;margin-top:10px">
                {sh.dims.map((dim, j) => <div class="grow"><div class="lbl">{t(`d_${dim}`)} (mm)</div>
                  <div class="field num"><input inputmode="decimal" value={l.size[j] || ''} onInput={(e) => { const s = [...l.size]; s[j] = e.currentTarget.value.replace(/[^\d.\s/]/g, ''); setLine(k, { size: s }); }} /></div></div>)}
              </div>
              <div class="row" style="gap:8px;margin-top:10px">
                <div class="grow"><div class="lbl">{t('dd_kg')}</div><div class="field num"><input inputmode="decimal" value={l.kg} onInput={(e) => setLine(k, { kg: e.currentTarget.value.replace(/[^\d.]/g, '') })} /><span class="faint">kg</span></div></div>
                <div class="grow"><div class="lbl">{t('dd_rate')}</div><div class="field num"><span class="faint">₹</span><input inputmode="decimal" value={l.rate} onInput={(e) => setLine(k, { rate: e.currentTarget.value.replace(/[^\d.]/g, '') })} /><span class="faint">/kg</span></div></div>
              </div>
              {Number(l.kg) > 0 && Number(l.rate) > 0 && <div class="faint num" style="font-size:12.5px;font-weight:600;margin-top:6px">{kgTxt(Number(l.kg))} × {money(Number(l.rate))} = {money(Number(l.kg) * Number(l.rate), false)}</div>}
            </div>
          );
        })}
        <div class="card pad dd-eff">
          <div class="row" style="gap:8px"><Icon name="Boxes" size={17} /><span>{t('dd_eff_stock')}</span></div>
          <div class="row" style="gap:8px;margin-top:6px"><Icon name="ReceiptText" size={17} /><span>{t('dd_eff_slip', money(total, false))}</span></div>
        </div>
        {a.error && <div class="error">{a.error.message}</div>}
      </div>
      <div class="quotebar">
        <button class="btn btn-accent btn-block" disabled={a.busy || !!bad} onClick={save}><Icon name="ReceiptText" size={19} />{bad ? t(bad) : t('dd_save')}</button>
      </div>
      <CustomerPicker open={picking} customers={cat.customers} onClose={() => setPicking(false)} onPick={(c) => { setCust(c); setPicking(false); }} title={t('dd_customer')} />
    </>
  );
}
