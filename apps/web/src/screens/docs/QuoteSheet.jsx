// "Send the price on WhatsApp" for an estimate or an open order (26 Oct 2026 walkthrough): the customer phoned for a price;
// now the shop sends it in one tap — GST bill or no bill, in the customer's language. Same rules as the slip (lib/docs.js).
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { loadCatalog } from '../../lib/catalog.js';
import { APP } from '../../config/app.js';
import { docPrefs, saveDocPrefs, quoteText, waLink, openWhatsApp } from '../../lib/docs.js';
import { toast } from '../../ui/toast.js';
import { Icon } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import './docs-screens.css';

export function QuoteSheet({ o, onClose }) {
  const [bill, setBill] = useState('pakka');
  const [lang, setLang] = useState(docPrefs().lang);
  const [cat, setCat] = useState(null);
  const [again, setAgain] = useState(null); // the WhatsApp link when the phone blocked it
  useEffect(() => { loadCatalog().then(setCat).catch(() => setCat({ settings: {} })); }, []);
  const s = cat?.settings || {};
  const text = cat ? quoteText(o, { bill, lang, shop: s.slip_header?.name || company.value?.name || '', gstPct: Number(s.gst_pct ?? 18),
    kachaPct: Number(s.kacha_pct ?? 10), tz: company.value?.timezone || 'Asia/Kolkata' }) : '';
  const phone = o.customers?.phone;
  const send = () => { const url = waLink(phone, text); if (!openWhatsApp(url)) setAgain(url); };
  const copy = () => navigator.clipboard?.writeText(text).then(() => toast(t('qt_copied'))).catch(() => {});
  return (
    <Sheet open onClose={onClose} title={t('qt_title', o.slip_no)}
      footer={<>
        <button class="btn btn-wa btn-block" disabled={!cat} onClick={send}><Icon name="MessageCircle" size={20} stroke={2.4} />{phone ? t('wa_to', o.customers?.name) : t('wa_choose')}</button>
        {again && <button class="btn btn-brand btn-block" style="margin-top:8px" onClick={() => { openWhatsApp(again); setAgain(null); }}>{t('open_wa')}</button>}
        <button class="btn btn-ghost btn-block" style="margin-top:8px" disabled={!cat} onClick={copy}><Icon name="Copy" size={18} />{t('qt_copy')}</button>
      </>}>
      {can('kacha') && <>
        <div class="lbl">{t('qt_which')}</div>
        <div class="seg" style="margin-bottom:12px"><button class={bill === 'pakka' ? 'on' : ''} onClick={() => setBill('pakka')}>{t('bill_gst_short')}</button>
          <button class={bill === 'kacha' ? 'on' : ''} onClick={() => setBill('kacha')}>{t('bill_none_short')}</button></div>
      </>}
      <div class="lbl">{t('qt_lang')}</div>
      <div class="row" style="gap:6px;margin-bottom:12px">{APP.languages.map((x) => <button class={`langchip ${lang === x.id ? 'on' : ''}`} onClick={() => { setLang(x.id); saveDocPrefs({ lang: x.id }); }}>{x.label}</button>)}</div>
      <div class="qt-preview">{text || '…'}</div>
    </Sheet>
  );
}
