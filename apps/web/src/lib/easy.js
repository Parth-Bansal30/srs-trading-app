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

// ---------------------------------------------------------------- saying it out loud
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

function pickVoice(code) {
  const vs = window.speechSynthesis.getVoices() || [];
  return vs.find((v) => v.lang === code) || vs.find((v) => v.lang?.startsWith(code.slice(0, 2))) || null;
}

/** Say a sentence in Hindi ('hi') or English ('en'). Never throws. */
export function say(text, voiceLang = 'hi') {
  if (!canSpeak() || !text) return false;
  try {
    const code = voiceLang === 'en' ? 'en-IN' : 'hi-IN';
    const u = new SpeechSynthesisUtterance(text);
    u.lang = code; u.rate = 0.95;
    const v = pickVoice(code);
    if (v) u.voice = v;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    return true;
  } catch { return false; }
}

/** The sentence for money received, in the chosen speaking language. amount in rupees. */
export function moneyWords(how, amount, customer) {
  const rs = Math.round(Number(amount) || 0);
  const who = String(customer || '').trim();
  if (how === 'en') return who ? `Received ${rs} rupees from ${who}.` : `Received ${rs} rupees.`;
  if (how === 'hn') return who ? `${rs} rupaye mil gaye, ${who} se.` : `${rs} rupaye mil gaye.`;
  return who ? `${who} से ${rs} रुपये मिल गए।` : `${rs} रुपये मिल गए।`;
}

/**
 * Money was SAVED in the app (never from a screenshot): show the big green "₹45,000 mil gaye" in easy
 * mode, and say it out loud when speaking is on. { amount, customer, slipNo, account, balance }
 */
export const praise = signal(null);
export function moneySaved(p) {
  if (!(Number(p?.amount) > 0)) return;
  const e = easy.value;
  if (e.on) praise.value = { ...p, at: Date.now() };
  if (e.speak && e.speak !== 'off') say(moneyWords(e.speak, p.amount, p.customer), e.speak === 'en' ? 'en' : e.speak === 'hn' ? 'hi' : 'hi');
}
export const sayAgain = () => { const p = praise.value; const e = easy.value; if (p && e.speak !== 'off') say(moneyWords(e.speak, p.amount, p.customer), e.speak === 'en' ? 'en' : 'hi'); };
