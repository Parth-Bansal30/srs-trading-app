// Giving the finished slip to the customer: WhatsApp (with a link to the slip), print, PDF,
// or look at it first. The big green button works in one tap; choices are remembered.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { company } from '../../lib/session.js';
import { loadCatalog } from '../../lib/catalog.js';
import { money, shortDate, time } from '../../lib/format.js';
import { APP } from '../../config/app.js';
import { docPrefs, saveDocPrefs, makeSlipDoc, sentInfo, docUrl, slipMessage, waLink, openWhatsApp, docFileName, isSampleUpi } from '../../lib/docs.js';
import { drawOffscreen, paperToPdf, shareOrSave, printPaper } from '../../lib/paper.js';
import { toast } from '../../ui/toast.js';
import { Icon } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { SlipPaper } from '../../ui/docs/Paper.jsx';
import { Preview } from '../../ui/docs/Preview.jsx';
import './docs-screens.css';

/** The same message as slipMessage(doc), made from the loaded order (so WhatsApp can open at once). */
function quickDoc(o, shopName, lang) {
  const total = Number(o.total_amount);
  return { lang, timezone: company.value?.timezone, shop: { name: shopName }, customer: { name: o.customers?.name },
    slip: { no: o.slip_no, at: o.done_at, total, paid: o.paid, balance: Math.max(0, Math.round((total - o.paid) * 100) / 100) } };
}

/** Everything the slip page needs to give a finished slip away. */
export function useGiveSlip(o) {
  const [prefs, setPrefs] = useState(docPrefs());
  const [info, setInfo] = useState([]);
  const [busy, setBusy] = useState(null);        // 'wa' | 'pdf' | 'print'
  const [pending, setPending] = useState(null);  // { kind: 'wa', url } | { kind: 'pdf', file, text } — needs one more tap
  const [shop, setShop] = useState(company.value?.name || '');
  const reload = () => sentInfo(o.id).then(setInfo).catch(() => {});
  useEffect(() => {
    reload();
    loadCatalog().then((c) => setShop(c.settings?.slip_header?.name || company.value?.name || '')).catch(() => {});
  }, [o.id]);
  const change = (p) => { saveDocPrefs(p); setPrefs({ ...prefs, ...p }); };
  const phone = o.customers?.phone;

  const sendWa = async (docResult) => {
    setPending(null);
    const lang = prefs.lang;
    const known = docResult?.token || info.find((x) => x.lang === lang)?.token;
    if (known) {
      const doc = docResult?.doc || quickDoc(o, shop, lang);
      const url = waLink(phone, slipMessage(doc, docUrl(known)));
      if (!openWhatsApp(url)) setPending({ kind: 'wa', url });
      makeSlipDoc({ orderId: o.id, lang, upi: prefs.upi, send: true }).then(reload).catch(() => {});
      return;
    }
    setBusy('wa');
    try {
      const r = await makeSlipDoc({ orderId: o.id, lang, upi: prefs.upi, send: true });
      const url = waLink(phone, slipMessage(r.doc, docUrl(r.token)));
      if (!openWhatsApp(url)) setPending({ kind: 'wa', url });
      reload();
    } catch (e) { toast(e.message || t('err_generic')); } finally { setBusy(null); }
  };

  const withDoc = async (fn, what, given) => {
    setBusy(what); setPending(null);
    try { await fn(given || await makeSlipDoc({ orderId: o.id, lang: prefs.lang, upi: prefs.upi })); } catch (e) { toast(e.message || t('err_generic')); } finally { setBusy(null); }
  };
  const pdf = (given) => withDoc(async (r) => {
    toast(t('making_pdf'));
    const { node, cleanup } = drawOffscreen(<SlipPaper doc={r.doc} size={prefs.size} showQr={prefs.upi} />);
    try {
      const file = await paperToPdf(node, { name: docFileName(r.doc), size: prefs.size });
      const text = slipMessage(r.doc, docUrl(r.token));
      const res = await shareOrSave(file, text);
      if (res === 'needs_tap') setPending({ kind: 'pdf', file, text });
      else if (res === 'saved') toast(t('pdf_saved'));
    } finally { cleanup(); }
  }, 'pdf', given);
  const print = (given) => withDoc(async (r) => printPaper(<SlipPaper doc={r.doc} size={prefs.size} showQr={prefs.upi} />, prefs.size), 'print', given);
  const again = async () => {
    const p = pending; setPending(null);
    if (p?.kind === 'wa') openWhatsApp(p.url);
    if (p?.kind === 'pdf') { const res = await shareOrSave(p.file, p.text); if (res === 'saved') toast(t('pdf_saved')); }
  };
  return { prefs, change, info, busy, pending, again, sendWa, pdf, print, phone };
}

function SentLine({ info }) {
  const tz = company.value?.timezone;
  const sent = info.filter((x) => x.sent_at).sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];
  const opened = info.reduce((a, x) => a + (x.open_count || 0), 0);
  if (!sent) return <div class="faint" style="font-size:12px;font-weight:600;margin-top:10px;text-align:center">{t('not_sent')} · {t('sent_help')}</div>;
  return (
    <div class="row" style="justify-content:center;gap:6px;margin-top:10px;font-size:13px;font-weight:700;color:var(--ok)">
      <Icon name="CircleCheck" size={16} stroke={2.4} />{t('sent_on', `${shortDate(sent.sent_at, tz)}, ${time(sent.sent_at, tz)}`)}{opened > 0 && <span class="faint" style="font-weight:600">· {t('opened_n', opened)}</span>}
    </div>
  );
}

