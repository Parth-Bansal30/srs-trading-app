// One customer's account: how much, how old, every slip and payment — record a payment, remind, old balances.
import { useEffect, useState } from 'preact/hooks';
import { whatsappLink } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money, shortDate } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { PAY_METHODS } from '../../config/options.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { ReminderSheet } from './Reminders.jsx';
import { daysSince } from './Khata.jsx';
import './khata.css';

const KIND_WORD = { advance: 'kind_adv', pickup: 'kind_pick', khata: 'kind_khata', refund: 'kind_refund', transfer: 'kind_transfer' };

export function Customer({ id }) {
  const [r, setR] = useState(undefined);
  const [sheet, setSheet] = useState(null); // pay | remind | old
  const tz = company.value?.timezone;
  const load = () => call('khata', { customer_id: id }).then(([x]) => setR(x || null)).catch(() => setR(null));
  useEffect(() => { load(); }, [id]);
  if (r === undefined) return <><TopBar title="…" /><div class="page"><Skeleton h={140} /><Skeleton h={220} style="margin-top:12px" /></div></>;
  if (r === null) return <><TopBar title={t('nav_khata')} /><div class="page muted">{t('err_generic')}</div></>;

  const c = r.customer;
  const sides = Object.keys(r.by_side || {});
  const days = r.oldest ? daysSince(r.oldest, tz) : 0;
  const pak = r.by_side?.pakka?.due || 0; const kac = r.by_side?.kacha?.due || 0;
  const entries = [...(r.entries || [])].reverse();

  return (
    <>
      <TopBar title={c.name} sub={c.phone || t('no_phone')}
        right={c.phone && <a class="round" href={`tel:${c.phone.replace(/\s/g, '')}`} aria-label={t('phone')}><Icon name="Phone" size={18} /></a>} />
      <div class="page">
        <div class="card pad">
          <div class="faint" style="font-size:13px;font-weight:600">{r.due > 0 ? t('to_receive_cap') : r.credit > 0 ? t('advance_held') : t('all_clear')}</div>
          <div class="num" style="font-size:36px;font-weight:800;letter-spacing:-.04em;margin:2px 0 10px">{money(r.due > 0 ? r.due : r.credit, false)}</div>
          {sides.length > 1 && r.due > 0 && (
            <>
              <div class="split"><div style={`flex:${pak || 0.001};background:var(--pakka)`} /><div style={`flex:${kac || 0.001};background:var(--kacha)`} /></div>
              <div class="row" style="justify-content:space-between;font-size:13px;font-weight:600;margin-top:8px">
                <span style="color:var(--pakka)">● {t('gst_bills')} {money(pak, false)}</span><span style="color:var(--kacha)">● {t('no_bills')} {money(kac, false)}</span>
              </div>
            </>
          )}
          <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:12px">
            {r.due > 0 && <Chip tone={days >= 30 ? 'bad' : days >= 10 ? 'warn' : 'ok'}>{t('oldest_days_chip', days)}</Chip>}
            {r.credit > 0 && r.due > 0 && <Chip tone="ok">{t('credit_chip', money(r.credit, false))}</Chip>}
            {r.pending_advance > 0 && <Chip tone="neutral">{t('pending_adv')} {money(r.pending_advance, false)}</Chip>}
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          {can('khata') && <button class="btn btn-brand grow" style="min-height:50px;font-size:15px" onClick={() => setSheet('pay')}><Icon name="IndianRupee" size={18} stroke={2.4} />{t('record_payment')}</button>}
          {can('khata') && r.due > 0 && <button class="btn btn-ghost" style="min-height:50px;font-size:15px;color:var(--bad)" onClick={() => setSheet('remind')}><Icon name="BellRing" size={18} />{t('remind')}</button>}
        </div>

        <div class="sec"><h3>{t('account_title')}</h3>{can('khata') && <button class="link" onClick={() => setSheet('old')}><Icon name="Plus" size={15} stroke={2.4} />{t('add_old')}</button>}</div>
        <div class="card">
          {entries.length === 0 ? <div class="li muted">{t('all_clear')}</div> : entries.map((e) => e.t === 'bill' ? (
            <button class="li" onClick={() => !e.old && go(`/slip/${e.oid}`)}>
              <div class={`iconbox tone-${e.side}`}><Icon name={e.old ? 'BookOpenText' : 'ReceiptText'} size={18} /></div>
              <div class="grow"><div class="t num">{e.old ? (e.ref ? t('old_slip', e.ref) : t('old_balance')) : `${t('slip')} #${r.slips?.[e.oid] ?? ''}`}</div>
                <div class="s">{shortDate(e.date, tz)} · {t(e.side === 'pakka' ? 'bill_gst_short' : 'bill_none_short')}</div></div>
              <div style="text-align:right"><div class="num" style="font-weight:700">{money(e.amt)}</div>
                {e.rem > 0 ? <Chip tone={e.paid > 0 ? 'accent' : 'warn'}>{e.paid > 0 ? t('due_left', money(e.rem)) : t('s_unpaid')}</Chip> : <Chip tone="ok">{t('s_paid')}</Chip>}</div>
            </button>
          ) : (
            <div class="li" style={e.pending ? 'opacity:.7' : ''}>
              <div class={`iconbox tone-${e.amt < 0 ? 'bad' : 'ok'}`}><Icon name={PAY_METHODS.find((m) => m.id === e.mode)?.icon || 'RefreshCw'} size={18} /></div>
              <div class="grow"><div class="t">{e.pending ? t('pending_adv') : t(KIND_WORD[e.kind] || 'payment')}{e.mode && e.mode !== 'Adjust' ? ` · ${e.mode}` : ''}</div>
                <div class="s ellip">{shortDate(e.date, tz)}{e.oid && r.slips?.[e.oid] ? ` · #${r.slips[e.oid]}` : ''}{e.note ? ` · ${e.note}` : ''}</div></div>
              <div class="num" style={`font-weight:700;color:${e.amt < 0 ? 'var(--bad)' : 'var(--ok)'}`}>{e.amt < 0 ? money(-e.amt) : `− ${money(e.amt)}`}</div>
            </div>
          ))}
        </div>
      </div>

      <PaySheet open={sheet === 'pay'} c={c} sides={sides} onClose={() => setSheet(null)} onDone={(amt) => { setSheet(null); toast(t('pay_saved', money(amt))); load(); }} />
      <OldDueSheet open={sheet === 'old'} c={c} sides={sides} onClose={() => setSheet(null)} onDone={() => { setSheet(null); toast(t('done_ok')); load(); }} />
      {sheet === 'remind' && <ReminderSheet customer={c} side={kac > 0 && (!pak || kac >= pak) ? 'kacha' : 'pakka'} sides={sides.filter((s) => r.by_side[s].due > 0)} onClose={() => setSheet(null)} onSent={() => { setSheet(null); load(); }} />}
    </>
  );
}

