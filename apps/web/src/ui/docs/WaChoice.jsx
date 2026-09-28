// "Send on WhatsApp": as text (straight into the customer's chat) or as a PDF (through the phone's share menu).
import { useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { Icon } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';

export function WaChoice({ open, onClose, name, hasPhone, sub, tooLong = 0, onPick }) {
  const [remember, setRemember] = useState(false);
  const who = name || '…';
  return (
    <Sheet open={open} onClose={onClose} title={t('wa_how')}>
      {sub && <div class="muted" style="font-size:14px;margin-bottom:12px">{sub}</div>}
      <button class="wac" disabled={tooLong > 0} onClick={() => onPick('text', remember)}>
        <div class="wac-ic" style="background:var(--wa)"><Icon name="MessageSquareText" size={24} stroke={2.2} /></div>
        <div class="grow"><div class="wac-t">{t('wa_text_t')}</div>
          <div class="wac-s">{tooLong > 0 ? t('wa_too_long', tooLong) : hasPhone ? t('wa_text_s', who) : t('wa_text_s2')}</div></div>
      </button>
      <button class="wac" onClick={() => onPick('pdf', remember)}>
        <div class="wac-ic" style="background:#E74C3C;font-weight:800;font-size:13px">PDF</div>
        <div class="grow"><div class="wac-t">{t('wa_pdf_t')}</div><div class="wac-s">{t('wa_pdf_s', who)}</div></div>
      </button>
      <label class="row" style="gap:10px;margin-top:14px;font-weight:600;font-size:14px">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} style="width:22px;height:22px" />{t('wa_remember')}
      </label>
    </Sheet>
  );
}

/** Small line under a WhatsApp button when a choice is remembered: "Sending as text · change". */
export const WaModeLine = ({ mode, onChange }) => (mode ? (
  <div class="faint" style="font-size:12.5px;font-weight:600;text-align:center;margin-top:6px">
    {t(mode === 'pdf' ? 'wa_mode_pdf' : 'wa_mode_text')} · <button class="link" style="font-size:12.5px;display:inline" onClick={onChange}>{t('wa_change')}</button>
  </div>
) : null);
