// Getting in: mobile number → SMS code → PIN, plus "Who is using?", "Not in a shop yet" and
// "You are joining…". Big targets, one thing per screen.
import { useState, useEffect } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import {
  auth, sendCode, verifyCode, setPin, unlock, forgotPin, goBack, openDoor, switchTo, switchPerson, addPerson, logOut, unlockFinger, fingerOn,
} from '../../lib/session.js';
import { online } from '../../lib/net.js';
import { outbox } from '../../lib/offline/outbox.js';
import { devicePeople } from '../../lib/device.js';
import { longDay } from '../../lib/format.js';
import { Icon, LangPill } from '../../ui/kit.jsx';
import { APP } from '../../config/app.js';
import { AVATAR_COLOURS } from '../../config/options.js';
import { Mark, Pile } from './art.jsx';
import './login.css';

const PRACTICE = import.meta.env.MODE !== 'production';
const PERM_ORDER = ['new', 'orders', 'weigh', 'khata', 'today', 'rates', 'people', 'settings', 'money', 'kacha'];

export const avatarColour = (name = '') => AVATAR_COLOURS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLOURS.length];
export const Avatar = ({ name = '', size = 52 }) => (
  <div class="av" style={`width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.34)}px;font-size:${Math.round(size * 0.42)}px;background:${avatarColour(name)}`}>{[...name.trim()][0] || '?'}</div>
);
const pretty = (p) => (p ? `${p.slice(0, 3)} ${p.slice(3, 8)} ${p.slice(8)}` : '');

function Frame({ children, title, sub, onBack, top }) {
  return (
    <div class="login">
      <div class="login-top">
        {onBack ? <button class="round" onClick={onBack} aria-label={t('back')}><Icon name="ChevronLeft" size={20} stroke={2.2} /></button>
          : <><Mark size={34} /><div class="login-app">{APP.name}</div></>}
        <div class="grow" />
        <LangPill />
      </div>
      <div class="login-body">
        {top}
        {title && <h1 class="login-title">{title}</h1>}
        {sub && <p class="login-sub">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

// ---------- mobile number ----------
export function PhoneStep() {
  const a = auth.value;
  const [phone, setPhone] = useState(a.phone ? a.phone.replace(/^\+91/, '') : '');
  const digits = phone.replace(/\D/g, '');
  const submit = (e) => { e.preventDefault(); sendCode(digits); };
  return (
    <Frame onBack={goBack} title={a.mode === 'join' ? t('gw_join') : t('login_phone')} sub={t('login_phone_s')}>
      {a.notice && <div class="notice tone-warn" style="margin-bottom:16px">{t(a.notice)}</div>}
      <form onSubmit={submit}>
        <div class="row" style="gap:10px">
          <div class="field big cc">{APP.countryCode}</div>
          <div class="field big grow">
            <input type="tel" inputmode="numeric" autocomplete="tel-national" maxLength={14} placeholder="98765 43210"
              value={phone} onInput={(e) => setPhone(e.currentTarget.value)} autofocus aria-label={t('login_phone')} />
          </div>
        </div>
        {a.error && <div class="error">{t(a.error)}</div>}
        <button class="btn btn-accent btn-block" style="margin-top:18px" disabled={a.busy || digits.length < 10}>{t('login_send')}</button>
      </form>
      {PRACTICE && <div class="practice"><Icon name="Info" size={16} />{t('login_practice')}</div>}
    </Frame>
  );
}

// ---------- SMS code ----------
export function CodeStep() {
  const a = auth.value;
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(60);
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, 60 - Math.floor((Date.now() - (a.sentAt || 0)) / 1000))), 500);
    return () => clearInterval(id);
  }, [a.sentAt]);
  const submit = (e) => { e?.preventDefault(); if (code.length === 6) verifyCode(code); };
  const back = () => { auth.value = { ...auth.value, step: 'phone', error: null }; };
  return (
    <Frame onBack={back} title={t('login_code')} sub={t('login_code_s', pretty(a.phone))}>
      <form onSubmit={submit}>
        <div class="field big code">
          <input type="text" inputmode="numeric" autocomplete="one-time-code" maxLength={6} placeholder="••••••" value={code} autofocus
            onInput={(e) => { const v = e.currentTarget.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) verifyCode(v); }}
            aria-label={t('login_code')} />
        </div>
        {a.error && <div class="error">{t(a.error)}</div>}
        <button class="btn btn-accent btn-block" style="margin-top:18px" disabled={a.busy || code.length < 6}>{t('login_verify')}</button>
      </form>
      <div class="row" style="justify-content:space-between;margin-top:14px">
        <button class="link" onClick={back}>{t('login_change_no')}</button>
        <button class="link" disabled={left > 0} style={left > 0 ? 'color:var(--ink-3)' : ''} onClick={() => sendCode(a.phone)}>
          {left > 0 ? t('login_resend_in', left) : t('login_resend')}
        </button>
      </div>
    </Frame>
  );
}

