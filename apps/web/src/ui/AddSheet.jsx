// The big + (25 Oct 2026): "What do you want to add?" — a new order is the big tile on top; money received, an
// expense, stock that came in, moving money, a new customer, giving money back and counting the cash below.
// Only what this person may do is shown (config/navigation.js ADD). Money received / giving money back first ask
// "which customer?", then open that customer's account with the right sheet already open.
import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { t } from '../lib/i18n.js';
import { can } from '../lib/session.js';
import { go } from '../lib/router.js';
import { loadCatalog } from '../lib/catalog.js';
import { ADD } from '../config/navigation.js';
import { easy } from '../lib/easy.js';
import { Icon } from './kit.jsx';
import { Sheet } from './Sheet.jsx';
import { CustomerPicker } from '../screens/order/CustomerPicker.jsx';
import { regularRows } from '../lib/habits.js';
import { topCustomers } from '../lib/habitsMath.js';

/** What this person may add (in the shop's order). */
export const addItems = () => ADD.filter((x) => !x.perm || [].concat(x.perm).every((p) => can(p)));

export const addOpen = signal(false);

/** The + was tapped: one choice → straight there; more → the sheet. */
export function tapAdd() {
  const items = addItems();
  if (items.length === 1 && items[0].route) return go(items[0].route);
  addOpen.value = true;
}

/** Press and hold the + (about half a second): straight to a new order, like before. */
export function holdable(onTap, onHold, ms = 550) {
  let timer = null; let held = false;
  const start = () => { held = false; clearTimeout(timer); timer = setTimeout(() => { held = true; onHold(); }, ms); };
  const end = (e) => { clearTimeout(timer); if (held) { e?.preventDefault?.(); return; } };
  return {
    onPointerDown: start, onPointerUp: end, onPointerLeave: () => clearTimeout(timer), onPointerCancel: () => clearTimeout(timer),
    onClick: (e) => { if (held) { held = false; e.preventDefault(); return; } onTap(); },
    onContextMenu: (e) => e.preventDefault(),
  };
}

export function AddSheet() {
  const [pick, setPick] = useState(null);           // 'pay' | 'giveback' — choosing the customer
  const [customers, setCustomers] = useState([]);
  const [regs, setRegs] = useState([]);
  const open = addOpen.value;
  useEffect(() => { if (open || pick) { loadCatalog().then((c) => setCustomers(c?.customers || [])).catch(() => {}); regularRows().then((r) => setRegs(topCustomers(r))); } }, [open, pick]);
  const items = addItems();
  const big = items.find((x) => x.big);
  const rest = items.filter((x) => !x.big);
  const close = () => { addOpen.value = false; };
  const choose = (x) => {
    close();
    if (x.pick) return setPick(x.pick);
    go(x.route);
  };
  const large = easy.value.on;
  return (
    <>
      <Sheet open={open} onClose={close} title={t('add_title')}>
        {big && (
          <button class="add-big" onClick={() => choose(big)}>
            <div class="add-ic tone-accent"><Icon name={big.icon} size={30} stroke={2.1} /></div>
            <div class="grow" style="text-align:left"><div class="add-t">{t(big.word)}</div><div class="add-s">{t(big.hint)}</div></div>
            <Icon name="ChevronRight" size={22} style="color:var(--ink-3)" />
          </button>
        )}
        <div class={`add-grid ${large ? 'one' : ''}`}>
          {rest.map((x) => (
            <button class="add-tile" onClick={() => choose(x)}>
              <div class={`add-ic tone-${x.tone || 'neutral'}`}><Icon name={x.icon} size={24} stroke={2.1} /></div>
              <div class="add-t">{t(x.word)}</div>
              <div class="add-s">{t(x.hint)}</div>
            </button>
          ))}
        </div>
        {big && rest.length > 0 && <div class="faint" style="font-size:12.5px;font-weight:600;text-align:center;margin-top:12px">{t('add_hold')}</div>}
      </Sheet>
      <CustomerPicker open={!!pick} customers={customers} regulars={regs} title={pick === 'giveback' ? t('add_giveback_who') : t('add_pay_who')}
        onClose={() => setPick(null)}
        onPick={(c) => { const p = pick; setPick(null); go(`/customer/${c.id}?${p === 'giveback' ? 'giveback' : 'pay'}=1`); }} />
    </>
  );
}
