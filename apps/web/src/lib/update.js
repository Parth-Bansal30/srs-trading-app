// Keeps the app on the newest version. The installed phone app can stay open in the background for days,
// so logging out and in again does NOT load a new version by itself. Here the app quietly checks the
// website for a newer version (on start, when it comes back to the screen, every 30 minutes) and shows
// "New version ready · Update". Tapping it reloads. Shop data is never touched.
import { signal } from '@preact/signals';
import { markLeaving } from './autolock.js';

export const updateReady = signal(false);
export const BUILD = typeof __BUILD__ !== 'undefined' ? __BUILD__ : '';

const current = () => (document.querySelector('script[src*="assets/index-"]')?.getAttribute('src') || '').split('/').pop();

export async function checkUpdate() {
  const mine = current();
  if (!mine || (location.protocol !== 'https:' && location.hostname !== 'localhost')) return false; // single-file copy
  try {
    const html = await fetch('./', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
    const latest = html.match(/assets\/(index-[\w-]+\.js)/)?.[1];
    if (latest && latest !== mine) updateReady.value = true;
  } catch { /* offline: try later */ }
  return updateReady.value;
}

export function watchUpdates() {
  setTimeout(checkUpdate, 8000);
  setInterval(checkUpdate, 30 * 60 * 1000);
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(); });
}

export const updateNow = () => { markLeaving(); location.reload(); };