function SideSeg({ sides, side, setSide }) {
  if (sides.length < 2) return null;
  return <><div class="lbl" style="margin-top:14px">{t('which_account')}</div>
    <div class="seg"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}</button></div></>;
}

function PaySheet({ open, c, sides, onClose, onDone }) {
  const [amt, setAmt] = useState(''); const [mode, setMode] = useState('Cash'); const [note, setNote] = useState(''); const [side, setSide] = useState('pakka');
  const a = useAction('recordPayment');
  return (
    <Sheet open={open} onClose={onClose} title={t('add_payment')}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy || !(Number(amt) > 0)} onClick={() => a.run({ customer_id: c.id, amount: Number(amt), mode, side, note }).then(() => onDone(amt)).catch(() => {})}>{t('record_payment')} {Number(amt) > 0 ? money(amt) : ''}</button>}>
      <div class="lbl">{t('amount')}</div>
      <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
      <SideSeg sides={sides} side={side} setSide={setSide} />
      <div class="lbl" style="margin-top:14px">{t('how_paid')}</div>
      <div class="pick">{PAY_METHODS.map((p) => <button class={mode === p.id ? 'on' : ''} onClick={() => setMode(p.id)}><Icon name={p.icon} size={18} />{t(p.word)}</button>)}</div>
      <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('pay_note_ph')} />
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

function OldDueSheet({ open, c, sides, onClose, onDone }) {
  const today = new Date().toISOString().slice(0, 10);
  const [kind, setKind] = useState('lump'); const [amt, setAmt] = useState(''); const [ref, setRef] = useState('');
  const [date, setDate] = useState(today); const [side, setSide] = useState('pakka'); const [note, setNote] = useState('');
  const a = useAction('addOldDue');
  const ok = Number(amt) > 0 && date && (kind === 'lump' || ref.trim());
  return (
    <Sheet open={open} onClose={onClose} title={t('add_old')}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !ok} onClick={() => a.run({ customer_id: c.id, side, ref: kind === 'slip' ? ref : null, date, amount: Number(amt), note }).then(() => { setAmt(''); setRef(''); onDone(); }).catch(() => {})}>{t('add_old')} {Number(amt) > 0 ? money(amt) : ''}</button>}>
      <div class="muted" style="margin-bottom:12px">{t('add_old_s')}</div>
      <div class="seg"><button class={kind === 'lump' ? 'on' : ''} onClick={() => setKind('lump')}>{t('old_lump')}</button><button class={kind === 'slip' ? 'on' : ''} onClick={() => setKind('slip')}>{t('old_by_slip')}</button></div>
      {kind === 'slip' && <><div class="lbl" style="margin-top:14px">{t('old_slip_no')}</div><div class="field"><input value={ref} onInput={(e) => setRef(e.currentTarget.value)} placeholder="553" /></div></>}
      <div class="row" style="margin-top:14px;gap:10px">
        <div class="grow"><div class="lbl">{t('amount')}</div><div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div></div>
        <div class="grow"><div class="lbl">{t('old_date')}</div><div class="field"><input type="date" max={today} value={date} onInput={(e) => setDate(e.currentTarget.value)} /></div></div>
      </div>
      <SideSeg sides={sides} side={side} setSide={setSide} />
      <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}
