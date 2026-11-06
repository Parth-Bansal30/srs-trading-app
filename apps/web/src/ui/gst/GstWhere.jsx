// "Where is the steel going?" on a GST slip (6 Nov 2026, plan v2 F10). Asked only for GST slips; the answer is
// remembered for the customer (shown first next time), never assumed. The result is the place of supply and the GST
// split for the CA to confirm — or "CA to check" when something is missing or unusual. Skipping is allowed.
import { useEffect, useState } from 'preact/hooks';
import { placeOfSupply, gstSplit, stateName, SUPPLY_STATES } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { call } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { Icon } from '../kit.jsx';
import './gst.css';

/** The shop's state + this customer's (from its GST number) + where its steel went last time. */
export function useGstContext(customerId, on) {
  const [ctx, setCtx] = useState(null);
  useEffect(() => { if (on && customerId) call('gstContext', { customer_id: customerId }).then(setCtx).catch(() => setCtx({})); }, [customerId, on]);
  return ctx;
}

/** "Delhi → Haryana · IGST 18% ₹13,320" or "CA to check — …" */
export function PosLine({ shop, delivery, dest, gst, pct }) {
  const p = placeOfSupply({ shop, delivery, dest });
  const sp = gstSplit(gst, p.kind);
  return (
    <div class={`pos-line ${p.sure ? 'ok' : 'check'}`}>
      <Icon name={p.sure ? 'MapPin' : 'CircleHelp'} size={16} />
      <span class="grow">
        {p.from && p.to ? `${stateName(p.from)} → ${stateName(p.to)}` : p.from ? `${stateName(p.from)} → ?` : '? → ?'}
        {p.kind && sp && ` · ${p.kind === 'local' ? t('pos_local', pct / 2, money(sp.cgst, true), money(sp.sgst, true)) : t('pos_inter', pct, money(sp.igst, true))}`}
        {!p.sure && <b> · {t('pos_check')}</b>}
        {!p.sure && <span class="s">{t(`pos_why_${p.reason}`)}</span>}
      </span>
    </div>
  );
}

/**
 * The question. value: { delivery, dest }; onChange(next). ctx from useGstContext. direct: a delivery straight from
 * the supplier (fixed). gst / pct: for the split line.
 */
export function GstWhere({ ctx, value, onChange, direct = false, gst = 0, pct = 18 }) {
  const [other, setOther] = useState(false);
  const shop = ctx?.shop_state || null;
  const mine = ctx?.customer?.gstin_state || null;
  const last = ctx?.customer?.dest_state || null;
  const chips = [...new Set([last, shop, mine].filter(Boolean))];
  const v = value || {};
  const set = (patch) => onChange({ ...v, ...patch });
  return (
    <div class="gst-where">
      <div class="q" style="margin-top:0">{t('gsw_q')}</div>
      {direct ? <div class="notice tone-accent" style="font-size:13px">{t('gsw_direct')}</div> : (
        <div class="seg"><button class={v.delivery === 'pickup' ? 'on' : ''} onClick={() => set({ delivery: 'pickup' })}>{t('gsw_pickup')}</button>
          <button class={v.delivery === 'ours' ? 'on' : ''} onClick={() => set({ delivery: 'ours' })}>{t('gsw_ours')}</button></div>
      )}
      <div class="lbl" style="margin-top:10px">{t('gsw_dest')}</div>
      <div class="gw-chips">
        {chips.map((c) => <button class={v.dest === c ? 'on' : ''} onClick={() => { setOther(false); set({ dest: c }); }}>{stateName(c)}{c === last ? <span class="faint"> · {t('gsw_last')}</span> : ''}</button>)}
        <button class={other || (v.dest && !chips.includes(v.dest)) ? 'on' : ''} onClick={() => setOther(true)}>{t('gsw_other')}</button>
        <button class={v.dest === null && v.skip ? 'on' : ''} onClick={() => { setOther(false); set({ dest: null, skip: true }); }}>{t('gsw_skip')}</button>
      </div>
      {(other || (v.dest && !chips.includes(v.dest))) && (
        <div class="field" style="margin-top:8px"><select value={v.dest || ''} onChange={(e) => set({ dest: e.currentTarget.value || null, skip: false })}>
          <option value="">{t('gsw_choose')}</option>
          {SUPPLY_STATES.map((s) => <option value={s.code}>{s.name}</option>)}
        </select></div>
      )}
      {(v.dest || v.skip || direct) && <PosLine shop={shop} delivery={direct ? 'direct' : v.delivery} dest={v.dest} gst={gst} pct={pct} />}
    </div>
  );
}
