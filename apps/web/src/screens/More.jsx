// More — every other screen, plus language, appearance and log out.
import { t, lang, setLang } from '../lib/i18n.js';
import { useEffect, useState } from 'preact/hooks';
import { me, company, can, lock, logOut, switchPerson, fingerOn, switchOffFinger, pinJustNow, prepareFinger, lockAfter, setLockAfter } from '../lib/session.js';
import { LOCK_CHOICES } from '../lib/autolock.js';
import { passkeyReady, bt, bioIcon, bioName } from '../lib/passkey.js';
import { outbox } from '../lib/offline/outbox.js';
import { online } from '../lib/net.js';
import { toast } from '../ui/toast.js';
import { turnFingerOn, UseKey } from '../ui/FingerOffer.jsx';
import { theme, applyTheme } from '../lib/theme.js';
import { go } from '../lib/router.js';
import { MENU } from '../config/navigation.js';
import { APP } from '../config/app.js';
import { BUILD } from '../lib/update.js';
import { longDay } from '../lib/format.js';
import { Icon, TopBar } from '../ui/kit.jsx';
import { easy, setEasy, say, moneyTalk, canSpeak } from '../lib/easy.js';
import { phoneVoices, voicesReady, isClearVoice } from '../lib/speech.js';
import { isApple } from '../lib/passkey.js';

export function More() {
  const c = company.value;
  const trialLeft = c?.plan === 'trial' && c?.trial_ends_at ? Math.max(0, Math.ceil((new Date(c.trial_ends_at) - Date.now()) / 86400000)) : null;
  const items = MENU.filter((m) => m.id !== 'today' && (!m.perm || can(m.perm)));
  const [sure, setSure] = useState(false);
  // entries not sent yet would be lost: ask once ("tap again"), and show how many
  const outLater = () => { if (outbox.value.length && !sure) { setSure(true); toast(t('off_logout_q', outbox.value.length), 6000); return; } logOut(); };
  return (
    <>
      <TopBar title={t('nav_more')} sub={`${me.value?.name} · ${company.value?.name}`} onBack={null} />
      <div class="page">
        {trialLeft != null && (
          <button class="card li" style="margin-bottom:12px" onClick={() => can('people') && go('/start')}>
            <div class="iconbox tone-accent"><Icon name="Gift" /></div>
            <div class="grow"><div class="t">{t('trial_left', trialLeft)}</div><div class="s">{t('trial_ends', longDay(company.value.trial_ends_at, company.value.timezone))}</div></div>
          </button>
        )}
        <div class="card">
          {items.map((m) => (
            <button class="li" onClick={() => go(m.route)}>
              <div class="iconbox tone-neutral"><Icon name={m.icon} /></div>
              <div class="grow t">{t(m.word)}</div>
              <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
            </button>
          ))}
        </div>

        <div class="card pad" style="margin-top:14px">
          <label class="row" style="gap:12px">
            <div class="iconbox tone-accent"><Icon name="Sun" /></div>
            <div class="grow"><div class="t" style="font-weight:700;font-size:16px">{t('easy_title')}</div><div class="muted" style="font-size:13px">{t('easy_sub')}</div></div>
            <input type="checkbox" class="switch" checked={easy.value.on} onChange={(e) => setEasy({ on: e.currentTarget.checked })} />
          </label>
          <div class="lbl" style="margin-top:14px">{t('speak_title')}</div>
          <div class="seg speak-seg">{[['hi', 'हिंदी'], ['hn', 'Hinglish'], ['en', 'English'], ['off', t('speak_off')]].map(([id, w]) =>
            <button class={easy.value.speak === id ? 'on' : ''} onClick={() => setEasy({ speak: id })}>{w}</button>)}</div>
          {easy.value.speak !== 'off' && (canSpeak()
            ? <VoicePick how={easy.value.speak} />
            : <div class="notice tone-warn" style="margin-top:8px;font-size:13px">{t('speak_none')}</div>)}
          <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:10px">{t('easy_note')}</div>
        </div>

        <FingerSwitch />
        <LockAfter />

        <div class="sec"><h3>{t('language')}</h3></div>
        <div class="seg">{APP.languages.map((l) => <button class={lang.value === l.id ? 'on' : ''} onClick={() => setLang(l.id)}>{l.label}</button>)}</div>

        <div class="sec"><h3>{t('theme')}</h3></div>
        <div class="seg">
          {[['auto', 'theme_auto'], ['light', 'theme_light'], ['dark', 'theme_dark']].map(([id, w]) =>
            <button class={theme.value === id ? 'on' : ''} onClick={() => applyTheme(id)}>{t(w)}</button>)}
        </div>

        <div class="card" style="margin-top:22px">
          <button class="li" onClick={lock}><div class="iconbox tone-neutral"><Icon name="Lock" /></div><div class="grow t">{t('lock')}</div></button>
          <button class="li" onClick={switchPerson}><div class="iconbox tone-neutral"><Icon name="Users" /></div><div class="grow t">{t('switch_person')}</div></button>
          <button class="li" onClick={outLater}><div class="iconbox tone-bad"><Icon name="LogOut" /></div><div class="grow t">{t('log_out_phone')}</div></button>
        </div>
        <div class="faint" style="text-align:center;font-size:12px;margin-top:18px">{APP.name} · v{APP.version}{BUILD ? ` · ${BUILD.slice(0, 10)} ${BUILD.slice(11, 16)} UTC` : ''}</div>
      </div>
    </>
  );
}

