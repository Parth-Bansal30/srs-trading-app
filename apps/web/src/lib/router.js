// Screens are chosen by the address after "#", e.g. #/khata. Works offline and in a single file.
import { signal } from '@preact/signals';

const read = () => {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = h.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
};
export const route = signal(read());
addEventListener('hashchange', () => { route.value = read(); });
export const go = (to) => { location.hash = to; };
export const back = () => (history.length > 1 ? history.back() : go('/'));
