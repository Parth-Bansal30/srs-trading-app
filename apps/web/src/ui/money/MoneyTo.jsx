// "Where did the money go?" — used wherever money is taken or given back.
// One tap on an account = the whole amount goes there. "Split between accounts" = an amount per account,
// and it won't save until it adds up. Before the shop adds any accounts: the old Cash / UPI / Bank / Cheque.
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { money } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { PAY_METHODS, BANK_METHODS } from '../../config/options.js';
import { accountsCache, loadAccounts, kindOf, accName, accSub, isBankLike, lastAccount, rememberAccount, splitState } from '../../lib/accounts.js';
import { Icon, Skeleton } from '../kit.jsx';
import './money.css';

/** The first choice when a sheet opens: the account used last on this phone, else Shop cash. */
export function defaultWhere(list) {
  const usable = (list || []).filter((a) => a.usable !== false);
  if (usable.length <= 1) return { mode: 'Cash' };
  const last = lastAccount();
  const pick = usable.find((a) => a.id === last) || usable[0];
  return { ids: [pick.id], methods: {} };
}

/** Hook for a sheet: [where, setWhere, accounts] — reset every time the sheet opens. */
export function useWhere(open) {
  const [list, setList] = useState(accountsCache.value);
  const [where, setWhere] = useState(accountsCache.value ? defaultWhere(accountsCache.value) : null);
  useEffect(() => {
    if (!open) return;
    if (accountsCache.value) setWhere(defaultWhere(accountsCache.value));
    loadAccounts().then((l) => { setList(l); setWhere((w) => (w && w.ids && w.ids.every((id) => l.some((a) => a.id === id)) ? w : defaultWhere(l))); })
      .catch(() => { setList([]); setWhere({ mode: 'Cash' }); });
  }, [open]);
  return [where, setWhere, list];
}

/**
 * amount: the total (number). value / onChange: the where-state (see lib/accounts.js).
 * single: one account only (money given back). accounts: from useWhere.
 */
export function MoneyTo({ amount, value, onChange, accounts, single = false }) {
  // the total changed (e.g. the part paid now): the first account of a split keeps taking what is left
  useEffect(() => {
    if (!value?.split || !value.auto || !value.ids?.includes(value.auto)) return;
    const others = value.ids.filter((x) => x !== value.auto).reduce((t, x) => t + (Number(value.amounts?.[x]) || 0), 0);
    const rest = Math.round((amount - others) * 100) / 100;
    if (String(rest > 0 ? rest : 0) !== String(value.amounts?.[value.auto])) onChange({ ...value, amounts: { ...value.amounts, [value.auto]: String(rest > 0 ? rest : 0) } });
  }, [amount]);
  if (!value || !accounts) return <Skeleton h={120} />;
  if (!value.ids) {
    return (
      <>
        <div class="pick">{PAY_METHODS.map((p) => <button class={value.mode === p.id ? 'on' : ''} onClick={() => onChange({ mode: p.id })}><Icon name={p.icon} size={18} />{t(p.word)}</button>)}</div>
        {can('settings') && <button class="link" style="margin-top:6px" onClick={() => go('/settings/accounts')}><Icon name="Plus" size={16} />{t('acc_setup_hint')}</button>}
      </>
    );
  }
  const usable = accounts.filter((a) => a.usable !== false);
  const split = !!value.split && !single;
  const st = split ? splitState(value, amount, accounts) : null;
  const set = (patch) => onChange({ ...value, ...patch });
  // the first account takes whatever is left (until someone types its amount), so a split always adds up
  const balance = (ids, amounts, auto) => {
    if (!auto || !ids.includes(auto)) return amounts;
    const others = ids.filter((x) => x !== auto).reduce((t, x) => t + (Number(amounts[x]) || 0), 0);
    const rest = Math.round((amount - others) * 100) / 100;
    return { ...amounts, [auto]: rest > 0 ? String(rest) : '0' };
  };
  const typeAmount = (id, v) => {
    const amounts = { ...value.amounts, [id]: v };
    const auto = id === value.auto ? null : value.auto;
    set({ amounts: balance(value.ids, amounts, auto), auto });
  };
  const tap = (a) => {
    rememberAccount(a.id);
    if (!split) return set({ ids: [a.id] });
    if (value.ids.includes(a.id)) {
      if (value.ids.length > 1) { const ids = value.ids.filter((x) => x !== a.id); set({ ids, amounts: balance(ids, value.amounts, value.auto) }); }
      return;
    }
    const left = st ? st.left : 0;
    set({ ids: [...value.ids, a.id], amounts: { ...value.amounts, [a.id]: left > 0 ? String(left) : '' } });
  };
  const setMethod = (id, m) => set({ methods: { ...value.methods, [id]: value.methods?.[id] === m ? undefined : m } });

  return (
    <div>
      <div class="acc-list card">
        {usable.map((a) => {
          const on = value.ids.includes(a.id);
          const k = kindOf(a);
          return (
            <div class={`acc-row ${on ? 'on' : ''}`}>
              <button class="acc-main" onClick={() => tap(a)} aria-pressed={on}>
                <span class="acc-ic" style={`background:${k.tone}`}><Icon name={k.icon} size={18} stroke={2.2} /></span>
                <span class="grow" style="min-width:0">
                  <span class="acc-name">{accName(a)}{a.owner === 'personal' && <span class="acc-own">{t('acc_personal')}</span>}</span>
                  <span class="acc-sub">{accSub(a)}</span>
                </span>
                {!split && <span class={`radio ${on ? 'on' : ''}`} />}
              </button>
              {split && on && (
                <div class="field acc-amt num"><span class="faint">₹</span>
                  <input inputmode="decimal" value={value.amounts?.[a.id] ?? ''} placeholder="0"
                    onInput={(e) => typeAmount(a.id, e.currentTarget.value.replace(/[^\d.]/g, ''))} /></div>
              )}
              {on && isBankLike(a) && (
                <div class="acc-methods">{BANK_METHODS.map((m) => <button class={value.methods?.[a.id] === m ? 'on' : ''} onClick={() => setMethod(a.id, m)}>{m === 'Cheque' ? t('pm_cheque') : m}</button>)}</div>
              )}
            </div>
          );
        })}
      </div>
      {!single && !split && usable.length > 1 && (
        <button class="btn btn-ghost btn-block acc-split" onClick={() => set({ split: true, auto: value.ids[0], amounts: { [value.ids[0]]: amount > 0 ? String(amount) : '' } })}>
          <Icon name="Split" size={18} />{t('acc_split')}
        </button>
      )}
      {split && (
        <>
          <div class={`notice ${st.ok ? 'tone-ok' : st.problem === 'over' ? 'tone-bad' : 'tone-warn'} acc-status`}>
            <span>{st.ok ? <><Icon name="CircleCheck" size={16} /> {t('acc_all_placed')}</> : st.problem === 'over' ? t('acc_too_much', money(-st.left, true))
              : st.problem === 'short' ? t('acc_left', money(st.left, true)) : t('acc_each')}</span>
            <span class="num">{t('acc_of', money(st.placed, true), money(amount, true))}</span>
          </div>
          <button class="link" onClick={() => set({ split: false, ids: [value.ids[0]] })}>{t('acc_one_only')}</button>
        </>
      )}
      {!split && !single && <div class="faint acc-hint">{t('acc_customer_sees')}</div>}
    </div>
  );
}
