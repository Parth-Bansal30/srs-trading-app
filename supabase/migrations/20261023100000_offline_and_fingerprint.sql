-- =====================================================================================
-- 24. Working without internet, and unlocking with a fingerprint (owner decisions 23 Oct 2026).
--
-- Offline:
--   * An entry made on a phone without internet is sent when the internet is back. It keeps the
--     time it really happened (a few days back at most), so the day's sales and cash are right.
--   * A new slip or customer made offline gets its id on the phone, so the phone can weigh and finish
--     that slip offline too; the slip NUMBER is still given by the server when it arrives.
--
-- Fingerprint / face (passkeys):
--   * After unlocking with the PIN, a person can switch on "unlock with fingerprint" on THEIR phone.
--     The phone keeps a private key that only opens with the finger; the server keeps the public key.
--   * Each day the phone proves the finger to the server (a fresh challenge, signed by the phone's key)
--     and gets the same unlock as the PIN. If it fails or is cancelled, the PIN is asked.
--   * Switching it on needs a PIN entered in the last 10 minutes. The owner can remove a person's
--     fingerprint phones; "sign out everywhere" removes them too.
-- =====================================================================================

-- ---------- a) when an offline entry really happened ----------
-- public.api_run sets app.at for one operation; these keep that time instead of "now".
create function app.at() returns timestamptz
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('app.at', true), '')::timestamptz, now())
$$;
create function app.offline_time_order() returns trigger
language plpgsql set search_path = '' as $$
declare v text := nullif(current_setting('app.at', true), '');
begin
  if v is null then return new; end if;
  if tg_op = 'INSERT' then new.created_at := v::timestamptz; return new; end if;
  if new.status is distinct from old.status then
    if new.status = 'accepted' and new.accepted_at is not null then new.accepted_at := v::timestamptz; end if;
    if new.status = 'weighed' and new.weighed_at is not null then new.weighed_at := v::timestamptz; end if;
    if new.status = 'done' and new.done_at is not null then new.done_at := v::timestamptz; end if;
    if new.status = 'cancelled' and new.cancelled_at is not null then new.cancelled_at := v::timestamptz; end if;
  end if;
  return new;
end $$;
create trigger aa_offline_time before insert or update on public.orders for each row execute function app.offline_time_order();
create function app.offline_time_payment() returns trigger
language plpgsql set search_path = '' as $$
declare v text := nullif(current_setting('app.at', true), '');
begin
  if v is not null then new.received_at := v::timestamptz; end if;
  return new;
end $$;
create trigger aa_offline_time before insert on public.payments for each row execute function app.offline_time_payment();

alter table public.orders add column entered_offline boolean not null default false;
alter table public.payments add column entered_offline boolean not null default false;

-- ---------- b) ids chosen on the phone (for slips and customers made offline) ----------
create or replace function app.insert_items(p_company uuid, p_order uuid, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare it jsonb; ln jsonb; i int := 0; j int; item_id uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item.' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (id, company_id, order_id, position, material_id, grade_code, shape, unit, dims,
                                    sell_rate, cut_rate, density, special_rate, stock_item_id)
      values (coalesce(nullif(it ->> 'id', '')::uuid, gen_random_uuid()), p_company, p_order, i, (it ->> 'material_id')::uuid, it ->> 'grade_code', it ->> 'shape', it ->> 'unit',
              array(select jsonb_array_elements_text(it -> 'dims')), (it ->> 'sell_rate')::numeric, (it ->> 'cut_rate')::numeric,
              (it ->> 'density')::numeric, coalesce((it ->> 'special_rate')::boolean, false), nullif(it ->> 'stock_item_id', '')::uuid)
      returning id into item_id;
    j := 0;
    for ln in select * from jsonb_array_elements(it -> 'lengths') loop
      insert into public.order_item_lengths (company_id, order_item_id, position, len, pcs, cuts)
        values (p_company, item_id, j, nullif(ln ->> 'len', ''), (ln ->> 'pcs')::int, nullif(ln ->> 'cuts', '')::int);
      j := j + 1;
    end loop;
    if j = 0 then raise exception 'Item % has no lengths.', i + 1 using errcode = '22023'; end if;
    i := i + 1;
  end loop;
end $$;

