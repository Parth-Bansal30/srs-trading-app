// api — the one door for every business change the app makes.
//
// Request:  POST /functions/v1/api   Authorization: Bearer <the person's login>
//           { "v": 1, "op": "createOrder", "key": "<new uuid per action>", "args": { … } }
// Answer:   { "ok": true, "v": 1, "data": { … } }   or   { "ok": false, "error": "<code>", "message": "…" }
//
// The caller must be signed in AND unlocked with their PIN. Every change carries a request
// key: if the phone retries (bad network), the first answer comes back and nothing happens twice.
// The steel maths is done with @srs/core (copied into ../_shared/core by scripts/sync-core.mjs).
import { createClient } from 'npm:@supabase/supabase-js@2';
import * as core from '../_shared/core/index.js';
import { ApiError, API_VERSION, SUPPORTED_VERSIONS, READ_OPS, isUuid, makeOps, mapDbError, stableStringify } from './ops.js';
import { sendPush } from './webpush.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5';
// Phone notifications (evening summary). Set by scripts/evening-setup.mjs; without them the job does nothing.
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:owner@example.com';
const CRON_SECRET = Deno.env.get('EVENING_CRON_SECRET') ?? '';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (e: ApiError) => json(e.status, { ok: false, v: API_VERSION, error: e.code, message: e.message, ...e.extra });

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function rpc(fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    const mapped = mapDbError(error.code, error.message);
    if (mapped) throw mapped;
    throw Object.assign(new Error(`${fn}: ${error.message}`), { db: error });
  }
  return data;
}

async function companySettings(companyId: string) {
  const { data } = await admin.from('company_settings').select('weight_warn_pct').eq('company_id', companyId).maybeSingle();
  return data;
}

async function askModel(prompt: string): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) {
    console.error('ask: model call failed', r.status, (await r.text()).slice(0, 300));
    throw new ApiError(502, 'ai_unavailable', 'Ask Claude could not answer right now. Please try again.');
  }
  const body = await r.json();
  return (body.content || []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('').trim();
}

const push = VAPID_PUBLIC && VAPID_PRIVATE ? { vapid: { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE, subject: VAPID_SUBJECT }, sendPush } : null;
const { ops, runEvening } = makeOps({ core, rpc, companySettings, askModel: ANTHROPIC_KEY ? askModel : null, push });

/** Same length + same bytes, without leaking where they differ. */
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail(new ApiError(405, 'method_not_allowed', 'Use POST.'));
  const started = Date.now();
  let op = '?';
  try {
    // 0. The evening job (pg_cron, every 10 minutes) — only with the shared secret from Vault.
    const cron = req.headers.get('x-cron-secret');
    if (cron !== null) {
      if (!sameSecret(cron, CRON_SECRET)) throw new ApiError(401, 'not_signed_in', 'Please sign in.');
      op = 'eveningJob';
      const data = await runEvening();
      console.log(JSON.stringify({ op, ok: true, ms: Date.now() - started, ...data }));
      return json(200, { ok: true, v: API_VERSION, data });
    }

    // 1. Who is calling? (their own login, checked by the database)
    const authz = req.headers.get('Authorization') ?? '';
    if (!authz.startsWith('Bearer ')) throw new ApiError(401, 'not_signed_in', 'Please sign in.');
    const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authz } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: status, error: statusError } = await asCaller.rpc('login_status');
    if (statusError || !status?.signed_in) throw new ApiError(401, 'not_signed_in', 'Please sign in.');
    if (!status.staff) throw new ApiError(403, 'not_staff', 'This number is not added as staff.');
    if (!status.unlocked) throw new ApiError(401, 'pin_required', 'Enter your PIN.');
    const caller = { id: status.person.id, company_id: status.company.id, perms: status.person.perms || {} };

    // 2. What do they want?
    let body: { v?: number; op?: string; key?: string; args?: Record<string, unknown> };
    try { body = await req.json(); } catch { throw new ApiError(400, 'bad_request', 'Bad request.'); }
    if (!SUPPORTED_VERSIONS.includes(Number(body.v))) {
      throw new ApiError(426, 'update_app', 'Please update the app.', { supported: SUPPORTED_VERSIONS });
    }
    op = String(body.op ?? '');
    const fn = (ops as Record<string, (c: unknown, a: unknown, k?: string, h?: string) => Promise<unknown>>)[op];
    if (!Object.hasOwn(ops, op) || typeof fn !== 'function') throw new ApiError(400, 'unknown_op', `Unknown operation: ${op}`);
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    let key: string | undefined, hash: string | undefined;
    if (!READ_OPS.has(op)) {
      if (!isUuid(body.key)) throw new ApiError(400, 'missing_key', 'Missing request key.');
      key = body.key;
      hash = await sha256(stableStringify({ op, args }));
    }

    // 3. Do it.
    const data = await fn(caller, args, key, hash);
    console.log(JSON.stringify({ op, ok: true, ms: Date.now() - started, company: caller.company_id }));
    return json(200, { ok: true, v: API_VERSION, data });
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status >= 500) console.error(JSON.stringify({ op, error: e.code, message: e.message }));
      return fail(e);
    }
    console.error(JSON.stringify({ op, error: 'server_error', message: String((e as Error)?.message ?? e) }));
    return fail(new ApiError(500, 'server_error', 'Something went wrong. Please try again.'));
  }
});
