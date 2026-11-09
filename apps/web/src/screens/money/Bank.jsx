// Bank statement → khata (owners, 25 Oct 2026).
// #/bank — choose the bank account and the statement file (PDF / Excel / CSV, read on this phone), see that it adds up.
// #/bank/<account>/<import> — every line with what the app thinks it is: READY (sure: remembered, exactly what a customer
// owes, bank charges), ALREADY IN THE APP (nothing new is added), PLEASE CHECK (a name or phone in the bank text), NEEDS YOU.
// Nothing is saved until the owner taps. Choosing once teaches the app ("SHARMA ENGG" → Sharma Engineering).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { shortNarration, payerKey, readNarration, bankDay, chequeShow, similarSuppliers, bankNameGuess } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { newKey } from '../../lib/api.js';
import { forgetCatalog } from '../../lib/catalog.js';
import { money } from '../../lib/format.js';
import { fmtDay } from '../../lib/docs.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { online } from '../../lib/net.js';
import { loadAccounts, kindOf, accName, accSub, forgetAccounts, balWords } from '../../lib/accounts.js';
import { catOf } from '../../lib/expenses.js';
import { readStatementFile, fileHash } from '../../lib/bankfile.js';
import { fileToData } from '../../lib/files.js';
import { loadCatalog } from '../../lib/catalog.js';
import { EXPENSE_CATEGORIES } from '../../config/options.js';
import { store } from '../../lib/store.js';
import { Icon, TopBar, Skeleton, Chip } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { chqName, chqStatus, STATUS_TONE } from '../../ui/money/Cheques.jsx';
import { BillSplit } from '../../ui/stock/BillSplit.jsx';
import { AddSupplier } from '../../ui/stock/AddSupplier.jsx';
import { useSameCustomer } from '../khata/SameCustomer.jsx';
import '../../ui/money/money.css';
import './money-screens.css';

const owner = () => can('settings') && can('money');
const LAST = 'bank:last_account';
const bankLike = (a) => a && !a.is_drawer && a.kind !== 'cash' && a.kind !== 'safe';

