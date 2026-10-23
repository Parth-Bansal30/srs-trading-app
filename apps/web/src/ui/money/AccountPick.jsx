// Choose ONE money account (money going out, or one side of a move): radio rows, the drawer first,
// and how it was paid for a bank account (UPI / IMPS / NEFT / RTGS / Cheque).
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { go } from '../../lib/router.js';
import { BANK_METHODS } from '../../config/options.js';
import { kindOf, accName, accSub, isBankLike } from '../../lib/accounts.js';
import { Icon, Skeleton } from '../kit.jsx';
import './money.css';

/**
 * accounts: the usable list (from loadAccounts). value: account id. method: for a bank account.
 * hide: an account id not to offer (the other side of a move).
 */
export function AccountPick({ accounts, value, onChange, method, onMethod, hide = null, showMethods = true }) {
  if (!accounts) return <Skeleton h={110} />;
  const list = accounts.filter((a) => a.usable !== false && a.id !== hide);
  return (
    <>
      <div class="acc-list card">
        {list.map((a) => {
          const on = value === a.id;
          const k = kindOf(a);
          return (
            <div class={`acc-row ${on ? 'on' : ''}`}>
              <button class="acc-main" onClick={() => onChange(a.id)} aria-pressed={on}>
                <span class="acc-ic" style={`background:${k.tone}`}><Icon name={k.icon} size={18} stroke={2.2} /></span>
                <span class="grow" style="min-width:0">
                  <span class="acc-name">{accName(a)}{a.owner === 'personal' && <span class="acc-own">{t('acc_personal')}</span>}</span>
                  <span class="acc-sub">{accSub(a)}</span>
                </span>
                <span class={`radio ${on ? 'on' : ''}`} />
              </button>
              {on && showMethods && isBankLike(a) && onMethod && (
                <div class="acc-methods">{BANK_METHODS.map((m) => <button class={method === m ? 'on' : ''} onClick={() => onMethod(method === m ? null : m)}>{m === 'Cheque' ? t('pm_cheque') : m}</button>)}</div>
              )}
            </div>
          );
        })}
      </div>
      {list.length <= 1 && can('settings') && <button class="link" style="margin-top:6px" onClick={() => go('/settings/accounts')}><Icon name="Plus" size={16} />{t('acc_setup_hint')}</button>}
    </>
  );
}
