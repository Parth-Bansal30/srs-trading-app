-- @fixtures
-- Login with mobile + SMS code, then a server-checked PIN. And staff management.
create function pg_temp.refused(q text, why text, want text default null) returns void language plpgsql as $$
declare st text; msg text;
begin
  begin execute q;
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
    if want is not null and st <> want then raise exception 'TEST FAILED (%): refused for the wrong reason: [%] %', why, st, msg; end if;
    return;
  end;
  raise exception 'TEST FAILED: should have been refused: %', why;
end $$;
-- Act as a signed-in user on a given session. otp_min_ago = minutes since their SMS code (null = no code in this login).
create function pg_temp.as_user(uid uuid, sid uuid, otp_min_ago integer default null) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'session_id', sid, 'role', 'authenticated',
    'amr', case when otp_min_ago is null then json_build_array(json_build_object('method', 'token_refresh', 'timestamp', extract(epoch from now())::bigint))
                else json_build_array(json_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint - otp_min_ago * 60)) end)::text, true);
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- New sessions (a new phone) for owner A and weigher A — signed in, NOT unlocked yet.
insert into auth.sessions (id, user_id) values
  ('d0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a'),
  ('d0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000b');
update public.people set phone = '+919812344827' where id = 'aaaaaaa2-0000-0000-0000-000000000000'; -- weigher's mobile

-- ---------- 1. new phone: signed in, nothing visible, can't set a PIN without a fresh SMS code ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a');
do $$ declare s jsonb := public.login_status(); begin
  assert (s ->> 'staff')::boolean and not (s ->> 'unlocked')::boolean and not (s ->> 'has_pin')::boolean, 'owner on a new phone: staff, locked, no PIN';
  assert (s ->> 'pin_length')::int = 6, 'owners need a 6-digit PIN';
  assert not (s ->> 'can_set_pin')::boolean, 'no fresh SMS code in this login → cannot set a PIN';
  assert (select count(*) from public.companies) = 0 and (select count(*) from public.people) = 0, 'nothing visible before unlocking';
end $$;
select pg_temp.refused($q$select public.set_pin('385917')$q$, 'setting a PIN without a fresh SMS code', '42501');
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a', 25);
select pg_temp.refused($q$select public.set_pin('385917')$q$, 'setting a PIN with an SMS code from 25 minutes ago', '42501');

-- ---------- 2. with a fresh SMS code: weak PINs refused, a good one accepted and unlocks ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a', 1);
select pg_temp.refused($q$select public.set_pin('3859')$q$, 'owner with a 4-digit PIN', '22023');
select pg_temp.refused($q$select public.set_pin('111111')$q$, 'PIN 111111', '22023');
select pg_temp.refused($q$select public.set_pin('123456')$q$, 'PIN 123456', '22023');
select pg_temp.refused($q$select public.set_pin('654321')$q$, 'PIN 654321', '22023');
select pg_temp.refused($q$select public.set_pin('112233')$q$, 'PIN 112233', '22023');
select pg_temp.refused($q$select public.set_pin('38591a')$q$, 'PIN with a letter', '22023');
select pg_temp.refused($q$select public.set_pin('3859172')$q$, 'PIN with 7 numbers', '22023');
do $$ declare s jsonb := public.set_pin('385917'); begin
  assert (s ->> 'unlocked')::boolean and (s ->> 'has_pin')::boolean, 'setting the PIN unlocks this phone';
  assert (select count(*) from public.companies) = 1, 'unlocked: sees own company';
  assert (select count(*) from public.people) = 5, 'unlocked: sees own staff';
end $$;
reset role;
do $$ begin
  assert (select secret_hash from private.auth_credentials where person_id = 'aaaaaaa1-0000-0000-0000-000000000000' and revoked_at is null) like '$2a$10$%',
    'PIN is stored scrambled with bcrypt';
  assert not exists (select 1 from private.auth_credentials where secret_hash like '%385917%'), 'the PIN itself is stored nowhere';
  assert not exists (select 1 from public.audit_log where after::text like '%secret_hash%' or before::text like '%secret_hash%'), 'scrambled PIN never copied into history';
end $$;

