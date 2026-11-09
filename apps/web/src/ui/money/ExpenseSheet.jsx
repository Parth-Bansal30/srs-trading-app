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
import { addDays } from '../../lib/evening.js';
import { loadAccounts, accountsCache, lastOutAccount, rememberOutAccount, useCreditWarn } from '../../lib/accounts.js';
import { shopToday, catOf } from '../../lib/expenses.js';
import { fileToData } from '../../lib/files.js';
import { EXPENSE_CATEGORIES } from '../../config/options.js';
import { Icon } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';
import { AccountPick } from './AccountPick.jsx';
import { BillSplit } from '../stock/BillSplit.jsx';
import { AddSupplier } from '../stock/AddSupplier.jsx';
import './money.css';

const blank = () => ({ kind: 'expense', category: null, amount: '', accountId: null, accPicked: false, method: null, paidTo: '', note: '', day: 'today', date: '',
  gstBill: false, gstAmount: '', billNo: '', sellerGstin: '', fileKey: null, supplierId: null, bills: [], parts: [], more: false, chq: '' });
/** The account an expense starts with: the one used last for this kind of expense, else the cash drawer. */
const startAccount = (list, what) => (list || []).find((a) => a.id === lastOutAccount(what) && a.usable !== false) || (list || []).find((a) => a.is_drawer) || (list || [])[0];

/** Which kinds this person may enter. */
export const expenseKinds = () => [
  (can('expenses') || can('settings')) && 'expense',
  (can('stock') || can('settings')) && 'supplier',
  can('settings') && 'owner',
].filter(Boolean);

/**
 * open / onClose / onDone(result). edit: an expense from the list to change (it is replaced, the old one kept as cancelled).
 * suppliers: [{ id, name }] for "paid a supplier" (its open bills come from the supplier khata: BillSplit).
 * preset: { kind, supplierId, amount } to start with (the supplier khata's "Record payment").
 */
