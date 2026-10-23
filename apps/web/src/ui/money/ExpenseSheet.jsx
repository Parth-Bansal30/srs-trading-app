// Add (or change) a shop expense: what it was for (big tiles), how much, from which account.
// Optional: who it was paid to, a note, the day, a GST bill (the CA may claim the GST) and a photo.
// Owners can also note "paid a supplier" (and tick his bills) or "for home".
import { useEffect, useRef, useState } from 'preact/hooks';
import { expenseProblem, gstInside, checkGstin, r2 } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { online } from '../../lib/net.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { addDays } from '../../lib/evening.js';
import { loadAccounts, accountsCache, lastAccount, rememberAccount } from '../../lib/accounts.js';
import { shopToday, catOf } from '../../lib/expenses.js';
import { fileToData } from '../../lib/files.js';
import { EXPENSE_CATEGORIES } from '../../config/options.js';
import { Icon } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';
import { AccountPick } from './AccountPick.jsx';
import './money.css';

const blank = () => ({ kind: 'expense', category: null, amount: '', accountId: null, method: null, paidTo: '', note: '', day: 'today', date: '',
  gstBill: false, gstAmount: '', billNo: '', sellerGstin: '', fileKey: null, supplierId: null, bills: [], more: false });

/** Which kinds this person may enter. */
export const expenseKinds = () => [
  (can('expenses') || can('settings')) && 'expense',
  (can('stock') || can('settings')) && 'supplier',
  can('settings') && 'owner',
].filter(Boolean);

/**
 * open / onClose / onDone(result). edit: an expense from the list to change (it is replaced, the old one kept as cancelled).
 * suppliers: [{ id, name, unpaid: [{ id, bill_no, date, total }] }] for "paid a supplier".
 */