/** How a sample date reads one way or the other ("05/06/2026" → "5 Jun 2026"). */
const dsShow = (v, style) => { const d = bankDay(v, style); return d ? fmtDay(d) : String(v || ''); };

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
  const [photo, setPhoto] = useState(null);     // a photo / scan: sent to Claude only with permission (F11)
  const [aiOn, setAiOn] = useState(false);
  const input = useRef(null);
  const save = useAction('bankSave');
  useEffect(() => { if (owner()) loadCatalog(true).then((c) => setAiOn(!!c.settings?.ai_photos)).catch(() => {}); }, []);
  useEffect(() => { if (!owner()) { go('/'); return; } loadAccounts(true).then((l) => { const b = (l || []).filter(bankLike); setAccs(b); if (!b.some((a) => a.id === acc)) setAcc(b[0]?.id || null); }).catch(() => setAccs([])); }, []);
  useEffect(() => {
    setWaiting(null);
    if (acc && online.value) call('bankData', { account_id: acc }).then((d) => setWaiting(d)).catch(() => {});
  }, [acc]);

  const open = async (f, password = null, dateStyle = null) => {
    setErr(null); setRead(null); setPhoto(null);
    if (String(f.type || '').startsWith('image/')) { setPhoto({ file: f }); return; }   // a photo: never read here, never sent without a yes
    setBusy(true);
    try {
      const r = await readStatementFile(f, password, { dateStyle });
      setRead(r); setNeedPw(false);
    } catch (e) {
      if (e.code === 'password' || e.code === 'password_wrong') { setNeedPw(true); setErr(e.code === 'password_wrong' ? t('bk_pw_wrong') : null); }
      else if (e.code === 'pdf_scan') setPhoto({ file: f });   // a scanned PDF: no text inside
      else setErr(t(`bk_err_${e.code}`) !== `bk_err_${e.code}` ? t(`bk_err_${e.code}`) : t('bk_err_read'));
    } finally { setBusy(false); }
  };
  /** The person said yes: the photo goes to Claude; every line comes back to check (nothing saved yet). */
  const sendPhoto = async () => {
    const f = photo.file;
    setErr(null); setBusy(true);
    try {
      const { mime, data } = await fileToData(f, 2400);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const r = await call('readStatementPhoto', { mime, data, consent: true, today });
      setRead({ ...r, file_hash: await fileHash(f) }); setPhoto(null);
    } catch (e) { setErr(e.message || t('bk_err_read')); setPhoto(null); } finally { setBusy(false); }
  };
  const pick = (e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (!f) return; setFile(f); setPw(''); open(f); };
  const ins = read ? read.lines.filter((l) => l.amount > 0) : [];
  const outs = read ? read.lines.filter((l) => l.amount < 0) : [];
  const sum = (ls) => ls.reduce((s, l) => s + Math.abs(l.amount), 0);
  const go2 = () => save.run({ account_id: acc, file_name: file?.name, from: read.from, to: read.to, opening: read.opening, closing: read.closing,
    adds_up: read.adds_up, file_hash: read.file_hash, lines: read.lines }).then((r) => { store.set(LAST, acc); go(`/bank/${acc}/${r.import_id}`); }).catch(() => {});
  const account = accs?.find((a) => a.id === acc);
  const openLines = (waiting?.lines || []).length;
  // a statement that covers days uploaded before: those entries are not saved again
  const before = read?.from && read?.to ? (waiting?.imports || []).filter((i) => i.from && i.to && i.from <= read.to && i.to >= read.from) : [];
  const minOf = (xs) => xs.reduce((m, x) => (x < m ? x : m)); const maxOf = (xs) => xs.reduce((m, x) => (x > m ? x : m));
  const overlapFrom = before.length ? maxOf([read.from, minOf(before.map((i) => i.from))]) : null;
  const overlapTo = before.length ? minOf([read.to, maxOf(before.map((i) => i.to))]) : null;
  const oldFrom = read?.from && waiting?.start && read.from < waiting.start ? waiting.start : null;
  // what the reader could not prove (4 Nov 2026): the owner sees it before anything is saved
  const doubtful = read ? read.lines.filter((l) => l.doubts?.length).length : 0;
  const askDates = read && read.dateStyle && !read.dateStyle.sure && !read.dateStyle.chosen;
  const sameFile = read?.file_hash ? (waiting?.imports || []).find((i) => i.file_hash === read.file_hash) : null;

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
          <input ref={input} type="file" hidden accept=".pdf,.xlsx,.xls,.csv,.txt,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,image/*" onChange={pick} />
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
          {photo && (
            <div class="card pad" style="margin-top:12px">
              <div class="row" style="gap:10px"><Icon name={aiOn ? 'ShieldQuestion' : 'ShieldX'} size={22} /><b class="grow">{t('bk_photo_t')}</b></div>
              {aiOn ? <>
                <div class="muted" style="font-size:13.5px;margin-top:6px;line-height:1.45">{t('ai_send_s', photo.file.name)}</div>
                <div class="muted" style="font-size:13px;margin-top:6px;line-height:1.45">{t('bk_photo_check')}</div>
                <div class="row" style="gap:10px;margin-top:12px">
                  <button class="btn btn-ghost grow" disabled={busy} onClick={() => { setPhoto(null); setFile(null); }}>{t('cancel')}</button>
                  <button class="btn btn-brand grow" disabled={busy} onClick={sendPhoto}><Icon name="Send" size={17} />{t('ai_send_yes')}</button>
                </div>
              </> : <>
                <div class="muted" style="font-size:13.5px;margin-top:6px;line-height:1.45">{t('bk_photo_off')}</div>
                <button class="btn btn-ghost btn-block" style="margin-top:12px" onClick={() => go('/settings')}><Icon name="Settings" size={17} />{t('bk_photo_settings')}</button>
              </>}
            </div>
          )}
          {err && <div class="error" style="margin-top:10px">{err}</div>}

          {read && read.kind === 'photo' && <div class="notice tone-warn" style="margin-top:14px;font-size:13.5px">{t('bk_photo_read', read.lines.length, read.lines.filter((l) => l.balance_agrees).length)}</div>}
          {read && (
            <div class="card pad bk-summary" style="margin-top:14px">
              <div class="row" style="gap:10px"><Icon name="FileCheck2" size={22} style="color:var(--ok)" />
                <div class="grow"><div class="t" style="font-weight:800">{read.from && read.to ? `${fmtDay(read.from)} – ${fmtDay(read.to)}` : file?.name}</div>
                  <div class="muted" style="font-size:13px">{account ? accName(account) : ''} · {t('bk_lines', read.lines.length)}</div></div></div>
              <div class="bk-io">
                <div><span class="cap">{t('bk_in')}</span><b class="num" style="color:var(--ok)">{money(sum(ins), false)}</b><span class="s">{t('bk_n_lines', ins.length)}</span></div>
                <div><span class="cap">{t('bk_out')}</span><b class="num" style="color:var(--bad)">{money(sum(outs), false)}</b><span class="s">{t('bk_n_lines', outs.length)}</span></div>
              </div>
              {read.opening != null && read.closing != null && <div class="muted num" style="font-size:13.5px;margin-top:8px">{t('bk_open_close', balWords(account, read.opening), balWords(account, read.closing))}</div>}
              <div style="margin-top:10px">{read.adds_up
                ? <Chip tone="ok"><Icon name="CircleCheck" size={14} />{t('bk_adds_up')}</Chip>
                : <div class="notice tone-warn" style="font-size:13px">{read.problems?.length ? t('bk_not_adds', read.problems.length) : t('bk_no_balance')}</div>}</div>
              {before.length > 0 && <div class="notice tone-ok bk-twice" style="font-size:13px;margin-top:8px"><Icon name="ShieldCheck" size={16} />
                <span>{t('bk_overlap', `${fmtDay(overlapFrom, false)} – ${fmtDay(overlapTo)}`)}</span></div>}
              {sameFile && <div class="notice tone-ok bk-twice" style="font-size:13px;margin-top:8px"><Icon name="ShieldCheck" size={16} />
                <span>{t('bk_same_file', fmtDay(String(sameFile.at).slice(0, 10)))}</span></div>}
              {askDates && (
                <div class="notice tone-warn" style="font-size:13.5px;margin-top:8px">
                  <b>{t('bk_ds_t')}</b><div style="margin-top:4px;font-weight:600">{t('bk_ds_s', String(read.dateStyle.sample || ''))}</div>
                  <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
                    <button class="btn btn-ghost grow" onClick={() => open(file, pw || null, 'dmy')}>{t('bk_ds_dmy', dsShow(read.dateStyle.sample, 'dmy'))}</button>
                    <button class="btn btn-ghost grow" onClick={() => open(file, pw || null, 'mdy')}>{t('bk_ds_mdy', dsShow(read.dateStyle.sample, 'mdy'))}</button></div>
                </div>)}
              {doubtful > 0 && !askDates && <div class="notice tone-warn bk-twice" style="font-size:13px;margin-top:8px"><Icon name="CircleHelp" size={16} /><span>{t('bk_doubts', doubtful)}</span></div>}
              {(read.unreadable || []).length > 0 && (
                <div class="notice tone-bad" style="font-size:13px;margin-top:8px"><b>{t('bk_unreadable_t', read.unreadable.length)}</b>
                  <div style="margin-top:4px;font-weight:600">{t('bk_unreadable_s')}</div>
                  {read.unreadable.slice(0, 5).map((u) => <div class="num" style="margin-top:4px;font-weight:600;opacity:.9">{u.day ? `${fmtDay(u.day, false)} · ` : ''}{u.text}</div>)}</div>)}
              {oldFrom && <div class="notice tone-warn bk-twice" style="font-size:13px;margin-top:8px"><Icon name="History" size={16} />
                <span>{read.to < oldFrom ? t('bk_all_old', fmtDay(oldFrom)) : t('bk_some_old', fmtDay(oldFrom))}</span></div>}
            </div>
          )}
        </>}
      </div>
      {read && <div class="actionbar"><button class="btn btn-brand btn-block" disabled={save.busy || !online.value || askDates || !read.lines.length} onClick={go2}><Icon name="Sparkles" size={20} />{save.busy ? t('bk_matching') : t('bk_match')}</button></div>}
      {save.error && <div class="error" style="position:fixed;bottom:calc(var(--tabbar-h) + 84px);left:16px;right:16px">{save.error.message}</div>}
    </>
  );
}

