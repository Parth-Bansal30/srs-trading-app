// The front door: what anyone sees first, and the short tour before registering a business.
import { useState } from 'preact/hooks';
import { t, lang, setLang } from '../../lib/i18n.js';
import { openDoor, goPhone, goBack } from '../../lib/session.js';
import { APP } from '../../config/app.js';
import { Icon } from '../../ui/kit.jsx';
import { Mark, Pile } from './art.jsx';
import './login.css';

function LangButton({ light }) {
  const i = APP.languages.findIndex((l) => l.id === lang.value);
  const next = APP.languages[(i + 1) % APP.languages.length];
  return (
    <button class={`gw-lang ${light ? 'light' : ''}`} onClick={() => setLang(next.id)} aria-label="language">
      <Icon name="Languages" size={16} />{APP.languages[i]?.label}
    </button>
  );
}

export function Welcome() {
  return (
    <div class="gw">
      <div class="gw-hero">
        <div class="gw-glow" />
        <div class="gw-top"><Mark size={38} light /><span class="gw-name">{APP.name}</span><LangButton light /></div>
        <div class="gw-pile"><Pile rows={6} r={25} hot={[8, 13, 17]} width={360} /></div>
        <div class="gw-hero-copy">
          <h1>{t('gw_tagline')}</h1>
          <p>{t('gw_sub')}</p>
        </div>
      </div>
      <div class="gw-sheet">
        <div class="gw-sheet-inner">
          <h2 class="gw-card-t">{t('gw_card_t')}</h2>
          <h1 class="gw-title">{t('gw_tagline')}</h1>
          <p class="gw-sub">{t('gw_sub')}</p>
          <button class="btn btn-accent btn-block" style="margin-top:22px" onClick={() => openDoor('signup')}><Icon name="Store" size={20} stroke={2.3} />{t('gw_start')}</button>
          <button class="btn btn-ghost btn-block" style="margin-top:10px" onClick={() => openDoor('login')}>{t('gw_login')}</button>
          <button class="link gw-join" onClick={() => openDoor('join')}><Icon name="MessageCircle" size={16} stroke={2.2} />{t('gw_join')}</button>
          <div class="gw-trust faint">
            <span><Icon name="ShieldCheck" size={14} stroke={2} />{t('gw_trust_data')}</span>
            <span><Icon name="Smartphone" size={14} stroke={2} />{t('gw_trust_devices')}</span>
            <span><Icon name="Languages" size={14} stroke={2} />हिंदी · English</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- quick tour (3 cards) ----------
function SlipPicture() {
  return (
    <div class="tour-slip">
      <div class="row" style="justify-content:space-between"><b class="num">#1061</b><span class="chip tone-pakka">{t('bill_gst_short')}</span></div>
      <div class="faint" style="font-size:12px;font-weight:600;margin-top:2px">Rana Tools · 10:42 am</div>
      <div class="tour-lines">
        <div><span>EN8 · 32 mm · 12 pcs</span><span class="num">26.5 kg</span></div>
        <div class="muted"><span>26.5 kg × ₹70</span><span class="num">₹1,855.00</span></div>
        <div class="muted"><span>Cutting · 12 × ₹10</span><span class="num">₹120.00</span></div>
        <div class="muted"><span>GST 18%</span><span class="num">₹355.50</span></div>
      </div>
      <div class="tour-total"><span>Total</span><span class="num">₹2,330.50</span></div>
    </div>
  );
}
function ReminderPicture() {
  return (
    <div class="tour-slip" style="transform:rotate(2deg)">
      <div class="row"><div class="iconbox tone-bad" style="width:34px;height:34px"><Icon name="BellRing" size={17} /></div>
        <div class="grow"><b>Gupta Fabricators</b><div class="faint" style="font-size:12px;font-weight:600">2 slips · 27 days</div></div><b class="num">₹13,900</b></div>
      <div class="tour-bubble">Namaste! Your balance is ₹13,900 for slips #1042, #1047…</div>
      <div class="row" style="margin-top:10px;gap:8px">
        <span class="chip tone-neutral" style="height:32px;padding:0 12px">{t('not_now')}</span>
        <span class="chip" style="height:32px;padding:0 12px;background:var(--wa);color:#fff"><Icon name="MessageCircle" size={14} stroke={2.4} />{t('rem_send')}</span>
      </div>
    </div>
  );
}
function StaffPicture() {
  return (
    <div class="tour-slip" style="transform:rotate(-2deg)">
      <div class="row"><div class="tour-av" style="background:#1C8456">S</div><div class="grow"><b>Suresh</b><div class="faint" style="font-size:12px;font-weight:600">{t('role_weigher')}</div></div><Icon name="Scale" size={20} /></div>
      <div class="tour-lines">
        <div><span>EN8 · 32 mm</span><span class="num">58.6 kg</span></div>
        <div class="muted"><span>Amount</span><span class="num">₹ • • • •</span></div>
      </div>
      <div class="row" style="margin-top:10px"><div class="tour-av" style="background:#8A5A2B">P</div><div class="grow"><b>Papa</b><div class="faint" style="font-size:12px;font-weight:600">{t('role_owner')} · {t('role_s_owner')}</div></div><Icon name="Crown" size={20} /></div>
    </div>
  );
}
const CARDS = [
  { pic: SlipPicture, t: 'tour1_t', s: 'tour1_s', tag: <span class="chip tone-ok tour-tag"><Icon name="Check" size={13} stroke={3} /> 30 sec</span> },
  { pic: ReminderPicture, t: 'tour2_t', s: 'tour2_s' },
  { pic: StaffPicture, t: 'tour3_t', s: 'tour3_s' },
];

export function Tour() {
  const [i, setI] = useState(0);
  const c = CARDS[i];
  const Pic = c.pic;
  return (
    <div class="login">
      <div class="login-top">
        <button class="round" onClick={() => (i ? setI(i - 1) : goBack())} aria-label={t('back')}><Icon name="ChevronLeft" size={20} stroke={2.2} /></button>
        <div class="grow" />
        <button class="link" style="color:var(--ink-2)" onClick={goPhone}>{t('gw_skip')}</button>
      </div>
      <div class="tour-card">
        <div class="tour-bg"><Pile rows={4} r={20} width={200} fade /></div>
        {i === 0 && <div class="tour-wa"><Icon name="MessageCircle" size={28} stroke={2.2} /></div>}
        {c.tag}
        <Pic />
      </div>
      <div class="tour-dots">{CARDS.map((_, k) => <span class={k === i ? 'on' : ''} />)}</div>
      <h1 class="login-title">{t(c.t)}</h1>
      <p class="login-sub">{t(c.s)}</p>
      <div style="flex:1" />
      <button class="btn btn-brand btn-block" style="margin-bottom:26px" onClick={() => (i < CARDS.length - 1 ? setI(i + 1) : goPhone())}>
        {t('gw_next')}<Icon name="ArrowRight" size={20} stroke={2.3} />
      </button>
    </div>
  );
}
