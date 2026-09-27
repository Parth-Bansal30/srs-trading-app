// Rates: every grade with today's rate. Changing a rate adds a NEW rate (history is kept; old slips keep theirs).
import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_FAMILY_DENSITY } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { loadCatalog, forgetCatalog } from '../../lib/catalog.js';
import { db } from '../../lib/backend.js';
import { useAction } from '../../lib/action.js';
import { money, shortDate } from '../../lib/format.js';
import { toast } from '../../ui/toast.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';

const FAMILIES = Object.keys(DEFAULT_FAMILY_DENSITY);

export function Rates() {
  const [cat, setCat] = useState(null);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => { forgetCatalog(); return loadCatalog(true).then(setCat); };
  useEffect(() => { load(); }, []);
  return (
    <>
      <TopBar title={t('nav_rates')} right={can('rates') && <button class="pill" onClick={() => setAdding(true)}><Icon name="Plus" size={16} stroke={2.4} />{t('add_material')}</button>} />
      <div class="page">
        <div class="card">
          {!cat ? <div class="pad"><Skeleton h={18} /></div> : cat.materials.map((m) => (
            <button class="li" onClick={() => setOpen(m)} style={m.active ? '' : 'opacity:.55'}>
              <div class="grow"><div class="t">{m.code}</div><div class="s">{t(`fam_${m.family}`)}{m.active ? '' : ` · ${t('grade_off')}`}</div></div>
              <div style="text-align:right"><div class="num" style="font-weight:800">{m.sell_rate != null ? `${money(m.sell_rate)}/kg` : '–'}</div>
                <div class="faint num" style="font-size:12px">{t('cutting')} {m.cut_rate != null ? money(m.cut_rate) : '–'}</div></div>
            </button>
          ))}
        </div>
      </div>
      {open && <GradeSheet m={open} cat={cat} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); }} />}
      <AddGrade open={adding} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />
    </>
  );
}