drop function public.api_create_order(uuid, uuid, text, uuid, jsonb, jsonb, boolean, jsonb);
create function public.api_create_order(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_rules jsonb,
                                        p_items jsonb, p_accept boolean default false, p_advance jsonb default null,
                                        p_order_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.people := app.caller(p_caller); prev jsonb; s public.company_settings; tz text;
  internal bigint; slip text; period text := 'internal'; n bigint; oid uuid := coalesce(p_order_id, gen_random_uuid()); st text := 'estimate';
  v_at timestamptz := app.at();
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'createOrder', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_order_id is not null and exists (select 1 from public.orders where id = p_order_id) then
    raise exception 'That slip is already saved.' using errcode = '23505';
  end if;
  select * into s from public.company_settings where company_id = c.company_id;
  select timezone into tz from public.companies where id = c.company_id;
  internal := app.next_counter(c.company_id, 'internal', s.first_slip_no);
  if s.slip_numbering = 'never' then
    slip := internal::text;
  else
    -- a slip made offline gets its number for the day it was made (numbers restarting each day / month / year)
    period := app.slip_counter_key(s.slip_numbering, v_at, tz);
    n := app.next_counter(c.company_id, period);
    slip := app.slip_label(s.slip_numbering, v_at, tz, n);
  end if;
  insert into public.orders (id, company_id, internal_no, slip_no, slip_scheme, slip_period, customer_id, pricing_rules, created_by, idempotency_key, entered_offline)
    values (oid, c.company_id, internal, slip, s.slip_numbering, period, p_customer, coalesce(p_rules, '{}'), c.id, p_key,
            nullif(current_setting('app.at', true), '') is not null);
  perform app.insert_items(c.company_id, oid, p_items);
  if p_accept then
    update public.orders set status = 'accepted', accepted_at = now() where id = oid;
    st := 'accepted';
    if p_advance is not null then perform app.take_advance(c, oid, p_advance, p_key); end if;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', oid, 'internal_no', internal, 'slip_no', slip, 'status', st,
    'items', (select jsonb_agg(i.id order by i.position) from public.order_items i where i.order_id = oid)));
end $$;

