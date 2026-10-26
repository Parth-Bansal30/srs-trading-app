// Bank statement → khata (owners, 25 Oct 2026).
// #/bank — choose the bank account and the statement file (PDF / Excel / CSV, read on this phone), see that it adds up.
// #/bank/<account>/<import> — every line with what the app thinks it is: READY (sure: remembered, exactly what a customer
// owes, bank charges), ALREADY IN THE APP (nothing new is added), PLEASE CHECK (a name or phone in the bank text), NEEDS YOU.
// Nothing is saved until the owner taps. Choosing once teaches the app ("SHARMA ENGG" → Sharma Engineering).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { shortNarration, payerKey, readNarration } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { online } from '../../lib/net.js';
import { loadAccounts, kindOf, accName, accSub, forgetAccounts } from '../../lib/accounts.js';
import { catOf } from '../../lib/expenses.js';
import { readStatementFile } from '../../lib/bankfile.js';
import { EXPENSE_CATEGORIES } from '../../config/options.js';
import { store } from '../../lib/store.js';
import { Icon, TopBar, Skeleton, Chip } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import '../../ui/money/money.css';
import './money-screens.css';

const owner = () => can('settings') && can('money');
const LAST = 'bank:last_account';
const bankLike = (a) => a && !a.is_drawer && a.kind !== 'cash' && a.kind !== 'safe';