// ---------- PIN keypad (setting and unlocking) ----------
export function PinPad({ length, onDone, busy, left }) {
  const [pin, setPinVal] = useState('');
  const press = (d) => {
    if (busy) return;
    const next = (pin + d).slice(0, length);
    setPinVal(next);
    if (next.length === length) { onDone(next); setTimeout(() => setPinVal(''), 250); }
  };
  useEffect(() => {
    const onKey = (e) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') setPinVal((p) => p.slice(0, -1)); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  return (
    <div>
      <div class="dots" aria-live="polite">{Array.from({ length }, (_, i) => <span class={i < pin.length ? 'on' : ''} />)}</div>
      <div class="keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'left', '0', 'del'].map((k) => k === 'left' ? (left || <span />) :
          <button class={`key ${k === 'del' ? 'del' : ''}`} onClick={() => (k === 'del' ? setPinVal(pin.slice(0, -1)) : press(k))} aria-label={k === 'del' ? 'delete' : k}>
            {k === 'del' ? <Icon name="Delete" size={24} /> : k}
          </button>)}
      </div>
    </div>
  );
}

/** Set + confirm a PIN. onPin(pin) returns an error text or null. */
export function PinSetter({ length, onPin, onBack }) {
  const [first, setFirst] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const done = async (pin) => {
    if (!first) { setFirst(pin); setErr(null); return; }
    if (pin !== first) { setFirst(null); setErr(t('pin_mismatch')); return; }
    setBusy(true);
    const problem = await onPin(pin);
    setBusy(false);
    if (problem) { setFirst(null); setErr(problem); }
  };
  return (
    <Frame onBack={onBack} top={<div class="gw-lock"><Icon name="LockKeyhole" size={28} stroke={2} /></div>}
      title={first ? t('pin_again') : t('pin_set_title')} sub={first ? '' : t('pin_set_s', length)}>
      <PinPad length={length} onDone={done} busy={busy} key={first ? 'b' : 'a'} />
      {err && <div class="error" style="text-align:center">{err}</div>}
    </Frame>
  );
}

export function SetPinStep() {
  const s = auth.value.status;
  return <PinSetter length={s?.pin_length || 4} onPin={setPin} />;
}