drop function public.api_create_customer(uuid, uuid, text, text, text, text);
create function public.api_create_customer(p_caller uuid, p_key uuid, p_hash text, p_name text, p_phone text, p_notes text,
                                           p_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; cu public.customers;
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'createCustomer', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_id is not null and exists (select 1 from public.customers where id = p_id) then
    raise exception 'That customer is already saved.' using errcode = '23505';
  end if;
  insert into public.customers (id, company_id, name, phone, notes)
    values (coalesce(p_id, gen_random_uuid()), c.company_id, btrim(p_name), nullif(btrim(p_phone), ''), nullif(btrim(p_notes), '')) returning * into cu;
  return app.idem_done(c.company_id, p_key, to_jsonb(cu));
end $$;

-- the payment trigger also marks offline payments
create or replace function app.offline_time_payment() returns trigger
language plpgsql set search_path = '' as $$
declare v text := nullif(current_setting('app.at', true), '');
begin
  if v is not null then new.received_at := v::timestamptz; new.entered_offline := true; end if;
  return new;
end $$;

-- Run one operation the way public.api_pay does (money accounts), and for an entry made offline with the
-- time it really happened (p_at, up to 3 days back; null = now).
create function public.api_run(p_caller uuid, p_op text, p_args jsonb, p_parts jsonb, p_account jsonb, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); v_at timestamptz; v_fn oid; v_args text; n int; v_res jsonb;
begin
  if p_op not in ('api_create_order','api_accept_order','api_add_advance','api_finalize_order','api_record_payment',
                  'api_adjust_advance','api_refund_credit','api_delete_orders','api_create_customer','api_record_weights') then
    raise exception 'Unknown operation.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_args) <> 'object' or (p_args ->> 'p_caller') is distinct from p_caller::text then
    raise exception 'Wrong request.' using errcode = '22023';
  end if;
  if p_parts is not null or p_account is not null then
    if p_op not in ('api_create_order','api_accept_order','api_add_advance','api_finalize_order','api_record_payment',
                    'api_adjust_advance','api_refund_credit','api_delete_orders') then
      raise exception 'Unknown operation.' using errcode = '22023';
    end if;
    -- money accounts: the same checks as api_pay (which also clears the time when done)
    perform app.run_at(p_at);
    return public.api_pay(p_caller, p_op, p_args, p_parts, p_account);
  end if;
  perform app.run_at(p_at);
  select p.oid into v_fn from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = p_op;
  select string_agg(format('%I => %s', a.key,
           case when a.value = 'null'::jsonb then 'NULL::' || pg_catalog.format_type(t.typ, null)
                when pg_catalog.format_type(t.typ, null) = 'jsonb' then pg_catalog.quote_literal(a.value::text) || '::jsonb'
                when pg_catalog.format_type(t.typ, null) = 'uuid[]' then
                  pg_catalog.quote_literal((select coalesce(array_agg(e), '{}') from jsonb_array_elements_text(a.value) e)::text) || '::uuid[]'
                else pg_catalog.quote_literal(a.value #>> '{}') || '::' || pg_catalog.format_type(t.typ, null) end), ', '),
         count(*)
    into v_args, n
    from jsonb_each(p_args) a
    join (select unnest(p.proargnames) nm, unnest(p.proargtypes::oid[]) typ from pg_catalog.pg_proc p where p.oid = v_fn) t on t.nm = a.key;
  if n is distinct from (select count(*) from jsonb_object_keys(p_args)) then
    raise exception 'Wrong request.' using errcode = '22023';
  end if;
  execute format('select public.%I(%s)', p_op, v_args) into v_res;
  perform set_config('app.at', '', true);
  return v_res;
end $$;

-- sets the time for this operation (checked: not in the future, at most 3 days back)
create function app.run_at(p_at timestamptz) returns void
language plpgsql set search_path = '' as $$
begin
  if p_at is null then perform set_config('app.at', '', true); return; end if;
  perform set_config('app.at', app.entry_time(p_at, 3)::text, true);
end $$;

-- api_pay: also allow creating customers and weighing to run through it (no money moves, so no accounts are needed),
-- and clear the offline time when it is done
create or replace function public.api_pay(p_caller uuid, p_op text, p_args jsonb, p_parts jsonb, p_account jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); boss boolean := app.has(c, 'settings');
  v_fn oid; v_args text; n int; v_res jsonb;
  methods text[] := array['UPI','IMPS','NEFT','RTGS','Cheque'];
begin
  if p_op not in ('api_create_order','api_accept_order','api_add_advance','api_finalize_order','api_record_payment',
                  'api_adjust_advance','api_refund_credit','api_delete_orders') then
    raise exception 'Unknown operation.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_args) <> 'object' or (p_args ->> 'p_caller') is distinct from p_caller::text then
    raise exception 'Wrong request.' using errcode = '22023';
  end if;
  if p_parts is not null then
    if jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) not between 1 and 8 then
      raise exception 'Choose where the money went.' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_parts) x
               where jsonb_typeof(x) <> 'object' or (x ->> 'account_id') !~ '^[0-9a-f-]{36}$'
                  or (x ->> 'amount') !~ '^[0-9]+(\.[0-9]+)?$' or (x ->> 'amount')::numeric <= 0
                  or ((x ->> 'method') is not null and (x ->> 'method') <> all (methods))) then
      raise exception 'Choose where the money went.' using errcode = '22023';
    end if;
    if (select count(distinct x ->> 'account_id') from jsonb_array_elements(p_parts) x) <> jsonb_array_length(p_parts) then
      raise exception 'The same account is in the list twice.' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_parts) x
               left join public.money_accounts a on a.company_id = c.company_id and a.id = (x ->> 'account_id')::uuid
               where a.id is null or a.hidden or not (a.staff_can or boss)) then
      raise exception 'That account can''t be chosen.' using errcode = '22023';
    end if;
    perform set_config('app.pay_parts', p_parts::text, true);
  end if;
  if p_account is not null then
    if jsonb_typeof(p_account) <> 'object' or (p_account ->> 'account_id') !~ '^[0-9a-f-]{36}$'
       or ((p_account ->> 'method') is not null and (p_account ->> 'method') <> all (methods))
       or not exists (select 1 from public.money_accounts a where a.company_id = c.company_id and a.id = (p_account ->> 'account_id')::uuid
                        and not a.hidden and (a.staff_can or boss)) then
      raise exception 'That account can''t be chosen.' using errcode = '22023';
    end if;
    perform set_config('app.pay_account', p_account::text, true);
  end if;
  select p.oid into v_fn from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = p_op;
  select string_agg(format('%I => %s', a.key,
           case when a.value = 'null'::jsonb then 'NULL::' || pg_catalog.format_type(t.typ, null)
                when pg_catalog.format_type(t.typ, null) = 'jsonb' then pg_catalog.quote_literal(a.value::text) || '::jsonb'
                when pg_catalog.format_type(t.typ, null) = 'uuid[]' then
                  pg_catalog.quote_literal((select coalesce(array_agg(e), '{}') from jsonb_array_elements_text(a.value) e)::text) || '::uuid[]'
                else pg_catalog.quote_literal(a.value #>> '{}') || '::' || pg_catalog.format_type(t.typ, null) end), ', '),
         count(*)
    into v_args, n
    from jsonb_each(p_args) a
    join (select unnest(p.proargnames) nm, unnest(p.proargtypes::oid[]) typ from pg_catalog.pg_proc p where p.oid = v_fn) t on t.nm = a.key;
  if n is distinct from (select count(*) from jsonb_object_keys(p_args)) then
    raise exception 'Wrong request.' using errcode = '22023';
  end if;
  execute format('select public.%I(%s)', p_op, v_args) into v_res;
  perform set_config('app.pay_parts', '', true);
  perform set_config('app.pay_account', '', true);
  perform set_config('app.at', '', true);
  return v_res;
end $$;

-- ---------- c) fingerprint / face unlock (passkeys) ----------
create table private.passkeys (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete restrict,
  person_id     uuid not null,
  credential_id text not null check (credential_id ~ '^[A-Za-z0-9_-]+$' and length(credential_id) between 16 and 1400),   -- base64url, from the phone
  public_key    jsonb not null,                                                    -- JWK (EC P-256 or RSA)
  alg           integer not null check (alg in (-7, -257)),                        -- ES256 / RS256
  sign_count    bigint not null default 0 check (sign_count >= 0),
  device_label  text check (device_label is null or length(device_label) <= 60),
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  unique (company_id, credential_id),
  foreign key (company_id, person_id) references public.people(company_id, id) on delete cascade
);
create index passkeys_person_idx on private.passkeys (company_id, person_id) where revoked_at is null;
create table private.passkey_challenges (
  company_id  uuid not null references public.companies(id) on delete cascade,
  challenge   text not null check (challenge ~ '^[A-Za-z0-9_-]{32,100}$'),
  person_id   uuid not null,
  session_id  uuid not null,
  purpose     text not null check (purpose in ('register','unlock')),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  primary key (company_id, challenge),
  foreign key (company_id, person_id) references public.people(company_id, id) on delete cascade
);
alter table private.passkeys enable row level security;           -- backend only
alter table private.passkey_challenges enable row level security;
revoke all on private.passkeys, private.passkey_challenges from public, anon, authenticated;
create trigger audit after insert or update or delete on private.passkeys for each row execute function app.audit_row();

-- how a session was unlocked (pin / passkey) — switching fingerprint on needs a fresh PIN
alter table private.session_unlocks add column method text not null default 'pin' check (method in ('pin','passkey'));
create function app.unlock_method() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.method := coalesce(nullif(current_setting('app.unlock_method', true), ''), 'pin');
  return new;
end $$;
create trigger unlock_method before insert or update on private.session_unlocks for each row execute function app.unlock_method();

-- The staff record behind a login (same rule as app.login_person, for the backend).
create function app.person_of_user(p_user uuid) returns public.people
language sql stable security definer set search_path = '' as $$
  select p.* from public.people p join public.companies c on c.id = p.company_id and c.active
  where p.auth_user_id = p_user and p.active order by p.created_at limit 1
$$;

-- 1. A fresh challenge for this login session. purpose 'register' needs this session unlocked with the PIN
--    in the last 10 minutes; 'unlock' lists the person's fingerprint keys.
create function public.api_passkey_begin(p_user uuid, p_session uuid, p_purpose text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.people := app.person_of_user(p_user); ch text;
begin
  if p.id is null then raise exception 'This mobile number is not registered as staff.' using errcode = '42501'; end if;
  if p_session is null or not exists (select 1 from auth.sessions s where s.id = p_session and s.user_id = p_user) then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_purpose = 'register' then
    if not exists (select 1 from private.session_unlocks su where su.session_id = p_session and su.person_id = p.id
                   and su.expires_at > now() and su.method = 'pin' and su.unlocked_at > now() - interval '10 minutes') then
      raise exception 'Enter your PIN first.' using errcode = '42501';
    end if;
    if (select count(*) from private.passkeys where person_id = p.id and revoked_at is null) >= 5 then
      raise exception 'Fingerprint is already on 5 phones. Remove one first.' using errcode = '23505';
    end if;
  elsif p_purpose <> 'unlock' then
    raise exception 'Wrong request.' using errcode = '22023';
  end if;
  delete from private.passkey_challenges where company_id = p.company_id and (expires_at < now() - interval '1 day');
  ch := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  insert into private.passkey_challenges (company_id, challenge, person_id, session_id, purpose, expires_at)
    values (p.company_id, ch, p.id, p_session, p_purpose, now() + interval '3 minutes');
  return jsonb_build_object('challenge', ch, 'person_id', p.id, 'name', p.display_name,
    'credentials', coalesce((select jsonb_agg(jsonb_build_object('id', k.credential_id, 'alg', k.alg, 'public_key', k.public_key, 'sign_count', k.sign_count))
      from private.passkeys k where k.person_id = p.id and k.revoked_at is null), '[]'::jsonb));
end $$;

-- The challenge, used once: right session, right purpose, still fresh.
create function app.take_challenge(p public.people, p_session uuid, p_challenge text, p_purpose text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.passkey_challenges set used_at = now()
    where company_id = p.company_id and challenge = p_challenge and person_id = p.id and session_id = p_session
      and purpose = p_purpose and used_at is null and expires_at > now();
  if not found then raise exception 'That took too long. Please try again.' using errcode = '42501'; end if;
end $$;

-- The saved public key of one of the person's fingerprint phones (to check an unlock).
create function public.api_passkey_key(p_user uuid, p_credential_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('public_key', k.public_key, 'alg', k.alg, 'sign_count', k.sign_count)
  from private.passkeys k join public.people p on p.company_id = k.company_id and p.id = k.person_id
  where k.credential_id = p_credential_id and k.revoked_at is null and p.id = (app.person_of_user(p_user)).id
$$;

-- 2. Switch fingerprint on: the backend has checked the phone's answer (clientData + authenticatorData).
create function public.api_passkey_save(p_user uuid, p_session uuid, p_challenge text, p_credential_id text, p_public_key jsonb,
                                        p_alg integer, p_sign_count bigint, p_label text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.people := app.person_of_user(p_user); k private.passkeys;
begin
  if p.id is null then raise exception 'This mobile number is not registered as staff.' using errcode = '42501'; end if;
  perform app.take_challenge(p, p_session, p_challenge, 'register');
  perform set_config('app.person_id', p.id::text, true);
  if exists (select 1 from private.passkeys where company_id = p.company_id and credential_id = p_credential_id) then
    update private.passkeys set revoked_at = null, public_key = p_public_key, alg = p_alg, sign_count = coalesce(p_sign_count, 0),
        device_label = nullif(left(btrim(coalesce(p_label, '')), 60), ''), person_id = p.id
      where company_id = p.company_id and credential_id = p_credential_id returning * into k;
  else
    insert into private.passkeys (company_id, person_id, credential_id, public_key, alg, sign_count, device_label)
      values (p.company_id, p.id, p_credential_id, p_public_key, p_alg, coalesce(p_sign_count, 0), nullif(left(btrim(coalesce(p_label, '')), 60), ''))
      returning * into k;
  end if;
  return jsonb_build_object('id', k.id, 'credential_id', k.credential_id);
end $$;

-- 3. Unlock with the fingerprint: the backend has checked the signature with the saved public key.
--    The same unlock as the PIN (for unlock_hours). A blocked PIN (10 wrong tries) still needs a new SMS code.
create function public.api_passkey_unlock(p_user uuid, p_session uuid, p_challenge text, p_credential_id text, p_sign_count bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.people := app.person_of_user(p_user); k private.passkeys; cred private.auth_credentials; hours integer;
begin
  if p.id is null then raise exception 'This mobile number is not registered as staff.' using errcode = '42501'; end if;
  perform app.take_challenge(p, p_session, p_challenge, 'unlock');
  perform set_config('app.person_id', p.id::text, true);
  select * into k from private.passkeys where company_id = p.company_id and credential_id = p_credential_id and person_id = p.id and revoked_at is null for update;
  if k.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_key'); end if;
  -- a copied key: the phone's counter must go up (phones that don't count send 0 every time)
  if k.sign_count > 0 and coalesce(p_sign_count, 0) <= k.sign_count then
    update private.passkeys set revoked_at = now() where id = k.id;
    return jsonb_build_object('ok', false, 'reason', 'copied_key');
  end if;
  select * into cred from private.auth_credentials where person_id = p.id and kind = 'pin' and revoked_at is null;
  if cred.id is null then return jsonb_build_object('ok', false, 'reason', 'no_pin'); end if;
  if cred.failed_attempts >= 10 then return jsonb_build_object('ok', false, 'reason', 'blocked'); end if;
  update private.passkeys set sign_count = greatest(coalesce(p_sign_count, 0), sign_count), last_used_at = now() where id = k.id;
  select unlock_hours into hours from public.company_settings where company_id = p.company_id;
  perform set_config('app.unlock_method', 'passkey', true);
  insert into private.session_unlocks (session_id, company_id, person_id, expires_at)
    values (p_session, p.company_id, p.id, now() + make_interval(hours => coalesce(hours, 12)))
    on conflict (session_id) do update set company_id = excluded.company_id, person_id = excluded.person_id,
      unlocked_at = now(), expires_at = excluded.expires_at;
  perform set_config('app.unlock_method', '', true);
  return jsonb_build_object('ok', true);
end $$;

-- 4. A person's fingerprint phones (their own), and switching one off.
create function public.api_passkeys(p_caller uuid, p_person uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); v_person uuid := coalesce(p_person, p_caller);
begin
  if v_person <> c.id then perform app.require(c, 'people'); end if;
  if not exists (select 1 from public.people where id = v_person and company_id = c.company_id) then raise exception 'Not found.' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'credential_id', k.credential_id, 'label', k.device_label,
      'created_at', k.created_at, 'last_used_at', k.last_used_at) order by k.created_at desc)
    from private.passkeys k where k.company_id = c.company_id and k.person_id = v_person and k.revoked_at is null), '[]'::jsonb);
end $$;

create function public.api_passkey_remove(p_caller uuid, p_key uuid, p_hash text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; k private.passkeys;
begin
  prev := app.idem_start(c.company_id, p_key, 'passkeyRemove', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into k from private.passkeys where company_id = c.company_id and id = p_id and revoked_at is null for update;
  if k.id is null then raise exception 'Not found.' using errcode = '22023'; end if;
  if k.person_id <> c.id then perform app.require(c, 'people'); end if;
  update private.passkeys set revoked_at = now() where id = k.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('id', k.id, 'removed', true));
end $$;

-- "sign out everywhere" (a lost phone) also switches off that person's fingerprint unlock
create or replace function public.admin_sign_out_everywhere(p_caller uuid, p_person uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare caller public.people; uid uuid;
begin
  caller := app.assert_manager(p_caller, p_person);
  perform set_config('app.person_id', caller.id::text, true);
  select auth_user_id into uid from public.people where id = p_person;
  delete from private.session_unlocks where person_id = p_person;
  update private.passkeys set revoked_at = now() where person_id = p_person and revoked_at is null;
  if uid is not null then delete from auth.sessions where user_id = uid; end if;
end $$;

-- ---------- d) access ----------
revoke all on function app.at(), app.offline_time_order(), app.offline_time_payment(), app.run_at(timestamptz), app.unlock_method(),
  app.person_of_user(uuid), app.take_challenge(public.people, uuid, text, text) from public, anon, authenticated;
revoke all on function public.api_create_order(uuid, uuid, text, uuid, jsonb, jsonb, boolean, jsonb, uuid),
  public.api_create_customer(uuid, uuid, text, text, text, text, uuid), public.api_run(uuid, text, jsonb, jsonb, jsonb, timestamptz),
  public.api_pay(uuid, text, jsonb, jsonb, jsonb),
  public.api_passkey_begin(uuid, uuid, text), public.api_passkey_save(uuid, uuid, text, text, jsonb, integer, bigint, text),
  public.api_passkey_unlock(uuid, uuid, text, text, bigint), public.api_passkeys(uuid, uuid), public.api_passkey_remove(uuid, uuid, text, uuid),
  public.api_passkey_key(uuid, text), public.admin_sign_out_everywhere(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_create_order(uuid, uuid, text, uuid, jsonb, jsonb, boolean, jsonb, uuid),
  public.api_create_customer(uuid, uuid, text, text, text, text, uuid), public.api_run(uuid, text, jsonb, jsonb, jsonb, timestamptz),
  public.api_pay(uuid, text, jsonb, jsonb, jsonb),
  public.api_passkey_begin(uuid, uuid, text), public.api_passkey_save(uuid, uuid, text, text, jsonb, integer, bigint, text),
  public.api_passkey_unlock(uuid, uuid, text, text, bigint), public.api_passkeys(uuid, uuid), public.api_passkey_remove(uuid, uuid, text, uuid),
  public.api_passkey_key(uuid, text), public.admin_sign_out_everywhere(uuid, uuid) to service_role;
