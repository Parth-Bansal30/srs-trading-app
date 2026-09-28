/**
 * One-time setup for the evening summary's phone notifications (dev project):
 *   - makes the VAPID key pair (the server's "signature" for push messages) and a shared secret,
 *   - stores them as Edge Function secrets (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, EVENING_CRON_SECRET),
 *   - stores the api address + the same secret in Supabase Vault, where the pg_cron job reads them.
 * Nothing secret is printed. Running it again keeps the existing keys (phones stay subscribed);
 * use --rotate to make new ones (every phone then has to switch notifications on again).
 *
 *   npm run evening:setup            npm run evening:setup -- --rotate
 */
import crypto from 'node:crypto';
import { query, lit, PROJECT_REF } from './lib/supabase.mjs';
import { generateVapidKeys } from '../supabase/functions/api/webpush.js';

const rotate = process.argv.includes('--rotate');
const APP_URL = 'https://srs-trading-app.bansalparth12345.workers.dev';
const api = async (path, init = {}) => {
  const fs = await import('node:fs');
  const tok = process.env.SUPABASE_ACCESS_TOKEN || fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^SUPABASE_ACCESS_TOKEN=(.*)$/m)?.[1]?.trim();
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}${path}`, {
    ...init, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
};

const existing = new Set((await api('/secrets')).map((s) => s.name));
const have = existing.has('VAPID_PUBLIC_KEY') && existing.has('VAPID_PRIVATE_KEY') && existing.has('EVENING_CRON_SECRET');
if (have && !rotate) {
  console.log('✓ Push keys and the job secret are already set (use --rotate to replace them).');
} else {
  const v = await generateVapidKeys();
  const secret = crypto.randomBytes(32).toString('base64url');
  await api('/secrets', { method: 'POST', body: JSON.stringify([
    { name: 'VAPID_PUBLIC_KEY', value: v.publicKey },
    { name: 'VAPID_PRIVATE_KEY', value: v.privateKey },
    { name: 'VAPID_SUBJECT', value: APP_URL },
    { name: 'EVENING_CRON_SECRET', value: secret },
  ]) });
  // Vault: the pg_cron job reads these
  for (const [name, value] of [['evening_url', `https://${PROJECT_REF}.supabase.co/functions/v1/api`], ['evening_cron_secret', secret]]) {
    await query(`do $$ declare v_id uuid; begin
      select id into v_id from vault.secrets where name = ${lit(name)};
      if v_id is null then perform vault.create_secret(${lit(value)}, ${lit(name)});
      else perform vault.update_secret(v_id, ${lit(value)}); end if; end $$;`);
  }
  console.log(`✓ ${rotate ? 'New' : 'Made'} push keys + job secret (Edge Function secrets and Vault). Nothing printed.`);
}
const [job] = await query("select schedule, active from cron.job where jobname = 'evening-summary'");
console.log(job ? `✓ Evening job runs ${job.schedule} (${job.active ? 'on' : 'OFF'})` : '✗ The evening job is missing — run npm run db:migrate first.');
console.log('Next: npm run functions:deploy (the api function reads the new secrets when it starts).');