/** Fingerprint / face unlock on this phone for the person using it. */
function FingerSwitch() {
  const [ready, setReady] = useState(null);
  const [on, setOn] = useState(fingerOn());
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(null);   // 'have' | 'maybe': this phone already has the key → "Use it with Face ID"
  // switching on needs a PIN in the last 10 minutes; then get the challenge ready so the tap goes straight to Face ID
  useEffect(() => { passkeyReady().then((ok) => { setReady(ok); if (ok && !fingerOn() && Date.now() - pinJustNow.value < 9 * 60000) prepareFinger('register'); }); }, []);
  if (ready === null) return null;
  const flip = async (want) => {
    setBusy(true);
    if (want) { const ok = await turnFingerOn(); setOn(ok === true); setKey(ok === true || !ok ? null : ok); } else { await switchOffFinger(); setOn(false); setKey(null); toast(bt('fp_off_done')); }
    setBusy(false);
  };
  return (
    <div class="card pad" style="margin-top:14px">
      <label class="row" style="gap:12px">
        <div class="iconbox tone-accent"><Icon name={bioIcon()} /></div>
        <div class="grow"><div class="t" style="font-weight:700;font-size:16px">{bt('fp_title')}</div><div class="muted" style="font-size:13px">{ready ? bt('fp_sub') : t('fp_none')}</div></div>
        <input type="checkbox" class="switch" checked={on} disabled={!ready || busy || (!on && !online.value)} onChange={(e) => flip(e.currentTarget.checked)} />
      </label>
      {key && !on && <UseKey kind={key} onDone={() => { setOn(true); setKey(null); }} />}
    </div>
  );
}

/** "Lock the app": how soon after leaving the app it asks for Face ID / fingerprint / PIN again (this person, this phone). */
function LockAfter() {
  const [mins, setMins] = useState(lockAfter());
  const pick = (m) => { setLockAfter(m); setMins(m); toast(t('al_saved', t(`al_${m}`))); };
  return (
    <div class="card pad" style="margin-top:14px">
      <div class="row" style="gap:12px">
        <div class="iconbox tone-accent"><Icon name="TimerReset" /></div>
        <div class="grow"><div class="t" style="font-weight:700;font-size:16px">{t('al_title')}</div><div class="muted" style="font-size:13px">{fingerOn() ? t('al_sub_f', bioName()) : t('al_sub')}</div></div>
      </div>
      <div class="lock-seg" role="radiogroup" aria-label={t('al_title')}>
        {LOCK_CHOICES.map((m) => <button role="radio" aria-checked={mins === m ? 'true' : 'false'} class={mins === m ? 'on' : ''} onClick={() => pick(m)}>{t(`al_${m}`)}</button>)}
      </div>
      <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:10px">
        {mins === 0 ? t('al_now_0') : mins >= 60 ? t('al_long', t(`al_w_${mins}`)) : t('al_now_n', t(`al_w_${mins}`))}
      </div>
    </div>
  );
}

/** The voice: hear it, slow / normal, and which of the phone's voices (best first; "Clearer" = the natural ones). */
function VoicePick({ how }) {
  const voiceLang = how === 'en' ? 'en' : 'hi';
  const [list, setList] = useState(() => phoneVoices(voiceLang));
  useEffect(() => { setList(phoneVoices(voiceLang)); voicesReady().then(() => setList(phoneVoices(voiceLang))); }, [voiceLang]);
  const sample = moneyTalk(how, 125000, 'Sharma ji');
  const hear = () => say(sample.text, sample.voiceLang);
  const chosen = easy.value.voice && list.some((v) => v.voiceURI === easy.value.voice) ? easy.value.voice : null;
  const pick = (uri) => { setEasy({ voice: uri }); setTimeout(hear, 50); };
  const clear = list.some(isClearVoice);
  return (
    <div class="voice-pick">
      <button class="btn btn-ghost btn-block" style="margin-top:10px;min-height:48px" onClick={hear}><Icon name="Volume2" size={18} />{t('speak_test')}</button>
      <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:6px">{t('speak_says')} “{sample.text}”</div>
      <div class="lbl" style="margin-top:12px">{t('speak_speed')}</div>
      <div class="seg">{[['slow', 'speak_slow'], ['normal', 'speak_normal']].map(([id, w]) =>
        <button class={(easy.value.rate || 'normal') === id ? 'on' : ''} onClick={() => { setEasy({ rate: id }); setTimeout(hear, 50); }}>{t(w)}</button>)}</div>
      {list.length > 1 && (
        <>
          <div class="lbl" style="margin-top:12px">{t('speak_voice')}</div>
          <div class="card voice-list">
            <button class={`li ${!chosen ? 'on' : ''}`} onClick={() => pick(null)}>
              <div class="grow"><div class="t">{t('speak_auto')}</div><div class="s">{voiceName(list[0])}</div></div>
              <span class={`radio ${!chosen ? 'on' : ''}`} />
            </button>
            {list.slice(0, 5).map((v) => (
              <button class={`li ${chosen === v.voiceURI ? 'on' : ''}`} onClick={() => pick(v.voiceURI)}>
                <div class="grow"><div class="t">{voiceName(v)}</div>{isClearVoice(v) && <div class="s" style="color:var(--ok);font-weight:700">{t('speak_clear')}</div>}</div>
                <span class={`radio ${chosen === v.voiceURI ? 'on' : ''}`} />
              </button>))}
          </div>
        </>
      )}
      {isApple() && voiceLang === 'hi' && !clear && <div class="notice tone-accent" style="margin-top:10px;font-size:13px">{t('speak_tip_iphone')}</div>}
    </div>
  );
}
const voiceName = (v) => String(v?.name || '').replace(/\s*[-–]\s*(Hindi|English).*$/i, '').replace(/^Microsoft\s+/i, '').trim() || '—';
