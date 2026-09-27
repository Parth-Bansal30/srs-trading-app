// Light / dark / follow the phone. Remembered on this device.
import { signal } from '@preact/signals';
import { store } from './store.js';

export const theme = signal(store.get('theme') || 'auto');
export function applyTheme(v = theme.value) {
  theme.value = v;
  store.set('theme', v);
  if (v === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', v);
}
