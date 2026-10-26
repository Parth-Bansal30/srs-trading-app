// Choose a customer (search by name or number) or add a new one.
import { useRef, useState } from 'preact/hooks';
import { newKey } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { useAction } from '../../lib/action.js';
import { forgetCatalog } from '../../lib/catalog.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { Icon } from '../../ui/kit.jsx';

export function CustomerPicker({ open, customers, onClose, onPick, title }) {
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const add = useAction('createCustomer');
  const newId = useRef(newKey());   // the new customer's id is chosen here (works without internet too)
  const s = q.trim().toLowerCase();
  const list = customers.filter((c) => c.active && (c.name.toLowerCase().includes(s) || (c.phone || '').replace(/\D/g, '').includes(s.replace(/\D/g, '') || '§')));
  const save = async () => {
    if (!name.trim()) return;
    const id = newId.current;
    const c = await add.run({ id, name, phone }, { local: () => ({ meta: { customer: { id, name: name.trim(), phone: phone.trim() || null }, creates: [id] },
      result: { id, name: name.trim(), phone: phone.trim() || null, active: true, local: true } }) }).catch(() => null);
    if (c) { newId.current = newKey(); forgetCatalog(); customers.push(c); setAdding(false); setName(''); setPhone(''); onPick(c); }
  };
  return (
    <Sheet open={open} onClose={onClose} title={adding ? t('new_customer') : title || t('choose_customer')}
      footer={adding
        ? <button class="btn btn-accent btn-block" disabled={add.busy || !name.trim()} onClick={save}>{t('add_save')}</button>
        : can('new') && <button class="btn btn-ghost btn-block" onClick={() => { setAdding(true); setName(q); }}><Icon name="Plus" size={18} stroke={2.4} />{t('new_customer')}</button>}>
      {adding ? (
        <>
          <div class="lbl">{t('name')}</div>
          <div class="field"><input value={name} onInput={(e) => setName(e.currentTarget.value)} autofocus /></div>
          <div class="lbl" style="margin-top:14px">{t('phone')}</div>
          <div class="field"><span class="faint">+91</span><input type="tel" inputmode="numeric" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} /></div>
          {add.error && <div class="error">{add.error.message}</div>}
        </>
      ) : (
        <>
          <div class="field" style="margin-bottom:12px"><Icon name="Search" size={18} /><input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('search_cust')} /></div>
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
