// "To check" (4 Nov 2026, plan v2): ONE list for the owner / accountant of everything the app was not sure about —
// a possible double payment, a cash-rule case, maybe the same customer twice, a GST doubt, a cheque to match… Each card
// shows the facts it was raised with; a person answers it (who and when are kept). Nothing here changes money by itself:
// the buttons open the entry, where the real change (a cancel, a join, a match) is made and confirmed.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money, shortDate, time } from '../../lib/format.js';
import { modeText } from '../../lib/accounts.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import './review.css';

const KIND_ICON = { twin_payment: 'Copy', cash_limit: 'Banknote', cash_exception: 'ShieldAlert', cash_out: 'Banknote', cash_occasion: 'Banknote',
  maybe_same_customer: 'Users', gst_check: 'Percent', cheque: 'FileText', cheque_twice: 'ScrollText', paid_twice: 'Copy', direct_pending: 'Truck' };
const tz = () => company.value?.timezone;
const when = (iso) => (iso ? `${shortDate(iso, tz())} · ${time(iso, tz())}` : '');

/** The facts of one entry of a possible double payment. */
function TwinSide({ x }) {
  if (!x) return null;
  const how = [x.mode ? modeText(x.mode) : null, x.bank ? t('rv_from_bank') : null, x.kind && x.kind !== 'khata' ? t(`rv_pk_${x.kind}`) : null].filter(Boolean).join(' · ');
  return (
    <div class="rv-fact"><Icon name="CornerDownRight" size={15} />
      <div><b>{when(x.at)}</b> · {how}{x.by ? ` · ${x.by}` : ''}{x.offline && <span class="rv-tag">{t('rv_offline')}</span>}
        {x.note && <div class="faint">{x.note}</div>}</div>
    </div>
  );
}

function title(r) {
  const d = r.data || {};
  if (r.kind === 'twin_payment') return t('rv_twin_t', money(Number(d.amount), false), r.customer || '');
  return t(`rv_k_${r.kind}`) !== `rv_k_${r.kind}` ? t(`rv_k_${r.kind}`, r.customer || r.supplier || '') : r.kind;
}

function Card({ r, onAnswer }) {
  const d = r.data || {};
  return (
    <div class={`card rv-card ${r.level === 'important' && r.status === 'open' ? 'imp' : ''} ${r.status}`}>
      <div class="row" style="gap:10px;align-items:flex-start">
        <div class={`iconbox tone-${r.status === 'done' ? 'ok' : r.level === 'important' ? 'bad' : 'warn'}`}><Icon name={r.status === 'done' ? 'CircleCheck' : KIND_ICON[r.kind] || 'CircleHelp'} size={18} /></div>
        <div class="grow" style="min-width:0">
          <div class="t">{title(r)}</div>
          <div class="s">{t('rv_raised', when(r.created_at))}{r.level === 'important' && r.status === 'open' ? ` · ${t('rv_important')}` : ''}</div>
        </div>
      </div>
      {r.kind === 'twin_payment' && <div class="rv-facts"><TwinSide x={d.twin} /><TwinSide x={d.new} /><div class="faint rv-hint">{t('rv_twin_hint')}</div></div>}
      {d.text && <div class="rv-facts"><div class="rv-hint">{d.text}</div></div>}
      {r.answer && <div class="rv-answer"><Icon name="MessageSquareText" size={14} />{r.answer}{r.answered_by ? ` — ${r.answered_by}, ${when(r.answered_at)}` : ''}</div>}
      <div class="row rv-btns">
        {r.customer_id && <button class="btn btn-ghost" onClick={() => go(`/customer/${r.customer_id}`)}><Icon name="BookOpenText" size={16} />{t('rv_open_khata')}</button>}
        {r.kind === 'cheque_twice' && <button class="btn btn-ghost" onClick={() => go('/cheques')}><Icon name="ScrollText" size={16} />{t('nav_cheques')}</button>}
        {r.status === 'open' ? <button class="btn btn-brand" onClick={() => onAnswer(r)}><Icon name="Check" size={16} stroke={2.6} />{t('rv_checked')}</button>
          : <button class="btn btn-ghost" onClick={() => onAnswer(r, true)}><Icon name="Undo2" size={16} />{t('rv_reopen')}</button>}
      </div>
    </div>
  );
}

function AnswerSheet({ r, reopen, onClose, onDone }) {
  const [note, setNote] = useState('');
  const a = useAction('reviewAnswer');
  useEffect(() => { setNote(r?.kind === 'twin_payment' && !reopen ? t('rv_both_real') : ''); a.setError(null); }, [r?.id]);
  if (!r) return null;
  const ownerOnly = ['cash_exception', 'cash_limit', 'maybe_same_customer', 'paid_twice'].includes(r.kind);
  return (
    <Sheet open={!!r} onClose={onClose} title={reopen ? t('rv_reopen') : t('rv_checked')}
      footer={<button class="btn btn-brand btn-block" disabled={a.busy || !note.trim() || (ownerOnly && !can('settings'))}
        onClick={() => a.run({ id: r.id, status: reopen ? 'open' : 'done', answer: note }).then(() => { toast(t('rv_saved')); onDone(); }).catch(() => {})}>
        <Icon name="Check" size={18} stroke={2.6} />{t('save')}</button>}>
      <div class="muted" style="font-size:14px;margin-bottom:10px">{title(r)}</div>
      <div class="lbl">{t('rv_what_found')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('rv_answer_ph')} />
      {ownerOnly && !can('settings') && <div class="notice tone-warn" style="margin-top:10px;font-size:13px">{t('rv_owner_only')}</div>}
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

export function Review() {
  const [all, setAll] = useState(false);
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [ans, setAns] = useState(null);
  const load = () => call('reviewList', { all }).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!can('money')) { go('/'); return; } setD(null); load(); }, [all]);
  const items = (d?.items || []).filter((r) => (all ? true : r.status === 'open'));
  return (
    <>
      <TopBar title={t('rv_title')} sub={t('rv_sub')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        <div class="seg" style="margin-bottom:12px"><button class={!all ? 'on' : ''} onClick={() => setAll(false)}>{t('rv_tab_open')}{d ? ` · ${d.open}` : ''}</button>
          <button class={all ? 'on' : ''} onClick={() => setAll(true)}>{t('rv_tab_all')}</button></div>
        {err && <div class="error">{err}</div>}
        {!d && !err ? <><Skeleton h={130} /><Skeleton h={130} style="margin-top:10px" /></> : items.length === 0 ? (
          <div class="card li"><div class="iconbox tone-ok"><Icon name="CircleCheck" /></div><div class="grow"><div class="t">{t('rv_none')}</div><div class="s">{t('rv_none_s')}</div></div></div>
        ) : items.map((r) => <Card r={r} onAnswer={(x, reopen) => setAns({ r: x, reopen: !!reopen })} />)}
      </div>
      <AnswerSheet r={ans?.r} reopen={ans?.reopen} onClose={() => setAns(null)} onDone={() => { setAns(null); load(); }} />
    </>
  );
}
