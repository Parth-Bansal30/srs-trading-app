// Add or edit a customer: name, mobile (WhatsApp), GST number (checked as you type), area, a private note.
import { useEffect, useState } from 'preact/hooks';
import { checkGstin } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { useAction } from '../../lib/action.js';
import { forgetCatalog } from '../../lib/catalog.js';
import { Icon } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';

const blank = { name: '', phone: '', gstin: '', address: '', notes: '' };
const canPickContact = typeof navigator !== 'undefined' && 'contacts' in navigator && 'select' in (navigator.contacts || {});

/** c = the customer to edit, or null to add a new one. onSaved(customer) after saving. */
export function CustomerEdit({ open, c, onClose, onSaved }) {
  const [v, setV] = useState(blank);
  const add = useAction('createCustomer');
  const upd = useAction('updateCustomer');
  const a = c ? upd : add;
  useEffect(() => {
    if (!open) return;
    setV(c ? { name: c.name || '', phone: c.phone || '', gstin: c.gstin || '', address: c.address || '', notes: c.notes || '' } : blank);
    add.setError(null); upd.setError(null);
  }, [open, c?.id]);
  const set = (k) => (e) => setV({ ...v, [k]: k === 'gstin' ? e.currentTarget.value.toUpperCase().replace(/\s/g, '') : e.currentTarget.value });
  const g = v.gstin.trim() ? checkGstin(v.gstin) : null;
  const gShow = g && v.gstin.trim().length >= 15;

  const pick = async () => {
    try {
      const [p] = await navigator.contacts.select(['name', 'tel'], { multiple: false });
      if (!p) return;
      setV((x) => ({ ...x, name: x.name || p.name?.[0] || '', phone: (p.tel?.[0] || '').replace(/[^\d+]/g, '') }));
    } catch { /* closed */ }
  };

  const save = async () => {
    let out;
    if (c) {
      const changes = {};
      for (const k of Object.keys(blank)) if ((v[k] || '').trim() !== (c[k] || '').trim()) changes[k] = v[k].trim();
      if (!Object.keys(changes).length) return onClose();
      out = await upd.run({ customer_id: c.id, changes }).catch(() => null);
    } else {
      out = await add.run({ name: v.name, phone: v.phone, gstin: v.gstin || undefined, address: v.address || undefined, notes: v.notes || undefined }).catch(() => null);
    }
    if (out) { forgetCatalog(); onSaved(out); }
  };

  return (
    <Sheet open={open} onClose={onClose} title={c ? t('cust_edit') : t('new_customer')}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !v.name.trim() || (gShow && !g.ok)} onClick={save}>{t('save')}</button>}>
      <div class="lbl">{t('name')}</div>
      <div class="field"><input value={v.name} onInput={set('name')} autofocus={!c} /></div>
      <div class="lbl" style="margin-top:12px">{t('cust_mobile')}</div>
      <div class="field"><span class="faint">+91</span><input type="tel" inputmode="tel" value={v.phone} onInput={set('phone')} /></div>
      {canPickContact && <button class="link" style="margin-top:8px" onClick={pick}><Icon name="Contact" size={15} stroke={2.3} />{t('cust_pick_contact')}</button>}
      <div class="lbl" style="margin-top:12px">{t('cust_gstin')}</div>
      <div class="field" style={gShow ? `border-color:var(--${g.ok ? 'ok' : 'bad'})` : ''}>
        <input class="num" style="letter-spacing:.03em" maxLength={15} value={v.gstin} onInput={set('gstin')} placeholder="07ABCDE1234F1Z5" />
        {gShow && g.ok && <Icon name="CircleCheck" size={18} stroke={2.3} style="color:var(--ok)" />}
      </div>
      {gShow && <div style={`font-size:13px;font-weight:600;margin-top:6px;color:var(--${g.ok ? 'ok' : 'bad'})`}>{g.ok ? t('cust_gstin_ok', g.state) : t('cust_gstin_bad')}</div>}
      <div class="lbl" style="margin-top:12px">{t('cust_area')}</div>
      <input class="textarea" value={v.address} onInput={set('address')} maxLength={300} />
      <div class="lbl" style="margin-top:12px">{t('cust_note')}</div>
      <input class="textarea" value={v.notes} onInput={set('notes')} maxLength={500} />
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}
