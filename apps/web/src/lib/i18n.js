// Words in the person's language. Screens call t('key', …values) — never write text directly.
import { signal } from '@preact/signals';
import { WORDS } from '../content/words.js';
import { APP } from '../config/app.js';
import { store } from './store.js';

const INDEX = { en: 0, hi: 1, hn: 2 };
export const lang = signal(store.get('lang') || APP.defaultLanguage);

export function setLang(l) {
  if (!(l in INDEX)) return;
  lang.value = l;
  store.set('lang', l);
  document.documentElement.lang = l === 'hi' ? 'hi' : 'en';
}

export function t(key, ...args) {
  const v = WORDS[key];
  if (!v) {
    if (import.meta.env.DEV) console.warn(`[words] missing: ${key}`);
    return key;
  }
  let s = v[INDEX[lang.value]] ?? v[0];
  args.forEach((a, i) => { s = s.split(`{${i}}`).join(String(a)); });
  return s;
}
