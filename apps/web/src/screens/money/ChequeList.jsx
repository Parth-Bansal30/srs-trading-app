// #/cheques — the cheque / DD register (4 Nov 2026, plan v2 F5): waiting to clear (from customers and to suppliers),
// cleared, came back. A customer's cheque is noted on their khata page ("Record payment" → Cheque / DD); it reaches the
// khata only when the owner confirms it in the bank statement (Bank → "Cheques & DDs").
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { ChequeRow, ChequeActSheet, isOpen } from '../../ui/money/Cheques.jsx';
import '../../ui/money/money.css';
import './money-screens.css';

const TABS = [
  { id: 'wait', word: 'chq_tab_wait', test: isOpen },
  { id: 'cleared', word: 'chq_tab_cleared', test: (q) => q.status === 'cleared' },
  { id: 'back', word: 'chq_tab_back', test: (q) => q.status === 'returned' },
  { id: 'all', word: 'chq_tab_all', test: () => true },
];

export function ChequeList() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('wait');
  const [open, setOpen] = useState(null);
  const load = () => call('cheques', { days: 120 }).then((l) => { setList(l || []); setErr(null); }).catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!can('money')) { go('/'); return; } load(); }, []);
  const shown = (list || []).filter(TABS.find((x) => x.id === tab).test);
  const waitIn = (list || []).filter((q) => q.direction === 'in' && isOpen(q));
  const waitOut = (list || []).filter((q) => q.direction === 'out' && isOpen(q));
  const sum = (l) => l.reduce((x, q) => x + Number(q.amount), 0);
  return (
    <>
      <TopBar title={t('chq_title')} sub={t('chq_sub')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        {list && (waitIn.length > 0 || waitOut.length > 0) && (
          <div class="card pad chq-sum">
            {waitIn.length > 0 && <div><div class="faint">{t('chq_wait_in', waitIn.length)}</div><b class="num" style="color:var(--ok)">{money(sum(waitIn), false)}</b></div>}
            {waitOut.length > 0 && <div><div class="faint">{t('chq_wait_out', waitOut.length)}</div><b class="num" style="color:var(--bad)">{money(sum(waitOut), false)}</b></div>}
          </div>
        )}
        <div class="seg" style="margin:12px 0">{TABS.map((x) => <button class={tab === x.id ? 'on' : ''} onClick={() => setTab(x.id)}>{t(x.word)}</button>)}</div>
        {err && <div class="error">{err}</div>}
        {!list && !err ? <><Skeleton h={70} /><Skeleton h={70} style="margin-top:8px" /></> : shown.length === 0 ? (
          <div class="card li"><div class="iconbox tone-neutral"><Icon name="ScrollText" /></div><div class="grow"><div class="t">{t('chq_none')}</div><div class="s">{t('chq_none_s')}</div></div></div>
        ) : <div class="card">{shown.map((q) => <ChequeRow q={q} onOpen={setOpen} />)}</div>}
        {can('settings') && waitIn.length > 0 && <button class="btn btn-ghost btn-block" style="margin-top:14px" onClick={() => go('/bank')}><Icon name="FileSpreadsheet" size={18} />{t('chq_go_bank')}</button>}
      </div>
      <ChequeActSheet q={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); toast(t('done_ok')); load(); }} />
    </>
  );
}