// ---------- every day: PIN ----------
export function UnlockStep() {
  const s = auth.value.status;
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fbusy, setFbusy] = useState(false);
  const name = s?.person?.name || '';
  const finger = fingerOn(auth.value.offlineUid);
  const off = !online.value || auth.value.offline;
  const done = async (pin) => {
    setBusy(true);
    const r = await unlock(pin);
    setBusy(false);
    if (r.ok) return;
    if (r.reason === 'wrong_pin') setMsg(t('pin_wrong', r.attempts_left));
    else if (r.reason === 'locked') setMsg(t('pin_locked', new Date(r.locked_until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    else if (r.message === 'offline_no_pin') setMsg(t('off_no_pin'));
    else setMsg(r.message || t('err_generic'));
  };
  const useFinger = async () => {
    setFbusy(true); setMsg(null);
    try { await unlockFinger(); } catch (e) { setMsg(e?.name === 'NotAllowedError' || e?.code === 'no_key' ? t('fp_use_pin') : e?.message || t('fp_use_pin')); }
    finally { setFbusy(false); }
  };
  // ask for the finger straight away (the PIN pad stays below if it is cancelled or fails)
  useEffect(() => { if (finger) useFinger(); }, []);
  return (
    <Frame>
      <div class="unlock-head">
        <Avatar name={name} size={80} />
        <h1 class="login-title" style="margin-top:14px">{t('pin_hello', name)}</h1>
        <div class="faint" style="font-weight:600">{s?.company?.name}</div>
        <p class="login-sub" style="margin-top:6px">{finger ? t('fp_or_pin') : t('pin_enter')}</p>
        {off && <div class="chip tone-warn" style="margin-top:8px"><Icon name="WifiOff" size={14} />{t('off_unlock_phone')}</div>}
        {!off && outbox.value.length > 0 && <div class="chip tone-accent" style="margin-top:8px"><Icon name="CloudUpload" size={14} />{t('off_unlock_send', outbox.value.length)}</div>}
      </div>
      {finger && (
        <button class="btn btn-brand btn-block fp-btn" disabled={fbusy || busy} onClick={useFinger}>
          <Icon name="Fingerprint" size={26} stroke={2} />{fbusy ? t('fp_touch') : t('fp_unlock')}
        </button>
      )}
      <PinPad length={s?.pin_length || 4} onDone={done} busy={busy} />
      {msg && <div class="error" style="text-align:center">{msg}</div>}
      <div class="row" style="justify-content:space-between;margin-top:18px">
        {!off ? <button class="link" onClick={forgotPin}>{t('pin_forgot')}</button> : <span />}
        <button class="link" style="color:var(--ink-2)" onClick={switchPerson}>{t('not_you', name.split(' ')[0])}</button>
      </div>
    </Frame>
  );
}

// ---------- shared phone: who is using? ----------
function greeting(tz = 'Asia/Kolkata') {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()));
  return t(h < 12 ? 'greet_m' : h < 17 ? 'greet_a' : 'greet_e');
}
export function WhoStep() {
  const people = devicePeople.value;
  const shops = [...new Set(people.map((p) => p.company).filter(Boolean))];
  const shop = shops.length === 1 ? shops[0] : '';
  const city = shop ? people.find((p) => p.company === shop)?.city : '';
  const initials = shop.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  return (
    <div class="login">
      <div class="login-top"><Mark size={30} /><div class="login-app">{APP.name}</div><div class="grow" /><LangPill /></div>
      <div class="who-hero">
        <div class="who-pile"><Pile rows={4} r={17} hot={[3, 7]} width={170} /></div>
        {shop && <div class="row" style="position:relative"><div class="who-badge">{initials}</div><div><div style="font-weight:800;font-size:19px">{shop}</div>{city && <div style="font-size:13px;opacity:.7;font-weight:600">{city}</div>}</div></div>}
        <div class="who-greet">{greeting()}</div>
        <div style="font-size:14px;opacity:.75;font-weight:600;position:relative">{longDay(new Date().toISOString(), 'Asia/Kolkata')}</div>
      </div>
      <div class="sec"><h3>{t('who_t')}</h3></div>
      <div class="who-grid">
        {people.map((p, i) => (
          <button class={`card who-card ${i === 0 ? 'last' : ''}`} onClick={() => switchTo(p)}>
            <Avatar name={p.name} />
            {i === 0 && people.length > 1 && <span class="chip tone-accent who-last">{t('who_last')}</span>}
            <div><div class="who-name">{p.name}</div><div class="muted" style="font-size:13px;font-weight:600">{t(`role_${p.role}`)}{!shop && p.company ? ` · ${p.company}` : ''}</div></div>
          </button>
        ))}
        <button class="who-card who-new" onClick={addPerson}><Icon name="UserPlus" size={24} stroke={2} />{t('who_new')}</button>
      </div>
      <div style="height:30px" />
    </div>
  );
}