export function ExpenseSheet({ open, onClose, onDone, edit = null, suppliers = [], startKind = 'expense' }) {
  const [f, setF] = useState(blank());
  const [accounts, setAccounts] = useState(accountsCache.value);
  const [upBusy, setUpBusy] = useState(false);
  const [upErr, setUpErr] = useState(null);
  const save = useAction('saveExpense');
  const photo = useRef(null);
  const kinds = expenseKinds();
  const today = shopToday();
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!open) return;
    save.setError(null); setUpErr(null);
    const base = blank();
    if (edit) {
      Object.assign(base, { kind: edit.kind, category: edit.category, amount: String(Number(edit.amount)), accountId: edit.account_id, method: edit.method || null,
        paidTo: edit.paid_to || '', note: edit.note || '', day: edit.day === today ? 'today' : edit.day === addDays(today, -1) ? 'yesterday' : 'pick', date: edit.day,
        gstBill: !!edit.gst_bill, gstAmount: edit.gst_amount == null ? '' : String(Number(edit.gst_amount)), billNo: edit.bill_no || '', sellerGstin: edit.seller_gstin || '',
        supplierId: edit.supplier_id || null, bills: edit.purchase_ids || [], more: !!(edit.gst_bill || edit.note || edit.paid_to) });
    } else if (kinds.includes(startKind)) base.kind = startKind;
    setF(base);
    loadAccounts().then((l) => {
      setAccounts(l);
      setF((x) => (x.accountId && l.some((a) => a.id === x.accountId) ? x : { ...x, accountId: (l.find((a) => a.id === lastAccount() && a.usable !== false) || l.find((a) => a.is_drawer) || l[0])?.id || null }));
    }).catch(() => setAccounts(accountsCache.value || []));
  }, [open, edit?.id]);

  const amount = Number(f.amount) || 0;
  const sup = suppliers.find((s) => s.id === f.supplierId);
  const billsTotal = r2((sup?.unpaid || []).filter((b) => f.bills.includes(b.id)).reduce((a, b) => a + Number(b.total), 0));
  const problem = expenseProblem({ kind: f.kind, category: f.category, amount: f.amount, accountId: f.accountId, gstBill: f.gstBill,
    gstAmount: f.gstAmount, sellerGstin: f.sellerGstin.trim(), supplierId: f.supplierId });
  const dayArg = f.day === 'today' ? null : f.day === 'yesterday' ? addDays(today, -1) : f.date || null;
  const gstinCheck = f.sellerGstin.trim() ? checkGstin(f.sellerGstin) : null;

  const pickPhoto = async (file) => {
    if (!file) return;
    setUpBusy(true); setUpErr(null);
    try { const d = await fileToData(file, 1600); const r = await call('uploadReceipt', d); set({ fileKey: r.file_key }); }
    catch (e) { setUpErr(e.message || t('err_generic')); } finally { setUpBusy(false); }
  };
  const submit = () => {
    if (problem) return;
    rememberAccount(f.accountId);
    save.run({
      kind: f.kind, category: f.kind === 'expense' ? f.category : undefined, amount: r2(amount), account_id: f.accountId, method: f.method || undefined,
      day: dayArg || undefined, paid_to: f.paidTo.trim() || undefined, note: f.note.trim() || undefined,
      gst_bill: f.gstBill || undefined, gst_amount: f.gstBill && f.gstAmount !== '' ? Number(f.gstAmount) : undefined,
      bill_no: f.gstBill ? f.billNo.trim() || undefined : undefined, seller_gstin: f.gstBill ? f.sellerGstin.trim() || undefined : undefined,
      supplier_id: f.kind === 'supplier' ? f.supplierId : undefined, purchase_ids: f.kind === 'supplier' && f.bills.length ? f.bills : undefined,
      file_key: f.fileKey || undefined, replaces_id: edit?.id || undefined,
    }, {
      // without internet: kept on the phone and sent later; the list shows it as "waiting to send"
      local: { meta: { expense: { kind: f.kind, category: f.kind === 'expense' ? f.category : f.kind === 'owner' ? 'home' : 'supplier', amount: r2(amount),
        day: dayArg || today, at: new Date().toISOString(), paid_to: f.paidTo.trim() || null, supplier: sup?.name || null, status: 'ok',
        account: (accounts || []).find((a) => a.id === f.accountId)?.name || '', is_drawer: !!(accounts || []).find((a) => a.id === f.accountId)?.is_drawer,
        replaces: edit?.id || null } } },
    }).then((r) => onDone?.(r)).catch(() => {});
  };

  return (
    <Sheet open={open} onClose={onClose} title={edit ? t('exp_change') : t('exp_add')}
      footer={<>
        {save.error && <div class="error" style="margin:0 0 8px">{save.error.message}</div>}
        <button class="btn btn-accent btn-block" disabled={!!problem || save.busy || upBusy} onClick={submit}>
          <Icon name="Check" size={20} stroke={2.6} />{save.busy ? '…' : problem && amount > 0 ? t(problem) : t('exp_save', amount > 0 ? money(amount) : '')}
        </button>
      </>}>
      {kinds.length > 1 && (
        <div class="seg exp-kinds" style="margin-bottom:14px">{kinds.map((k) => (
          <button class={f.kind === k ? 'on' : ''} disabled={!!edit} onClick={() => set({ kind: k, bills: [], supplierId: null })}>{t(`exp_k_${k}`)}</button>
        ))}</div>
      )}

      {f.kind === 'expense' && <>
        <div class="lbl">{t('exp_what')}</div>
        <div class="exp-cats">{EXPENSE_CATEGORIES.map((c) => (
          <button class={`exp-cat ${f.category === c.id ? 'on' : ''}`} onClick={() => set({ category: c.id })} aria-pressed={f.category === c.id}>
            <span class="exp-cat-ic" style={`background:${c.tone}`}><Icon name={c.icon} size={20} stroke={2.2} /></span>
            <span class="exp-cat-w">{t(c.word)}</span>
          </button>
        ))}</div>
      </>}

      {f.kind === 'supplier' && <>
        <div class="lbl">{t('exp_supplier')}</div>
        <select class="field" style="width:100%" value={f.supplierId || ''} onChange={(e) => set({ supplierId: e.currentTarget.value || null, bills: [] })}>
          <option value="">—</option>
          {suppliers.map((s) => <option value={s.id}>{s.name}{s.unpaid?.length ? ` · ${s.unpaid.length}` : ''}</option>)}
        </select>
        {sup && <>
          <div class="lbl" style="margin-top:14px">{t('exp_supplier_bills')}</div>
          {!sup.unpaid?.length ? <div class="muted" style="font-size:14px">{t('exp_supplier_none')}</div> : (
            <div class="card">{sup.unpaid.map((b) => {
              const on = f.bills.includes(b.id);
              return (
                <button class="li" onClick={() => set({ bills: on ? f.bills.filter((x) => x !== b.id) : [...f.bills, b.id] })}>
                  <span class={`acc-tick ${on ? 'on' : ''}`}>{on && <Icon name="Check" size={16} stroke={3} />}</span>
                  <span class="grow"><span class="t">{b.bill_no || '—'}</span><span class="s" style="display:block">{fmtDay(b.date)}</span></span>
                  <b class="num">{money(b.total)}</b>
                </button>
              );
            })}</div>
          )}
          {billsTotal > 0 && <div class="row" style="justify-content:space-between;margin-top:8px"><span class="muted" style="font-size:14px">{t('exp_bills_total', money(billsTotal))}</span>
            {billsTotal !== amount && <button class="link" onClick={() => set({ amount: String(billsTotal) })}>{t('exp_use_total', money(billsTotal))}</button>}</div>}
        </>}
      </>}
      {f.kind === 'owner' && <div class="notice tone-warn" style="font-size:13.5px">{t('exp_k_owner_s')}</div>}

      <div class="lbl" style="margin-top:16px">{t('exp_amount')}</div>
      <div class="field num exp-amount"><span class="faint">₹</span>
        <input inputmode="decimal" value={f.amount} placeholder="0" autofocus={!edit}
          onInput={(e) => set({ amount: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div>

      <div class="lbl" style="margin-top:16px">{t('exp_from')}</div>
      <AccountPick accounts={accounts} value={f.accountId} onChange={(id) => set({ accountId: id, method: null })} method={f.method} onMethod={(m) => set({ method: m })} />

      <div class="lbl" style="margin-top:16px">{t('exp_day')}</div>
      <div class="seg">
        <button class={f.day === 'today' ? 'on' : ''} onClick={() => set({ day: 'today' })}>{t('exp_today')}</button>
        <button class={f.day === 'yesterday' ? 'on' : ''} onClick={() => set({ day: 'yesterday' })}>{t('exp_yesterday')}</button>
        <button class={f.day === 'pick' ? 'on' : ''} onClick={() => set({ day: 'pick', date: f.date || addDays(today, -2) })}>{t('exp_pick_day')}</button>
      </div>
      {f.day === 'pick' && <div class="field" style="margin-top:8px"><Icon name="Calendar" size={18} />
        <input type="date" value={f.date} max={today} min={can('settings') ? addDays(today, -400) : addDays(today, -3)} onInput={(e) => set({ date: e.currentTarget.value })} /></div>}

      {!f.more ? (
        <button class="link" style="margin-top:12px" onClick={() => set({ more: true })}><Icon name="Plus" size={16} />{t('exp_more')}</button>
      ) : <>
        {f.kind !== 'supplier' && <>
          <div class="lbl" style="margin-top:16px">{t('exp_to')}</div>
          <div class="field"><input value={f.paidTo} maxLength={80} placeholder={t('exp_to_ph')} onInput={(e) => set({ paidTo: e.currentTarget.value })} /></div>
        </>}
        <div class="lbl" style="margin-top:14px">{t('exp_note')}</div>
        <div class="field"><input value={f.note} maxLength={300} placeholder={t('exp_note_ph')} onInput={(e) => set({ note: e.currentTarget.value })} /></div>

        {f.kind !== 'owner' && (
          <label class="row card pad" style="gap:12px;margin-top:14px">
            <div class="grow"><div style="font-weight:700">{t('exp_gst_bill')}</div><div class="muted" style="font-size:12.5px">{t('exp_gst_bill_s')}</div></div>
            <input type="checkbox" class="switch" checked={f.gstBill} onChange={(e) => set({ gstBill: e.currentTarget.checked })} />
          </label>
        )}
        {f.gstBill && <>
          <div class="row" style="gap:8px;margin-top:10px">
            <div class="grow"><div class="lbl">{t('exp_gst_amt')}</div>
              <div class="field num"><span class="faint">₹</span><input inputmode="decimal" value={f.gstAmount} onInput={(e) => set({ gstAmount: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div></div>
            <div style="width:42%"><div class="lbl">{t('exp_bill_no')}</div>
              <div class="field"><input value={f.billNo} maxLength={40} onInput={(e) => set({ billNo: e.currentTarget.value })} /></div></div>
          </div>
          {amount > 0 && <button class="link" onClick={() => set({ gstAmount: String(gstInside(amount)) })}>{t('exp_gst_18', money(gstInside(amount), true))}</button>}
          <div class="lbl" style="margin-top:8px">{t('exp_seller_gstin')}</div>
          <div class="field"><input value={f.sellerGstin} maxLength={15} autocapitalize="characters" spellcheck={false}
            onInput={(e) => set({ sellerGstin: e.currentTarget.value.toUpperCase().replace(/\s/g, '') })} />
            {gstinCheck && <Icon name={gstinCheck.ok ? 'CircleCheck' : 'CircleAlert'} size={18} style={`color:var(--${gstinCheck.ok ? 'ok' : 'bad'})`} />}</div>
          {gstinCheck?.ok && <div class="faint" style="font-size:12.5px;margin-top:4px">{gstinCheck.state}</div>}
        </>}

        <div class="lbl" style="margin-top:16px">{t('exp_photo')}</div>
        <input ref={photo} type="file" accept="image/*,application/pdf" capture="environment" hidden onChange={(e) => pickPhoto(e.currentTarget.files[0])} />
        <button class="btn btn-ghost btn-block" disabled={upBusy || !online.value} onClick={() => photo.current?.click()}>
          <Icon name={f.fileKey ? 'CircleCheck' : 'Camera'} size={19} />{upBusy ? '…' : f.fileKey ? t('exp_photo_on') : t('exp_photo_add')}
        </button>
        {!online.value && <div class="faint" style="font-size:12.5px;margin-top:4px">{t('off_needs_net')}</div>}
        {upErr && <div class="error">{upErr}</div>}
      </>}
      {f.kind === 'expense' && f.category && <div class="faint" style="font-size:12px;margin-top:12px;text-align:center"><Icon name={catOf(f.category).icon} size={13} /> {t(catOf(f.category).word)}</div>}
    </Sheet>
  );
}