function AgainButton({ g }) {
  if (!g.pending) return null;
  return g.pending.kind === 'wa'
    ? <button class="btn btn-wa btn-block" style="margin-top:10px" onClick={g.again}><Icon name="MessageCircle" size={20} stroke={2.4} />{t('open_wa')}</button>
    : <button class="btn btn-brand btn-block" style="margin-top:10px" onClick={g.again}><Icon name="FileDown" size={20} stroke={2.3} />{t('pdf_ready')}</button>;
}

/** The card on a finished slip: big WhatsApp button + Print / PDF / See. */
function GiveSlipCard({ g, o, openSheet }) {
  return (
    <div class="give">
      <div class="lbl">{t('give_slip')}</div>
      <button class="btn btn-wa btn-block" disabled={!!g.busy} onClick={() => g.sendWa()}>
        <Icon name="MessageCircle" size={20} stroke={2.4} />{g.busy === 'wa' ? t('getting_ready') : g.phone ? t('wa_to', o.customers?.name) : t('wa_choose')}
      </button>
      <div class="row" style="gap:10px;margin-top:10px">
        <button class="btn btn-ghost grow give-sm" disabled={!!g.busy} onClick={() => g.print()}><Icon name="Printer" size={19} />{t('print')}</button>
        <button class="btn btn-ghost grow give-sm" disabled={!!g.busy} onClick={() => g.pdf()}><Icon name="FileDown" size={19} />{g.busy === 'pdf' ? '…' : t('pdf')}</button>
        <button class="btn btn-ghost grow give-sm" onClick={openSheet}><Icon name="Eye" size={19} />{t('see')}</button>
      </div>
      <AgainButton g={g} />
      <SentLine info={g.info} />
    </div>
  );
}

/** "Send slip #…": live preview + choices (size, language, UPI QR), then WhatsApp / Print / PDF. */
function SendSlipSheet({ g, o, open, onClose }) {
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  const { size, lang, upi } = g.prefs;
  useEffect(() => {
    if (!open) return;
    setErr(null);
    makeSlipDoc({ orderId: o.id, lang, upi }).then(setR).catch((e) => setErr(e.message || t('err_generic')));
  }, [open, lang, upi]);
  const balance = Math.max(0, Number(o.total_amount) - o.paid);
  const upiId = r?.doc?.upi?.id;
  return (
    <Sheet open={open} onClose={onClose} title={t('send_slip_t', o.slip_no)}
      footer={<>
        <button class="btn btn-wa btn-block" disabled={!r || !!g.busy} onClick={() => g.sendWa(r)}><Icon name="MessageCircle" size={20} stroke={2.4} />{g.phone ? t('wa_to', o.customers?.name) : t('wa_choose')}</button>
        <div class="row" style="gap:10px;margin-top:10px">
          <button class="btn btn-ghost grow give-sm" disabled={!r || !!g.busy} onClick={() => g.print(r)}><Icon name="Printer" size={19} />{t('print')}</button>
          <button class="btn btn-ghost grow give-sm" disabled={!r || !!g.busy} onClick={() => g.pdf(r)}><Icon name="Share2" size={19} />{g.busy === 'pdf' ? t('making_pdf') : t('share_pdf')}</button>
        </div>
        <AgainButton g={g} />
      </>}>
      {err ? <div class="error">{err}</div> : !r ? <div class="pp-preview" style="height:260px" /> : (
        <Preview><SlipPaper doc={r.doc} size={size} showQr={upi} /></Preview>
      )}
      <div class="lbl" style="margin-top:14px">{t('size_label')}</div>
      <div class="seg">
        <button class={size === 'page' ? 'on' : ''} onClick={() => g.change({ size: 'page' })}><Icon name="Smartphone" size={15} />&nbsp;{t('size_page')}</button>
        <button class={size === 'roll' ? 'on' : ''} onClick={() => g.change({ size: 'roll' })}><Icon name="ReceiptText" size={15} />&nbsp;{t('size_roll')}</button>
      </div>
      <div class="card" style="margin-top:12px">
        <div class="li" style="flex-wrap:wrap"><div class="grow"><div class="t">{t('doc_lang')}</div></div>
          <div class="row" style="gap:6px">{APP.languages.map((x) => <button class={`langchip ${lang === x.id ? 'on' : ''}`} onClick={() => g.change({ lang: x.id })}>{x.label}</button>)}</div></div>
        {balance > 0 && (
          <label class="li"><div class="grow"><div class="t">{t('show_upi')}</div>
            <div class="s">{upiId ? (isSampleUpi(upiId) ? t('upi_is_sample') : upiId) : r && !r.doc.upi && upi ? t('no_upi_yet') : ''}</div></div>
            <input type="checkbox" class="switch" checked={upi} onChange={(e) => g.change({ upi: e.currentTarget.checked })} /></label>
        )}
      </div>
      {balance > 0 && <div class="faint num" style="font-size:12px;font-weight:600;margin-top:8px">{t('bal_to_pay')}: {money(balance, true)}</div>}
    </Sheet>
  );
}

/** Card + sheet together (they share the remembered choices). autoOpen: open the sheet at once. */
export function GiveSlip({ o, autoOpen = false }) {
  const g = useGiveSlip(o);
  const [open, setOpen] = useState(autoOpen);
  return <>
    <GiveSlipCard g={g} o={o} openSheet={() => setOpen(true)} />
    <SendSlipSheet g={g} o={o} open={open} onClose={() => setOpen(false)} />
  </>;
}
