// Settings → Payment accounts: the shop's own list of where money comes in (owners only).
// Shop cash is always there; everything else the owner adds, names, marks firm / personal, reorders or hides.
// Address: #/settings/accounts
import { useEffect, useState } from 'preact/hooks';
import { maskNumber } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { forgetAccounts, kindOf, accName } from '../../lib/accounts.js';
import { ACCOUNT_KINDS } from '../../config/options.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import '../../ui/money/money.css';

export function Accounts() {
  const [list, setList] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null); // {} = new, account = change
  const order = useAction('orderAccounts');
  const load = () => call('accounts', { all: true }).then(setList).catch((e) => setErr(e.message));
  useEffect(() => { if (!can('settings')) { go('/settings'); return; } load(); }, []);
  const done = (msg) => { setEdit(null); forgetAccounts(); toast(msg || t('acc_saved')); load(); };

  if (err) return <><TopBar title={t('acc_title')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!list) return <><TopBar title={t('acc_title')} sub={t('acc_title_s')} /><div class="page"><Skeleton h={260} /></div></>;
  const shown = list.filter((a) => !a.hidden);
  const hidden = list.filter((a) => a.hidden);
  const movable = shown.filter((a) => !a.is_drawer);
  const move = (a, dir) => {
    const ids = movable.map((x) => x.id);
    const i = ids.indexOf(a.id); const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    setList([...list.filter((x) => x.is_drawer), ...ids.map((id) => list.find((x) => x.id === id)), ...hidden]); // show at once
    order.run({ ids }).then(() => forgetAccounts()).catch(() => load());
  };

  const Row = ({ a }) => {
    const k = kindOf(a);
    const i = movable.findIndex((x) => x.id === a.id);
    return (
      <div class={`li ${a.hidden ? 'acc-hidden' : ''}`}>
        <button class="row grow" style="gap:12px;min-width:0;text-align:left" onClick={() => setEdit(a)}>
          <span class="acc-ic" style={`background:${k.tone}`}><Icon name={k.icon} size={18} stroke={2.2} /></span>
          <span class="grow" style="min-width:0">
            <span class="acc-name">{accName(a)}</span>
            <span class="acc-sub">{a.is_drawer ? t('acc_k_cash') : [t(k.word), maskNumber(a.number), a.staff_can ? null : t('acc_owners_only')].filter(Boolean).join(' · ')}</span>
          </span>
          <span class={`chip ${a.owner === 'personal' ? 'tone-warn' : 'tone-pakka'}`} style="flex:none">{a.hidden ? t('acc_hidden') : t(a.owner === 'personal' ? 'acc_personal' : 'acc_firm')}</span>
        </button>
        {!a.is_drawer && !a.hidden && movable.length > 1 && (
          <div class="acc-move">
            <button aria-label="Up" disabled={i <= 0 || order.busy} onClick={() => move(a, -1)}><Icon name="ArrowUp" size={16} /></button>
            <button aria-label="Down" disabled={i >= movable.length - 1 || order.busy} onClick={() => move(a, 1)}><Icon name="ArrowDown" size={16} /></button>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <TopBar title={t('acc_title')} sub={t('acc_title_s')} />
      <div class="page acc-set" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        <div class="card">{shown.map((a) => <Row a={a} key={a.id} />)}</div>
        <button class="btn btn-accent btn-block" style="margin-top:12px" onClick={() => setEdit({})}><Icon name="Plus" size={20} stroke={2.6} />{t('acc_add')}</button>
        {shown.length <= 1 && (
          <div class="card pad" style="margin-top:12px">
            <div style="font-weight:700;font-size:15px">{t('acc_info_t')}</div>
            <div class="muted" style="font-size:14px;line-height:1.45;margin-top:4px">{t('acc_info')}</div>
          </div>
        )}
        {hidden.length > 0 && <><div class="sec"><h3>{t('acc_hidden')}</h3></div><div class="card">{hidden.map((a) => <Row a={a} key={a.id} />)}</div>
          <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:6px">{t('acc_hidden_s')}</div></>}
        <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:12px">{t('acc_owners_note')}</div>
      </div>
      <AccountSheet open={!!edit} a={edit || {}} onClose={() => setEdit(null)} onDone={done} />
    </>
  );
}

function AccountSheet({ open, a, onClose, onDone }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('bank');
  const [owner, setOwner] = useState('firm');
  const [number, setNumber] = useState('');
  const [staff, setStaff] = useState(true);
  const save = useAction('saveAccount');
  const drawer = !!a.is_drawer;
  useEffect(() => {
    if (!open) return;
    setName(a.id ? a.name : ''); setKind(a.kind && a.kind !== 'cash' ? a.kind : 'bank'); setOwner(a.owner || 'firm');
    setNumber(a.number || ''); setStaff(a.staff_can !== false); save.setError(null);
  }, [open, a.id]);
  const run = (extra = {}) => save.run({ account: { id: a.id || null, name: name.trim(), kind: drawer ? 'cash' : kind, owner, number: number.trim() || null, staff_can: staff, ...extra } })
    .then(() => onDone()).catch(() => {});
  return (
    <Sheet open={open} onClose={onClose} title={a.id ? t('acc_edit') : t('acc_add')}
      footer={<button class="btn btn-accent btn-block" disabled={save.busy || !name.trim()} onClick={() => run()}>{t('acc_save')}</button>}>
      <div class="lbl">{t('acc_name')}</div>
      <div class="field"><input value={name} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} placeholder={t('acc_name_ph')} autofocus={!a.id} /></div>
      {drawer ? <div class="muted" style="margin-top:12px;font-size:14px">{t('acc_drawer_note')}</div> : <>
        <div class="lbl" style="margin-top:14px">{t('acc_what')}</div>
        <div class="pick">{ACCOUNT_KINDS.map((k) => <button class={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}><Icon name={k.icon} size={17} />{t(k.word)}</button>)}</div>
        <div class="lbl" style="margin-top:14px">{t('acc_whose')}</div>
        <div class="seg"><button class={owner === 'firm' ? 'on' : ''} onClick={() => setOwner('firm')}>{t('acc_firm')}</button><button class={owner === 'personal' ? 'on' : ''} onClick={() => setOwner('personal')}>{t('acc_personal')}</button></div>
        <div class="lbl" style="margin-top:14px">{t('acc_number')}</div>
        <div class="field"><input value={number} maxLength={60} autocapitalize="off" autocorrect="off" spellcheck={false} onInput={(e) => setNumber(e.currentTarget.value)} /><span class="faint" style="font-size:12px">{t('acc_optional')}</span></div>
        <div class="lbl" style="margin-top:14px">{t('acc_staff')}</div>
        <div class="seg"><button class={staff ? 'on' : ''} onClick={() => setStaff(true)}>{t('acc_staff_yes')}</button><button class={!staff ? 'on' : ''} onClick={() => setStaff(false)}>{t('acc_staff_no')}</button></div>
        {a.id && <button class="link" style={`margin-top:14px;${a.hidden ? '' : 'color:var(--bad)'}`} disabled={save.busy} onClick={() => run({ hidden: !a.hidden })}>
          <Icon name={a.hidden ? 'Eye' : 'EyeOff'} size={16} />{a.hidden ? t('acc_show') : t('acc_hide')}</button>}
      </>}
      {save.error && <div class="error" style="margin-top:10px">{save.error.message}</div>}
    </Sheet>
  );
}
