// Which bills a supplier payment is for (5 Nov 2026, plan v2 F6). The app suggests oldest first (the opening balance,
// then bills by date) as the amount is typed; the person can change every amount or untick a bill. What is not set
// against any bill stays as money with the supplier (an advance). Bills marked "paid outside the app" (the old Paid tick)
// can be LINKED to this payment — the due does not go down twice.
// value: [{ purchase_id | opening_id, amount, outside }] · onChange(value) · editing: the payment being changed (its own
// split counts as still open).
import { useEffect, useState } from 'preact/hooks';
import { suggestSupplierAllocation, allocationProblem } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { call } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { Icon } from '../kit.jsx';
import '../money/money.css';

const r2 = (n) => Math.round(n * 100) / 100;

/** What is open for a supplier (from the khata): [{ kind, id, date, left, label, overdue_days }] and the "outside" bills. */
export async function openForSupplier(supplierId, editing = null) {
  const k = await call('supplierKhata', { supplier_id: supplierId });
  const back = (id) => (editing ? (k.allocations || []).filter((a) => a.expense_id === editing && (a.purchase_id === id || a.opening_id === id)).reduce((s, a) => s + Number(a.amount), 0) : 0);
  const open = [
    ...(k.openings || []).filter((o) => o.direction === 'owe').map((o) => ({ kind: 'opening', id: o.id, date: o.date, left: r2(o.left + back(o.id)), label: t('sk_opening') })),
    ...(k.bills || []).filter((b) => !b.outside).map((b) => ({ kind: 'bill', id: b.id, date: b.date, left: r2(b.left + back(b.id)), label: b.bill_no || '—', side: b.side, overdue_days: b.overdue_days, total: b.total })),
  ].filter((x) => x.left > 0.5);
  const outside = (k.bills || []).filter((b) => b.outside).slice(-12).reverse();
  return { open, outside, khata: k };
}

export function BillSplit({ supplierId, amount, value, onChange, editing = null }) {
  const [d, setD] = useState(null);
  const [mine, setMine] = useState(false);     // the person changed the split: stop suggesting
  const [showOut, setShowOut] = useState(false);
  useEffect(() => { setD(null); setMine(false); if (supplierId) openForSupplier(supplierId, editing).then(setD).catch(() => setD({ open: [], outside: [], err: true })); }, [supplierId]);
  useEffect(() => { if (d && !mine) onChange(suggestSupplierAllocation(amount, d.open).parts); }, [d, amount]);
  if (!supplierId) return null;
  if (!d) return <div class="muted" style="font-size:14px;margin-top:8px">…</div>;
  const parts = value || [];
  const idOf = (p) => p.purchase_id || p.opening_id;
  const partFor = (id) => parts.find((p) => idOf(p) === id);
  const set = (next) => { setMine(true); onChange(next); };
  const toggle = (it) => {
    const p = partFor(it.id);
    if (p) return set(parts.filter((x) => idOf(x) !== it.id));
    const used = parts.reduce((s, x) => s + Number(x.amount || 0), 0);
    const give = r2(Math.max(0, Math.min(it.left, (Number(amount) || 0) - used)));
    return set([...parts, it.kind === 'opening' ? { opening_id: it.id, amount: give || it.left } : { purchase_id: it.id, amount: give || it.left }]);
  };
  const setAmt = (id, v) => set(parts.map((x) => (idOf(x) === id ? { ...x, amount: v } : x)));
  const used = r2(parts.reduce((s, x) => s + (Number(x.amount) || 0), 0));
  const advance = r2((Number(amount) || 0) - used);
  const problem = allocationProblem(amount, parts.map((x) => ({ ...x, amount: Number(x.amount) })), d.open);
  return (
    <div class="bsplit">
      {d.open.length === 0 ? <div class="muted" style="font-size:14px">{t('sa_none_open')}</div> : (
        <div class="card">{d.open.map((it) => {
          const p = partFor(it.id);
          return (
            <div class={`li bsplit-row ${p ? 'on' : ''}`}>
              <button class="bsplit-tick" onClick={() => toggle(it)} aria-pressed={!!p}><span class={`acc-tick ${p ? 'on' : ''}`}>{p && <Icon name="Check" size={16} stroke={3} />}</span></button>
              <button class="grow bsplit-txt" onClick={() => toggle(it)}>
                <span class="t">{it.label}</span>
                <span class="s">{fmtDay(it.date, false)} · {t('sa_left', money(it.left, false))}{it.overdue_days > 0 ? <b style="color:var(--bad)"> · {t('sk_overdue_days', it.overdue_days)}</b> : ''}</span>
              </button>
              {p ? <div class="field bsplit-amt"><span class="faint">₹</span><input inputmode="decimal" value={p.amount} onInput={(e) => setAmt(it.id, e.currentTarget.value.replace(/[^\d.]/g, ''))} /></div>
                : <b class="num faint">{money(it.left, false)}</b>}
            </div>
          );
        })}</div>
      )}
      <div class="row bsplit-sum">
        <span class="grow muted">{t('sa_set', money(used, false))}</span>
        {advance > 0.005 && <b style="color:var(--accent)">{t('sa_advance', money(advance, false))}</b>}
      </div>
      {problem && Number(amount) > 0 && <div class="error" style="margin-top:6px">{t(problem)}</div>}
      {mine && <button class="link" style="margin-top:4px" onClick={() => { setMine(false); onChange(suggestSupplierAllocation(amount, d.open).parts); }}><Icon name="RotateCcw" size={15} />{t('sa_oldest_first')}</button>}
      {d.outside.length > 0 && <>
        <button class="link" style="margin-top:8px" onClick={() => setShowOut(!showOut)}><Icon name={showOut ? 'ChevronUp' : 'ChevronDown'} size={15} />{t('sa_outside_q', d.outside.length)}</button>
        {showOut && <div class="card" style="margin-top:6px">
          <div class="li"><div class="s" style="font-size:12.5px">{t('sa_outside_s')}</div></div>
          {d.outside.map((b) => {
            const p = partFor(b.id);
            return (
              <button class={`li ${p ? 'on' : ''}`} onClick={() => set(p ? parts.filter((x) => idOf(x) !== b.id) : [...parts, { purchase_id: b.id, amount: Math.min(b.total, Number(amount) || b.total), outside: true }])}>
                <span class={`acc-tick ${p ? 'on' : ''}`}>{p && <Icon name="Link" size={14} stroke={3} />}</span>
                <span class="grow"><span class="t">{b.bill_no || '—'}</span><span class="s" style="display:block">{fmtDay(b.date, false)} · {t('sa_paid_outside')}</span></span>
                <b class="num">{money(b.total, false)}</b>
              </button>
            );
          })}
          {parts.some((x) => x.outside && Math.abs(Number(x.amount) - Number(d.outside.find((b) => b.id === x.purchase_id)?.total || 0)) > 0.5) && (
            <div class="li"><div class="notice tone-warn" style="font-size:13px">{t('sa_outside_diff')}</div></div>)}
        </div>}
      </>}
    </div>
  );
}
export const splitProblem = (amount, parts, open) => allocationProblem(amount, (parts || []).map((x) => ({ ...x, amount: Number(x.amount) })), open || []);