// ================================================================ 1. the file
export function BankStart() {
  const [accs, setAccs] = useState(null);
  const [acc, setAcc] = useState(store.get(LAST));
  const [file, setFile] = useState(null);
  const [read, setRead] = useState(null);       // what the phone read
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [pw, setPw] = useState('');
  const [needPw, setNeedPw] = useState(false);
  const [waiting, setWaiting] = useState(null); // earlier statements with open lines
  const input = useRef(null);
  const save = useAction('bankSave');
  useEffect(() => { if (!owner()) { go('/'); return; } loadAccounts(true).then((l) => { const b = (l || []).filter(bankLike); setAccs(b); if (!b.some((a) => a.id === acc)) setAcc(b[0]?.id || null); }).catch(() => setAccs([])); }, []);
  useEffect(() => {
    setWaiting(null);
    if (acc && online.value) call('bankData', { account_id: acc }).then((d) => setWaiting(d)).catch(() => {});
  }, [acc]);

  const open = async (f, password = null) => {
    setErr(null); setRead(null); setBusy(true);
    try {
      const r = await readStatementFile(f, password);
      setRead(r); setNeedPw(false);
    } catch (e) {
      if (e.code === 'password' || e.code === 'password_wrong') { setNeedPw(true); setErr(e.code === 'password_wrong' ? t('bk_pw_wrong') : null); }
      else setErr(t(`bk_err_${e.code}`) !== `bk_err_${e.code}` ? t(`bk_err_${e.code}`) : t('bk_err_read'));
    } finally { setBusy(false); }
  };
  const pick = (e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (!f) return; setFile(f); setPw(''); open(f); };
  const ins = read ? read.lines.filter((l) => l.amount > 0) : [];
  const outs = read ? read.lines.filter((l) => l.amount < 0) : [];
  const sum = (ls) => ls.reduce((s, l) => s + Math.abs(l.amount), 0);
  const go2 = () => save.run({ account_id: acc, file_name: file?.name, from: read.from, to: read.to, opening: read.opening, closing: read.closing,
    adds_up: read.adds_up, lines: read.lines }).then((r) => { store.set(LAST, acc); go(`/bank/${acc}/${r.import_id}`); }).catch(() => {});
  const account = accs?.find((a) => a.id === acc);
  const openLines = (waiting?.lines || []).length;

  return (
    <>
      <TopBar title={t('bk_title')} sub={t('bk_sub')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 110px)">
        {!accs ? <Skeleton h={160} /> : accs.length === 0 ? (
          <div class="card pad"><div class="muted">{t('bk_no_bank')}</div>
            <button class="btn btn-ghost btn-block" style="margin-top:12px" onClick={() => go('/settings/accounts')}><Icon name="Plus" size={18} />{t('bk_add_bank')}</button></div>
        ) : <>
          <div class="lbl">{t('bk_which')}</div>
          <div class="card acc-list">{accs.map((a) => {
            const k = kindOf(a);
            return (
              <button class={`li acc-main ${acc === a.id ? 'on' : ''}`} onClick={() => { setAcc(a.id); setRead(null); }}>
                <span class="acc-ic" style={`background:${k.tone}`}><Icon name={k.icon} size={18} stroke={2.2} /></span>
                <span class="grow" style="min-width:0"><span class="t ellip" style="display:block">{accName(a)}</span><span class="s ellip" style="display:block">{accSub(a)}</span></span>
                <span class={`radio ${acc === a.id ? 'on' : ''}`} />
              </button>);
          })}</div>

          {openLines > 0 && !read && (
            <button class="card li" style="margin-top:12px" onClick={() => go(`/bank/${acc}/open`)}>
              <div class="iconbox tone-accent"><Icon name="ListTodo" /></div>
              <div class="grow"><div class="t">{t('bk_waiting', openLines)}</div><div class="s">{t('bk_waiting_s')}</div></div>
              <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
            </button>
          )}

          <div class="lbl" style="margin-top:16px">{t('bk_file')}</div>
          <input ref={input} type="file" hidden accept=".pdf,.xlsx,.xls,.csv,.txt,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={pick} />
          <button class="btn btn-ghost btn-block bk-file" disabled={!acc || busy} onClick={() => input.current?.click()}>
            <Icon name={busy ? 'LoaderCircle' : 'FileUp'} size={22} class={busy ? 'spin' : ''} />{busy ? t('bk_reading') : file ? file.name : t('bk_choose')}
          </button>
          {!read && !busy && <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:8px;line-height:1.45">{t('bk_how_get')}</div>}

          {needPw && (
            <div class="card pad" style="margin-top:12px">
              <div class="t" style="font-weight:700">{t('bk_pw_t')}</div>
              <div class="muted" style="font-size:13px;margin-top:2px">{t('bk_pw_s')}</div>
              <div class="field" style="margin-top:10px"><input type="password" value={pw} autocomplete="off" onInput={(e) => setPw(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && pw && open(file, pw)} /></div>
              <button class="btn btn-brand btn-block" style="margin-top:10px" disabled={!pw || busy} onClick={() => open(file, pw)}>{t('bk_pw_open')}</button>
            </div>
          )}
          {err && <div class="error" style="margin-top:10px">{err}</div>}

          {read && (
            <div class="card pad bk-summary" style="margin-top:14px">
              <div class="row" style="gap:10px"><Icon name="FileCheck2" size={22} style="color:var(--ok)" />
                <div class="grow"><div class="t" style="font-weight:800">{read.from && read.to ? `${fmtDay(read.from)} – ${fmtDay(read.to)}` : file?.name}</div>
                  <div class="muted" style="font-size:13px">{account ? accName(account) : ''} · {t('bk_lines', read.lines.length)}</div></div></div>
              <div class="bk-io">
                <div><span class="cap">{t('bk_in')}</span><b class="num" style="color:var(--ok)">{money(sum(ins), false)}</b><span class="s">{t('bk_n_lines', ins.length)}</span></div>
                <div><span class="cap">{t('bk_out')}</span><b class="num" style="color:var(--bad)">{money(sum(outs), false)}</b><span class="s">{t('bk_n_lines', outs.length)}</span></div>
              </div>
              {read.opening != null && read.closing != null && <div class="muted num" style="font-size:13.5px;margin-top:8px">{t('bk_open_close', money(read.opening, false), money(read.closing, false))}</div>}
              <div style="margin-top:10px">{read.adds_up
                ? <Chip tone="ok"><Icon name="CircleCheck" size={14} />{t('bk_adds_up')}</Chip>
                : <div class="notice tone-warn" style="font-size:13px">{read.problems?.length ? t('bk_not_adds', read.problems.length) : t('bk_no_balance')}</div>}</div>
            </div>
          )}
        </>}
      </div>
      {read && <div class="actionbar"><button class="btn btn-brand btn-block" disabled={save.busy || !online.value} onClick={go2}><Icon name="Sparkles" size={20} />{save.busy ? t('bk_matching') : t('bk_match')}</button></div>}
      {save.error && <div class="error" style="position:fixed;bottom:calc(var(--tabbar-h) + 84px);left:16px;right:16px">{save.error.message}</div>}
    </>
  );
}

// ================================================================ 2. the review
const GROUPS = [
  { id: 'unknown', word: 'bk_g_needs', tone: 'bad' },
  { id: 'likely', word: 'bk_g_check', tone: 'warn' },
  { id: 'sure', word: 'bk_g_ready', tone: 'ok' },
  { id: 'link', word: 'bk_g_already', tone: 'neutral' },
];

export function BankReview({ account, imp }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);      // the line being changed
  const [bulk, setBulk] = useState(null);      // { done, total }
  const [showDone, setShowDone] = useState(false);
  const [accs, setAccs] = useState([]);
  const run = useAction('bankRun');
  const link = useAction('bankLink');
  const mark = useAction('bankMark');
  const bal = useAction('bankBalance');
  const load = () => call('bankData', { account_id: account, import_id: imp === 'open' ? null : imp }).then((x) => { setD(x); setErr(null); }).catch((e) => setErr(e.message || t('err_generic')));
  useEffect(() => { if (!owner()) { go('/'); return; } load(); loadAccounts().then(setAccs).catch(() => {}); }, [account, imp]);

  const cust = useMemo(() => new Map((d?.customers || []).map((c) => [c.id, c])), [d]);
  const sups = useMemo(() => new Map((d?.suppliers || []).map((s) => [s.id, s])), [d]);
  const accById = useMemo(() => new Map((accs || []).map((a) => [a.id, a])), [accs]);
  if (err) return <><TopBar title={t('bk_title')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!d) return <><TopBar title={t('bk_title')} /><div class="page"><Skeleton h={120} /><Skeleton h={300} style="margin-top:12px" /></div></>;

  const rows = d.lines.map((l, i) => ({ l, s: d.suggestions[i] }));
  const open = rows.filter((r) => r.l.status === 'open');
  const groupOf = (r) => (r.s.action === 'link' ? 'link' : r.s.confidence === 'sure' ? 'sure' : r.s.confidence === 'likely' ? 'likely' : 'unknown');
  const by = Object.fromEntries(GROUPS.map((g) => [g.id, open.filter((r) => groupOf(r) === g.id)]));
  const done = rows.filter((r) => r.l.status === 'added' || r.l.status === 'linked');
  const skipped = rows.filter((r) => r.l.status === 'skipped');
  const readyAll = [...by.sure, ...by.link];

  /** Do what the suggestion says (✓). remember = teach the app this payer (when it isn't already remembered). */
  const accept = async (r, { silent = false } = {}) => {
    const { l, s } = r;
    const key = s.reason !== 'remembered' ? payerKey(l.narration) : null;
    if (s.action === 'link') return link.run({ line_id: l.id, src: s.src, ref: s.move });
    if (s.action === 'skip') return mark.run({ line_id: l.id, status: 'skipped', note: t(`bk_why_${s.reason}`) !== `bk_why_${s.reason}` ? t(`bk_why_${s.reason}`) : null, remember_key: key });
    return run.run({ line_id: l.id, amount: l.amount, action: s.action, customer_id: s.customer_id, side: s.side || 'pakka', category: s.category,
      supplier_id: s.supplier_id, to: s.to, method: s.method, remember_key: key, paid_to: s.action === 'expense' ? readNarration(l.narration).name : null })
      .then((x) => { if (!silent) toast(t('bk_added')); return x; });
  };
  const one = (r) => accept(r).then(load).catch(() => {});
  const all = async () => {
    setBulk({ done: 0, total: readyAll.length });
    let n = 0; let bad = 0;
    for (const r of readyAll) {
      try { await accept(r, { silent: true }); } catch { bad++; }   // eslint-disable-line no-await-in-loop
      n++; setBulk({ done: n, total: readyAll.length });
    }
    setBulk(null); toast(bad ? t('bk_bulk_some', n - bad, bad) : t('bk_bulk_done', n)); load();
  };
  const describe = (s, l) => suggestionText(s, l, cust, sups, accById, d.drawer);
  const appBal = d.app_balance;
  const closing = d.import?.closing;
  const diff = appBal?.balance != null && closing != null ? Math.round((Number(closing) - Number(appBal.balance)) * 100) / 100 : null;

  return (
    <>
      <TopBar title={t('bk_title')} sub={`${d.account.name}${d.import?.from ? ` · ${fmtDay(d.import.from, false)} – ${fmtDay(d.import.to)}` : ''}`} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 120px)">
        <div class="card pad bk-head">
          <div class="bk-count"><b class="num">{done.length + skipped.length}</b><span>/ {rows.length}</span></div>
          <div class="grow"><div class="t" style="font-weight:800">{open.length ? t('bk_left', open.length) : t('bk_all_done')}</div>
            <div class="muted" style="font-size:13px">{d.import?.seen > 0 ? t('bk_seen_before', d.import.seen) : t('bk_nothing_saved')}</div></div>
        </div>

        {GROUPS.map((g) => by[g.id].length > 0 && (
          <section class="bk-sec">
            <div class="sec"><h3><span class={`dot tone-${g.tone}`} />{t(g.word)} <span class="faint">({by[g.id].length})</span></h3></div>
            <div class="faint bk-sec-s">{t(`${g.word}_s`)}</div>
            <div class="card">{by[g.id].map((r) => (
              <LineRow r={r} text={describe(r.s, r.l)} busy={run.busy || link.busy || mark.busy || !!bulk}
                onOk={r.s.action ? () => one(r) : null} onChange={() => setEdit(r)}
                onSkip={g.id === 'unknown' ? () => mark.run({ line_id: r.l.id, status: 'skipped', note: null }).then(load).catch(() => {}) : null} />
            ))}</div>
          </section>
        ))}

        {(done.length > 0 || skipped.length > 0) && (
          <section class="bk-sec">
            <button class="sec link-sec" onClick={() => setShowDone(!showDone)}><h3>{t('bk_g_done')} <span class="faint">({done.length + skipped.length})</span></h3><Icon name={showDone ? 'ChevronUp' : 'ChevronDown'} size={18} /></button>
            {showDone && <div class="card">{[...done, ...skipped].map((r) => (
              <div class="li bk-line done">
                <div class={`iconbox tone-${r.l.status === 'skipped' ? 'neutral' : 'ok'}`}><Icon name={r.l.status === 'skipped' ? 'SkipForward' : 'Check'} size={18} /></div>
                <div class="grow" style="min-width:0"><div class="t ellip">{shortNarration(r.l.narration)}</div>
                  <div class="s">{fmtDay(r.l.day, false)} · {t(`bk_st_${r.l.status}`)}{r.l.note ? ` · ${r.l.note}` : ''}</div></div>
                <div style="text-align:right"><b class="num" style={`color:${r.l.amount > 0 ? 'var(--ok)' : 'var(--bad)'}`}>{r.l.amount > 0 ? '+' : '−'}{money(Math.abs(r.l.amount), false)}</b>
                  {r.l.status !== 'added' && <button class="link" style="min-height:0;font-size:12.5px" onClick={() => mark.run({ line_id: r.l.id, status: 'open' }).then(load).catch(() => {})}>{t('bk_reopen')}</button>}</div>
              </div>))}</div>}
          </section>
        )}

        {closing != null && (
          <div class={`card pad bk-balance ${diff === 0 ? 'ok' : ''}`}>
            <div class="row" style="gap:10px"><Icon name={diff === 0 ? 'CircleCheck' : 'Scale'} size={22} style={`color:${diff === 0 ? 'var(--ok)' : 'var(--ink-2)'}`} />
              <div class="grow"><div class="t" style="font-weight:800">{diff === 0 ? t('bk_bal_match') : t('bk_bal_title')}</div>
                <div class="muted num" style="font-size:13px">{t('bk_bal_line', fmtDay(d.import.to, false), money(Number(closing), false), appBal?.known || appBal?.balance != null ? money(Number(appBal.balance), false) : '—')}</div></div></div>
            {diff !== 0 && <>
              <div class="muted" style="font-size:13px;margin-top:8px">{open.length ? t('bk_bal_finish', open.length) : t('bk_bal_diff', money(Math.abs(diff ?? 0), false))}</div>
              {d.import?.adds_up && <button class="btn btn-ghost btn-block" style="margin-top:10px" disabled={bal.busy} onClick={() => bal.run({ import_id: d.import.id }).then(() => { forgetAccounts(); toast(t('bk_bal_set')); load(); }).catch(() => {})}>
                <Icon name="Scale" size={18} />{t('bk_bal_set_btn', d.account.name, money(Number(closing), false))}</button>}
            </>}
          </div>
        )}
        {[run, link, mark, bal].map((a) => a.error && <div class="error">{a.error.message}</div>)}
      </div>
      {readyAll.length > 0 && (
        <div class="actionbar"><button class="btn btn-brand btn-block" disabled={!!bulk || !online.value} onClick={all}>
          <Icon name="CheckCheck" size={20} />{bulk ? t('bk_bulk_going', bulk.done, bulk.total) : t('bk_add_all', readyAll.length)}</button></div>
      )}
      {edit && <LineSheet r={edit} d={d} accs={accs} onClose={() => setEdit(null)} onDone={() => { setEdit(null); toast(t('bk_saved')); load(); }} />}
    </>
  );
}

