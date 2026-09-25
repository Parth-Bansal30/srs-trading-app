-- =====================================================================================
-- 8. Logins: mobile number + one-time SMS code (Supabase Auth), then a PIN that the
--    SERVER checks every day.
--
--  • Only staff the owner has added can log in (public sign-up is switched off in Auth).
--  • First time on a phone: SMS code proves the phone is theirs → they set a PIN.
--  • Daily: the PIN "unlocks" that phone's login session for the working day.
--    Nothing is readable until the session is unlocked — enforced here, not in the app,
--    so a stolen phone or copied login token is useless without the PIN.
--  • Wrong PINs: 5 → locked 15 minutes; 10 → blocked until a fresh SMS code.
--  • A shared shop tablet works: each worker has their own session on it and their own PIN.
-- =====================================================================================

alter table public.company_settings
  add column unlock_hours integer not null default 12 check (unlock_hours between 1 and 24);
comment on column public.company_settings.unlock_hours is 'How long a PIN unlock lasts before the PIN is asked again (the app also locks itself when idle).';

-- Which login sessions are unlocked by a PIN right now, and for whom.
create table private.session_unlocks (
  session_id  uuid primary key,                -- the Supabase login session (one per phone/tablet per person)
  company_id  uuid not null references public.companies(id) on delete restrict,
  person_id   uuid not null,
  unlocked_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  foreign key (company_id, person_id) references public.people(company_id, id) on delete cascade
);
create index session_unlocks_person_idx on private.session_unlocks (company_id, person_id);
alter table private.session_unlocks enable row level security;   -- no policies: backend only
revoke all on private.session_unlocks from public, anon, authenticated;
create trigger audit after insert or delete on private.session_unlocks for each row execute function app.audit_row(); -- login / logout history

-- ---------- role presets (same as @srs/core ROLE_PRESETS) ----------
create function app.role_preset(role text) returns jsonb
language sql immutable set search_path = '' as $$
  select case role
    when 'owner'    then '{"new":true,"orders":true,"weigh":true,"khata":true,"today":true,"rates":true,"people":true,"settings":true,"money":true,"kacha":true}'::jsonb
    when 'sales'    then '{"new":true,"orders":true,"money":true,"kacha":true}'::jsonb
    when 'weigher'  then '{"weigh":true,"orders":true}'::jsonb
    when 'accounts' then '{"orders":true,"khata":true,"today":true,"money":true}'::jsonb
    else '{}'::jsonb end
$$;

-- ---------- WHO is asking: now requires an unlocked, still-valid session ----------
create or replace function app.current_person_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from private.session_unlocks su
  join public.people p    on p.id = su.person_id and p.company_id = su.company_id and p.active
  join public.companies c on c.id = p.company_id and c.active
  join auth.sessions s    on s.id = su.session_id and s.user_id = p.auth_user_id
  where su.session_id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
    and p.auth_user_id = (select auth.uid())
    and su.expires_at > now()
    and (s.not_after is null or s.not_after > now())
$$;

-- The staff record a signed-in (not yet unlocked) user would unlock into.
create function app.login_person(p_company uuid) returns public.people
language sql stable security definer set search_path = '' as $$
  select p.* from public.people p
  join public.companies c on c.id = p.company_id and c.active
  where p.auth_user_id = (select auth.uid()) and p.active
    and (p_company is null or p.company_id = p_company)
  order by p.created_at
  limit 1
$$;

-- Did this login prove the phone with an SMS code in the last 10 minutes?
create function app.recent_otp(minutes integer default 10) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from jsonb_array_elements(coalesce((select auth.jwt()) -> 'amr', '[]'::jsonb)) e
    where e ->> 'method' in ('otp', 'sms')
      and (e ->> 'timestamp')::bigint >= extract(epoch from now())::bigint - minutes * 60)
$$;

-- Owners and anyone who manages people or settings must use a 6-digit PIN.
create function app.pin_length_for(p public.people) returns integer
language sql immutable set search_path = '' as $$
  select case when coalesce((p.perms ->> 'people')::boolean, false) or coalesce((p.perms ->> 'settings')::boolean, false) then 6 else 4 end
$$;

