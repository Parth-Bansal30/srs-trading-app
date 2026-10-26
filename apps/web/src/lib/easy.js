// Easy mode ("Papa mode", 8 Oct 2026): one switch per person on this phone — big text, four big tiles
// on Today, a help button on every screen, and money said out loud. Numbers, permissions and khata
// are exactly the same as normal mode. Also: speaking can be switched on in normal mode.
import { signal, effect } from '@preact/signals';
import { me } from './session.js';
import { store } from './store.js';
import { lang } from './i18n.js';

const KEY = (id) => `easy:${id}`;
const DEFAULT = { on: false, speak: 'off' };
/** { on, speak: 'hi' | 'hn' | 'en' | 'off' } for the person using the app now. */
export const easy = signal(DEFAULT);

effect(() => {
  const id = me.value?.id;
  easy.value = id ? { ...DEFAULT, ...(store.json(KEY(id)) || {}) } : DEFAULT;
});
effect(() => { try { document.documentElement.classList.toggle('easy', !!easy.value.on); } catch { /* no page */ } });

export function setEasy(patch) {
  const id = me.value?.id;
  const next = { ...easy.value, ...patch };
  // switching easy mode on also switches speaking on (in the person's language) unless they chose otherwise
  if (patch.on === true && easy.value.speak === 'off' && !('speak' in patch)) next.speak = lang.value === 'en' ? 'en' : lang.value === 'hn' ? 'hn' : 'hi';
  easy.value = next;
  if (id) store.setJson(KEY(id), next);
}

// ---------------------------------------------------------------- saying it out loud (lib/speech.js, smoother 25 Oct 2026)
import { canSpeak as canSpeakNow, say as sayNow, moneySpeech, primeSpeech } from './speech.js';
export const canSpeak = canSpeakNow;

/** Say a sentence in Hindi ('hi') or English ('en') with this person's voice and speed. Never throws. */
export const say = (text, voiceLang = 'hi') => sayNow(text, voiceLang, { voice: easy.value.voice || null, rate: easy.value.rate || 'normal' });

/** The sentence spoken for money received ({ text, voiceLang }). Hindi and Hinglish are spoken in Hindi script. */
export const moneyTalk = (how, amount, customer) => moneySpeech(how, amount, customer);

/** Kept for older screens: the sentence for money received (spoken form). */
export const moneyWords = (how, amount, customer) => moneySpeech(how, amount, customer).text;

const speakMoney = (p) => { const e = easy.value; if (e.speak && e.speak !== 'off') { const m = moneySpeech(e.speak, p.amount, p.customer); say(m.text, m.voiceLang); } };

/**
 * Money was SAVED in the app (never from a screenshot): show the big green "₹45,000 mil gaye" in easy
 * mode, and say it out loud when speaking is on. { amount, customer, slipNo, account, balance }
 */
export const praise = signal(null);
export function moneySaved(p) {
  if (!(Number(p?.amount) > 0)) return;
  const e = easy.value;
  if (e.on) praise.value = { ...p, at: Date.now() };
  speakMoney(p);
}
export const sayAgain = () => { const p = praise.value; if (p) speakMoney(p); };

// iPhone lets the voice speak after saving only if a first (silent) sentence came from a tap
if (typeof document !== 'undefined') document.addEventListener('pointerdown', () => { if (easy.value.speak && easy.value.speak !== 'off') primeSpeech(); }, { capture: true, passive: true });
