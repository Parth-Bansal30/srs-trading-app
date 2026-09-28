-- @fixtures
-- The front door: a business registers itself; invited staff join with their mobile number.
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
create function pg_temp.as_user(uid uuid, sid uuid, otp_min_ago integer default null) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'session_id', sid, 'role', 'authenticated',
    'amr', case when otp_min_ago is null then json_build_array(json_build_object('method', 'token_refresh', 'timestamp', extract(epoch from now())::bigint))
                else json_build_array(json_build_object('method', 'otp', 'timestamp', extract(epoch from now())::bigint - otp_min_ago * 60)) end)::text, true);
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- A new owner, a worker the owner will invite, and a stranger — all with SMS-proven numbers.
insert into auth.users (id, phone, phone_confirmed_at, aud, role) values
  ('e0000000-0000-0000-0000-000000000001', '919876500001', now(), 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000002', '919876500002', now(), 'authenticated', 'authenticated'),
  ('e0000000-0000-0000-0000-000000000003', '919876500003', now(), 'authenticated', 'authenticated');
insert into auth.sessions (id, user_id) values
  ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001'),
  ('f0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002'),
  ('f0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000003');

create temp table form as select jsonb_build_object(
  'name', 'Test Company Signup', 'legal_name', 'TEST SIGNUP STEELS', 'gstin', '03abcde1234f1za', 'city', 'Ludhiana', 'state', 'Punjab',
  'trade', 'steel', 'owner_name', 'New Owner', 'lang', 'hi', 'first_slip_no', 1061, 'estimates', false, 'plan', 'business',
  'team', jsonb_build_array(
    jsonb_build_object('name', 'Invited Weigher', 'phone', '+919876500002', 'role', 'weigher'),
    jsonb_build_object('name', 'Myself again', 'phone', '+919876500001', 'role', 'sales'),
    jsonb_build_object('name', 'Sales Person', 'phone', '+919876500004', 'role', 'sales'))) as f;
grant select on form to authenticated;

-- ---------- 1. a number that is in no shop sees nothing and cannot register without a fresh code ----------
select pg_temp.as_user('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001');
do $$ declare s jsonb := public.login_status(); begin
  assert (s ->> 'signed_in')::boolean and not (s ->> 'staff')::boolean, 'signed in, not staff';
  assert not (s ->> 'can_register')::boolean, 'no fresh SMS code → cannot register';
  assert s ->> 'phone' = '+919876500001', 'the proven number is shown back';
  assert (select count(*) from public.companies) = 0 and (select count(*) from public.materials) = 0, 'nothing visible';
end $$;
select pg_temp.refused($q$select public.register_company((select f from form), '385917')$q$, 'register without a fresh SMS code', '42501');
select pg_temp.as_user('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 45);
select pg_temp.refused($q$select public.register_company((select f from form), '385917')$q$, 'register with a 45-minute-old code', '42501');

-- ---------- 2. bad details are refused ----------
select pg_temp.as_user('e0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000001', 5);
select pg_temp.refused($q$select public.register_company((select f from form), '123456')$q$, 'easy PIN', '22023');
select pg_temp.refused($q$select public.register_company((select f from form), '3859')$q$, 'owners need 6 digits', '22023');
select pg_temp.refused($q$select public.register_company((select f from form) || '{"name":" "}', '385917')$q$, 'no shop name', '22023');
select pg_temp.refused($q$select public.register_company((select f from form) || '{"owner_name":""}', '385917')$q$, 'no owner name', '22023');
select pg_temp.refused($q$select public.register_company((select f from form) || '{"gstin":"03ABCDE1234"}', '385917')$q$, 'bad GST number', '22023');
select pg_temp.refused($q$select public.register_company((select f from form) || '{"trade":"plywood"}', '385917')$q$, 'trade not ready yet', '22023');
select pg_temp.refused($q$select public.register_company((select f from form) || '{"team":[{"name":"X","phone":"12345","role":"sales"}]}', '385917')$q$, 'bad team number', '22023');
select pg_temp.refused($q$select public.register_company((select f from form) || '{"team":[{"name":"X","phone":"+919876500009","role":"boss"}]}', '385917')$q$, 'unknown role', '22023');
do $$ begin assert (select count(*) from public.companies) = 0, 'refused attempts left nothing behind'; end $$;

-- ---------- 3. registering: everything is set up and this phone is unlocked ----------
do $$ declare s jsonb := public.register_company((select f from form), '385917'); begin
  assert (s ->> 'staff')::boolean and (s ->> 'unlocked')::boolean and (s ->> 'has_pin')::boolean, 'owner, PIN set, unlocked';
  assert s -> 'person' ->> 'role' = 'owner' and s -> 'person' ->> 'lang' = 'hi', 'owner in Hindi';
  assert s -> 'company' ->> 'name' = 'Test Company Signup' and s -> 'company' ->> 'trade' = 'steel' and s -> 'company' ->> 'plan' = 'trial', 'company on a trial';
  assert (s -> 'company' ->> 'trial_ends_at')::timestamptz between now() + interval '29 days' and now() + interval '31 days', '30-day trial';
  assert not (s -> 'company' ->> 'estimates')::boolean, 'no estimates chosen';
end $$;
do $$ begin
  assert (select count(*) from public.companies) = 1, 'sees only its own company';
  assert (select gstin from public.companies) = '03ABCDE1234F1ZA', 'GST number stored in capitals';
  assert (select chosen_plan from public.companies) = 'business', 'plan choice kept for later';
  assert (select count(*) from public.people) = 3, 'owner + 2 team members (own number not added twice)';
  assert (select count(*) from public.people where auth_user_id is null) = 2, 'team members join later';
  assert (select perms from public.people where display_name = 'Invited Weigher') = '{"weigh":true,"orders":true}'::jsonb, 'weigher preset';
  assert (select count(*) from public.materials) = 10 and (select count(*) from public.current_material_rates) = 10, '10 steel grades with rates';
  assert (select sell_rate from public.current_material_rates r join public.materials m on m.id = r.material_id where m.code = 'EN8') = 75, 'EN8 starts at 75';
  assert (select first_slip_no from public.company_settings) = 1061 and not (select estimates_enabled from public.company_settings), 'settings saved';
end $$;
-- pressing the button twice makes no second company
do $$ declare s jsonb := public.register_company((select f from form), '385917'); begin
  assert (s ->> 'staff')::boolean, 'second press just reports the status';
end $$;
reset role;
do $$ begin
  assert (select count(*) from public.companies where created_by_user = 'e0000000-0000-0000-0000-000000000001') = 1, 'only one company';
  assert (select count(*) from public.audit_log a join public.companies c on c.id = a.company_id where c.name = 'Test Company Signup') > 10, 'setup is in the history';
end $$;

-- ---------- 4. the invited worker joins with their own number ----------
select pg_temp.as_user('e0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000002');
do $$ begin assert public.join_by_phone() = 0, 'no fresh SMS code → not linked'; end $$;
select pg_temp.as_user('e0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000002', 2);
do $$ declare s jsonb; begin
  assert not (public.login_status() ->> 'staff')::boolean, 'before joining: not staff';
  assert public.join_by_phone() = 1, 'linked to the invite';
  assert public.join_by_phone() = 0, 'second call changes nothing';
  s := public.login_status();
  assert (s ->> 'staff')::boolean and not (s ->> 'has_pin')::boolean and (s ->> 'can_set_pin')::boolean, 'staff, first time, may set a PIN';
  assert s -> 'company' ->> 'name' = 'Test Company Signup' and s -> 'person' ->> 'role' = 'weigher', 'joined the right shop as weigher';
  assert (select count(*) from public.companies) = 0, 'still nothing visible before the PIN';
  s := public.set_pin('5817');
  assert (s ->> 'unlocked')::boolean, 'PIN set, unlocked';
  assert (select count(*) from public.companies) = 1 and (select count(*) from public.orders) = 0, 'sees the shop';
end $$;

-- ---------- 5. a stranger stays out ----------
select pg_temp.as_user('e0000000-0000-0000-0000-000000000003', 'f0000000-0000-0000-0000-000000000003', 1);
do $$ begin
  assert public.join_by_phone() = 0, 'nobody invited this number';
  assert not (public.login_status() ->> 'staff')::boolean and (public.login_status() ->> 'can_register')::boolean, 'not staff, may register own shop';
  assert (select count(*) from public.companies) = 0 and (select count(*) from public.people) = 0, 'sees nothing';
end $$;

-- ---------- 6. someone already in a shop does not get a second one ----------
reset role;
insert into auth.sessions (id, user_id) values ('d0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a');
select pg_temp.as_user('a0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-00000000000a', 1);
do $$ declare s jsonb := public.register_company((select f from form) || '{"name":"Test Company Second"}', '385917'); begin
  assert s -> 'company' ->> 'name' = 'Test Company A', 'owner A stays in their own shop';
end $$;
reset role;
do $$ begin assert not exists (select 1 from public.companies where name = 'Test Company Second'), 'no second company'; end $$;

-- ---------- 7. only signed-in users can call these; the template is backend-only ----------
do $$ begin
  assert not has_function_privilege('anon', 'public.register_company(jsonb, text)', 'execute'), 'anon cannot register';
  assert not has_function_privilege('anon', 'public.join_by_phone()', 'execute'), 'anon cannot join';
  assert not has_function_privilege('authenticated', 'app.trade_template(text)', 'execute'), 'template is backend-only';
end $$;
