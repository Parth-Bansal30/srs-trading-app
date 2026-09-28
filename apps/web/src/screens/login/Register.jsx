// Register a new business: 4 short steps (business, trade, team, free trial), then the owner's PIN.
// Everything is sent to the server in ONE call at the end (register_company). The form is kept on
// the phone as it is filled, so a lost connection or an expired SMS code never loses the typing.
import { useState } from 'preact/hooks';
import { checkGstin, GST_STATES, normalizeIndianMobile } from '@srs/core';
import { t, lang } from '../../lib/i18n.js';
import { registerCompany, reconfirmNumber, logOut } from '../../lib/session.js';
import { store } from '../../lib/store.js';
import { money } from '../../lib/format.js';
import { Icon, LangPill } from '../../ui/kit.jsx';
import { TRADES, PLANS, TEAM_ROLES } from '../../config/options.js';
import { Avatar, PinSetter } from './Login.jsx';
import './login.css';

const DRAFT = 'reg_draft';
const EMPTY = { step: 1, name: '', owner_name: '', gstin: '', city: '', state: '', trade: 'steel', first_slip_no: '1', estimates: true, team: [], plan: 'business', yearly: true };
const STATES = [...new Set(Object.values(GST_STATES))].filter((s) => !/Other|Centre/.test(s)).sort();

function Top({ step, onBack }) {
  return (
    <div class="login-top">
      <button class="round" onClick={onBack} aria-label={t('back')}><Icon name="ChevronLeft" size={20} stroke={2.2} /></button>
      <div class="reg-steps">
        {[1, 2, 3, 4].map((n) => <span class={n <= step ? 'on' : ''} />)}
        <b>{t('reg_step', step, 4)} · {t(`reg_s${step}`)}</b>
      </div>
      <LangPill />
    </div>
  );
}

export function Register() {
  const [f, setF] = useState(() => ({ ...EMPTY, ...(store.json(DRAFT) || {}) }));
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const up = (patch) => { const next = { ...f, ...patch }; setF(next); store.setJson(DRAFT, next); setErr(null); };
  const go = (step) => up({ step });
  const back = () => (f.step > 1 ? go(f.step === 'pin' ? 4 : f.step - 1) : logOut());

  if (f.step === 'pin') {
    const submit = async (pin) => {
      setSaving(true);
      const form = {
        name: f.name.trim(), owner_name: f.owner_name.trim(), gstin: checkGstin(f.gstin).ok ? checkGstin(f.gstin).gstin : null,
        city: f.city.trim(), state: f.state, trade: f.trade, lang: lang.value, first_slip_no: Number(f.first_slip_no) || 1,
        estimates: f.estimates, plan: f.plan, team: f.team.map(({ name, phone, role }) => ({ name, phone, role })),
      };
      const r = await registerCompany(form, pin);
      if (r === 'code') { await reconfirmNumber(); setSaving(false); return null; }
      if (r) { setSaving(false); return t(r) === r ? r : t(r); }
      store.set(DRAFT, null);
      return null;
    };
    return (
      <>
        <PinSetter length={6} onPin={submit} onBack={back} />
        {saving && <div class="reg-saving"><div class="spinner" /><b>{t('reg_saving')}</b></div>}
      </>
    );
  }

  return (
    <div class="login">
      <Top step={f.step} onBack={back} />
      <div class="reg-body">
        {f.step === 1 && <Business f={f} up={up} />}
        {f.step === 2 && <Trade f={f} up={up} />}
        {f.step === 3 && <Team f={f} up={up} />}
        {f.step === 4 && <Trial f={f} up={up} />}
        {err && <div class="error">{err}</div>}
      </div>
      <div class="reg-foot">
        {f.step === 1 && <button class="btn btn-brand btn-block" disabled={!f.name.trim() || !f.owner_name.trim() || (f.gstin && !checkGstin(f.gstin).ok)} onClick={() => go(2)}>{t('gw_next')}<Icon name="ArrowRight" size={20} stroke={2.3} /></button>}
        {f.step === 2 && <button class="btn btn-brand btn-block" disabled={!(Number(f.first_slip_no) >= 1)} onClick={() => go(3)}>{t('gw_next')}<Icon name="ArrowRight" size={20} stroke={2.3} /></button>}
        {f.step === 3 && <>
          <button class="btn btn-brand btn-block" onClick={() => go(4)}>{t('gw_next')}<Icon name="ArrowRight" size={20} stroke={2.3} /></button>
          {f.team.length === 0 && <button class="link" style="align-self:center;margin-top:6px;color:var(--ink-2)" onClick={() => go(4)}>{t('reg_skip_team')}</button>}
        </>}
        {f.step === 4 && <button class="btn btn-accent btn-block" onClick={() => go('pin')}>{t('reg_start_trial')}</button>}
      </div>
    </div>
  );
}

