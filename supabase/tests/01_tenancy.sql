-- @fixtures
-- Companies, settings and people: each person sees only their own company.

-- Owner A
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a","session_id":"a0000000-0000-0000-0000-00000000000a","role":"authenticated"}';
do $$ begin
  assert (select count(*) from public.companies) = 1, 'owner A should see exactly 1 company';
  assert (select name from public.companies) = 'Test Company A', 'owner A should see company A';
  assert (select count(*) from public.company_settings) = 1, 'owner A: 1 settings row';
  assert (select count(*) from public.people) = 5, 'owner A: all 5 staff of A (incl. former), none of B';
  assert not exists (select 1 from public.people where display_name = 'Owner B'), 'owner A must not see Owner B';
end $$;

-- Owner B
set local request.jwt.claims = '{"sub":"b0000000-0000-0000-0000-00000000000a","session_id":"b0000000-0000-0000-0000-00000000000a","role":"authenticated"}';
do $$ begin
  assert (select count(*) from public.companies) = 1 and (select name from public.companies) = 'Test Company B', 'owner B sees only B';
  assert (select count(*) from public.people) = 1, 'owner B sees only their own staff';
end $$;

-- Signed in, but not staff anywhere / deactivated staff / a token naming the wrong company
set local request.jwt.claims = '{"sub":"c0000000-0000-0000-0000-000000000000","session_id":"c0000000-0000-0000-0000-000000000000","role":"authenticated"}';
do $$ begin
  assert (select count(*) from public.companies) = 0 and (select count(*) from public.people) = 0, 'stranger sees nothing';
end $$;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000e","session_id":"a0000000-0000-0000-0000-00000000000e","role":"authenticated"}';
do $$ begin
  assert (select count(*) from public.companies) = 0, 'deactivated person sees nothing';
end $$;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a","session_id":"99999999-9999-9999-9999-999999999999","role":"authenticated"}';
do $$ begin
  assert (select count(*) from public.companies) = 0 and (select count(*) from public.people) = 0,
    'a login session that was never unlocked with the PIN sees nothing';
end $$;

-- Nobody writes directly through the API — not even the owner
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a","session_id":"a0000000-0000-0000-0000-00000000000a","role":"authenticated"}';
do $$ begin
  begin update public.company_settings set gst_pct = 5; raise exception 'TEST FAILED: owner updated settings directly';
  exception when insufficient_privilege then null; end;
  begin insert into public.people (company_id, display_name, role) values ('11111111-1111-1111-1111-111111111111','X','sales'); raise exception 'TEST FAILED: direct insert into people';
  exception when insufficient_privilege then null; end;
  begin delete from public.companies; raise exception 'TEST FAILED: direct delete of companies';
  exception when insufficient_privilege then null; end;
  begin perform 1 from private.auth_credentials; raise exception 'TEST FAILED: login secrets readable';
  exception when insufficient_privilege then null; end;
end $$;

-- Not signed in at all
reset role;
set local role anon;
do $$ begin
  begin perform 1 from public.companies; raise exception 'TEST FAILED: anonymous can read companies';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- Bad data is refused by the database itself
do $$ begin
  begin update public.company_settings set gst_pct = 150; raise exception 'TEST FAILED: GST 150%% accepted';
  exception when check_violation then null; end;
  begin update public.company_settings set slip_numbering = 'weekly'; raise exception 'TEST FAILED: unknown numbering accepted';
  exception when check_violation then null; end;
  begin update public.people set perms = '{"superuser":true}' where display_name = 'Owner A'; raise exception 'TEST FAILED: unknown permission accepted';
  exception when check_violation then null; end;
  begin update public.people set perms = '{"money":1}' where display_name = 'Owner A'; raise exception 'TEST FAILED: non-true/false permission accepted';
  exception when check_violation then null; end;
  begin insert into public.companies (name, timezone) values ('Bad TZ', 'Mars/Olympus'); raise exception 'TEST FAILED: bad time zone accepted';
  exception when check_violation then null; end;
  begin insert into public.people (company_id, display_name, role) values ('22222222-2222-2222-2222-222222222222','Dup','sales'), ('22222222-2222-2222-2222-222222222222','Dup2','sales');
  exception when others then raise exception 'TEST FAILED: two staff without phone should be allowed (%)', sqlerrm; end;
end $$;
