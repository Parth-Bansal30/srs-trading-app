// Reading data for the screens. The database only returns what this person may see
// (no money for the weigher, no kacha without permission), so screens stay simple.
import { cashOf, businessDate } from '@srs/core';
import { db } from './backend.js';
import { call } from './api.js';
import { dayStartISO } from './format.js';

const q = async (p) => { const { data, error } = await p; if (error) throw error; return data; };

/** Everything the Today screen shows. perms decide what is asked for. */
export async function loadToday({ perms, tz }) {
  const since = dayStartISO(tz);
  const out = { sales: null, cash: null, counts: {}, recent: [], reminders: null };
  const jobs = [];
  if (perms.money) {
    jobs.push(q(db.from('orders').select('bill_type,total_amount').eq('status', 'done').gte('done_at', since)).then((rows) => {
      const sum = (b) => rows.filter((r) => !b || r.bill_type === b).reduce((a, r) => a + Number(r.total_amount), 0);
      out.sales = { total: sum(), pakka: sum('pakka'), kacha: sum('kacha'),
        nPakka: rows.filter((r) => r.bill_type === 'pakka').length, nKacha: rows.filter((r) => r.bill_type === 'kacha').length };
    }));
    jobs.push(q(db.from('orders').select('status').in('status', ['estimate', 'accepted', 'weighed'])).then((rows) => {
      out.counts.estimates = rows.filter((r) => r.status === 'estimate').length;
      out.counts.readyForPickup = rows.filter((r) => r.status === 'weighed').length;
      out.counts.accepted = rows.filter((r) => r.status === 'accepted').length;
    }));
    jobs.push(q(db.from('orders').select('id,slip_no,status,bill_type,total_amount,created_at,done_at,customers(name),order_items(count)')
      .neq('status', 'deleted').order('created_at', { ascending: false }).limit(8)).then((rows) => { out.recent = rows; }));
  }
  if (perms.money && perms.today) {
    // what should be in the drawer now: the cash book (left last night + cash in − cash out, 23 Oct 2026);
    // if that can't be read, the old way: the cash part of today's payments
    jobs.push(call('cashBook', {}).then((cb) => { out.cash = Number(cb.expected); out.cashBook = cb; })
      .catch(() => q(db.from('payments').select('amount,mode,parts:payment_parts(mode,amount)').neq('mode', 'Adjust').gte('received_at', since)).then((rows) => {
        out.cash = rows.reduce((a, r) => a + cashOf(r), 0);
      })));
  }
  if (perms.expenses || perms.settings) {
    const day = businessDate(new Date().toISOString(), tz);
    jobs.push(call('expenses', { from: day, to: day }).then((x) => { out.expenses = x.totals; }));
  }
  if (perms.weigh) jobs.push(call('weighingList', {}).then((list) => { out.counts.toWeigh = list.length; out.weighing = list; }));
  if (perms.money && perms.khata) {
    jobs.push(call('reminderList', {}).then((list) => {
      out.counts.reminders = list.length;
      out.reminders = { n: list.length, due: list.reduce((a, x) => a + x.due, 0), days: Math.min(...list.map((x) => x.oldest_days), 999) };
    }));
  }
  const res = await Promise.allSettled(jobs);
  const failed = res.filter((r) => r.status === 'rejected');
  if (failed.length === res.length && res.length) throw failed[0].reason;
  return out;
}