function GradeSheet({ m, cat, onClose, onDone }) {
  const [sell, setSell] = useState(String(m.sell_rate ?? ''));
  const [cut, setCut] = useState(String(m.cut_rate ?? ''));
  const [note, setNote] = useState('');
  const [hist, setHist] = useState(null);
  const [specials, setSpecials] = useState(null);
  const [addCust, setAddCust] = useState(''); const [addRate, setAddRate] = useState('');
  const rate = useAction('changeMaterialRate');
  const upd = useAction('updateMaterial');
  const spec = useAction('setCustomerRate');
  const tz = company.value?.timezone;
  const loadExtra = () => {
    db.from('material_rates').select('sell_rate,cut_rate,effective_from,note').eq('material_id', m.id).order('effective_from', { ascending: false }).limit(8).then(({ data }) => setHist(data || []));
    db.from('current_customer_rates').select('customer_id,rate,customers(name)').eq('material_id', m.id).then(({ data }) => setSpecials((data || []).filter((x) => x.rate != null)));
  };
  useEffect(loadExtra, [m.id]);
  const changed = Number(sell) !== Number(m.sell_rate) || Number(cut) !== Number(m.cut_rate);
  const edit = can('rates');
  return (
    <Sheet open onClose={onClose} title={`${m.code} · ${t(`fam_${m.family}`)}`}
      footer={edit && <button class="btn btn-accent btn-block" disabled={rate.busy || !changed || !(Number(sell) >= 0)}
        onClick={() => rate.run({ material_id: m.id, sell_rate: Number(sell), cut_rate: Number(cut), note }).then(() => { toast(t('rate_saved')); onDone(); }).catch(() => {})}>{t('change_rate')}</button>}>
      <div class="row" style="gap:10px">
        <div class="grow"><div class="lbl">{t('rate_kg')}</div><div class="field num"><span class="faint">₹</span><input inputmode="decimal" disabled={!edit} value={sell} onInput={(e) => setSell(e.currentTarget.value)} /></div></div>
        <div class="grow"><div class="lbl">{t('cut_rate')}</div><div class="field num"><span class="faint">₹</span><input inputmode="decimal" disabled={!edit} value={cut} onInput={(e) => setCut(e.currentTarget.value)} /></div></div>
      </div>
      {edit && changed && <input class="textarea" style="margin-top:10px" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('rate_note_ph')} />}
      {rate.error && <div class="error">{rate.error.message}</div>}

      <div class="sec"><h3>{t('special_rates')}</h3></div>
      <div class="card">
        {!specials ? <div class="pad"><Skeleton h={16} /></div> : specials.length === 0 ? <div class="li muted">{t('no_special')}</div> : specials.map((s) => (
          <div class="li"><div class="grow t">{s.customers?.name}</div><div class="num" style="font-weight:700">{money(s.rate)}/kg</div>
            {edit && <button class="link" style="color:var(--bad)" onClick={() => spec.run({ customer_id: s.customer_id, material_id: m.id, rate: null }).then(loadExtra).catch(() => {})}>{t('remove_special')}</button>}</div>
        ))}
      </div>
      {edit && (
        <div class="row" style="margin-top:10px;gap:8px">
          <select class="field grow" value={addCust} onChange={(e) => setAddCust(e.currentTarget.value)}>
            <option value="">{t('choose_customer')}</option>
            {cat.customers.filter((c) => c.active).map((c) => <option value={c.id}>{c.name}</option>)}
          </select>
          <div class="field num" style="width:110px"><span class="faint">₹</span><input inputmode="decimal" value={addRate} onInput={(e) => setAddRate(e.currentTarget.value)} /></div>
          <button class="btn btn-ghost" style="min-height:52px" disabled={!addCust || !(Number(addRate) > 0) || spec.busy}
            onClick={() => spec.run({ customer_id: addCust, material_id: m.id, rate: Number(addRate) }).then(() => { setAddCust(''); setAddRate(''); loadExtra(); }).catch(() => {})}><Icon name="Plus" size={18} /></button>
        </div>
      )}

      <div class="sec"><h3>{t('rate_history')}</h3></div>
      <div class="card">
        {(hist || []).map((h) => (
          <div class="li"><div class="grow"><div class="t num">{money(h.sell_rate)}/kg · {t('cutting')} {money(h.cut_rate)}</div>{h.note && <div class="s">{h.note}</div>}</div>
            <span class="faint" style="font-size:13px">{shortDate(h.effective_from, tz)}</span></div>
        ))}
      </div>
      {edit && <button class="link" style="margin-top:10px" onClick={() => upd.run({ material_id: m.id, changes: { active: !m.active } }).then(onDone).catch(() => {})}>{m.active ? t('switch_off') : t('switch_on')}</button>}
    </Sheet>
  );
}

function AddGrade({ open, onClose, onDone }) {
  const [code, setCode] = useState(''); const [family, setFamily] = useState('carbon'); const [sell, setSell] = useState(''); const [cut, setCut] = useState('');
  const a = useAction('createMaterial');
  return (
    <Sheet open={open} onClose={onClose} title={t('add_material')}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !code.trim() || !(Number(sell) > 0)} onClick={() => a.run({ code, family, sell_rate: Number(sell), cut_rate: Number(cut || 0) }).then(() => { setCode(''); setSell(''); setCut(''); onDone(); }).catch(() => {})}>{t('save')}</button>}>
      <div class="lbl">{t('grade_code')}</div><div class="field"><input value={code} onInput={(e) => setCode(e.currentTarget.value.toUpperCase())} placeholder="EN8" /></div>
      <div class="lbl" style="margin-top:14px">{t('family')}</div>
      <div class="pick">{FAMILIES.map((f) => <button class={family === f ? 'on' : ''} onClick={() => setFamily(f)}>{t(`fam_${f}`)}</button>)}</div>
      <div class="row" style="gap:10px;margin-top:14px">
        <div class="grow"><div class="lbl">{t('rate_kg')}</div><div class="field num"><span class="faint">₹</span><input inputmode="decimal" value={sell} onInput={(e) => setSell(e.currentTarget.value)} /></div></div>
        <div class="grow"><div class="lbl">{t('cut_rate')}</div><div class="field num"><span class="faint">₹</span><input inputmode="decimal" value={cut} onInput={(e) => setCut(e.currentTarget.value)} /></div></div>
      </div>
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}
