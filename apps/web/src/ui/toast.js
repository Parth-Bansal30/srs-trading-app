// A short message at the bottom of the screen ("Order #1061 saved").
import { signal } from '@preact/signals';
export const toastMsg = signal(null);
let timer;
export function toast(msg, ms = 2800) { toastMsg.value = msg; clearTimeout(timer); timer = setTimeout(() => { toastMsg.value = null; }, ms); }