// ---------- 1. the business ----------
function Business({ f, up }) {
  const g = f.gstin ? checkGstin(f.gstin) : null;
  const typing = f.gstin && f.gstin.replace(/\s/g, '').length < 15;
  const onGst = (v) => {
    const next = v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 15);
    const c = checkGstin(next);
    up({ gstin: next, ...(c.ok && !f.state ? { state: c.state } : {}) });
  };
  return (
    <>
      <h1 class="login-title">{t('reg_biz_t')}</h1>
      <div class="lbl" style="margin-top:18px">{t('reg_gst')}</div>
      <div class={`field ${g?.ok ? 'good' : g && !typing ? 'bad' : ''}`}>
        <input class="num" style="letter-spacing:.04em" value={f.gstin} onInput={(e) => onGst(e.currentTarget.value)} placeholder="03ABCDE1234F1ZA" autocapitalize="characters" />
        {g?.ok && <Icon name="CircleCheck" size={20} stroke={2.3} style="color:var(--ok)" />}
      </div>
      {g?.ok && <div class="gst-ok"><Icon name="BadgeCheck" size={16} stroke={2.3} />{t('reg_gst_ok', g.state)}</div>}
      {g && !g.ok && !typing && <div class="error">{t('reg_gst_bad')}</div>}
      <div class="faint" style="font-size:12px;font-weight:600;margin-top:6px">{t('reg_gst_note')}</div>

      <div class="lbl" style="margin-top:16px">{t('reg_shop')}</div>
      <div class="field"><input value={f.name} maxLength={200} onInput={(e) => up({ name: e.currentTarget.value })} placeholder={t('reg_shop_ph')} /></div>
      <div class="lbl" style="margin-top:14px">{t('reg_you')}</div>
      <div class="field"><input value={f.owner_name} maxLength={100} onInput={(e) => up({ owner_name: e.currentTarget.value })} autocomplete="name" /></div>
      <div class="row" style="gap:10px;margin-top:14px;align-items:flex-start">
        <div class="grow"><div class="lbl">{t('reg_city')}</div><div class="field"><input value={f.city} maxLength={100} onInput={(e) => up({ city: e.currentTarget.value })} /></div></div>
        <div class="grow"><div class="lbl">{t('reg_state')}</div>
          <select class="field sel" value={f.state} onChange={(e) => up({ state: e.currentTarget.value })}>
            <option value="">—</option>{STATES.map((s) => <option value={s}>{s}</option>)}
          </select></div>
      </div>
    </>
  );
}

// ---------- 2. what they sell ----------
function Trade({ f, up }) {
  return (
    <>
      <h1 class="login-title">{t('reg_trade_t')}</h1>
      <p class="login-sub">{t('reg_trade_s')}</p>
      <div class="trade-grid">
        {TRADES.map((x) => (
          <button class={`trade ${f.trade === x.id ? 'on' : ''}`} disabled={!x.ready} onClick={() => up({ trade: x.id })}>
            <Icon name={x.icon} size={22} stroke={2} />
            <div class="grow"><div class="t">{t(x.word)}</div><div class="s">{x.ready ? t(x.sub) : t('soon')}</div></div>
            {f.trade === x.id && <span class="trade-tick"><Icon name="Check" size={13} stroke={3.2} /></span>}
          </button>
        ))}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="li">
          <div class="grow"><div class="t">{t('reg_slip')}</div><div class="s">{t('reg_slip_s')}</div></div>
          <div class="field num" style="width:112px;min-height:46px"><span class="faint">#</span><input inputmode="numeric" value={f.first_slip_no} onInput={(e) => up({ first_slip_no: e.currentTarget.value.replace(/\D/g, '').slice(0, 9) })} /></div>
        </div>
        <div class="li" style="flex-wrap:wrap">
          <div class="grow t">{t('reg_bills')}</div>
          <span class="chip tone-pakka bill-chip"><Icon name="Check" size={13} stroke={3} />{t('bill_gst_short')}</span>
          <button class={`chip bill-chip ${f.estimates ? 'tone-kacha' : 'tone-neutral'}`} onClick={() => up({ estimates: !f.estimates })}>
            <Icon name={f.estimates ? 'Check' : 'Plus'} size={13} stroke={3} />{t('bill_none_short')}
          </button>
        </div>
      </div>
    </>
  );
}

