// Choose a customer (search by name or number) or add a new one.
import { useRef, useState } from 'preact/hooks';
import { newKey } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { useAction } from '../../lib/action.js';
import { forgetCatalog } from '../../lib/catalog.js';
import { avatarColour, firstLetter } from '../../lib/customers.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { Icon } from '../../ui/kit.jsx';
import { useSameCustomer } from '../khata/SameCustomer.jsx';

export function CustomerPicker({ open, customers, onClose, onPick, title, regulars = [], noAdd = false }) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const add = useAction('createCustomer');
  const same = useSameCustomer(customers);   // "already in khata?" (F9)
  const newId = useRef(newKey());   // the new customer's id is chosen here (works without internet too)
  const s = q.trim().toLowerCase();
  const list = customers.filter((c) => c.active && !c.joined_into && (c.name.toLowerCase().includes(s) || (c.phone || '').replace(/\D/g, '').includes(s.replace(/\D/g, '') || '§')));
  const save = async (notSame = same.notSame) => {
    if (!name.trim()) return;
    if (notSame === same.notSame && !(await same.ask({ name, phone }))) return;   // asks first; "different person" comes back here
    const id = newId.current;
    const c = await add.run({ id, name, phone, ...(notSame.length ? { not_same: notSame } : {}) }, { local: () => ({ meta: { customer: { id, name: name.trim(), phone: phone.trim() || null }, creates: [id] },
      result: { id, name: name.trim(), phone: phone.trim() || null, active: true, local: true } }) }).catch(() => null);
    if (c) { newId.current = newKey(); forgetCatalog(); customers.push(c); setAdding(false); setName(''); setPhone(''); same.reset(); onPick(c); }
  };
  return (
    <Sheet open={open} onClose={onClose} title={adding ? t('new_customer') : title || t('choose_customer')}
      footer={adding
        ? <button class="btn btn-accent btn-block" disabled={add.busy || !name.trim() || same.asking} onClick={() => save()}>{t('add_save')}</button>
        : can('new') && !noAdd && <button class="btn btn-ghost btn-block" onClick={() => { setAdding(true); setName(q); }}><Icon name="Plus" size={18} stroke={2.4} />{t('new_customer')}</button>}>
      {adding ? (
        <>
          <div class="lbl">{t('name')}</div>
          <div class="field"><input value={name} onInput={(e) => { setName(e.currentTarget.value); same.reset(); }} autofocus /></div>
          <div class="lbl" style="margin-top:14px">{t('phone')}</div>
          <div class="field"><span class="faint">+91</span><input type="tel" inputmode="numeric" value={phone} onInput={(e) => { setPhone(e.currentTarget.value); same.reset(); }} /></div>
          {same.box((c) => { same.reset(); setAdding(false); setName(''); setPhone(''); onPick(c); }, (ids) => save(ids))}
          {add.error && <div class="error">{add.error.message}</div>}
        </>
      ) : (
        <>
          <div class="field" style="margin-bottom:12px"><Icon name="Search" size={18} /><input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('search_cust')} /></div>
          {!s && regulars.length > 0 && (() => {
            const byId = new Map(customers.map((c) => [c.id, c]));
            const top = regulars.map((x) => byId.get(x.id)).filter((c) => c && c.active);
            return top.length > 0 && <>
              <div class="lbl">{t('cp_regulars')}</div>
              <div class="reg-chips">{top.map((c) => <button class="reg-chip" onClick={() => onPick(c)}><span class="cav sm" style={`background:${avatarColour(c.id)}`}>{firstLetter(c.name)}</span><span class="ellip">{c.name}</span></button>)}</div>
              <div class="lbl" style="margin-top:12px">{t('cp_all')}</div>
            </>;
          })()}
          <div class="card">
            {list.map((c) => (
              <button class="li" onClick={() => onPick(c)}>
                <div class="grow"><div class="t">{c.name}</div><div class="s">{c.phone || t('no_phone')}</div></div>
                <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
              </button>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}