// ================================================================ 2. the review
const GROUPS = [
  { id: 'unknown', word: 'bk_g_needs', tone: 'bad' },
  { id: 'cheque', word: 'bk_g_cheque', tone: 'accent' },   // 4 Nov 2026 (F5): matched with the register one by one, never "ready"
  { id: 'likely', word: 'bk_g_check', tone: 'warn' },
  { id: 'sure', word: 'bk_g_ready', tone: 'ok' },
  { id: 'link', word: 'bk_g_already', tone: 'neutral' },
];

export function BankReview({ account, imp }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);      // the line being changed
  const [chq, setChq] = useState(null);        // a cheque line being matched
  const [bulk, setBulk] = useState(null);      // { done, total }
  const [showDone, setShowDone] = useState(false);
  const [accs, setAccs] = useState([]);
  const run = useAction('bankRun');
  const link = useAction('bankLink');
  const mark = useAction('bankMark');
  const dir = useAction('bankDirection');
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
  const groupOf = (r) => (r.s.doubt ? 'unknown' : r.s.cheque ? 'cheque' : r.s.action === 'link' ? 'link' : r.s.confidence === 'sure' ? 'sure' : r.s.confidence === 'likely' ? 'likely' : 'unknown');
  const by = Object.fromEntries(GROUPS.map((g) => [g.id, open.filter((r) => groupOf(r) === g.id)]));
  const done = rows.filter((r) => r.l.status === 'added' || r.l.status === 'linked');
  const skipped = rows.filter((r) => r.l.status === 'skipped');
  const readyAll = [...by.sure, ...by.link];

  /** Do what the suggestion says (✓). remember = teach the app this payer (when it isn't already remembered). */
  const accept = async (r, { silent = false } = {}) => {
    const { l, s } = r;
    const key = s.reason !== 'remembered' ? payerKey(l.narration, d.own) : null;
    if (s.action === 'link') return link.run({ line_id: l.id, src: s.src, ref: s.move }).then((x) => { if (!silent && x?.moved_from) toast(t('bk_moved_upi', s.via || '')); return x; });
    if (s.action === 'skip') return mark.run({ line_id: l.id, status: 'skipped', note: t(`bk_why_${s.reason}`) !== `bk_why_${s.reason}` ? t(`bk_why_${s.reason}`) : null, remember_key: key });
    return run.run({ line_id: l.id, amount: l.amount, action: s.action, customer_id: s.customer_id, side: s.side || 'pakka', category: s.category,
      supplier_id: s.supplier_id, to: s.to, method: s.method, remember_key: key, paid_to: s.action === 'expense' ? readNarration(l.narration, d.own).name : null })
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
  const chqById = new Map((d.cheques || []).map((q) => [q.id, q]));
  const describe = (s, l) => (s.action === 'cheque' ? chequeText(s, chqById) : suggestionText(s, l, cust, sups, accById, d.drawer));
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
            <div class="muted" style="font-size:13px">{d.import?.seen > 0 ? t('bk_seen_before', d.import.seen) : open.length ? t('bk_nothing_saved') : ''}</div>
            {d.import?.old > 0 && <div class="muted" style="font-size:13px;margin-top:2px">{t('bk_old_kept', d.import.old, fmtDay(d.start))}</div>}</div>
        </div>

        {GROUPS.map((g) => by[g.id].length > 0 && (
          <section class="bk-sec">
            <div class="sec"><h3><span class={`dot tone-${g.tone}`} />{t(g.word)} <span class="faint">({by[g.id].length})</span></h3></div>
            <div class="faint bk-sec-s">{t(`${g.word}_s`)}</div>
            <div class="card">{by[g.id].map((r) => (
              <LineRow r={r} own={d.own} text={describe(r.s, r.l)} busy={run.busy || link.busy || mark.busy || dir.busy || !!bulk}
                onDir={(isIn) => dir.run({ line_id: r.l.id, money_in: isIn }).then(load).catch(() => {})}
                onOk={r.s.action === 'cheque' ? () => setChq(r) : r.s.action ? () => one(r) : null} onChange={() => (r.s.cheque && r.s.cheque.kind !== 'charges' ? setChq(r) : setEdit(r))}
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
                <div class="grow" style="min-width:0"><div class="t ellip">{shortNarration(r.l.narration, d.own)}</div>
                  <div class="s">{fmtDay(r.l.day, false)} · {t(`bk_st_${r.l.status}`)}{r.l.note ? ` · ${r.l.note}` : ''}</div></div>
                <div style="text-align:right"><b class="num" style={`color:${r.l.amount > 0 ? 'var(--ok)' : 'var(--bad)'}`}>{r.l.amount > 0 ? '+' : '−'}{money(Math.abs(r.l.amount), false)}</b>
                  {r.l.status !== 'added' && <button class="link" style="min-height:0;font-size:12.5px" onClick={() => mark.run({ line_id: r.l.id, status: 'open' }).then(load).catch(() => {})}>{t('bk_reopen')}</button>}</div>
              </div>))}</div>}
          </section>
        )}

        {closing != null && !(d.start && d.import?.to && d.import.to < d.start) && (   /* a statement from before the app: no balance point then */
          <div class={`card pad bk-balance ${diff === 0 ? 'ok' : ''}`}>
            <div class="row" style="gap:10px"><Icon name={diff === 0 ? 'CircleCheck' : 'Scale'} size={22} style={`color:${diff === 0 ? 'var(--ok)' : 'var(--ink-2)'}`} />
              <div class="grow"><div class="t" style="font-weight:800">{diff === 0 ? t('bk_bal_match') : t('bk_bal_title')}</div>
                <div class="muted num" style="font-size:13px">{t('bk_bal_line', fmtDay(d.import.to, false), balWords(accById.get(d.account.id), closing), appBal?.known || appBal?.balance != null ? balWords(accById.get(d.account.id), appBal.balance) : '—')}</div></div></div>
            {diff !== 0 && <>
              <div class="muted" style="font-size:13px;margin-top:8px">{open.length ? t('bk_bal_finish', open.length) : t('bk_bal_diff', money(Math.abs(diff ?? 0), false))}</div>
              {d.import?.adds_up && <button class="btn btn-ghost btn-block" style="margin-top:10px" disabled={bal.busy} onClick={() => bal.run({ import_id: d.import.id }).then(() => { forgetAccounts(); toast(t('bk_bal_set')); load(); }).catch(() => {})}>
                <Icon name="Scale" size={18} />{t('bk_bal_set_btn', d.account.name, balWords(accById.get(d.account.id), closing))}</button>}
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
      {chq && <ChequeSheet r={chq} d={d} rows={rows} onClose={() => setChq(null)} onOther={() => { const x = chq; setChq(null); setEdit(x); }}
        onDone={(word) => { setChq(null); toast(t(word)); load(); }} />}
    </>
  );
}

const REASON_ICON = { cheque_in: 'ScrollText', cheque_return: 'Undo2', cheque_out: 'ScrollText', cheque_out_return: 'Undo2', cheque_charges: 'Receipt', remembered: 'Brain', name: 'UserSearch', phone: 'Phone', amount: 'Equal', already: 'Link', already_via: 'Link', words: 'Tag', atm: 'Landmark',
  cash_deposit: 'Banknote', interest: 'Percent', came_back: 'Undo2', went_back: 'Undo2', near_payment: 'TriangleAlert' };
function LineRow({ r, text, busy, onOk, onChange, onSkip, own, onDir }) {
  const { l, s } = r;
  const [more, setMore] = useState(false);
  return (
    <div class="li bk-line">
      <div class="grow" style="min-width:0">
        <div class="row" style="gap:8px;align-items:flex-start">
          <button class="grow bk-txt" onClick={() => setMore(!more)}>
            <div class="t">{more ? l.narration : shortNarration(l.narration, own)}</div>
            {l.status === 'open' && l.note && <div class="bk-reopen"><Icon name="Undo2" size={13} />{t('bk_reopened')} {l.note}</div>}
            {l.status === 'open' && s.doubt && <div class="bk-reopen"><Icon name="CircleHelp" size={13} />{s.doubt.map((d) => t(`bk_d_${d}`)).join(' · ')}{s.doubt.includes('photo') && !s.doubt.includes('balance') && l.balance != null ? ` · ${t('bk_d_photo_ok')}` : ''}</div>}
            <div class="s">{fmtDay(l.day, false)}{l.ref ? ` · ${l.ref}` : ''}</div>
          </button>
          <b class="num bk-amt" style={`color:${l.amount > 0 ? 'var(--ok)' : 'var(--bad)'}`}>{l.amount > 0 ? '+' : '−'}{money(Math.abs(l.amount), false)}</b>
        </div>
        {l.status === 'open' && s.doubt?.includes('direction') && onDir && <div class="row" style="gap:8px;margin-top:8px">
          <button class="btn btn-ghost grow" style="min-height:40px;font-size:13.5px" disabled={busy} onClick={() => onDir(true)}><Icon name="ArrowDown" size={15} />{t('bk_dir_in')}</button>
          <button class="btn btn-ghost grow" style="min-height:40px;font-size:13.5px" disabled={busy} onClick={() => onDir(false)}><Icon name="ArrowUp" size={15} />{t('bk_dir_out')}</button></div>}
        {s.action ? (
          <div class="bk-sug">
            <Icon name={sugIcon(s)} size={16} stroke={2.2} />
            <span class="grow"><b>{text}</b>{s.reason && <span class="bk-why"><Icon name={REASON_ICON[s.reason] || 'Info'} size={12} />{t(`bk_r_${s.reason}`)}</span>}</span>
          </div>
        ) : <div class="bk-sug unknown"><Icon name="CircleHelp" size={16} /><span>{t(l.amount > 0 ? 'bk_who_paid' : 'bk_what_out')}</span></div>}
        <div class="row bk-acts">
          {onOk && <button class="btn btn-brand" disabled={busy} onClick={onOk}><Icon name={s.action === 'cheque' ? 'ScrollText' : 'Check'} size={17} stroke={2.6} />{s.action === 'cheque' ? t('bk_chq_match') : s.action === 'link' ? t('bk_ok_link') : s.action === 'skip' ? t('bk_skip') : t('bk_ok')}</button>}
          {s.action !== 'cheque' && <button class={`btn ${onOk ? 'btn-ghost' : 'btn-brand'}`} disabled={busy} onClick={onChange}><Icon name={onOk ? 'Pencil' : 'ListChecks'} size={16} />{onOk ? t('bk_change') : t('bk_choose_what')}</button>}
          {onSkip && <button class="btn btn-ghost" disabled={busy} onClick={onSkip}>{t('bk_skip')}</button>}
        </div>
      </div>
    </div>
  );
}
const sugIcon = (s) => ({ cheque: 'ScrollText', link: 'Link', payment: 'IndianRupee', refund: 'Undo2', expense: 'Receipt', supplier: 'Truck', move: 'ArrowRightLeft', skip: 'SkipForward' }[s.action] || 'Info');
function suggestionText(s, l, cust, sups, accs, drawer) {
  const side = (x) => (x === 'kacha' ? ` · ${t('bill_none_short')}` : '');
  switch (s.action) {
    case 'link': return t('bk_same_as', `${s.label || t(`bk_src_${s.src}`)}`) + (s.via ? ` · ${t('bk_in_acc', s.via)}` : '');
    case 'payment': return `${cust.get(s.customer_id)?.name || '?'} · ${t('bk_khata')}${side(s.side)}`;
    case 'refund': return `${t('bk_gave_back')} · ${cust.get(s.customer_id)?.name || '?'}`;
    case 'expense': return `${t('bk_expense')} · ${t(catOf(s.category).word)}`;
    case 'supplier': return `${t('bk_paid_supplier')} · ${sups.get(s.supplier_id)?.name || '?'}`;
    case 'move': { const other = accs.get(s.to || drawer); const nm = other ? accName(other) : t('acc_drawer'); return l.amount < 0 ? t('bk_move_out', nm) : t('bk_move_in', nm); }
    case 'skip': return s.reason === 'came_back' ? t('bk_came_back') : t('bk_not_shop');
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
  const [parts, setParts] = useState([]);      // which of the supplier's bills (5 Nov 2026, F6)
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(null);   // 'supplier' | 'customer': a new one, right here (9 Nov 2026)
  const [sq, setSq] = useState('');
  const key = payerKey(l.narration, d.own);
  const [remember, setRemember] = useState(!!key);
  const run = useAction('bankRun');
  const mark = useAction('bankMark');
  const n = readNarration(l.narration, d.own);
  const list = (kind === 'refund' ? d.customers.filter((c) => (d.dues[c.id]?.credit || 0) > 0) : d.customers)
    .filter((c) => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()) || String(c.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, '') || '§'));
  const shown = (customer && !list.slice(0, 8).some((c) => c.id === customer) ? [d.customers.find((c) => c.id === customer), ...list] : list).filter(Boolean).slice(0, 8);
  // suppliers: the ones whose name looks like the bank line first (9 Nov 2026)
  const looksLike = new Set(n.name ? similarSuppliers(d.suppliers, { name: n.name }).map((x) => x.s.id) : []);
  const supList = d.suppliers.filter((x) => !sq.trim() || x.name.toLowerCase().includes(sq.trim().toLowerCase()))
    .sort((a, b) => Number(looksLike.has(b.id)) - Number(looksLike.has(a.id)));
  const ok = kind === 'skip' || ((kind === 'payment' || kind === 'refund') ? !!customer : kind === 'supplier' ? !!supplier : kind === 'move' ? !!to : true);
  const save = () => {
    const remember_key = remember ? key : null;
    if (kind === 'skip') return mark.run({ line_id: l.id, status: 'skipped', note: note || null, remember_key }).then(onDone).catch(() => {});
    return run.run({ line_id: l.id, amount: l.amount, action: kind, customer_id: customer, side, category, supplier_id: supplier, to, note: note || null,
      method: n.method, remember_key, paid_to: kind === 'expense' ? n.name : null,
      ...(kind === 'supplier' ? { allocations: parts.map((x) => ({ ...x, amount: Number(x.amount) })).filter((x) => x.amount > 0) } : {}) }).then(onDone).catch(() => {});
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
          </button>)) : <div class="li muted">{t('bk_no_match')}</div>}
          {kind === 'payment' && can('new') && adding !== 'customer' && <button class="add-new-btn" onClick={() => setAdding('customer')}><Icon name="UserPlus" size={18} />{t('nc_add_here')}</button>}</div>
        {kind === 'payment' && adding === 'customer' && <AddCustomer d={d} hint={q.trim() || n.name} phone={n.phone} onCancel={() => setAdding(null)}
          onPick={(c) => { if (!d.customers.some((x) => x.id === c.id)) d.customers.unshift(c); setCustomer(c.id); setQ(''); setAdding(null); }} />}
        {can('kacha') && <><div class="lbl" style="margin-top:12px">{t('which_account')}</div>
          <div class="seg"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}</button></div></>}
      </>}
      {kind === 'expense' && <><div class="lbl" style="margin-top:12px">{t('bk_what_for')}</div>
        <div class="bk-cats">{EXPENSE_CATEGORIES.map((c) => <button class={category === c.id ? 'on' : ''} onClick={() => setCategory(c.id)}><Icon name={c.icon} size={18} />{t(c.word)}</button>)}</div></>}
      {kind === 'supplier' && <><div class="lbl" style="margin-top:12px">{t('bk_which_supplier')}</div>
        {d.suppliers.length > 6 && <div class="field" style="margin-bottom:8px"><Icon name="Search" size={16} style="color:var(--ink-3)" /><input value={sq} placeholder={n.name || t('sup_search')} onInput={(e) => setSq(e.currentTarget.value)} /></div>}
        <div class="card bk-pick">{supList.length ? supList.map((x) => (
          <button class={`li ${supplier === x.id ? 'on' : ''}`} onClick={() => { setSupplier(x.id); setParts([]); }}><div class="grow"><div class="t">{x.name}</div>
            {looksLike.has(x.id) && supplier !== x.id && <div class="s" style="color:var(--accent)">{t('ns_looks_like')}</div>}</div><span class={`radio ${supplier === x.id ? 'on' : ''}`} /></button>))
          : <div class="li muted">{d.suppliers.length ? t('bk_no_match') : t('bk_no_suppliers')}</div>}
          {adding !== 'supplier' && <button class="add-new-btn" onClick={() => setAdding('supplier')}><Icon name="Plus" size={18} stroke={2.4} />{t('ns_add_here')}</button>}</div>
        {adding === 'supplier' && <AddSupplier suppliers={d.suppliers} hint={sq.trim() || n.name} onCancel={() => setAdding(null)}
          onUse={(x) => { setSupplier(x.id); setParts([]); setAdding(null); }}
          onAdded={(x) => { d.suppliers.unshift(x); setSupplier(x.id); setParts([]); setSq(''); setAdding(null); toast(t('ns_added', x.name)); }} />}
        {supplier && <><div class="lbl" style="margin-top:12px">{t('exp_supplier_bills')}</div>
          <BillSplit supplierId={supplier} amount={Math.abs(l.amount)} value={parts} onChange={setParts} /></>}</>}
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