-- Why a PIN is not allowed (null = fine). Rejects guessable PINs.
create function app.pin_problem(pin text, p public.people) returns text
language plpgsql immutable set search_path = '' as $$
declare
  minlen integer := app.pin_length_for(p);
  digits text := regexp_replace(coalesce(p.phone, ''), '\D', '', 'g');
  asc_run text := '01234567890';
  desc_run text := '09876543210';
begin
  if pin is null or pin !~ '^[0-9]+$' then return 'Use numbers only.'; end if;
  if length(pin) < minlen or length(pin) > 6 then
    return case when minlen = 6 then 'Use exactly 6 numbers.' else 'Use 4 to 6 numbers.' end;
  end if;
  if pin ~ '^(.)\1+$' then return 'Too easy to guess (all the same number).'; end if;
  if position(pin in asc_run) > 0 or position(pin in desc_run) > 0 then return 'Too easy to guess (numbers in a row).'; end if;
  if pin in ('1212','1122','2580','0852','1004','2000','6969','4545','7777','1010','2020','121212','112233','123123','101010','696969','159753','147258','789456')
    then return 'Too easy to guess (a very common PIN).'; end if;
  if length(digits) >= length(pin) and right(digits, length(pin)) = pin then return 'Do not use the end of your mobile number.'; end if;
  return null;
end $$;

-- ---------- what the app calls (signed-in users) ----------

-- Where am I in the login steps?
create function public.login_status(p_company uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.people; c public.companies; cred private.auth_credentials; unlocked uuid;
begin
  if (select auth.uid()) is null then return jsonb_build_object('signed_in', false); end if;
  p := app.login_person(p_company);
  if p.id is null then return jsonb_build_object('signed_in', true, 'staff', false); end if;
  select * into c from public.companies where id = p.company_id;
  select * into cred from private.auth_credentials where person_id = p.id and kind = 'pin' and revoked_at is null;
  unlocked := app.current_person_id();
  return jsonb_build_object(
    'signed_in', true, 'staff', true,
    'unlocked', unlocked is not null,
    'has_pin', cred.id is not null,
    'blocked', coalesce(cred.failed_attempts, 0) >= 10,
    'locked_until', case when cred.locked_until > now() then cred.locked_until end,
    'pin_length', app.pin_length_for(p),
    'can_set_pin', app.recent_otp(),
    'person', jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role, 'perms', p.perms, 'lang', p.preferred_lang),
    'company', jsonb_build_object('id', c.id, 'name', c.name, 'timezone', c.timezone));
end $$;

