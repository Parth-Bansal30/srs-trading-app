// Easy mode: after money is SAVED, a full green screen "₹45,000 मिल गए · Sharma ji" (and it is said out loud).
import { t } from '../../lib/i18n.js';
import { money } from '../../lib/format.js';
import { praise, sayAgain, easy } from '../../lib/easy.js';
import { Icon } from '../kit.jsx';
import './easy.css';

export function Praise() {
  const p = praise.value;
  if (!p) return null;
  const close = () => { praise.value = null; };
  return (
    <div class="praise" role="dialog" aria-live="assertive">
      <div class="praise-tick"><Icon name="Check" size={60} stroke={3} /></div>
      <div class="num praise-amt">{money(p.amount, false)}</div>
      <div class="praise-got">{t('praise_got')}</div>
      {(p.customer || p.slipNo) && <div class="praise-who">{[p.customer, p.slipNo ? `#${p.slipNo}` : null].filter(Boolean).join(' · ')}</div>}
      <div class="row" style="gap:8px;justify-content:center;flex-wrap:wrap;margin-top:12px">
        {p.account && <span class="praise-chip">{p.account}</span>}
        {p.balance != null && <span class="praise-chip">{t('praise_bal', money(p.balance, false))}</span>}
      </div>
      <div class="row" style="gap:10px;margin-top:28px;width:100%">
        {easy.value.speak !== 'off' && <button class="btn btn-ghost grow" onClick={sayAgain}><Icon name="RotateCcw" size={19} />{t('praise_again')}</button>}
        <button class="btn btn-brand grow" onClick={close} autofocus>{t('praise_ok')}</button>
      </div>
      <div class="praise-note">{t('praise_note')}</div>
    </div>
  );
}
