// Add a new supplier right where one is chosen (9 Nov 2026, Parth: from a bank statement line, an expense). The name can
// come from the bank line (to check and correct). Before adding, suppliers that look the same are shown ("Use this"),
// so nobody is added twice; the server refuses the very same name or GST number anyway.
import { useMemo, useRef, useState } from 'preact/hooks';
import { similarSuppliers, bankNameGuess } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { newKey } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { Icon } from '../kit.jsx';
import '../../screens/khata/khata.css';
import './add-supplier.css';

/** suppliers: [{ id, name, gstin? }]; hint: a name read off a bank line; onAdded(newSupplier); onUse(existing); onCancel(). */
export function AddSupplier({ suppliers = [], hint = '', onAdded, onUse, onCancel }) {
  const start = bankNameGuess(hint);
  const [name, setName] = useState(start);
  const [gstin, setGstin] = useState('');
  const [city, setCity] = useState('');
  const add = useAction('createSupplier');
  const id = useRef(newKey());
  const same = useMemo(() => (name.trim().length >= 3 || gstin.trim().length >= 15 ? similarSuppliers(suppliers, { name, gstin }) : []), [name, gstin, suppliers]);
  const save = () => add.run({ id: id.current, name: name.trim(), gstin: gstin.trim() || null, city: city.trim() || null })
    .then((s) => { id.current = newKey(); onAdded({ id: s.id, name: s.name, gstin: s.gstin || null, city: s.city || null, fresh: true }); }).catch(() => {});
  return (
    <div class="card pad add-party">
      <div class="row" style="gap:8px;margin-bottom:10px"><Icon name="Truck" size={18} /><b class="grow">{t('ns_title')}</b>
        {onCancel && <button class="link" style="min-height:0" onClick={onCancel}>{t('cancel')}</button>}</div>
      <div class="lbl">{t('ns_name')}</div>
      <div class="field"><input value={name} maxLength={120} onInput={(e) => setName(e.currentTarget.value)} autofocus /></div>
      {start && name === start && <div class="faint add-party-hint">{t('ns_from_bank')}</div>}
      <div class="lbl" style="margin-top:12px">{t('ns_gstin')}</div>
      <div class="field"><input value={gstin} maxLength={15} style="text-transform:uppercase" placeholder="07AAAAA0000A1Z5" onInput={(e) => setGstin(e.currentTarget.value.replace(/\s/g, '').toUpperCase())} /></div>
      <div class="lbl" style="margin-top:12px">{t('ns_city')}</div>
      <div class="field"><input value={city} maxLength={80} onInput={(e) => setCity(e.currentTarget.value)} /></div>
      {same.length > 0 && <div class={`same-box ${same[0].strong ? 'strong' : ''}`} style="margin-top:12px">
        <div class="t"><Icon name="Users" size={17} /> {same[0].strong ? t('ns_same_gstin') : t('ns_same_name')}</div>
        {same.slice(0, 3).map(({ s }) => (
          <div class="same-row"><span class="grow" style="font-weight:700">{s.name}{s.gstin ? <span class="faint num" style="display:block;font-size:12px;font-weight:600">{s.gstin}</span> : null}</span>
            <button class="btn btn-brand" style="min-height:40px;padding:0 14px" onClick={() => onUse(s)}>{t('same_use')}</button></div>))}
      </div>}
      {add.error && <div class="error" style="margin-top:10px">{add.error.message}</div>}
      <button class="btn btn-accent btn-block" style="margin-top:12px" disabled={!name.trim() || add.busy || (same[0]?.strong)} onClick={save}>
        <Icon name="Plus" size={18} stroke={2.4} />{same.length ? t('ns_add_anyway') : t('ns_add')}</button>
    </div>
  );
}