// ================================================================ 4. a cheque / DD line (4 Nov 2026, plan v2 F5)
/** "Cheque 004512 · Sharma Steel (in the register)" / "Not in the register" */
function chequeText(s, byId) {
  const c = s.cheque;
  const first = (s.candidates || []).map((x) => byId.get(x.id)).find(Boolean);
  const what = t(`bk_chq_k_${c.kind}`, c.number ? chequeShow(c.number) : '').replace(/\s+·\s*$/, '');
  if (first) return `${what} · ${first.direction === 'in' ? first.customer : first.supplier}${s.candidates.length > 1 ? ` ${t('bk_chq_more', s.candidates.length - 1)}` : ''}`;
  return `${what} · ${t(s.move ? 'bk_chq_in_app' : 'bk_chq_not_reg')}`;
}

/**
 * Match a cheque line with the register and confirm. Nothing happens until Confirm: the line and the register cheque
 * are shown side by side; different amounts need a note. A cheque coming back shows what changes before it is confirmed.
 */
function ChequeSheet({ r, d, rows, onClose, onDone, onOther }) {
  const { l, s } = r;
  const c = s.cheque;
  const byId = new Map((d.cheques || []).map((q) => [q.id, q]));
  const cands = (s.candidates || []).map((x) => ({ ...x, q: byId.get(x.id) })).filter((x) => x.q);
  const [pick, setPick] = useState(null);          // the register cheque the owner tapped "Match" on
  const [note, setNote] = useState('');
  const [charge, setCharge] = useState(false);     // return charges onto the khata: off unless ticked
  const chargeLine = c.kind === 'return' ? rows.find((x) => x.l.status === 'open' && x.s.cheque?.kind === 'charges' && Math.abs(Date.parse(x.l.day) - Date.parse(l.day)) <= 3 * 86400000) : null;
  const [chargeAmt, setChargeAmt] = useState(chargeLine ? String(-chargeLine.l.amount) : '');
  // not in the register (a cheque from a customer): the owner chooses whose it is
  const [customer, setCustomer] = useState(s.customer_id || null);
  const [side, setSide] = useState(s.side || 'pakka');
  const [number, setNumber] = useState(c.number ? chequeShow(c.number) : '');
  const [q, setQ] = useState('');
  const [addCust, setAddCust] = useState(false);   // a new customer right here (9 Nov 2026)
  const clear = useAction('chequeClear');
  const back = useAction('chequeReturn');
  const link = useAction('bankLink');
  const busy = clear.busy || back.busy || link.busy;
  const err = clear.error || back.error || link.error;
  const amt = Math.abs(l.amount);
  const p = pick ? byId.get(pick) : null;
  const diff = p && Math.abs(Number(p.amount) - amt) > 0.005;
  const isBack = c.kind === 'return' || c.kind === 'out_return';
  const depLine = s.deposit_line ? rows.find((x) => x.l.id === s.deposit_line)?.l : null;
  const fresh = !cands.length && c.kind === 'in';
  const list = fresh ? d.customers.filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];

  const confirm = () => {
    if (isBack) return back.run({ id: p.id, line_id: l.id, deposit_line_id: p.status !== 'cleared' && depLine ? depLine.id : null,
      charge: charge && c.kind === 'return' ? Number(chargeAmt) || 0 : 0, note: note || null }).then(() => onDone('bk_chq_returned')).catch(() => {});
    if (fresh) return clear.run({ line_id: l.id, new: { customer_id: customer, side, number, bank_name: c.bank || null, instrument: c.instrument }, note: note || null })
      .then(() => onDone('bk_chq_cleared')).catch(() => {});
    return clear.run({ id: p.id, line_id: l.id, note: note || null }).then(() => onDone('bk_chq_cleared')).catch(() => {});
  };
  const ready = isBack ? !!p : fresh ? !!customer && number.trim().length > 0 : !!p && (!diff || note.trim());
  const who = (x) => (x.direction === 'in' ? x.customer : x.supplier);
  const effect = () => {
    if (!p) return null;
    if (c.kind === 'return') return p.status === 'cleared' ? t('bk_chq_ret_cleared', money(Number(p.amount), false), p.customer) : t('bk_chq_ret_waiting');
    if (c.kind === 'out_return') return p.expense_id ? t('bk_chq_ret_out', p.supplier) : t('bk_chq_ret_out_none');
    if (c.kind === 'in') return t('bk_chq_eff_in', money(amt, false), p.customer);
    return p.expense_id ? t('bk_chq_eff_out', p.supplier) : t('bk_chq_eff_out_new', p.supplier);
  };

  return (
    <Sheet open onClose={onClose} title={t(`bk_chq_t_${c.kind}`, money(amt, false))}
      footer={(cands.length > 0 || fresh) && <button class="btn btn-brand btn-block" disabled={busy || !ready || !online.value} onClick={confirm}>
        <Icon name="Check" size={18} stroke={2.6} />{isBack ? t('bk_chq_confirm_back') : t('bk_chq_confirm')}</button>}>
      <div class="muted bk-narr">{fmtDay(l.day)} · {l.narration}{l.ref ? ` · ${l.ref}` : ''}</div>
      {c.instrument === 'dd' && c.kind === 'in' && <div class="notice tone-neutral" style="font-size:13px;margin-top:8px">{t('bk_chq_dd')}</div>}

      {s.move && !p && c.kind !== 'return' && c.kind !== 'out_return' && (
        <div class="card pad" style="margin-top:12px">
          <div class="t" style="font-weight:800">{t('bk_chq_app_t', s.label || '')}</div>
          <div class="muted" style="font-size:13px;margin:4px 0 10px">{t('bk_chq_app_s')}</div>
          <button class="btn btn-ghost btn-block" disabled={busy} onClick={() => link.run({ line_id: l.id, src: s.src, ref: s.move }).then(() => onDone('bk_saved')).catch(() => {})}>
            <Icon name="Link" size={17} />{t('bk_ok_link')}</button>
        </div>
      )}

      {cands.length > 0 && <>
        <div class="lbl" style="margin-top:14px">{t('bk_chq_reg')}</div>
        <div class="card">{cands.map((x) => (
          <div class={`li chq-cand ${pick === x.id ? 'on' : ''}`}>
            <div class="grow" style="min-width:0">
              <div class="t ellip">{who(x.q)}</div>
              <div class="s"><span class="num">{chqName(x.q)}</span>{[x.q.bank_name, t(x.q.direction === 'in' ? 'chq_got' : 'chq_given_on', fmtDay(x.q.got_on, false)), t(x.why === 'number' ? 'bk_chq_by_number' : 'bk_chq_by_amount')].filter(Boolean).map((z) => ` · ${z}`).join('')}</div>
              <div class="row" style="gap:6px;margin-top:4px"><b class="num">{money(Number(x.q.amount), false)}</b><span class={`chip tone-${STATUS_TONE[x.q.status]}`}>{chqStatus(x.q)}</span></div>
            </div>
            <button class={`btn ${pick === x.id ? 'btn-brand' : 'btn-ghost'}`} style="min-height:40px" onClick={() => { setPick(pick === x.id ? null : x.id); setNote(''); }}>
              {pick === x.id ? <><Icon name="Check" size={16} />{t('bk_chq_picked')}</> : t('bk_chq_match')}</button>
          </div>))}</div>
      </>}

      {p && (
        <div class="chq-side">
          <div><div class="cap">{t('bk_chq_bank_says')}</div><b class="num">{money(amt, false)}</b><span>{c.number ? `${t('bk_chq_no')} ${chequeShow(c.number)}` : t('bk_chq_no_number')}</span><span>{fmtDay(l.day, false)}</span></div>
          <div><div class="cap">{t('bk_chq_reg_says')}</div><b class="num" style={diff ? 'color:var(--bad)' : ''}>{money(Number(p.amount), false)}</b><span>{t('bk_chq_no')} {chequeShow(p.number)}</span><span>{fmtDay(p.got_on, false)}</span></div>
        </div>
      )}
      {p && <div class={`notice ${isBack ? 'tone-warn' : 'tone-accent'}`} style="font-size:13.5px;margin-top:10px">{effect()}
        {c.kind === 'return' && p.status !== 'cleared' && depLine && <div style="margin-top:4px">{t('bk_chq_ret_dep', fmtDay(depLine.day, false))}</div>}</div>}
      {p && diff && !isBack && <><div class="lbl" style="margin-top:12px">{t('bk_chq_why_diff', money(Number(p.amount), false), money(amt, false))}</div>
        <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('bk_chq_why_ph')} /></>}
      {p && c.kind === 'return' && (
        <label class="row bk-remember" style="margin-top:12px"><input type="checkbox" checked={charge} onChange={(e) => setCharge(e.currentTarget.checked)} />
          <span>{t('bk_chq_charge_tick', p.customer)}</span></label>
      )}
      {p && c.kind === 'return' && charge && <div class="field" style="margin-top:8px"><span class="faint">₹</span><input inputmode="decimal" value={chargeAmt} onInput={(e) => setChargeAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>}
      {p && isBack && <><div class="lbl" style="margin-top:12px">{t('pay_note')}</div>
        <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('bk_chq_back_ph')} /></>}

      {fresh && <>
        <div class="notice tone-warn" style="font-size:13.5px;margin-top:12px">{t('bk_chq_none')}</div>
        <div class="lbl" style="margin-top:12px">{t('bk_chq_pick_cust')}</div>
        <div class="field"><Icon name="Search" size={16} style="color:var(--ink-3)" /><input value={q} placeholder={t('bk_search_ph')} onInput={(e) => setQ(e.currentTarget.value)} /></div>
        <div class="card bk-pick">{(customer && !list.some((x) => x.id === customer) ? [d.customers.find((x) => x.id === customer), ...list] : list).filter(Boolean).map((x) => (
          <button class={`li ${customer === x.id ? 'on' : ''}`} onClick={() => setCustomer(x.id)}>
            <div class="grow"><div class="t">{x.name}</div><div class="s">{d.dues[x.id]?.pakka || d.dues[x.id]?.kacha ? t('bk_owes', money((d.dues[x.id].pakka || 0) + (d.dues[x.id].kacha || 0), false)) : x.phone || ''}</div></div>
            <span class={`radio ${customer === x.id ? 'on' : ''}`} /></button>))}
          {can('new') && !addCust && <button class="add-new-btn" onClick={() => setAddCust(true)}><Icon name="UserPlus" size={18} />{t('nc_add_here')}</button>}</div>
        {addCust && <AddCustomer d={d} hint={q.trim() || readNarration(l.narration, d.own).name} onCancel={() => setAddCust(false)}
          onPick={(x) => { if (!d.customers.some((y) => y.id === x.id)) d.customers.unshift(x); setCustomer(x.id); setQ(''); setAddCust(false); }} />}
        <div class="lbl" style="margin-top:12px">{t(c.instrument === 'dd' ? 'chq_number_dd' : 'chq_number')}</div>
        <div class="field"><input class="num" value={number} maxLength={20} onInput={(e) => setNumber(e.currentTarget.value.replace(/[^0-9A-Za-z/-]/g, '').toUpperCase())} placeholder="004512" /></div>
        {can('kacha') && <><div class="lbl" style="margin-top:12px">{t('which_account')}</div>
          <div class="seg"><button class={side === 'pakka' ? 'on' : ''} onClick={() => setSide('pakka')}>{t('bill_gst_short')}</button><button class={side === 'kacha' ? 'on' : ''} onClick={() => setSide('kacha')}>{t('bill_none_short')}</button></div></>}
        {customer && number && <div class="notice tone-accent" style="font-size:13.5px;margin-top:12px">{t('bk_chq_eff_in', money(amt, false), d.customers.find((x) => x.id === customer)?.name || '')}</div>}
      </>}
      {!cands.length && !fresh && <div class="notice tone-warn" style="font-size:13.5px;margin-top:12px">{t(isBack ? (c.kind === 'return' ? 'bk_chq_none_back' : 'bk_chq_none_out_back') : 'bk_chq_none_out')}</div>}

      <button class="btn btn-ghost btn-block" style="margin-top:14px" disabled={busy} onClick={onOther}><Icon name="ListChecks" size={16} />{t('bk_chq_other')}</button>
      {err && <div class="error">{err.message}</div>}
    </Sheet>
  );
}

