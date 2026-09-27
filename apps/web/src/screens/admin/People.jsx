// People: who can log in and what each person may do. Presets per job, then any switch can be changed.
import { useEffect, useState } from 'preact/hooks';
import { PERMS, ROLE_PRESETS } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { me, can } from '../../lib/session.js';
import { db } from '../../lib/backend.js';
import { staff } from '../../lib/staff.js';
import { toast } from '../../ui/toast.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';

const ROLES = ['owner', 'sales', 'weigher', 'accounts', 'custom'];
const roleWord = (r) => `role_${r}`;
const bools = (p) => Object.fromEntries(PERMS.map((k) => [k, !!p?.[k]]));

export function People() {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => db.from('people').select('id,display_name,phone,role,perms,active,preferred_lang').order('display_name').then(({ data }) => setRows(data || []));
  useEffect(() => { load(); }, []);
  return (
    <>
      <TopBar title={t('nav_people')} right={can('people') && <button class="pill" onClick={() => setAdding(true)}><Icon name="Plus" size={16} stroke={2.4} />{t('add_person')}</button>} />
      <div class="page">
        <div class="muted" style="margin:0 2px 12px;font-size:14px">{t('people_note')}</div>
        <div class="card">
          {!rows ? <div class="pad"><Skeleton h={18} /></div> : rows.map((p) => (
            <button class="li" onClick={() => can('people') && setOpen(p)} style={p.active ? '' : 'opacity:.55'}>
              <div class="avatar-sm tone-neutral" style="width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800">{p.display_name.slice(0, 1)}</div>
              <div class="grow"><div class="t">{p.display_name}{p.id === me.value?.id ? ` (${t('you')})` : ''}</div><div class="s num">{p.phone || ''}</div></div>
              {p.active ? <Chip tone="neutral">{t(roleWord(p.role))}</Chip> : <Chip tone="bad">{t('inactive')}</Chip>}
            </button>
          ))}
        </div>
      </div>
      {open && <PersonSheet p={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); }} />}
      {adding && <AddPerson onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </>
  );
}

function PermList({ perms, setPerms }) {
  return (
    <div class="card">
      {PERMS.map((k) => {
        const mine = !!me.value?.perms?.[k];
        return (
          <label class="li" style={mine ? '' : 'opacity:.45'}>
            <div class="grow t">{t(`perm_${k}`)}</div>
            <input type="checkbox" class="switch" checked={perms[k]} disabled={!mine} onChange={(e) => setPerms({ ...perms, [k]: e.currentTarget.checked })} />
          </label>
        );
      })}
    </div>
  );
}

function PersonSheet({ p, onClose, onDone }) {
  const [role, setRole] = useState(p.role);
  const [perms, setPerms] = useState(bools(p.perms));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const self = p.id === me.value?.id;
  const run = async (action, body, msg) => {
    setBusy(true); setErr(null);
    try { await staff(action, { person_id: p.id, ...body }); toast(msg || t('saved')); onDone(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const pickRole = (r) => { setRole(r); if (ROLE_PRESETS[r]) setPerms(bools(ROLE_PRESETS[r]())); };
  return (
    <Sheet open onClose={onClose} title={p.display_name}
      footer={<button class="btn btn-accent btn-block" disabled={busy} onClick={() => run('update_person', { role, perms })}>{t('save')}</button>}>
      <div class="lbl">{t('role')}</div>
      <div class="pick">{ROLES.map((r) => <button class={role === r ? 'on' : ''} onClick={() => pickRole(r)}>{t(roleWord(r))}</button>)}</div>
      <div class="sec"><h3>{t('perms_title')}</h3></div>
      <PermList perms={perms} setPerms={(x) => { setPerms(x); setRole('custom'); }} />
      <div class="sec"><h3>{t('security')}</h3></div>
      <div class="card">
        <button class="li" disabled={busy} onClick={() => run('reset_pin', {}, t('reset_pin_s'))}><div class="iconbox tone-neutral"><Icon name="Lock" size={18} /></div><div class="grow"><div class="t">{t('reset_pin')}</div><div class="s">{t('reset_pin_s')}</div></div></button>
        <button class="li" disabled={busy} onClick={() => run('sign_out_everywhere', {})}><div class="iconbox tone-neutral"><Icon name="LogOut" size={18} /></div><div class="grow t">{t('sign_out_all')}</div></button>
        {!self && <button class="li" disabled={busy} onClick={() => run('set_active', { active: !p.active })}><div class="iconbox tone-bad"><Icon name="X" size={18} /></div><div class="grow t" style="color:var(--bad)">{p.active ? t('deactivate') : t('activate')}</div></button>}
      </div>
      {err && <div class="error">{err}</div>}
    </Sheet>
  );
}

function AddPerson({ onClose, onDone }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [role, setRole] = useState('sales');
  const [busy, setBusy] = useState(false); const [err, setErr] = useState(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await staff('add_person', { name, phone, role }); toast(t('added')); onDone(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} title={t('add_person')}
      footer={<button class="btn btn-accent btn-block" disabled={busy || !name.trim() || phone.replace(/\D/g, '').length < 10} onClick={save}>{t('add_person')}</button>}>
      <div class="lbl">{t('name')}</div><div class="field"><input value={name} onInput={(e) => setName(e.currentTarget.value)} autofocus /></div>
      <div class="lbl" style="margin-top:14px">{t('mobile')}</div><div class="field"><span class="faint">+91</span><input type="tel" inputmode="numeric" value={phone} onInput={(e) => setPhone(e.currentTarget.value)} /></div>
      <div class="lbl" style="margin-top:14px">{t('role')}</div>
      <div class="pick">{ROLES.filter((r) => r !== 'custom').map((r) => <button class={role === r ? 'on' : ''} onClick={() => setRole(r)}>{t(roleWord(r))}</button>)}</div>
      <div class="faint" style="font-size:13px;margin-top:10px">{t('role_note')}</div>
      {err && <div class="error">{err}</div>}
    </Sheet>
  );
}