// ---------- a number that is in no shop ----------
export function NotStaffStep() {
  const phone = auth.value.status?.phone || auth.value.phone || '';
  const msg = encodeURIComponent(t('nis_msg', pretty(phone)));
  return (
    <Frame onBack={logOut} top={<div class="gw-lock warn"><Icon name="UserSearch" size={30} stroke={2} /></div>}
      title={t('nis_title')} sub={t('nis_sub', pretty(phone))}>
      <div class="sec" style="margin-top:4px"><h3>{t('nis_ask')}</h3></div>
      <div class="card pad">
        <div class="row"><div class="iconbox" style="background:var(--ok-soft);color:var(--wa)"><Icon name="MessageCircle" size={20} stroke={2.2} /></div>
          <div class="grow"><div style="font-weight:700;font-size:16px">{t('nis_work')}</div><div class="muted" style="font-size:13px">{t('nis_work_s')}</div></div></div>
        <a class="btn btn-wa btn-block" style="margin-top:12px;min-height:48px;font-size:15px" href={`https://wa.me/?text=${msg}`} target="_blank" rel="noopener"><Icon name="Send" size={17} stroke={2.3} />{t('nis_send')}</a>
      </div>
      <div class="card pad" style="margin-top:12px">
        <div class="row"><div class="iconbox tone-accent"><Icon name="Store" size={20} stroke={2.2} /></div>
          <div class="grow"><div style="font-weight:700;font-size:16px">{t('nis_own')}</div><div class="muted" style="font-size:13px">{t('nis_own_s')}</div></div></div>
        <button class="btn btn-accent btn-block" style="margin-top:12px;min-height:48px;font-size:15px"
          onClick={() => { auth.value = { ...auth.value, mode: 'signup', step: auth.value.status?.can_register ? 'register' : 'phone' }; }}>{t('nis_start')}</button>
      </div>
      <button class="link" style="align-self:center;margin-top:14px;color:var(--ink-2)" onClick={logOut}>{t('nis_other')}</button>
    </Frame>
  );
}

// ---------- first time for an invited person: what they are joining ----------
export function JoiningStep() {
  const s = auth.value.status;
  const perms = s?.person?.perms || {};
  const list = PERM_ORDER.filter((k) => !(k === 'kacha' && s?.company?.estimates === false));
  const yes = list.filter((k) => perms[k]);
  const no = ['money', 'khata', 'rates', 'settings', 'people'].filter((k) => list.includes(k) && !perms[k]).slice(0, 4);
  const go = () => { auth.value = { ...auth.value, step: 'set_pin' }; };
  return (
    <Frame onBack={logOut}>
      <div class="join-card">
        <div class="who-pile" style="right:-20px;top:-26px;bottom:auto"><Pile rows={3} r={18} hot={[2]} width={130} /></div>
        <div class="who-badge">{(s?.company?.name || '').split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase()}</div>
        <div style="font-size:14px;opacity:.75;font-weight:600;margin-top:14px">{t('join_to')}</div>
        <div style="font-size:26px;font-weight:800;letter-spacing:-.03em">{s?.company?.name}</div>
        <div class="join-role"><Icon name="BadgeCheck" size={15} stroke={2.2} />{t('join_as', t(`role_${s?.person?.role}`))} · {s?.person?.name}</div>
      </div>
      <div class="card" style="margin-top:14px;padding:10px 16px">
        {yes.length > 0 && <div class="lbl" style="margin:6px 0 2px">{t('join_can')}</div>}
        {yes.map((k) => <div class="can"><span class="jt ok"><Icon name="Check" size={14} stroke={3} /></span>{t(`perm_${k}`)}</div>)}
        {no.length > 0 && <div class="lbl" style="margin:10px 0 2px">{t('join_cant')}</div>}
        {no.map((k) => <div class="can"><span class="jt no"><Icon name="X" size={14} stroke={3} /></span>{t(`perm_${k}`)}</div>)}
      </div>
      <button class="btn btn-accent btn-block" style="margin-top:18px" onClick={go}>{t('join_go')}</button>
      <button class="link" style="align-self:center;margin-top:10px;color:var(--ink-2)" onClick={logOut}>{t('join_not_me')}</button>
    </Frame>
  );
}

export { openDoor };
