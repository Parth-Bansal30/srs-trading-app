// Login: mobile number → SMS code → PIN. Big targets, one thing per screen.
import { useState, useEffect } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { auth, sendCode, verifyCode, setPin, unlock, forgotPin, logOut } from '../../lib/session.js';
import { Icon, LangPill } from '../../ui/kit.jsx';
import { APP } from '../../config/app.js';
import './login.css';

function Frame({ children, title, sub }) {
  return (
    <div class="login">
      <div class="login-top">
        <div class="brandmark">{APP.name.slice(0, 1)}</div>
        <div class="grow"><div class="login-app">{APP.name}</div></div>
        <LangPill />
      </div>
      <div class="login-body">
        <h1 class="login-title">{title}</h1>
        {sub && <p class="login-sub">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

export function PhoneStep() {
  const a = auth.value;
  const [phone, setPhone] = useState(a.phone ? a.phone.replace(/^\+91/, '') : '');
  const digits = phone.replace(/\D/g, '');
  const submit = (e) => { e.preventDefault(); sendCode(digits); };
  return (
    <Frame title={t('login_phone')} sub={t('login_phone_s')}>
      {a.notice && <div class="notice tone-warn">{t(a.notice)}</div>}
      <form onSubmit={submit}>
        <div class="field big">
          <span class="faint" style="font-weight:700">{APP.countryCode}</span>
          <input type="tel" inputmode="numeric" autocomplete="tel-national" maxLength={14} placeholder="98765 43210"
            value={phone} onInput={(e) => setPhone(e.currentTarget.value)} autofocus aria-label={t('login_phone')} />
        </div>
        {a.error && <div class="error">{t(a.error)}</div>}
        <button class="btn btn-accent btn-block" style="margin-top:18px" disabled={a.busy || digits.length < 10}>{t('login_send')}</button>
      </form>
    </Frame>
  );
}

export function CodeStep() {
  const a = auth.value;
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(60);
  useEffect(() => {
    const id = setInterval(() => setLeft(Math.max(0, 60 - Math.floor((Date.now() - (a.sentAt || 0)) / 1000))), 500);
    return () => clearInterval(id);
  }, [a.sentAt]);
  const submit = (e) => { e?.preventDefault(); if (code.length === 6) verifyCode(code); };
  const shown = a.phone ? `${a.phone.slice(0, 3)} ${a.phone.slice(3, 8)} ${a.phone.slice(8)}` : '';
  return (
    <Frame title={t('login_code')} sub={t('login_code_s', shown)}>
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
        <button class="link" onClick={() => { auth.value = { ...auth.value, step: 'phone', error: null }; }}>{t('login_change_no')}</button>
        <button class="link" disabled={left > 0} style={left > 0 ? 'color:var(--ink-3)' : ''} onClick={() => sendCode(a.phone)}>
          {left > 0 ? t('login_resend_in', left) : t('login_resend')}
        </button>
      </div>
    </Frame>
  );
}

/** PIN keypad — used for setting and for unlocking. */
function PinPad({ length, onDone, busy }) {
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
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k) => k === '' ? <span /> :
          <button class={`key ${k === 'del' ? 'del' : ''}`} onClick={() => (k === 'del' ? setPinVal(pin.slice(0, -1)) : press(k))} aria-label={k === 'del' ? 'delete' : k}>
            {k === 'del' ? <Icon name="Delete" size={24} /> : k}
          </button>)}
      </div>
    </div>
  );
}

export function SetPinStep() {
  const s = auth.value.status;
  const len = s?.pin_length || 4;
  const [first, setFirst] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const done = async (pin) => {
    if (!first) { setFirst(pin); setErr(null); return; }
    if (pin !== first) { setFirst(null); setErr(t('pin_mismatch')); return; }
    setBusy(true);
    const problem = await setPin(pin);
    setBusy(false);
    if (problem) { setFirst(null); setErr(problem); }
  };
  return (
    <Frame title={first ? t('pin_again') : t('pin_set_title')} sub={first ? '' : t('pin_set_s', len)}>
      <PinPad length={len} onDone={done} busy={busy} key={first ? 'b' : 'a'} />
      {err && <div class="error" style="text-align:center">{err}</div>}
    </Frame>
  );
}

export function UnlockStep() {
  const s = auth.value.status;
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const done = async (pin) => {
    setBusy(true);
    const r = await unlock(pin);
    setBusy(false);
    if (r.ok) return;
    if (r.reason === 'wrong_pin') setMsg(t('pin_wrong', r.attempts_left));
    else if (r.reason === 'locked') setMsg(t('pin_locked', new Date(r.locked_until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    else setMsg(r.message || t('err_generic'));
  };
  return (
    <Frame title={t('pin_hello', s?.person?.name || '')} sub={t('pin_enter')}>
      <PinPad length={s?.pin_length || 4} onDone={done} busy={busy} />
      {msg && <div class="error" style="text-align:center">{msg}</div>}
      <div class="row" style="justify-content:space-between;margin-top:18px">
        <button class="link" onClick={forgotPin}>{t('pin_forgot')}</button>
        <button class="link" style="color:var(--ink-2)" onClick={logOut}>{t('switch_person')}</button>
      </div>
    </Frame>
  );
}

export function NotStaffStep() {
  return (
    <Frame title={t('not_staff')} sub={t('login_not_added')}>
      <button class="btn btn-ghost btn-block" onClick={logOut}>{t('login_change_no')}</button>
    </Frame>
  );
}
