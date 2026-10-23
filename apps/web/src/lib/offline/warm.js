// While the internet is on, keep the data the counter needs on the phone (23 Oct 2026): grades, rates and
// customers, money accounts, the weighing list, stock, khata. Then a sale, weighing, pickup or expense
// still works if the internet goes. Runs a few seconds after unlocking, then every 10 minutes at most.
import { call } from '../api.js';
import { loadCatalog, allSpecialRates } from '../catalog.js';
import { online } from '../net.js';

let last = 0;
export function warmUp(perms = {}) {
  if (!online.value || Date.now() - last < 10 * 60000) return;
  last = Date.now();
  setTimeout(() => {
    const jobs = [loadCatalog(true), allSpecialRates(true)];
    if (perms.money) jobs.push(call('accounts', {}));
    if (perms.weigh) jobs.push(call('weighingList', {}));
    if (perms.new || perms.orders) jobs.push(call('stockData', {}));
    if (perms.khata) jobs.push(call('khata', {}));
    if (perms.money && perms.today) jobs.push(call('cashBook', {}));
    Promise.allSettled(jobs);
  }, 3000);
}
