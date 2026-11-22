// #/gst-bills — every GST slip of a month with its Tally bill (22 Nov 2026). The CA makes the GST bills in Tally; here
// each GST slip gets that bill's no., date and total, one after another ("Save & next", the next no. suggested), so the
// app and Tally always match. Tabs: Waiting · Check (Tally total differs, where it went unknown, address needed) ·
// Done · Deleted (a GST slip deleted after its bill — the CA cancels the bill or makes a credit note).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go, route } from '../../lib/router.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { TallySheet, TallyCancelSheet } from '../../ui/gst/TallySheet.jsx';
import { monthsBack, monthName, MonthChips } from './months.jsx';
import '../../ui/gst/gst.css';

const TABS = ['waiting', 'check', 'done', 'deleted'];
const inTab = (b, tab) => {
  if (tab === 'deleted') return b.deleted;
  if (b.deleted || !b.in_month) return false;
  if (tab === 'waiting') return b.state === 'waiting';
  if (tab === 'check') return b.state === 'differs' || !b.pos_sure || b.b2c_details;
  return b.state === 'done';
};
const tagOf = (b) => (b.table === 'b2b' ? null : b.table === 'b2cl' ? 'gbl_b2cl' : 'gbl_b2cs');

export function GstBills() {
  const months = monthsBack(12);
  const q = route.value.query;
  const asked = /^\d{4}-\d{2}$/.test(q.month || '') && q.month <= months[0] ? q.month : null;
  const [month, setMonth] = useState(asked || months[0]);
  const [tab, setTab] = useState(TABS.includes(q.tab) ? q.tab : 'waiting');
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [find, setFind] = useState('');
  const [open, setOpen] = useState(null);       // { bill, kind: 'tally' | 'cancel' }
  const [suggest, setSuggest] = useState(null);
  const load = () => call('gstBills', { month }).then((x) => { setD(x); setErr(null); setSuggest((s) => s || x.next_tally); return x; })
    .catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!can('khata') || !can('money')) { go('/'); return; } setD(null); setSuggest(null); load(); }, [month]);

  const list = useMemo(() => {
    const f = find.trim().toLowerCase();
    return (d?.bills || []).filter((b) => inTab(b, tab))
      .filter((b) => !f || String(b.slip_no).includes(f) || (b.customer || '').toLowerCase().includes(f) || (b.tally_no || '').toLowerCase().includes(f));
  }, [d, tab, find]);
  const count = (x) => (d?.bills || []).filter((b) => inTab(b, x)).length;
  const prevMonth = months[months.indexOf(month) + 1];

  const openBill = (b) => setOpen({ bill: b, kind: b.deleted ? 'cancel' : 'tally' });
  // after "Save & next": the next bill below it in the list on screen that still waits opens, the next no. suggested
  const next = async (saved) => {
    if (saved.next) setSuggest(saved.next);
    const cur = open?.bill?.id;
    const order = list.map((b) => b.id);
    const at = order.indexOf(cur);
    const after = at < 0 ? order : [...order.slice(at + 1), ...order.slice(0, at)];
    const fresh = await load();
    const waiting = new Map((fresh?.bills || []).filter((b) => inTab(b, 'waiting')).map((b) => [b.id, b]));
    const id = after.find((x) => x !== cur && waiting.has(x));
    setOpen(id ? { bill: waiting.get(id), kind: 'tally' } : null);
  };

  return (
    <>
      <TopBar title={t('gbl_title')} sub={t('gbl_sub')} right={<button class="round" aria-label={t('gbl_for_ca')} onClick={() => go(`/ca?month=${month}`)}><Icon name="FileSpreadsheet" size={20} /></button>} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        <MonthChips months={months} month={month} onPick={setMonth} />
        {d?.waiting_before > 0 && (
          <div class="notice tone-warn row" style="margin-top:12px;gap:8px;align-items:center;font-size:13.5px">
            <Icon name="FileClock" size={18} /><span class="grow">{t('gbl_before', d.waiting_before)}</span>
            {prevMonth && <button class="link" style="min-height:0" onClick={() => { setMonth(prevMonth); setTab('waiting'); }}>{t('gbl_before_go')}</button>}
          </div>)}
        <div class="seg" style="margin:12px 0 10px">
          {TABS.map((x) => <button class={tab === x ? 'on' : ''} onClick={() => setTab(x)}>{t(`gbl_tab_${x}`)}{d ? ` · ${count(x)}` : ''}</button>)}
        </div>
        <div class="field" style="margin-bottom:10px"><Icon name="Search" size={18} /><input value={find} onInput={(e) => setFind(e.currentTarget.value)} placeholder={t('gbl_search')} /></div>
        {err && <div class="error">{err}</div>}
        {!d && !err ? <Skeleton h={260} /> : d && (
          <div class="card" style="padding:0">
            {list.length === 0 ? <div class="li muted">{tab === 'waiting' && !find ? t('gbl_none_waiting', monthName(month)) : t('gbl_none')}</div>
              : list.map((b) => <Row b={b} onOpen={() => openBill(b)} />)}
          </div>)}
      </div>
      <TallySheet open={open?.kind === 'tally'} bill={open?.kind === 'tally' ? open.bill : null} suggest={suggest}
        onClose={() => setOpen(null)} onDone={(s) => { if (s.next) setSuggest(s.next); setOpen(null); load(); }}
        onNext={open?.bill && !open.bill.tally_no ? next : null} />
      <TallyCancelSheet open={open?.kind === 'cancel'} bill={open?.kind === 'cancel' ? open.bill : null} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); }} />
    </>
  );
}

function Row({ b, onOpen }) {
  const tag = tagOf(b);
  let right;
  if (b.deleted) right = <span class={`tn ${b.cancel_done ? '' : 'add'}`}>{b.cancel_done ? (b.cn_no ? t('gbl_cn_done', b.cn_no) : t('gbl_bill_cancelled')) : t('gbl_what_ca_did')}</span>;
  else if (!b.tally_no) right = <span class="tn add">+ {t('gbl_add')}</span>;
  else right = <span class="tn">{b.tally_no}</span>;
  const tone = b.deleted ? (b.cancel_done ? 'ok' : 'bad') : b.state === 'differs' ? 'bad' : !b.tally_no ? 'warn' : !b.pos_sure || b.b2c_details ? 'warn' : 'ok';
  return (
    <button class="gbl-row" onClick={onOpen}>
      <div class={`iconbox tone-${tone}`} style="width:34px;height:34px"><Icon name={b.deleted ? 'FileX' : !b.tally_no ? 'FileClock' : tone === 'ok' ? 'FileCheck2' : 'TriangleAlert'} size={17} /></div>
      <div class="grow" style="min-width:0">
        <div class="t">#{b.slip_no} · {b.customer}{tag && <span class="gbl-tag">{t(tag)}</span>}</div>
        <div class="s">{fmtDay(b.date, false)} · {money(b.total, true)}
          {b.state === 'differs' && <span class="gbl-tag bad">{t('gbl_differs', money(b.tally_total, true), money(b.total, true))}</span>}
          {!b.deleted && !b.pos_sure && <span class="gbl-tag warn">{t('gbl_pos')}</span>}
          {!b.deleted && b.b2c_details && <span class="gbl-tag warn">{t('gbl_details')}</span>}
          {b.deleted && <> · {t('gbl_deleted_on', fmtDay(b.deleted_on, false))} · {b.need === 'cancel_bill' ? t('gbl_need_cancel', b.tally_no) : t('gbl_need_cn', b.tally_no)}</>}
        </div>
      </div>
      {right}<Icon name="ChevronRight" size={16} />
    </button>
  );
}