export function ExpenseSheet({ open, onClose, onDone, edit = null, suppliers = [], startKind = 'expense', preset = null }) {
  const [f, setF] = useState(blank());
  const [accounts, setAccounts] = useState(accountsCache.value);
  const credWarn = useCreditWarn(f.accountId, f.amount);   // OD / CC: past the limit? (owners, estimate)
  const [upBusy, setUpBusy] = useState(false);
  const [upErr, setUpErr] = useState(null);
  const [newSup, setNewSup] = useState(false);   // adding a new supplier right here (9 Nov 2026)
  const [added, setAdded] = useState([]);
  const [allCats, setAllCats] = useState(false);   // the 8 usual kinds first, the rest behind "More kinds" (26 Oct 2026)
  const save = useAction('saveExpense');
  const [why, setWhy] = useState(null);   // ₹2 lakh cash to a supplier was stopped: only the owner can record it, with what happened (F8)
  const chqAdd = useAction('chequeAdd');   // a supplier paid by cheque: its number goes in the cheque register (4 Nov 2026, F5)
  const photo = useRef(null);
  const amountIn = useRef(null);
  const kinds = expenseKinds();
  const today = shopToday();
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  useEffect(() => {
    if (!open) return;
    save.setError(null); setUpErr(null); setAllCats(false); setWhy(null); setNewSup(false);
    const base = blank();
    if (edit) {
      Object.assign(base, { kind: edit.kind, category: edit.category, amount: String(Number(edit.amount)), accountId: edit.account_id, method: edit.method || null,
        paidTo: edit.paid_to || '', note: edit.note || '', day: edit.day === today ? 'today' : edit.day === addDays(today, -1) ? 'yesterday' : 'pick', date: edit.day,
        gstBill: !!edit.gst_bill, gstAmount: edit.gst_amount == null ? '' : String(Number(edit.gst_amount)), billNo: edit.bill_no || '', sellerGstin: edit.seller_gstin || '',
        supplierId: edit.supplier_id || null, bills: edit.purchase_ids || [], more: !!(edit.gst_bill || edit.note || edit.paid_to) });
    } else if (kinds.includes(startKind)) base.kind = startKind;
    if (!edit && preset) Object.assign(base, preset.kind && kinds.includes(preset.kind) ? { kind: preset.kind } : {}, preset.supplierId ? { supplierId: preset.supplierId } : {},
      preset.amount ? { amount: String(preset.amount) } : {});
    setF(base);
    loadAccounts().then((l) => {
      setAccounts(l);
      setF((x) => (x.accountId && l.some((a) => a.id === x.accountId) ? x : { ...x, accountId: startAccount(l, x.kind === 'expense' ? x.category : x.kind)?.id || null }));
    }).catch(() => setAccounts(accountsCache.value || []));
  }, [open, edit?.id]);

  const amount = Number(f.amount) || 0;
  const allSup = [...added, ...suppliers.filter((s) => !added.some((x) => x.id === s.id))];
  const sup = allSup.find((s) => s.id === f.supplierId);
  const splitBad = f.kind === 'supplier' && (f.parts || []).reduce((a, x) => a + (Number(x.amount) || 0), 0) > amount + 0.005;
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
    if (problem || splitBad) return;
    rememberOutAccount(f.kind === 'expense' ? f.category : f.kind, f.accountId);
    save.run({
      kind: f.kind, category: f.kind === 'expense' ? f.category : undefined, amount: r2(amount), account_id: f.accountId, method: f.method || undefined,
      day: dayArg || undefined, paid_to: f.paidTo.trim() || undefined, note: f.note.trim() || undefined,
      gst_bill: f.gstBill || undefined, gst_amount: f.gstBill && f.gstAmount !== '' ? Number(f.gstAmount) : undefined,
      bill_no: f.gstBill ? f.billNo.trim() || undefined : undefined, seller_gstin: f.gstBill ? f.sellerGstin.trim() || undefined : undefined,
      supplier_id: f.kind === 'supplier' ? f.supplierId : undefined,
      allocations: f.kind === 'supplier' ? (f.parts || []).map((x) => ({ ...x, amount: Number(x.amount) })).filter((x) => x.amount > 0) : undefined,
      file_key: f.fileKey || undefined, replaces_id: edit?.id || undefined,
      cash_reason: why != null && why.trim().length >= 5 ? why.trim() : undefined,
    }, {
      // without internet: kept on the phone and sent later; the list shows it as "waiting to send"
      local: { meta: { expense: { kind: f.kind, category: f.kind === 'expense' ? f.category : f.kind === 'owner' ? 'home' : 'supplier', amount: r2(amount),
        day: dayArg || today, at: new Date().toISOString(), paid_to: f.paidTo.trim() || null, supplier: sup?.name || null, status: 'ok',
        account: (accounts || []).find((a) => a.id === f.accountId)?.name || '', is_drawer: !!(accounts || []).find((a) => a.id === f.accountId)?.is_drawer,
        replaces: edit?.id || null } } },
    }).then(async (r) => {
      const no = f.chq.trim();
      if (no && r?.expense_id && f.kind === 'supplier' && f.method === 'Cheque') {
        try { await chqAdd.run({ direction: 'out', number: no, amount: r2(amount), expense_id: r.expense_id }); } catch { /* the payment is saved; the cheque can be noted again */ }
      }
      onDone?.(r);
    }).catch(() => {});
  };

  return (
    <Sheet open={open} onClose={onClose} title={edit ? t('exp_change') : f.kind === 'supplier' ? t('sk_record_payment') : t('exp_add')}
      footer={<>
        {save.error && <div class="error" style="margin:0 0 8px">{save.error.message}</div>}
        {save.error?.code === 'cash_limit' && can('settings') && <div style="margin:0 0 8px">
          <label class="cash-taken" style="margin-top:0"><input type="checkbox" checked={why != null} onChange={(e) => setWhy(e.currentTarget.checked ? '' : null)} /><span>{t('cash_out_taken')}</span></label>
          {why != null && <><input class="textarea" style="margin-top:8px" value={why} onInput={(e) => setWhy(e.currentTarget.value)} placeholder={t('cash_reason_ph')} />
            <div class="faint" style="font-size:12px;font-weight:600;margin-top:4px">{t('cash_reason_s')}</div></>}
        </div>}
        <button class="btn btn-accent btn-block" disabled={!!problem || splitBad || save.busy || upBusy || (why != null && why.trim().length < 5)} onClick={submit}>
          <Icon name="Check" size={20} stroke={2.6} />{save.busy ? '…' : problem && amount > 0 ? t(problem) : t(f.kind === 'supplier' ? 'sk_pay_save' : 'exp_save', amount > 0 ? money(amount) : '')}
        </button>
      </>}>
      {kinds.length > 1 && (
        <div class="seg exp-kinds" style="margin-bottom:14px">{kinds.map((k) => (
          <button class={f.kind === k ? 'on' : ''} disabled={!!edit} onClick={() => set({ kind: k, bills: [], supplierId: null, ...(f.accPicked ? {} : { accountId: startAccount(accounts, k === 'expense' ? f.category : k)?.id || f.accountId }) })}>{t(`exp_k_${k}`)}</button>
        ))}</div>
      )}

      {f.kind === 'expense' && <>
        <div class="lbl">{t('exp_what')}</div>
        <div class="exp-cats">{EXPENSE_CATEGORIES.filter((c, k) => allCats || k < 8 || c.id === f.category).map((c) => (
          <button class={`exp-cat ${f.category === c.id ? 'on' : ''}`} aria-pressed={f.category === c.id}
            onClick={() => { set({ category: c.id, ...(f.accPicked || edit ? {} : { accountId: startAccount(accounts, c.id)?.id || f.accountId, method: null }) }); if (!f.amount) amountIn.current?.focus(); }}>
            <span class="exp-cat-ic" style={`background:${c.tone}`}><Icon name={c.icon} size={20} stroke={2.2} /></span>
            <span class="exp-cat-w">{t(c.word)}</span>
          </button>
        ))}
        {!allCats && <button class="exp-cat" onClick={() => setAllCats(true)}>
          <span class="exp-cat-ic" style="background:var(--ink-3)"><Icon name="ChevronDown" size={20} stroke={2.4} /></span>
          <span class="exp-cat-w">{t('exp_more_kinds')}</span></button>}</div>
      </>}

      {f.kind === 'supplier' && <>
        <div class="lbl">{t('exp_supplier')}</div>
        <select class="field" style="width:100%" value={f.supplierId || ''} onChange={(e) => set({ supplierId: e.currentTarget.value || null, bills: [], parts: [] })}>
          <option value="">—</option>
          {allSup.map((s) => <option value={s.id}>{s.name}{s.unpaid?.length ? ` · ${s.unpaid.length}` : ''}</option>)}
        </select>
        {/* a supplier not in the app yet: add it right here (9 Nov 2026) */}
        {!edit && !newSup && <button class="link" style="margin-top:6px" onClick={() => setNewSup(true)}><Icon name="Plus" size={15} stroke={2.4} style="vertical-align:-2px;margin-right:4px" />{t('ns_add_here')}</button>}
        {newSup && <AddSupplier suppliers={allSup} hint={f.paidTo} onCancel={() => setNewSup(false)}
          onUse={(x) => { set({ supplierId: x.id, bills: [], parts: [] }); setNewSup(false); }}
          onAdded={(x) => { setAdded((l) => [x, ...l]); set({ supplierId: x.id, bills: [], parts: [] }); setNewSup(false); }} />}
        {f.supplierId && <>
          <div class="lbl" style="margin-top:14px">{t('exp_supplier_bills')}</div>
          <BillSplit supplierId={f.supplierId} amount={amount} value={f.parts} onChange={(parts) => set({ parts })} editing={edit?.id || null} />
        </>}
      </>}
      {f.kind === 'owner' && <div class="notice tone-warn" style="font-size:13.5px">{t('exp_k_owner_s')}</div>}

      <div class="lbl" style="margin-top:16px">{t('exp_amount')}</div>
      <div class="field num exp-amount"><span class="faint">₹</span>
        <input ref={amountIn} inputmode="decimal" value={f.amount} placeholder="0" autofocus={!edit && f.kind !== 'expense'}
          onInput={(e) => set({ amount: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div>

      <div class="lbl" style="margin-top:16px">{t('exp_from')}</div>
      <AccountPick accounts={accounts} value={f.accountId} onChange={(id) => set({ accountId: id, accPicked: true, method: null })} method={f.method} onMethod={(m) => set({ method: m })} />
      {credWarn && <div class="notice tone-warn cr-warn">{credWarn}</div>}
      {f.kind === 'supplier' && f.method === 'Cheque' && !edit && <>
        <div class="lbl" style="margin-top:14px">{t('chq_number')}</div>
        <div class="field"><Icon name="ScrollText" size={16} style="color:var(--ink-3)" />
          <input class="num" inputmode="numeric" value={f.chq} maxLength={20} placeholder="118244" onInput={(e) => set({ chq: e.currentTarget.value.replace(/[^0-9A-Za-z/-]/g, '').toUpperCase() })} /></div>
        <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:6px">{t('chq_out_hint')}</div>
      </>}

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