-- ---------- 3. lock, then unlock with the PIN; wrong PINs lock it ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a');
select public.lock_session();
do $$ begin assert (select count(*) from public.companies) = 0, 'locked again: nothing visible'; end $$;
do $$ declare r jsonb; begin
  r := public.unlock('000000'); assert r ->> 'reason' = 'wrong_pin' and (r ->> 'attempts_left')::int = 4, 'wrong PIN 1: 4 tries left';
  r := public.unlock('000001'); r := public.unlock('000002'); r := public.unlock('000003');
  assert r ->> 'reason' = 'wrong_pin' and (r ->> 'attempts_left')::int = 1, 'wrong PIN 4: 1 try left';
  r := public.unlock('000004'); assert r ->> 'reason' = 'locked', 'wrong PIN 5: locked for 15 minutes';
  r := public.unlock('385917'); assert r ->> 'reason' = 'locked', 'even the right PIN is refused while locked';
  assert (select count(*) from public.companies) = 0, 'still nothing visible';
end $$;
reset role;
update private.auth_credentials set locked_until = now() - interval '1 second' where person_id = 'aaaaaaa1-0000-0000-0000-000000000000' and revoked_at is null; -- 15 minutes pass
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a');
do $$ declare r jsonb := public.unlock('385917'); begin
  assert (r ->> 'ok')::boolean and (r ->> 'unlocked')::boolean, 'after the wait, the right PIN unlocks';
  assert (select count(*) from public.companies) = 1, 'unlocked: company visible';
end $$;
reset role;
do $$ begin assert (select failed_attempts from private.auth_credentials where person_id = 'aaaaaaa1-0000-0000-0000-000000000000' and revoked_at is null) = 0, 'success resets the count'; end $$;

-- ---------- 4. ten wrong PINs → blocked until a fresh SMS code ----------
update private.auth_credentials set failed_attempts = 9 where person_id = 'aaaaaaa1-0000-0000-0000-000000000000' and revoked_at is null;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a');
select public.lock_session();
do $$ declare r jsonb; begin
  r := public.unlock('999999'); assert r ->> 'reason' = 'blocked', '10th wrong PIN: blocked';
  r := public.unlock('385917'); assert r ->> 'reason' = 'blocked', 'blocked even with the right PIN';
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a', 2);
do $$ declare s jsonb := public.set_pin('740392'); begin
  assert (s ->> 'unlocked')::boolean and not (s ->> 'blocked')::boolean, 'fresh SMS code + new PIN clears the block';
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a');
select public.lock_session();
do $$ begin assert (public.unlock('385917') ->> 'reason') = 'wrong_pin', 'the old PIN no longer works'; end $$;

-- ---------- 5. staff (4 digits allowed), common PINs and own phone ending refused ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b', 'd0000000-0000-0000-0000-00000000000b', 1);
do $$ begin assert (public.login_status() ->> 'pin_length')::int = 4, 'staff may use 4 digits'; end $$;
select pg_temp.refused($q$select public.set_pin('2580')$q$, 'PIN 2580 (straight down the keypad)', '22023');
select pg_temp.refused($q$select public.set_pin('1234')$q$, 'PIN 1234', '22023');
select pg_temp.refused($q$select public.set_pin('4827')$q$, 'last 4 digits of own mobile', '22023');
do $$ begin assert (public.set_pin('7315') ->> 'unlocked')::boolean, 'weigher sets PIN 7315'; end $$;

-- ---------- 6. unlock ends: time's up, signed out, or deactivated ----------
reset role;
update private.session_unlocks set expires_at = now() - interval '1 second' where session_id = 'd0000000-0000-0000-0000-00000000000b';
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000b', 'd0000000-0000-0000-0000-00000000000b');
do $$ begin assert (select count(*) from public.materials) = 0 and not (public.login_status() ->> 'unlocked')::boolean, 'unlock expired: PIN needed again'; end $$;
reset role;
delete from auth.sessions where id = 'a0000000-0000-0000-0000-00000000000c'; -- sales A's phone signed out
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000c');
do $$ begin assert (select count(*) from public.companies) = 0, 'a signed-out session sees nothing, even with an old unlock'; end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000e', 'a0000000-0000-0000-0000-00000000000e', 1);
do $$ begin assert not (public.login_status() ->> 'staff')::boolean, 'a deactivated person is not staff'; end $$;
select pg_temp.refused($q$select public.set_pin('740392')$q$, 'deactivated person setting a PIN', '42501');
select pg_temp.as_user('c0000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000000', 1);
select pg_temp.refused($q$select public.unlock('740392')$q$, 'a non-staff mobile number unlocking', '42501');

-- ---------- 7. staff management: only via the backend, only by managers, only within limits ----------
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a');
select pg_temp.refused($q$select public.admin_add_person('aaaaaaa1-0000-0000-0000-000000000000', null, 'X', '+919000000077', 'sales')$q$,
  'the app calling staff management directly (must go through the backend)', '42501');
