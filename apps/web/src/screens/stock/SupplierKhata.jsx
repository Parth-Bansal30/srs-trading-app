// One supplier's khata (5 Nov 2026, plan v2 F6). Address: #/supplier/:id
// What we owe (opening + bills − payments − credit notes, worked out by @srs/core), which bills are still open (part paid,
// due dates, overdue), money with them that is not set against any bill, credit notes / returns, the statement line by
// line. "Record payment" opens the payment sheet with the bills to choose. The opening balance is the owner's.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { shopToday } from '../../lib/expenses.js';
import { forgetStock, kgTxt } from '../../lib/stock.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { ExpenseSheet } from '../../ui/money/ExpenseSheet.jsx';
import { BillSplit } from '../../ui/stock/BillSplit.jsx';
import './stock.css';
import '../money/money-screens.css';

const STATUS_TONE = { paid: 'ok', part: 'accent', to_pay: 'warn', outside: 'neutral' };
const LINE_WORD = { opening: 'sk_l_opening', bill: 'sk_l_bill', bill_outside: 'sk_l_bill_outside', payment: 'sk_l_payment', note_return: 'sk_l_return',
  note_rate: 'sk_l_rate', note_discount: 'sk_l_discount', note_other: 'sk_l_other' };

export function SupplierKhata({ id }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('bills');
  const [sheet, setSheet] = useState(null);   // pay | note | opening | days | split:<expense> | cancel:<note>
  const load = () => call('supplierKhata', { supplier_id: id }).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!can('stock') && !can('settings')) { go('/'); return; } load(); }, [id]);
  if (err) return <><TopBar title={t('nav_suppliers')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!d) return <><TopBar title={t('nav_suppliers')} /><div class="page"><Skeleton h={140} /><Skeleton h={240} style="margin-top:12px" /></div></>;
  const s = d.supplier;
  const open = d.bills.filter((b) => b.left > 0.5 && !b.outside);
  const done = d.bills.filter((b) => !(b.left > 0.5) || b.outside).slice().reverse();
  const freePays = d.payments.filter((p) => p.free > 0.5);
  const lines = d.lines.slice().reverse();
  const closeAnd = (word) => { setSheet(null); if (word) toast(t(word)); load(); };
  return (
    <>
      <TopBar title={s.name} sub={[s.gstin, s.city].filter(Boolean).join(' · ') || t('sup_no_gstin')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        <div class="card pad">
          <div class="faint" style="font-size:13px;font-weight:600">{d.due > 0 ? t('sk_we_owe') : d.advance > 0 ? t('sk_with_them') : t('all_clear')}</div>
          <div class="num" style={`font-size:34px;font-weight:800;letter-spacing:-.04em;margin:2px 0 8px;color:${d.due > 0 ? 'var(--bad)' : d.advance > 0 ? 'var(--ok)' : 'var(--ink)'}`}>{money(d.due > 0 ? d.due : d.advance, false)}</div>
          <div class="row" style="flex-wrap:wrap;gap:8px">
            {d.overdue > 0 && <Chip tone="bad">{t('sk_overdue_amt', money(d.overdue, false), d.overdue_n)}</Chip>}
            {open.length > 0 && <Chip tone="warn">{t('sk_open_n', open.length)}</Chip>}
            <button class="chip tone-neutral" onClick={() => setSheet('days')}><Icon name="CalendarDays" size={13} />{d.credit_days != null ? t('sk_credit_days', d.credit_days) : t('sk_set_days')}</button>
          </div>
          {d.free > 0.5 && d.due > 0 && <div class="notice tone-accent" style="font-size:13px;margin-top:10px">{t('sk_free_note', money(d.free, false))}</div>}
        </div>
        <button class="btn btn-brand btn-block" style="min-height:52px;margin-top:12px" onClick={() => setSheet('pay')}><Icon name="IndianRupee" size={18} stroke={2.4} />{t('sk_record_payment')}</button>
        <div class="row" style="margin-top:8px;gap:8px">
          <button class="btn btn-ghost grow" onClick={() => setSheet('note')}><Icon name="Undo2" size={17} />{t('sk_note_btn')}</button>
          {can('settings') && <button class="btn btn-ghost grow" onClick={() => setSheet('opening')}><Icon name="BookOpenText" size={16} />{(d.openings || []).length ? t('sk_opening_change') : t('sk_opening_add')}</button>}
        </div>

        <div class="seg" style="margin-top:14px">
          <button class={tab === 'bills' ? 'on' : ''} onClick={() => setTab('bills')}>{t('sk_tab_bills')}</button>
          <button class={tab === 'pays' ? 'on' : ''} onClick={() => setTab('pays')}>{t('sk_tab_pays')}</button>
          <button class={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>{t('sk_tab_statement')}</button>
        </div>

        {tab === 'bills' && <>
          <div class="sec"><h3>{t('sk_open_t')}</h3></div>
          <div class="card">
            {(d.openings || []).filter((o) => o.left > 0.5).map((o) => (
              <div class="li"><div class="iconbox tone-neutral"><Icon name="BookOpenText" size={18} /></div>
                <div class="grow"><div class="t">{t('sk_opening')}</div><div class="s">{fmtDay(o.date, false)}{o.overdue_days > 0 ? ` · ${t('sk_overdue_days', o.overdue_days)}` : ''}</div></div>
                <b class="num">{money(o.left, false)}</b></div>))}
            {open.length === 0 && !(d.openings || []).some((o) => o.left > 0.5) ? <div class="li muted">{t('sk_nothing_open')}</div> : open.slice().reverse().map((b) => <BillRow b={b} />)}
          </div>
          {done.length > 0 && <><div class="sec"><h3>{t('sk_done_t')}</h3></div><div class="card">{done.slice(0, 30).map((b) => <BillRow b={b} />)}</div></>}
          {(d.notes || []).length > 0 && <><div class="sec"><h3>{t('sk_notes_t')}</h3></div><div class="card">{d.notes.slice().reverse().map((n) => (
            <div class="li"><div class="iconbox tone-ok"><Icon name={n.kind === 'return' ? 'PackageMinus' : 'Percent'} size={18} /></div>
              <div class="grow"><div class="t">{t(`sk_k_${n.kind}`)}{n.note_no ? ` · ${n.note_no}` : ''}</div>
                <div class="s">{fmtDay(n.date, false)}{n.kg ? ` · ${kgTxt(Number(n.kg))}` : ''}{n.purchase_id ? ` · ${t('sk_on_bill', d.bills.find((b) => b.id === n.purchase_id)?.bill_no || '')}` : ''}{n.note ? ` · ${n.note}` : ''}</div></div>
              <div style="text-align:right"><b class="num" style="color:var(--ok)">− {money(Number(n.amount), false)}</b>
                <button class="link" style="min-height:0;font-size:12.5px;color:var(--bad)" onClick={() => setSheet(`cancel:${n.id}`)}>{t('sk_cancel_note')}</button></div></div>))}</div></>}
        </>}

        {tab === 'pays' && <>
          {freePays.length > 0 && <div class="notice tone-accent" style="font-size:13.5px;margin-top:12px">{t('sk_free_pays', money(freePays.reduce((x, p) => x + p.free, 0), false))}</div>}
          <div class="card" style="margin-top:12px">{d.payments.length === 0 ? <div class="li muted">{t('sk_no_pays')}</div> : d.payments.slice().reverse().map((p) => (
            <div class="li">
              <div class="iconbox tone-bad"><Icon name="BanknoteArrowUp" size={18} /></div>
              <div class="grow" style="min-width:0"><div class="t">{fmtDay(p.day, false)}{p.method ? ` · ${p.method === 'Cheque' ? t('pm_cheque') : p.method}` : ''}{p.cheque ? ` ${p.cheque}` : ''}</div>
                <div class="s ellip">{[p.account, p.free > 0.5 ? t('sk_pay_free', money(p.free, false)) : t('sk_pay_set'), p.note].filter(Boolean).join(' · ')}</div></div>
              <div style="text-align:right"><b class="num">{money(p.amount, false)}</b>
                <button class="link" style="min-height:0;font-size:12.5px" onClick={() => setSheet(`split:${p.id}`)}>{t('sk_set_bills')}</button></div>
            </div>))}</div>
        </>}

        {tab === 'all' && <>
          <div class="card" style="margin-top:12px">{lines.length === 0 ? <div class="li muted">{t('sk_no_lines')}</div> : lines.map((l) => (
            <div class="li sk-line">
              <div class="grow" style="min-width:0"><div class="t">{t(LINE_WORD[l.kind] || 'sk_l_other')}{l.ref ? ` · ${l.ref}` : ''}</div><div class="s">{fmtDay(l.date)}</div></div>
              <div style="text-align:right">
                <div class="num" style={`font-weight:700;color:${l.plus > 0 ? 'var(--bad)' : l.minus > 0 ? 'var(--ok)' : 'var(--ink-3)'}`}>{l.plus > 0 ? `+ ${money(l.plus, false)}` : l.minus > 0 ? `− ${money(l.minus, false)}` : money(0, false)}</div>
                <div class="s num">{t('sk_balance', money(Math.abs(l.balance), false))}{l.balance < 0 ? ` ${t('sk_adv_short')}` : ''}</div>
              </div>
            </div>))}</div>
          <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:8px">{t('sk_statement_s')}</div>
        </>}
      </div>

      <ExpenseSheet open={sheet === 'pay'} startKind="supplier" preset={{ kind: 'supplier', supplierId: s.id }} suppliers={[{ id: s.id, name: s.name }]}
        onClose={() => setSheet(null)} onDone={() => closeAnd('sk_pay_saved')} />
      {sheet === 'note' && <NoteSheet d={d} onClose={() => setSheet(null)} onDone={() => { forgetStock(); closeAnd('sk_note_saved'); }} />}
      {sheet === 'opening' && <OpeningSheet d={d} onClose={() => setSheet(null)} onDone={() => closeAnd('done_ok')} />}
      {sheet === 'days' && <DaysSheet d={d} onClose={() => setSheet(null)} onDone={() => closeAnd('done_ok')} />}
      {sheet?.startsWith('split:') && <SplitSheet d={d} pay={d.payments.find((p) => `split:${p.id}` === sheet)} onClose={() => setSheet(null)} onDone={() => closeAnd('done_ok')} />}
      {sheet?.startsWith('cancel:') && <CancelNoteSheet id={sheet.slice(7)} onClose={() => setSheet(null)} onDone={() => { forgetStock(); closeAnd('done_ok'); }} />}
    </>
  );
}

function BillRow({ b }) {
  return (
    <button class="li" onClick={() => go(`/purchase/${b.id}`)}>
      <div class={`iconbox tone-${STATUS_TONE[b.status]}`}><Icon name={b.status === 'paid' ? 'CircleCheck' : b.outside ? 'FileCheck2' : 'ReceiptText'} size={18} /></div>
      <div class="grow" style="min-width:0">
        <div class="t ellip">{b.bill_no || '—'}{b.side === 'kacha' ? ` · ${t('bill_none_short')}` : ''}</div>
        <div class="s">{fmtDay(b.date, false)}{b.due_date && b.left > 0.5 ? ` · ${t('sk_due_on', fmtDay(b.due_date, false))}` : ''}{b.overdue_days > 0 ? <b style="color:var(--bad)"> · {t('sk_overdue_days', b.overdue_days)}</b> : ''}</div>
      </div>
      <div style="text-align:right">
        <b class="num">{money(b.status === 'part' || b.status === 'to_pay' ? b.left : b.total, false)}</b>
        <div><Chip tone={STATUS_TONE[b.status]}>{b.status === 'part' ? t('sk_part', money(b.total, false)) : t(`sk_st_${b.status}`)}</Chip></div>
      </div>
    </button>
  );
}

/** Set an existing payment against bills again (the old split is kept, undone). */
function SplitSheet({ d, pay, onClose, onDone }) {
  const [parts, setParts] = useState([]);
  const a = useAction('supplierAllocate');
  if (!pay) return null;
  const used = parts.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  return (
    <Sheet open onClose={onClose} title={t('sk_split_t', money(pay.amount, false))}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy || used > pay.amount + 0.005} onClick={() => a.run({ expense_id: pay.id, allocations: parts.map((x) => ({ ...x, amount: Number(x.amount) })).filter((x) => x.amount > 0) }).then(onDone).catch(() => {})}>
        <Icon name="Check" size={18} stroke={2.6} />{t('save')}</button>}>
      <div class="muted" style="font-size:13.5px;margin-bottom:10px">{fmtDay(pay.day)} · {pay.account}</div>
      <BillSplit supplierId={d.supplier.id} amount={pay.amount} value={parts} onChange={setParts} editing={pay.id} />
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

/** A credit note: goods sent back (with the steel and kg — it leaves the stock), a rate difference, a discount. */
function NoteSheet({ d, onClose, onDone }) {
  const [kind, setKind] = useState('return');
  const [bill, setBill] = useState(null);
  const [amt, setAmt] = useState('');
  const [no, setNo] = useState('');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState([]);     // the bill's steel: [{ stock_item_id, label, kg }]
  const [kgs, setKgs] = useState({});
  const a = useAction('supplierNote');
  const open = d.bills.filter((b) => !b.outside).slice().reverse().slice(0, 20);
  useEffect(() => { setLines([]); setKgs({}); if (bill) call('purchase', { id: bill }).then((x) => setLines((x.lines || []).map((l) => ({ stock_item_id: l.stock_item_id, label: `${l.code} · ${l.description}`, on_hand: l.on_hand })))).catch(() => {}); }, [bill]);
  const picked = Object.entries(kgs).filter(([, v]) => Number(v) > 0).map(([k, v]) => ({ stock_item_id: k, kg: Number(v) }));
  const ok = Number(amt) > 0 && (kind !== 'return' || picked.length > 0);
  const b = d.bills.find((x) => x.id === bill);
  return (
    <Sheet open onClose={onClose} title={t('sk_note_t')}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy || !ok} onClick={() => a.run({ supplier_id: d.supplier.id, kind, purchase_id: bill, side: b?.side || 'pakka', amount: Number(amt), note_no: no || null, note: note || null, lines: kind === 'return' ? picked : [] }).then(onDone).catch(() => {})}>
        <Icon name="Check" size={18} stroke={2.6} />{t('sk_note_save', Number(amt) > 0 ? money(Number(amt), false) : '')}</button>}>
      <div class="bk-kinds">{['return', 'rate', 'discount', 'other'].map((k) => <button class={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{t(`sk_k_${k}`)}</button>)}</div>
      <div class="lbl" style="margin-top:14px">{t('sk_note_bill')}</div>
      <select class="field" style="width:100%" value={bill || ''} onChange={(e) => setBill(e.currentTarget.value || null)}>
        <option value="">{t('sk_note_no_bill')}</option>
        {open.map((x) => <option value={x.id}>{x.bill_no || '—'} · {fmtDay(x.date, false)} · {money(x.total, false)}</option>)}
      </select>
      {kind === 'return' && <>
        <div class="lbl" style="margin-top:14px">{t('sk_note_steel')}</div>
        {!bill ? <div class="muted" style="font-size:13.5px">{t('sk_note_pick_bill')}</div> : <div class="card">{lines.map((l) => (
          <div class="li"><div class="grow" style="min-width:0"><div class="t ellip">{l.label}</div><div class="s">{t('st_on_hand')} {kgTxt(l.on_hand)}</div></div>
            <div class="field" style="width:110px"><input inputmode="decimal" placeholder="kg" value={kgs[l.stock_item_id] || ''} onInput={(e) => setKgs({ ...kgs, [l.stock_item_id]: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div></div>))}</div>}
      </>}
      <div class="row" style="gap:10px;margin-top:14px">
        <div class="grow"><div class="lbl">{t('sk_note_amount')}</div><div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div></div>
        <div class="grow"><div class="lbl">{t('sk_note_no')}</div><div class="field"><input value={no} maxLength={40} onInput={(e) => setNo(e.currentTarget.value)} placeholder="CN-14" /></div></div>
      </div>
      <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      <div class="notice tone-accent" style="font-size:13px;margin-top:12px">{kind === 'return' ? t('sk_note_eff_return') : t('sk_note_eff')}</div>
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

function CancelNoteSheet({ id, onClose, onDone }) {
  const [why, setWhy] = useState('');
  const a = useAction('supplierNoteCancel');
  return (
    <Sheet open onClose={onClose} title={t('sk_cancel_note')}
      footer={<button class="btn btn-block" style="background:var(--bad);color:#fff" disabled={a.busy || !why.trim()} onClick={() => a.run({ id, reason: why }).then(onDone).catch(() => {})}><Icon name="Ban" size={18} />{t('sk_cancel_note')}</button>}>
      <div class="muted" style="font-size:14px;margin-bottom:10px">{t('sk_cancel_note_s')}</div>
      <input class="textarea" autofocus value={why} onInput={(e) => setWhy(e.currentTarget.value)} placeholder={t('pc_reason_ph')} />
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

/** Owner: the opening balance (what was owed before the app), per bill kind. */
function OpeningSheet({ d, onClose, onDone }) {
  const cur = (side) => (d.openings || []).find((o) => o.side === side);
  const [side, setSide] = useState('pakka');
  const [dir, setDir] = useState(cur('pakka')?.direction || 'owe');
  const [amt, setAmt] = useState(cur('pakka') ? String(cur('pakka').amount) : '');
  const [note, setNote] = useState('');
  const a = useAction('supplierOpening');
  useEffect(() => { const o = cur(side); setDir(o?.direction || 'owe'); setAmt(o ? String(o.amount) : ''); }, [side]);
  return (
    <Sheet open onClose={onClose} title={t('sk_opening_t')}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy || amt === ''} onClick={() => a.run({ supplier_id: d.supplier.id, side, direction: dir, amount: Number(amt) || 0, note: note || null }).then(onDone).catch(() => {})}>
        <Icon name="Check" size={18} stroke={2.6} />{t('save')}</button>}>
      <div class="muted" style="font-size:13.5px;margin-bottom:12px">{t('sk_opening_s')}</div>
      {can('kacha') && <div class="seg" style="margin-bottom:12px"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}</button></div>}
      <div class="seg"><button class={dir === 'owe' ? 'on' : ''} onClick={() => setDir('owe')}>{t('sk_dir_owe')}</button><button class={dir === 'credit' ? 'on' : ''} onClick={() => setDir('credit')}>{t('sk_dir_credit')}</button></div>
      <div class="lbl" style="margin-top:14px">{t('amount')}</div>
      <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
      <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('sk_opening_ph')} />
      {cur(side) && <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:10px">{t('sk_opening_now', money(cur(side).amount, false), fmtDay(cur(side).date))}</div>}
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

function DaysSheet({ d, onClose, onDone }) {
  const [days, setDays] = useState(d.credit_days == null ? '' : String(d.credit_days));
  const a = useAction('supplierSettings');
  const today = shopToday();
  return (
    <Sheet open onClose={onClose} title={t('sk_days_t')}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy} onClick={() => a.run({ supplier_id: d.supplier.id, credit_days: days === '' ? null : Number(days) }).then(onDone).catch(() => {})}><Icon name="Check" size={18} stroke={2.6} />{t('save')}</button>}>
      <div class="muted" style="font-size:13.5px;margin-bottom:12px">{t('sk_days_s')}</div>
      <div class="chq-banks">{[0, 7, 15, 30, 45, 60, 90].map((n) => <button class={days === String(n) ? 'on' : ''} onClick={() => setDays(String(n))}>{n}</button>)}</div>
      <div class="field" style="margin-top:10px"><input inputmode="numeric" value={days} onInput={(e) => setDays(e.currentTarget.value.replace(/\D/g, '').slice(0, 3))} placeholder={t('sk_days_ph')} /></div>
      {days !== '' && <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:8px">{t('sk_days_eg', fmtDay(today, false), days)}</div>}
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}
