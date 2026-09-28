// "Send statement": pick a period and which bills, check the totals, then WhatsApp / print / download.
// Looking costs nothing (no link is made); only WhatsApp saves a copy with a link for the customer.
import { useEffect, useRef, useState } from 'preact/hooks';
import { periodDates } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { money } from '../../lib/format.js';
import { APP } from '../../config/app.js';
import { docPrefs, saveDocPrefs, makeStatementDoc, docUrl, statementText, pdfCaption, TEXT_MAX_ROWS, waLink, openWhatsApp, docFileName, fmtDay } from '../../lib/docs.js';
import { drawOffscreen, paperToPdf, shareOrSave, printPaper } from '../../lib/paper.js';
import { toast } from '../../ui/toast.js';
import { Icon } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { StatementPaper } from '../../ui/docs/Paper.jsx';
import { Preview } from '../../ui/docs/Preview.jsx';
import { WaChoice, WaModeLine } from '../../ui/docs/WaChoice.jsx';
import './docs-screens.css';

const PERIODS = [['this_month', 'p_this_month'], ['last_month', 'p_last_month'], ['last_3_months', 'p_last_3_months'], ['this_fy', 'p_this_fy'], ['pick', 'p_pick']];

export function StatementSheet({ open, c, sides = [], onClose }) {
  const tz = company.value?.timezone;
  const today = periodDates('this_month', new Date().toISOString(), tz).to;
  const [period, setPeriod] = useState('this_month');
  const [custom, setCustom] = useState({ from: today.slice(0, 8) + '01', to: today });
  const [which, setWhich] = useState('both');
  const [prefs, setPrefs] = useState(docPrefs());
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const [see, setSee] = useState(false);
  const [busy, setBusy] = useState(null);
  const [pending, setPending] = useState(null);
  const latest = useRef(null); // only the answer for the latest choice is shown
  const range = period === 'pick' ? custom : periodDates(period, new Date().toISOString(), tz);
  const showWhich = can('kacha') && sides.length > 1;
  const lang = prefs.lang;
  const args = { customerId: c.id, from: range.from, to: range.to, which: showWhich ? which : 'both', lang, upi: prefs.upi };

  useEffect(() => {
    if (!open) return;
    if (!range.from || !range.to || range.from > range.to) { setR(null); return; }
    setErr(null);
    const k = JSON.stringify(args); latest.current = k;
    makeStatementDoc({ ...args, preview: true }).then((x) => { if (latest.current === k) setR(x); }).catch((e) => { if (latest.current === k) setErr(e.message || t('err_generic')); });
  }, [open, range.from, range.to, which, lang, prefs.upi]);

  const doc = r?.doc;
  const nBills = doc ? doc.rows.filter((x) => x.type !== 'pay').length : 0;
  const nPays = doc ? doc.rows.filter((x) => x.type === 'pay').length : 0;
  const change = (p) => { saveDocPrefs(p); setPrefs({ ...prefs, ...p }); };

  // WhatsApp: as text (straight into the customer's chat) or as a PDF (phone's share menu).
  const [choose, setChoose] = useState(false);
  const tooLong = doc && doc.rows.length + 1 > TEXT_MAX_ROWS ? doc.rows.length + 1 : 0;
  const sendWa = () => {
    setPending(null);
    const mode = prefs.waMode === 'text' && tooLong ? 'pdf' : prefs.waMode;
    if (mode) runWa(mode); else setChoose(true);
  };
  const pick = (mode, remember) => { setChoose(false); if (remember) change({ waMode: mode }); runWa(mode); };
  const runWa = async (mode) => {
    if (mode === 'pdf') return pdf(true);
    setBusy('wa');
    try {
      const s = await makeStatementDoc({ ...args, send: true });
      const url = waLink(c.phone, statementText(s.doc, docUrl(s.token)));
      if (!openWhatsApp(url)) setPending({ kind: 'wa', url });
    } catch (e) { toast(e.message || t('err_generic')); } finally { setBusy(null); }
  };
  const pdf = async (forWa = false) => {
    setBusy(forWa ? 'wa' : 'pdf'); setPending(null);
    const { node, cleanup } = drawOffscreen(<StatementPaper doc={doc} showQr={prefs.upi} />);
    try {
      // for WhatsApp the copy is saved too (link in the note, and "sent" is recorded)
      const [file, saved] = await Promise.all([
        paperToPdf(node, { name: docFileName(doc), size: 'a4' }),
        forWa ? makeStatementDoc({ ...args, send: true }).catch(() => null) : null,
      ]);
      const text = forWa ? pdfCaption(doc, saved ? docUrl(saved.token) : null) : undefined;
      const res = await shareOrSave(file, text);
      if (res === 'needs_tap') setPending({ kind: 'pdf', file, text });
      else if (res === 'saved') toast(t('pdf_saved'));
    } catch (e) { toast(e.message || t('err_generic')); } finally { cleanup(); setBusy(null); }
  };
  const again = async () => {
    const p = pending; setPending(null);
    if (p?.kind === 'wa') openWhatsApp(p.url);
    if (p?.kind === 'pdf' && (await shareOrSave(p.file, p.text)) === 'saved') toast(t('pdf_saved'));
  };

  const Line = ({ a, b, strong, top }) => <div class="row" style={`justify-content:space-between;padding:${strong ? '10px' : '7px'} 0;${strong || top ? 'border-top:1px solid var(--line);' : ''}${strong ? 'font-size:16px' : ''}`}><span class={strong ? '' : 'muted'}>{strong ? <b>{a}</b> : a}</span><span class="num" style="font-weight:700">{b}</span></div>;

  return (
    <>
    <Sheet open={open && !choose} onClose={onClose} title={t('send_stmt')}
      footer={<>
        <button class="btn btn-wa btn-block" disabled={!doc || !!busy} onClick={sendWa}><Icon name="MessageCircle" size={20} stroke={2.4} />{busy === 'wa' ? t('getting_ready') : c.phone ? t('wa_to', c.name) : t('wa_stmt')}</button>
        <WaModeLine mode={prefs.waMode} onChange={() => change({ waMode: null })} />
        <div class="row" style="gap:10px;margin-top:10px">
          <button class="btn btn-ghost grow give-sm" disabled={!doc || !!busy} onClick={() => printPaper(<StatementPaper doc={doc} showQr={prefs.upi} />, 'a4')}><Icon name="Printer" size={18} />{t('print')}</button>
          <button class="btn btn-ghost grow give-sm" disabled={!doc || !!busy} onClick={() => pdf(false)}><Icon name="FileDown" size={18} />{busy === 'pdf' ? t('making_pdf') : t('download')}</button>
        </div>
        {pending && <button class={`btn btn-block ${pending.kind === 'wa' ? 'btn-wa' : 'btn-brand'}`} style="margin-top:10px" onClick={again}>{pending.kind === 'wa' ? t('open_wa') : t('pdf_ready')}</button>}
      </>}>
      <div class="lbl">{t('stmt_period')}</div>
      <div class="periods">{PERIODS.map(([id, w]) => <button class={`langchip ${period === id ? 'on' : ''}`} style="height:40px" onClick={() => setPeriod(id)}>{t(w)}</button>)}</div>
      {period === 'pick' && (
        <div class="row" style="gap:10px;margin-top:10px">
          <div class="grow"><div class="lbl">{t('p_from')}</div><div class="field"><input type="date" max={today} value={custom.from} onInput={(e) => setCustom({ ...custom, from: e.currentTarget.value })} /></div></div>
          <div class="grow"><div class="lbl">{t('p_to')}</div><div class="field"><input type="date" max={today} value={custom.to} onInput={(e) => setCustom({ ...custom, to: e.currentTarget.value })} /></div></div>
        </div>
      )}
      {showWhich && <>
        <div class="lbl" style="margin-top:14px">{t('stmt_which')}</div>
        <div class="seg">{[['both', 'stmt_both'], ['pakka', 'bill_gst_short'], ['kacha', 'bill_none_short']].map(([id, w]) => <button class={which === id ? 'on' : ''} onClick={() => setWhich(id)}>{t(w)}</button>)}</div>
        <div class="faint" style="font-size:12px;font-weight:600;margin-top:6px">{t('stmt_nb_note')}</div>
      </>}

      {err ? <div class="error">{err}</div> : (
        <div class="card stmt-sum">
          {!doc ? <div class="muted" style="padding:10px 0">…</div> : <>
            <Line a={t('stmt_bal_on', fmtDay(doc.period.from, false))} b={money(doc.opening, true)} />
            <Line a={t('stmt_bought_n', nBills)} b={`+ ${money(doc.bought, true)}`} />
            <Line a={<b style="color:var(--ink)">{t('stmt_total_due')}</b>} b={money(Math.round((doc.opening + doc.bought) * 100) / 100, true)} top />
            <Line a={t('stmt_paid_n', nPays)} b={`− ${money(doc.paid, true)}`} />
            <Line strong a={t('stmt_bal_on', fmtDay(doc.period.to, false))} b={doc.closing < 0 ? `${money(-doc.closing, true)} (${t('stmt_credit')})` : money(doc.closing, true)} />
          </>}
        </div>
      )}

      <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap">
        {APP.languages.map((x) => <button class={`langchip ${lang === x.id ? 'on' : ''}`} onClick={() => change({ lang: x.id })}>{x.label}</button>)}
        <div class="grow" />
        {doc && <button class="link" onClick={() => setSee(!see)}><Icon name="Eye" size={15} stroke={2.3} />{t('see')}</button>}
      </div>
      {see && doc && <div style="margin-top:12px"><Preview><StatementPaper doc={doc} showQr={prefs.upi} /></Preview></div>}
    </Sheet>
    <WaChoice open={open && choose} onClose={() => setChoose(false)} name={c.name} hasPhone={!!c.phone} tooLong={tooLong}
      sub={doc ? `${fmtDay(doc.period.from, false)} – ${fmtDay(doc.period.to, false)} · ${money(Math.max(0, doc.closing), true)}` : ''} onPick={pick} />
    </>
  );
}
