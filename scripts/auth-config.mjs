/**
 * Login settings of the DEV project (Supabase Auth), kept in code so they are repeatable.
 *   node scripts/auth-config.mjs          → show the settings that matter
 *   node scripts/auth-config.mjs --apply  → apply them
 *
 * Front door (28 Sept 2026): sign-up is ON so a new business can prove its number and register.
 * A number that is in no shop still sees nothing (every read needs an unlocked staff session).
 * Practice numbers (code 123456, dev ONLY — never in production):
 *   +91 90000 00001–00005  SRS Trading (Dev) staff      +91 90000 00009  Claude's UI tester
 *   +91 90000 00010–00019  free for trying "Start my business" / invites
 *   +91 90000 00901–00906  automated tests
 */
import { PROJECT_REF, ROOT } from './lib/supabase.mjs';
import fs from 'node:fs';
import path from 'node:path';

const token = () => fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN=')).slice(22).trim();
const api = async (method, body) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`, {
    method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const PRACTICE = ['01', '02', '03', '04', '05', '09', ...Array.from({ length: 10 }, (_, i) => String(10 + i)), '901', '902', '903', '904', '905', '906']
  .map((n) => `91${'9000000000'.slice(0, 10 - n.length)}${n}`);

const cur = await api('GET');
const have = new Map(String(cur.sms_test_otp || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
const show = (c) => ({ disable_signup: c.disable_signup, external_phone_enabled: c.external_phone_enabled,
  sms_otp_exp: c.sms_otp_exp, sms_max_frequency: c.sms_max_frequency, rate_limit_sms_sent: c.rate_limit_sms_sent,
  sms_test_otp: String(c.sms_test_otp || '').split(',').filter(Boolean).length + ' practice numbers', sms_test_otp_valid_until: c.sms_test_otp_valid_until });
console.log('now:', show(cur));

if (process.argv.includes('--apply')) {
  for (const p of PRACTICE) if (!have.has(p)) have.set(p, '123456');
  const next = await api('PATCH', {
    disable_signup: false,
    sms_test_otp: [...have].map(([k, v]) => `${k}=${v}`).join(','),
    sms_test_otp_valid_until: cur.sms_test_otp_valid_until || '2027-03-31T23:59:59Z', // must be sent along, or the numbers are ignored
  });
  console.log('applied:', show(next));
  const missing = PRACTICE.filter((p) => !String(next.sms_test_otp).includes(`${p}=`));
  if (missing.length) { console.log('MISSING practice numbers:', missing.join(', ')); process.exit(1); }
}