reset role;
select pg_temp.refused($q$select public.admin_add_person('aaaaaaa2-0000-0000-0000-000000000000', null, 'X', '+919000000077', 'sales')$q$,
  'the weigher adding staff', '42501');
do $$ declare r jsonb := public.admin_add_person('aaaaaaa1-0000-0000-0000-000000000000', null, 'New Sales', '+919000000077', 'sales'); begin
  assert r -> 'perms' = '{"new":true,"orders":true,"money":true,"kacha":true}'::jsonb, 'role preset applied (same as the prototype)';
  assert r ->> 'company_id' = '11111111-1111-1111-1111-111111111111', 'added to the owner''s own company';
end $$;
select pg_temp.refused($q$select public.admin_add_person('aaaaaaa1-0000-0000-0000-000000000000', null, 'Dup', '+919000000077', 'sales')$q$,
  'the same mobile number twice', '23505');
-- a manager who can manage people but not see money can't hand out money access
select public.admin_add_person('aaaaaaa1-0000-0000-0000-000000000000', null, 'Manager', '+919000000078', 'custom', '{"people":true,"orders":true}');
select pg_temp.refused($q$select public.admin_add_person((select id from public.people where display_name = 'Manager'), null, 'Y', '+919000000079', 'sales')$q$,
  'granting permissions you don''t have (money, kacha)', '42501');
select pg_temp.refused($q$select public.admin_update_person((select id from public.people where display_name = 'Manager'),
  (select id from public.people where display_name = 'Manager'), p_perms => '{"people":true,"orders":true,"settings":true}')$q$,
  'giving yourself more permissions', '42501');
select pg_temp.refused($q$select public.admin_set_active('bbbbbbb1-0000-0000-0000-000000000000', 'aaaaaaa2-0000-0000-0000-000000000000', false)$q$,
  'company B deactivating company A''s worker', '42501');
select pg_temp.refused($q$select public.admin_set_active('aaaaaaa1-0000-0000-0000-000000000000', 'aaaaaaa1-0000-0000-0000-000000000000', false)$q$,
  'deactivating yourself', '42501');
select pg_temp.refused($q$select public.admin_update_person('bbbbbbb1-0000-0000-0000-000000000000', 'bbbbbbb1-0000-0000-0000-000000000000',
  p_perms => '{"orders":true}')$q$, 'the only manager removing their own right to manage people', '23514');
-- deactivate the weigher: logged out everywhere at once
update private.session_unlocks set expires_at = now() + interval '1 hour' where session_id = 'd0000000-0000-0000-0000-00000000000b';
select public.admin_set_active('aaaaaaa1-0000-0000-0000-000000000000', 'aaaaaaa2-0000-0000-0000-000000000000', false);
do $$ begin assert not exists (select 1 from private.session_unlocks where person_id = 'aaaaaaa2-0000-0000-0000-000000000000'), 'deactivated → no unlocked sessions left'; end $$;
-- forgot PIN: owner resets it; the person must confirm with a new SMS code
select public.admin_reset_pin('aaaaaaa1-0000-0000-0000-000000000000', 'aaaaaaa4-0000-0000-0000-000000000000');
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000d', 'a0000000-0000-0000-0000-00000000000d');
do $$ begin
  assert not (public.login_status() ->> 'has_pin')::boolean and not (public.login_status() ->> 'unlocked')::boolean, 'after reset: no PIN, locked';
end $$;
reset role;
-- lost phone: sign out everywhere
select public.admin_sign_out_everywhere('aaaaaaa1-0000-0000-0000-000000000000', 'aaaaaaa1-0000-0000-0000-000000000000');
do $$ begin
  assert not exists (select 1 from auth.sessions where user_id = 'a0000000-0000-0000-0000-00000000000a'), 'all of that person''s sessions ended';
  assert exists (select 1 from auth.sessions where user_id = 'b0000000-0000-0000-0000-00000000000a'), 'other people are not affected';
end $$;

-- ---------- 8. every login step is in the history ----------
do $$ begin
  assert (select count(*) from public.audit_log where entity_type = 'session_unlocks' and action = 'insert') >= 3, 'unlocks recorded';
  assert (select count(*) from public.audit_log where entity_type = 'auth_credentials') >= 3, 'PIN set / wrong tries recorded (without the PIN)';
  assert exists (select 1 from public.audit_log where entity_type = 'people' and action = 'update'
                 and person_id = 'aaaaaaa1-0000-0000-0000-000000000000' and after ->> 'active' = 'false'), 'deactivation recorded with who did it';
end $$;