// ---------- 3. the team ----------
function Team({ f, up }) {
  const [adding, setAdding] = useState(false);
  const [p, setP] = useState({ name: '', phone: '', role: 'sales' });
  const [err, setErr] = useState(null);
  const add = () => {
    const phone = normalizeIndianMobile(p.phone);
    if (!p.name.trim() || !phone) return setErr(t('login_bad_phone'));
    if (f.team.some((x) => x.phone === phone)) return setErr(t('reg_person_dup'));
    up({ team: [...f.team, { name: p.name.trim(), phone, role: p.role }] });
    setP({ name: '', phone: '', role: 'sales' }); setAdding(false); setErr(null);
  };
  return (
    <>
      <h1 class="login-title">{t('reg_team_t')}</h1>
      <p class="login-sub">{t('reg_team_s')}</p>
      <div class="card">
        <div class="li"><Avatar name={f.owner_name || '?'} size={42} /><div class="grow"><div class="t">{f.owner_name}</div><div class="s">{t('role_owner')} · {t('role_s_owner')}</div></div><span class="chip tone-neutral">{t('reg_you_chip')}</span></div>
        {f.team.map((x, i) => (
          <div class="li"><Avatar name={x.name} size={42} /><div class="grow"><div class="t">{x.name}</div><div class="s">{t(`role_${x.role}`)} · {t(`role_s_${x.role}`)} · <span class="num">{x.phone.slice(3)}</span></div></div>
            <button class="round" style="width:36px;height:36px" aria-label="remove" onClick={() => up({ team: f.team.filter((_, k) => k !== i) })}><Icon name="X" size={16} /></button></div>
        ))}
      </div>
      {!adding ? (
        <button class="dashed" onClick={() => setAdding(true)}><Icon name="UserPlus" size={19} stroke={2.2} />{t('reg_add_person')}</button>
      ) : (
        <div class="card pad" style="margin-top:10px">
          <div class="lbl">{t('reg_person_name')}</div>
          <div class="field"><input value={p.name} maxLength={100} onInput={(e) => setP({ ...p, name: e.currentTarget.value })} autofocus /></div>
          <div class="lbl" style="margin-top:12px">{t('reg_person_phone')}</div>
          <div class="field"><span class="faint" style="font-weight:700">+91</span><input type="tel" inputmode="numeric" maxLength={14} value={p.phone} onInput={(e) => setP({ ...p, phone: e.currentTarget.value })} placeholder="98765 43210" /></div>
          <div class="lbl" style="margin-top:12px">{t('reg_person_role')}</div>
          <div class="pick">{TEAM_ROLES.map((r) => <button class={p.role === r.id ? 'on' : ''} onClick={() => setP({ ...p, role: r.id })}><Icon name={r.icon} size={16} />{t(r.word)}</button>)}</div>
          <div class="faint" style="font-size:13px;margin-top:8px">{t(`role_s_${p.role}`)}</div>
          {err && <div class="error">{err}</div>}
          <div class="row" style="margin-top:14px"><button class="btn btn-ghost" onClick={() => { setAdding(false); setErr(null); }}>{t('cancel')}</button><button class="btn btn-accent grow" onClick={add}>{t('reg_person_add')}</button></div>
        </div>
      )}
      {f.team.length > 0 && <div class="faint row" style="font-size:13px;font-weight:600;margin-top:10px;gap:6px"><Icon name="MessageCircle" size={15} />{t('reg_invite_later')}</div>}
    </>
  );
}

// ---------- 4. free trial ----------
function Trial({ f, up }) {
  return (
    <>
      <h1 class="login-title">{t('reg_trial_t')}</h1>
      <p class="login-sub">{t('reg_trial_s')}</p>
      <div class="seg">
        <button class={f.yearly ? 'on' : ''} onClick={() => up({ yearly: true })}>{t('plan_yearly')} <span class="chip tone-ok" style="height:20px;margin-left:6px;font-size:11px">{t('plan_2free')}</span></button>
        <button class={!f.yearly ? 'on' : ''} onClick={() => up({ yearly: false })}>{t('plan_monthly')}</button>
      </div>
      <div class="plans">
        {PLANS.map((p) => (
          <button class={`plan ${f.plan === p.id ? 'on' : ''} ${p.best ? 'best' : ''}`} onClick={() => up({ plan: p.id })}>
            {p.best && <span class="plan-best"><Icon name="Sparkles" size={12} stroke={2.4} />{t('plan_best')}</span>}
            <div class="row" style="justify-content:space-between;align-items:baseline">
              <b style="font-size:17px">{t(p.word)}</b>
              <span><b class="num" style="font-size:21px">{money(f.yearly ? p.year : p.month, false)}</b><span class="per">{t(f.yearly ? 'per_year' : 'per_month')}</span></span>
            </div>
            <div class="plan-s">{t(p.sub)}</div>
          </button>
        ))}
      </div>
      <div class="row muted" style="align-items:flex-start;gap:8px;margin-top:14px;font-size:13px;line-height:1.45">
        <span style="color:var(--ok);display:flex;flex:none"><Icon name="ShieldCheck" size={17} stroke={2.2} /></span>{t('plan_note')}
      </div>
    </>
  );
}
