// staff-admin — staff management for owners/managers.
//
// Actions: add_person, update_person, set_active, reset_pin, sign_out_everywhere.
// The caller must be signed in, UNLOCKED with their PIN, and have the 'people' permission.
// The database functions (public.admin_*) check every rule again — two layers of safety.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

/** Indian mobile: 10 digits starting 6–9, typed with or without +91 / 0 / spaces. → "+91XXXXXXXXXX" or null. */
export function normalizeIndianMobile(input: unknown): string | null {
  const d = String(input ?? '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null;
}

const ROLES = ['owner', 'sales', 'weigher', 'accounts', 'custom'];
const LANGS = ['en', 'hi', 'hn'];
const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  // 1. Who is calling? (their own login, checked by the database)
  const authz = req.headers.get('Authorization') ?? '';
  if (!authz.startsWith('Bearer ')) return json(401, { error: 'not_signed_in' });
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authz } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: status, error: statusError } = await asCaller.rpc('login_status');
  if (statusError || !status?.signed_in) return json(401, { error: 'not_signed_in' });
  if (!status.staff) return json(403, { error: 'not_staff' });
  if (!status.unlocked) return json(401, { error: 'pin_required' });
  if (!status.person?.perms?.people) return json(403, { error: 'not_allowed', message: 'Only someone who can manage people can do this.' });
  const caller: string = status.person.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'bad_request' }); }

  // 2. Do it with backend rights (the database re-checks the caller on every call).
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw Object.assign(new Error(error.message), { db: error });
    return data;
  };
  const person = String(body.person_id ?? '');

  try {
    switch (body.action) {
      case 'add_person': {
        const phone = normalizeIndianMobile(body.phone);
        if (!phone) return json(400, { error: 'bad_phone', message: 'Enter a 10-digit Indian mobile number.' });
        const name = String(body.name ?? '').trim();
        if (!name || name.length > 100) return json(400, { error: 'bad_name', message: 'Enter the person’s name.' });
        const role = String(body.role ?? '');
        if (!ROLES.includes(role)) return json(400, { error: 'bad_role' });
        let uid: string | null = await rpc('admin_auth_user_by_phone', { p_phone: phone });
        let created = false;
        if (!uid) {
          const { data, error } = await admin.auth.admin.createUser({ phone, phone_confirm: true });
          if (error || !data.user) throw error ?? new Error('could not create login');
          uid = data.user.id;
          created = true;
        }
        try {
          const added = await rpc('admin_add_person', {
            p_caller: caller, p_auth_user: uid, p_name: name, p_phone: phone, p_role: role,
            p_perms: body.perms ?? null, p_lang: LANGS.includes(String(body.lang)) ? body.lang : 'en',
          });
          return json(200, { person: added });
        } catch (e) {
          if (created && uid) await admin.auth.admin.deleteUser(uid); // don't leave a stray login behind
          throw e;
        }
      }
      case 'update_person': {
        if (!isUuid(person)) return json(400, { error: 'bad_request' });
        if (body.role != null && !ROLES.includes(String(body.role))) return json(400, { error: 'bad_role' });
        const updated = await rpc('admin_update_person', {
          p_caller: caller, p_person: person,
          p_name: body.name == null ? null : String(body.name).trim(),
          p_role: body.role ?? null, p_perms: body.perms ?? null,
          p_lang: LANGS.includes(String(body.lang)) ? body.lang : null,
        });
        return json(200, { person: updated });
      }
      case 'set_active': {
        if (!isUuid(person) || typeof body.active !== 'boolean') return json(400, { error: 'bad_request' });
        return json(200, { person: await rpc('admin_set_active', { p_caller: caller, p_person: person, p_active: body.active }) });
      }
      case 'reset_pin': {
        if (!isUuid(person)) return json(400, { error: 'bad_request' });
        await rpc('admin_reset_pin', { p_caller: caller, p_person: person });
        return json(200, { ok: true });
      }
      case 'sign_out_everywhere': {
        if (!isUuid(person)) return json(400, { error: 'bad_request' });
        await rpc('admin_sign_out_everywhere', { p_caller: caller, p_person: person });
        return json(200, { ok: true });
      }
      default:
        return json(400, { error: 'unknown_action' });
    }
  } catch (e) {
    const code: string | undefined = (e as { db?: { code?: string } }).db?.code;
    const httpStatus = code === '42501' ? 403 : code === '23505' ? 409 : code === '23514' || code?.startsWith('22') ? 400 : 500;
    if (httpStatus === 500) console.error('staff-admin failed', e);
    return json(httpStatus, httpStatus === 500
      ? { error: 'server_error', message: 'Something went wrong. Please try again.' }
      : { error: 'refused', message: (e as Error).message });
  }
});