/** A new customer right here, from a bank line (9 Nov 2026): the name (and phone, if the bank line has one) to check,
 *  "already in khata?" first (F9) — never the same customer twice. */
function AddCustomer({ d, hint, phone: ph, onPick, onCancel }) {
  const [name, setName] = useState(bankNameGuess(hint));
  const [phone, setPhone] = useState(ph ? String(ph).replace(/\D/g, '').slice(-10) : '');
  const add = useAction('createCustomer');
  const same = useSameCustomer(d.customers);
  const id = useRef(newKey());
  const save = async (notSame = same.notSame) => {
    if (!name.trim()) return;
    if (notSame === same.notSame && !(await same.ask({ name, phone }))) return;
    const c = await add.run({ id: id.current, name: name.trim(), phone: phone.trim() || null, ...(notSame.length ? { not_same: notSame } : {}) }).catch(() => null);
    if (c) { id.current = newKey(); forgetCatalog(); same.reset(); toast(t('nc_added', c.name)); onPick({ id: c.id, name: c.name, phone: c.phone || null }); }
  };
  return (
    <div class="card pad add-party">
      <div class="row" style="gap:8px;margin-bottom:10px"><Icon name="UserPlus" size={18} /><b class="grow">{t('new_customer')}</b>
        <button class="link" style="min-height:0" onClick={onCancel}>{t('cancel')}</button></div>
      <div class="lbl">{t('name')}</div>
      <div class="field"><input value={name} maxLength={200} onInput={(e) => { setName(e.currentTarget.value); same.reset(); }} autofocus /></div>
      {hint && name === bankNameGuess(hint) && <div class="faint add-party-hint">{t('ns_from_bank')}</div>}
      <div class="lbl" style="margin-top:12px">{t('phone')}</div>
      <div class="field"><span class="faint">+91</span><input type="tel" inputmode="numeric" value={phone} onInput={(e) => { setPhone(e.currentTarget.value); same.reset(); }} /></div>
      {same.box((c) => { same.reset(); onPick({ id: c.id, name: c.name, phone: c.phone || null }); }, (ids) => save(ids))}
      {add.error && <div class="error" style="margin-top:10px">{add.error.message}</div>}
      <button class="btn btn-accent btn-block" style="margin-top:12px" disabled={!name.trim() || add.busy || same.asking} onClick={() => save()}>
        <Icon name="Plus" size={18} stroke={2.4} />{t('nc_add')}</button>
    </div>
  );
}
