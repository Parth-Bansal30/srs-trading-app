// Join two customers (6 Nov 2026, plan v2 F9) — owner only, preview first, nothing moves until "Join".
// The old customer goes to ₹0 with a note, the kept one gets the same amounts; old slips and payments never move.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money } from '../../lib/format.js';
import { loadCatalog, forgetCatalog } from '../../lib/catalog.js';
import { avatarColour, firstLetter } from '../../lib/customers.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { Icon, Skeleton } from '../../ui/kit.jsx';
import { CustomerPicker } from '../order/CustomerPicker.jsx';
import './khata.css';

const SIDE_WORD = { pakka: 'bill_gst_short', kacha: 'bill_none_short' };
const sideAmt = (x) => (!x ? money(0, false) : x.due > 0 ? t('join_due_amt', money(x.due, false)) : x.adv > 0 ? t('join_with_us', money(x.adv, false)) : money(0, false));

function Who({ c, by, after, label, sides }) {
  return (
    <div class="card pad join-who">
      <div class="faint" style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.04em">{label}</div>
      <div class="row" style="gap:10px;margin-top:6px"><span class="cav sm" style={`background:${avatarColour(c.id)}`}>{firstLetter(c.name)}</span><b class="grow ellip">{c.name}</b></div>
      {sides.map((s) => (
        <div class="row join-side"><span class="grow">{t(SIDE_WORD[s])}</span><span class="num">{sideAmt(by?.[s])}</span>
          <Icon name="ArrowRight" size={14} /><b class="num">{sideAmt(after?.[s])}</b></div>
      ))}
    </div>
  );
}

export function JoinSheet({ open, c, onClose, onDone }) {
  const [other, setOther] = useState(null);
  const [keepThis, setKeepThis] = useState(true);
  const [picking, setPicking] = useState(false);
  const [list, setList] = useState([]);
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');
  const a = useAction('customerJoin');
  useEffect(() => {
    if (!open) return;
    setOther(null); setKeepThis(true); setP(null); setErr(null); setNote(''); a.setError(null);
    loadCatalog().then((x) => setList((x.customers || []).filter((y) => y.id !== c.id && !y.joined_into && y.active))).catch(() => setList([]));
    setPicking(true);
  }, [open]);
  const kept = other && (keepThis ? c : other);
  const old = other && (keepThis ? other : c);
  const load = () => { setP(null); setErr(null); call('customerJoinPreview', { kept_id: kept.id, old_id: old.id }).then(setP).catch((e) => setErr(e.message || t('err_generic'))); };
  useEffect(() => { if (open && other) load(); }, [other?.id, keepThis]);
  const sides = p ? [...new Set([...Object.keys(p.before.kept || {}), ...Object.keys(p.before.old || {})])].sort().reverse() : [];
  const blocked = p && p.open_slips.length > 0;
  const go_ = () => a.run({ kept_id: kept.id, old_id: old.id, stamp: p.stamp, moves: p.moves, note }).then((r) => { forgetCatalog(); onDone(r); })
    .catch((e) => { if (e.code === 'changed') load(); });
  return (
    <>
      <Sheet open={open && !picking} onClose={onClose} title={t('join_title')}
        footer={p && !blocked && <button class="btn btn-brand btn-block" disabled={a.busy} onClick={go_}><Icon name="GitMerge" size={18} />{t('join_confirm', old.name, kept.name)}</button>}>
        {!other ? <Skeleton h={80} /> : <>
          <div class="lbl">{t('join_keep_q')}</div>
          <div class="seg"><button class={keepThis ? 'on' : ''} onClick={() => setKeepThis(true)}>{c.name}</button>
            <button class={!keepThis ? 'on' : ''} onClick={() => setKeepThis(false)}>{other.name}</button></div>
          <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:6px">{t('join_keep_s', old.name, kept.name)}</div>
          <button class="link" style="margin-top:6px" onClick={() => setPicking(true)}><Icon name="UserSearch" size={15} />{t('join_change')}</button>
          {err && <div class="error">{err}</div>}
          {!p && !err && <Skeleton h={160} style="margin-top:12px" />}
          {p && <>
            {blocked && <div class="notice tone-bad" style="margin-top:12px;font-size:13.5px">{t('join_open', p.open_slips.map((x) => `#${x.slip_no}`).join(', '), old.name)}</div>}
            <div class="join-pair">
              <Who c={p.kept} by={p.before.kept} after={p.after.kept} label={t('join_keep_label')} sides={sides} />
              <Who c={p.old} by={p.before.old} after={p.after.old} label={t('join_old_label')} sides={sides} />
            </div>
            <div class="lbl" style="margin-top:12px">{t('join_moves')}</div>
            <div class="card pad" style="font-size:14px">
              {p.moves.length === 0 ? <div class="muted">{t('join_nothing')}</div> : p.moves.map((m) => (
                <div class="row" style="gap:8px;padding:3px 0"><Icon name={m.kind === 'due' ? 'ReceiptText' : 'IndianRupee'} size={15} />
                  <span>{t(m.kind === 'due' ? 'join_move_due' : 'join_move_credit', money(m.amount, false), t(SIDE_WORD[m.side]), kept.name)}</span></div>))}
              <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:8px">{t('join_how', old.name, kept.name)}</div>
            </div>
            <div class="lbl" style="margin-top:12px">{t('join_note')}</div>
            <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('join_note_ph')} maxLength={300} />
            {a.error && <div class="error">{a.error.message}</div>}
          </>}
        </>}
      </Sheet>
      <CustomerPicker open={open && picking} customers={list} title={t('join_pick', c.name)} noAdd
        onClose={() => { setPicking(false); if (!other) onClose(); }} onPick={(x) => { setOther(x); setPicking(false); }} />
    </>
  );
}