const REASON_ICON = { remembered: 'Brain', name: 'UserSearch', phone: 'Phone', amount: 'Equal', already: 'Link', words: 'Tag', atm: 'Landmark', cash_deposit: 'Banknote', interest: 'Percent' };
function LineRow({ r, text, busy, onOk, onChange, onSkip }) {
  const { l, s } = r;
  const [more, setMore] = useState(false);
  return (
    <div class="li bk-line">
      <div class="grow" style="min-width:0">
        <div class="row" style="gap:8px;align-items:flex-start">
          <button class="grow bk-txt" onClick={() => setMore(!more)}>
            <div class="t">{more ? l.narration : shortNarration(l.narration)}</div>
            <div class="s">{fmtDay(l.day, false)}{l.ref ? ` · ${l.ref}` : ''}</div>
          </button>
          <b class="num bk-amt" style={`color:${l.amount > 0 ? 'var(--ok)' : 'var(--bad)'}`}>{l.amount > 0 ? '+' : '−'}{money(Math.abs(l.amount), false)}</b>
        </div>
        {s.action ? (
          <div class="bk-sug">
            <Icon name={sugIcon(s)} size={16} stroke={2.2} />
            <span class="grow"><b>{text}</b>{s.reason && <span class="bk-why"><Icon name={REASON_ICON[s.reason] || 'Info'} size={12} />{t(`bk_r_${s.reason}`)}</span>}</span>
          </div>
        ) : <div class="bk-sug unknown"><Icon name="CircleHelp" size={16} /><span>{t(l.amount > 0 ? 'bk_who_paid' : 'bk_what_out')}</span></div>}
        <div class="row bk-acts">
          {onOk && <button class="btn btn-brand" disabled={busy} onClick={onOk}><Icon name="Check" size={17} stroke={2.6} />{s.action === 'link' ? t('bk_ok_link') : t('bk_ok')}</button>}
          <button class={`btn ${onOk ? 'btn-ghost' : 'btn-brand'}`} disabled={busy} onClick={onChange}><Icon name={onOk ? 'Pencil' : 'ListChecks'} size={16} />{onOk ? t('bk_change') : t('bk_choose_what')}</button>
          {onSkip && <button class="btn btn-ghost" disabled={busy} onClick={onSkip}>{t('bk_skip')}</button>}
        </div>
      </div>
    </div>
  );
}
const sugIcon = (s) => ({ link: 'Link', payment: 'IndianRupee', refund: 'Undo2', expense: 'Receipt', supplier: 'Truck', move: 'ArrowRightLeft', skip: 'SkipForward' }[s.action] || 'Info');
function suggestionText(s, l, cust, sups, accs, drawer) {
  const side = (x) => (x === 'kacha' ? ` · ${t('bill_none_short')}` : '');
  switch (s.action) {
    case 'link': return t('bk_same_as', `${s.label || t(`bk_src_${s.src}`)}`);
    case 'payment': return `${cust.get(s.customer_id)?.name || '?'} · ${t('bk_khata')}${side(s.side)}`;
    case 'refund': return `${t('bk_gave_back')} · ${cust.get(s.customer_id)?.name || '?'}`;
    case 'expense': return `${t('bk_expense')} · ${t(catOf(s.category).word)}`;
    case 'supplier': return `${t('bk_paid_supplier')} · ${sups.get(s.supplier_id)?.name || '?'}`;
    case 'move': { const other = accs.get(s.to || drawer); const nm = other ? accName(other) : t('acc_drawer'); return l.amount < 0 ? t('bk_move_out', nm) : t('bk_move_in', nm); }
    case 'skip': return t('bk_not_shop');
    default: return '';
  }
}