-- Set (or change) my PIN. Needs an SMS code from the last 10 minutes. Also unlocks this session.
create function public.set_pin(p_pin text, p_company uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.people; problem text; hours integer; sid uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
begin
  p := app.login_person(p_company);
  if p.id is null then raise exception 'This mobile number is not registered as staff.' using errcode = '42501'; end if;
  if sid is null then raise exception 'Not signed in.' using errcode = '42501'; end if;
  if not app.recent_otp() then
    raise exception 'For safety, confirm your mobile number with a new SMS code before setting a PIN.' using errcode = '42501';
  end if;
  problem := app.pin_problem(p_pin, p);
  if problem is not null then raise exception '%', problem using errcode = '22023'; end if;
  perform set_config('app.person_id', p.id::text, true);
  update private.auth_credentials set revoked_at = now() where person_id = p.id and kind = 'pin' and revoked_at is null;
  insert into private.auth_credentials (company_id, person_id, kind, secret_hash)
    values (p.company_id, p.id, 'pin', extensions.crypt(p_pin, extensions.gen_salt('bf', 10)));
  select unlock_hours into hours from public.company_settings where company_id = p.company_id;
  insert into private.session_unlocks (session_id, company_id, person_id, expires_at)
    values (sid, p.company_id, p.id, now() + make_interval(hours => coalesce(hours, 12)))
    on conflict (session_id) do update set company_id = excluded.company_id, person_id = excluded.person_id,
      unlocked_at = now(), expires_at = excluded.expires_at;
  return public.login_status(p.company_id);
end $$;

-- Unlock this session with my PIN. Never raises on a wrong PIN (so the attempt is counted);
-- returns ok=false with a reason instead: no_pin | wrong_pin | locked | blocked.
create function public.unlock(p_pin text, p_company uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p public.people; cred private.auth_credentials; hours integer; fails integer;
  sid uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
begin
  p := app.login_person(p_company);
  if p.id is null then raise exception 'This mobile number is not registered as staff.' using errcode = '42501'; end if;
  if sid is null then raise exception 'Not signed in.' using errcode = '42501'; end if;
  perform set_config('app.person_id', p.id::text, true);
  select * into cred from private.auth_credentials
    where person_id = p.id and kind = 'pin' and revoked_at is null for update;
  if cred.id is null then return jsonb_build_object('ok', false, 'reason', 'no_pin'); end if;
  if cred.failed_attempts >= 10 then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if cred.locked_until > now() then return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', cred.locked_until); end if;

  if p_pin is not null and extensions.crypt(p_pin, cred.secret_hash) = cred.secret_hash then
    update private.auth_credentials set failed_attempts = 0, locked_until = null, last_used_at = now() where id = cred.id;
    select unlock_hours into hours from public.company_settings where company_id = p.company_id;
    insert into private.session_unlocks (session_id, company_id, person_id, expires_at)
      values (sid, p.company_id, p.id, now() + make_interval(hours => coalesce(hours, 12)))
      on conflict (session_id) do update set company_id = excluded.company_id, person_id = excluded.person_id,
        unlocked_at = now(), expires_at = excluded.expires_at;
    return jsonb_build_object('ok', true) || public.login_status(p.company_id);
  end if;

  fails := cred.failed_attempts + 1;
  update private.auth_credentials
    set failed_attempts = fails,
        locked_until = case when fails % 5 = 0 then now() + interval '15 minutes' else locked_until end
    where id = cred.id;
  if fails >= 10 then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  if fails % 5 = 0 then return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_until', now() + interval '15 minutes'); end if;
  return jsonb_build_object('ok', false, 'reason', 'wrong_pin', 'attempts_left', 5 - (fails % 5));
end $$;

-- Lock this session (switch user / log out on this device).
create function public.lock_session() returns void
language sql security definer set search_path = '' as $$
  delete from private.session_unlocks where session_id = nullif((select auth.jwt()) ->> 'session_id', '')::uuid
$$;

-- ---------- staff management (called by the backend only, after checking the caller) ----------
-- Every function re-checks: caller is active, has 'people', same company, and can only
-- grant permissions they have themselves.
create function app.assert_manager(p_caller uuid, p_target uuid) returns public.people
language plpgsql stable security definer set search_path = '' as $$
declare caller public.people; target public.people;
begin
  select * into caller from public.people where id = p_caller and active;
  if caller.id is null or not coalesce((caller.perms ->> 'people')::boolean, false) then
    raise exception 'Only someone who can manage people can do this.' using errcode = '42501';
  end if;
  if p_target is not null then
    select * into target from public.people where id = p_target;
    if target.id is null or target.company_id <> caller.company_id then
      raise exception 'That person is not in your company.' using errcode = '42501';
    end if;
  end if;
  return caller;
end $$;

create function app.assert_can_grant(caller public.people, perms jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare k text;
begin
  for k in select key from jsonb_each(perms) where value = 'true'::jsonb loop
    if not coalesce((caller.perms ->> k)::boolean, false) then
      raise exception 'You can''t give the "%" permission because you don''t have it yourself.', k using errcode = '42501';
    end if;
  end loop;
end $$;

-- Someone must always be able to manage people (so the company can never lock itself out).
create function app.assert_manager_remains(p_company uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.people where company_id = p_company and active and coalesce((perms ->> 'people')::boolean, false)) then
    raise exception 'At least one active person must be able to manage people.' using errcode = '23514';
  end if;
end $$;

create function public.admin_auth_user_by_phone(p_phone text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from auth.users where phone = regexp_replace(p_phone, '\D', '', 'g') and deleted_at is null limit 1
$$;

create function public.admin_add_person(p_caller uuid, p_auth_user uuid, p_name text, p_phone text,
                                        p_role text, p_perms jsonb default null, p_lang text default 'en') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller public.people; perms jsonb; row public.people;
begin
  caller := app.assert_manager(p_caller, null);
  perms := coalesce(p_perms, app.role_preset(p_role));
  perform app.assert_can_grant(caller, perms);
  perform set_config('app.person_id', caller.id::text, true);
  if exists (select 1 from public.people where company_id = caller.company_id and (auth_user_id = p_auth_user or phone = p_phone)) then
    raise exception 'This mobile number is already on your staff list.' using errcode = '23505';
  end if;
  insert into public.people (company_id, auth_user_id, display_name, phone, role, perms, preferred_lang)
    values (caller.company_id, p_auth_user, p_name, p_phone, p_role, perms, coalesce(p_lang, 'en'))
    returning * into row;
  return to_jsonb(row);
end $$;

create function public.admin_update_person(p_caller uuid, p_person uuid, p_name text default null, p_role text default null,
                                           p_perms jsonb default null, p_lang text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller public.people; row public.people;
begin
  caller := app.assert_manager(p_caller, p_person);
  if p_perms is not null then perform app.assert_can_grant(caller, p_perms); end if;
  perform set_config('app.person_id', caller.id::text, true);
  update public.people set
      display_name = coalesce(p_name, display_name),
      role = coalesce(p_role, role),
      perms = coalesce(p_perms, case when p_role is not null and p_role <> role then app.role_preset(p_role) else perms end),
      preferred_lang = coalesce(p_lang, preferred_lang)
    where id = p_person returning * into row;
  perform app.assert_can_grant(caller, row.perms);
  perform app.assert_manager_remains(caller.company_id);
  return to_jsonb(row);
end $$;

-- Deactivating logs the person out of every device at once.
create function public.admin_set_active(p_caller uuid, p_person uuid, p_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller public.people; row public.people;
begin
  caller := app.assert_manager(p_caller, p_person);
  if p_person = p_caller and not p_active then raise exception 'You can''t deactivate yourself.' using errcode = '42501'; end if;
  perform set_config('app.person_id', caller.id::text, true);
  update public.people set active = p_active where id = p_person returning * into row;
  if not p_active then delete from private.session_unlocks where person_id = p_person; end if;
  perform app.assert_manager_remains(caller.company_id);
  return to_jsonb(row);
end $$;

-- Forgot PIN / phone lost: the person must confirm with a new SMS code and set a new PIN.
create function public.admin_reset_pin(p_caller uuid, p_person uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare caller public.people;
begin
  caller := app.assert_manager(p_caller, p_person);
  perform set_config('app.person_id', caller.id::text, true);
  update private.auth_credentials set revoked_at = now() where person_id = p_person and kind = 'pin' and revoked_at is null;
  delete from private.session_unlocks where person_id = p_person;
end $$;

-- Lost phone: end every login session of this person, on every device.
create function public.admin_sign_out_everywhere(p_caller uuid, p_person uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare caller public.people; uid uuid;
begin
  caller := app.assert_manager(p_caller, p_person);
  perform set_config('app.person_id', caller.id::text, true);
  select auth_user_id into uid from public.people where id = p_person;
  delete from private.session_unlocks where person_id = p_person;
  if uid is not null then delete from auth.sessions where user_id = uid; end if;
end $$;

-- ---------- who may call what ----------
revoke all on function app.role_preset(text), app.login_person(uuid), app.recent_otp(integer), app.pin_length_for(public.people),
  app.pin_problem(text, public.people), app.assert_manager(uuid, uuid), app.assert_can_grant(public.people, jsonb),
  app.assert_manager_remains(uuid) from public, anon, authenticated;
revoke all on function public.login_status(uuid), public.set_pin(text, uuid), public.unlock(text, uuid), public.lock_session() from public, anon;
grant execute on function public.login_status(uuid), public.set_pin(text, uuid), public.unlock(text, uuid), public.lock_session() to authenticated;
revoke all on function public.admin_auth_user_by_phone(text), public.admin_add_person(uuid, uuid, text, text, text, jsonb, text),
  public.admin_update_person(uuid, uuid, text, text, jsonb, text), public.admin_set_active(uuid, uuid, boolean),
  public.admin_reset_pin(uuid, uuid), public.admin_sign_out_everywhere(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_auth_user_by_phone(text), public.admin_add_person(uuid, uuid, text, text, text, jsonb, text),
  public.admin_update_person(uuid, uuid, text, text, jsonb, text), public.admin_set_active(uuid, uuid, boolean),
  public.admin_reset_pin(uuid, uuid), public.admin_sign_out_everywhere(uuid, uuid) to service_role;