// ================================================================ 3. choose / change one line
function LineSheet({ r, d, accs, onClose, onDone }) {
  const { l, s } = r;
  const isIn = l.amount > 0;
  const kinds = isIn ? ['payment', 'move', 'skip'] : ['expense', 'supplier', 'move', ...(can('delete') ? ['refund'] : []), 'skip'];
  const start = s.action && s.action !== 'link' && kinds.includes(s.action) ? s.action : kinds[0];
  const [kind, setKind] = useState(start);
  const [customer, setCustomer] = useState(s.customer_id || null);
  const [side, setSide] = useState(s.side || 'pakka');
  const [category, setCategory] = useState(s.category || 'other');
  const [supplier, setSupplier] = useState(s.supplier_id || null);
  const [to, setTo] = useState(s.to || d.drawer);
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const key = payerKey(l.narration);
  const [remember, setRemember] = useState(!!key);
  const run = useAction('bankRun');
  const mark = useAction('bankMark');
  const n = readNarration(l.narration);
  const list = (kind === 'refund' ? d.customers.filter((c) => (d.dues[c.id]?.credit || 0) > 0) : d.customers)
    .filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()) || String(c.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '§'));
  const shown = (customer && !list.slice(0, 8).some((c) => c.id === customer) ? [d.customers.find((c) => c.id === customer), ...list] : list).filter(Boolean).slice(0, 8);
  const ok = kind === 'skip' || ((kind === 'payment' || kind === 'refund') ? !!customer : kind === 'supplier' ? !!supplier : kind === 'move' ? !!to : true);
  const save = () => {
    const remember_key = remember ? key : null;
    if (kind === 'skip') return mark.run({ line_id: l.id, status: 'skipped', note: note || null, remember_key }).then(onDone).catch(() => {});
    return run.run({ line_id: l.id, amount: l.amount, action: kind, customer_id: customer, side, category, supplier_id: supplier, to, note: note || null,
      method: n.method, remember_key, paid_to: kind === 'expense' ? n.name : null }).then(onDone).catch(() => {});
  };
  const others = (accs || []).filter((a) => a.id !== d.account.id && !a.hidden);
  return (
    <Sheet open onClose={onClose} title={isIn ? t('bk_sheet_in', money(l.amount, false)) : t('bk_sheet_out', money(-l.amount, false))}
      footer={<button class="btn btn-brand btn-block" disabled={!ok || run.busy || mark.busy} onClick={save}><Icon name="Check" size={18} stroke={2.6} />{kind === 'skip' ? t('bk_skip_save') : t('bk_save_line')}</button>}>
      <div class="muted bk-narr">{fmtDay(l.day)} · {l.narration}</div>
      <div class="bk-kinds">{kinds.map((k) => <button class={kind === k ? 'on' : ''} onClick={() => setKind(k)}><Icon name={sugIcon({ action: k })} size={18} />{t(`bk_k_${k}${k === 'move' ? (isIn ? '_in' : '_out') : ''}`)}</button>)}</div>

      {(kind === 'payment' || kind === 'refund') && <>
        <div class="lbl" style="margin-top:12px">{t('bk_which_customer')}</div>
        <div class="field"><Icon name="Search" size={16} style="color:var(--ink-3)" /><input value={q} placeholder={n.name || t('bk_search_ph')} onInput={(e) => setQ(e.currentTarget.value)} /></div>
        <div class="card bk-pick">{shown.length ? shown.map((c) => (
          <button class={`li ${customer === c.id ? 'on' : ''}`} onClick={() => setCustomer(c.id)}>
            <div class="grow"><div class="t">{c.name}</div><div class="s">{c.phone || ''}{d.dues[c.id]?.pakka || d.dues[c.id]?.kacha ? ` · ${t('bk_owes', money((d.dues[c.id].pakka || 0) + (d.dues[c.id].kacha || 0), false))}` : ''}</div></div>
            <span class={`radio ${customer === c.id ? 'on' : ''}`} />
          </button>)) : <div class="li muted">{t('bk_no_match')}</div>}</div>
        {can('kacha') && <><div class="lbl" style="margin-top:12px">{t('which_account')}</div>
          <div class="seg"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}</button></div></>}
      </>}
      {kind === 'expense' && <><div class="lbl" style="margin-top:12px">{t('bk_what_for')}</div>
        <div class="bk-cats">{EXPENSE_CATEGORIES.map((c) => <button class={category === c.id ? 'on' : ''} onClick={() => setCategory(c.id)}><Icon name={c.icon} size={18} />{t(c.word)}</button>)}</div></>}
      {kind === 'supplier' && <><div class="lbl" style="margin-top:12px">{t('bk_which_supplier')}</div>
        <div class="card bk-pick">{d.suppliers.length ? d.suppliers.map((x) => (
          <button class={`li ${supplier === x.id ? 'on' : ''}`} onClick={() => setSupplier(x.id)}><div class="grow t">{x.name}</div><span class={`radio ${supplier === x.id ? 'on' : ''}`} /></button>))
          : <div class="li muted">{t('bk_no_suppliers')}</div>}</div></>}
      {kind === 'move' && <><div class="lbl" style="margin-top:12px">{isIn ? t('bk_move_from') : t('bk_move_to')}</div>
        <div class="card bk-pick">{others.map((a) => (
          <button class={`li ${to === a.id ? 'on' : ''}`} onClick={() => setTo(a.id)}><div class="grow t">{accName(a)}</div><span class={`radio ${to === a.id ? 'on' : ''}`} /></button>))}</div></>}

      <div class="lbl" style="margin-top:12px">{t('pay_note')}</div>
      <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={kind === 'skip' ? t('bk_skip_ph') : ''} />
      {key && <label class="row bk-remember"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
        <span>{t('bk_remember', (n.name || n.upi || n.phone || '').toUpperCase())}</span></label>}
      {(run.error || mark.error) && <div class="error">{(run.error || mark.error).message}</div>}
    </Sheet>
  );
}
