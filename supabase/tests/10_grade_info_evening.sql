-- @fixtures fixtures business
-- Grade "i" information (template v2) and the evening summary (day data, settings, phones, the evening job).
create function pg_temp.err(q text) returns text language plpgsql as $$
declare st text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics st = returned_sqlstate;
  return st;
end $$;
create function pg_temp.expect(q text, want text, why text) returns void language plpgsql as $$
declare got text := pg_temp.err(q);
begin
  if got <> want then raise exception 'TEST FAILED (%): expected %, got %', why, want, got; end if;
end $$;

do $$
declare
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  weigher uuid := 'aaaaaaa2-0000-0000-0000-000000000000';
  sales uuid := 'aaaaaaa3-0000-0000-0000-000000000000';   -- money, no kacha
  co uuid := '11111111-1111-1111-1111-111111111111';
  gst_slip uuid := 'a3000000-0000-0000-0000-000000000001';
  nb_slip uuid := 'a3000000-0000-0000-0000-000000000002';
  t jsonb; r jsonb; d date; k uuid := gen_random_uuid(); n int;
begin
  -- ---------- 1. the steel template carries the fuller info ----------
  t := app.trade_template('steel');
  assert jsonb_array_length(t) = 10, 'ten grades';
  select e -> 'info' into r from jsonb_array_elements(t) e where e ->> 'code' = 'EN8';
  assert (r ->> 'v')::int = 2 and jsonb_array_length(r -> 'comp') >= 3 and jsonb_array_length(r -> 'good' -> 0) >= 8, 'EN8: composition and uses';
  assert jsonb_array_length(r -> 'what') = 3 and jsonb_array_length(r -> 'tell') = 3, 'three languages';
  select e -> 'info' -> 'eq' into r from jsonb_array_elements(t) e where e ->> 'code' = 'EN19';
  assert r #>> '{}' like '%709M40%', 'EN19 equivalent corrected';

  -- ---------- 2. one shop day ----------
  -- the day the GST fixture slip was finished (shop calendar)
  select (done_at at time zone 'Asia/Kolkata')::date into d from public.orders where id = gst_slip;
  select count(*) into n from public.orders where company_id = co and status = 'done' and (done_at at time zone 'Asia/Kolkata')::date = d;
  r := public.api_day_data(owner, d);
  assert (r ->> 'day')::date = d and jsonb_array_length(r -> 'orders') = n, 'owner sees every slip of the day';
  assert jsonb_typeof(r -> 'orders' -> 0 -> 'items') = 'array' and (r -> 'orders' -> 0 -> 'items' -> 0 ? 'std_rate'), 'items carry the usual rate';
  select count(*) into n from public.orders where company_id = co and status = 'done' and bill_type = 'pakka' and (done_at at time zone 'Asia/Kolkata')::date = d;
  r := public.api_day_data(sales, d);
  assert jsonb_array_length(r -> 'orders') = n, 'only GST slips without the no-bill permission';
  assert not exists (select 1 from jsonb_array_elements(r -> 'orders') o where o ->> 'bill' = 'kacha'), 'no no-bill slip for sales';
  assert r -> 'cash_close' is null or r -> 'cash_close' = 'null'::jsonb, 'cash count only with no-bill permission (it includes all cash)';
  r := public.api_day_data(owner, null);
  assert (r ->> 'day')::date = (now() at time zone 'Asia/Kolkata')::date, 'no day = today in the shop calendar';
  perform pg_temp.expect(format('select public.api_day_data(%L, %L)', weigher, d), '42501', 'weigher sees no money');

  -- ---------- 3. settings ----------
  r := public.api_evening_get(owner);
  assert (r ->> 'on')::boolean and r ->> 'time' = '20:00' and r -> 'days' = '[1,2,3,4,5,6]'::jsonb, 'defaults: on, 8 pm, Mon–Sat';
  assert exists (select 1 from jsonb_array_elements(r -> 'people') p where (p ->> 'id')::uuid = owner and (p ->> 'on')::boolean), 'owners get it';
  assert not exists (select 1 from jsonb_array_elements(r -> 'people') p where (p ->> 'id')::uuid = weigher), 'people without money are not listed';
  r := public.api_evening_set(owner, k, 'h', jsonb_build_object('time', '19:30', 'days', '[1,2,3,4,5,6,7]'::jsonb, 'people', jsonb_build_object(sales, true, weigher, true)));
  assert r ->> 'time' = '19:30' and jsonb_array_length(r -> 'days') = 7, 'time and days saved';
  assert (select evening_summary from public.people where id = sales), 'sales added';
  assert not (select evening_summary from public.people where id = weigher), 'a weigher can never get it';
  perform pg_temp.expect(format('select public.api_evening_set(%L, %L, %L, %L)', sales, gen_random_uuid(), 'h', '{"on":false}'), '42501', 'only settings people change it');

  -- ---------- 4. this phone + the evening job ----------
  r := public.api_save_push(owner, gen_random_uuid(), 'h', jsonb_build_object('endpoint', 'https://push.example.com/abc',
        'keys', jsonb_build_object('p256dh', repeat('B', 87), 'auth', repeat('a', 22))), true);
  assert (r ->> 'my_phones')::int = 1, 'phone saved';
  perform pg_temp.expect(format('select public.api_save_push(%L, %L, %L, %L, true)', weigher, gen_random_uuid(), 'h',
        '{"endpoint":"https://push.example.com/w","keys":{"p256dh":"' || repeat('B', 87) || '","auth":"' || repeat('a', 22) || '"}}'), '42501', 'weigher cannot subscribe');
  r := public.api_evening_due(timestamptz '2026-09-28 19:00+05:30');
  assert not exists (select 1 from jsonb_array_elements(r) x where (x ->> 'company_id')::uuid = co), 'not before the time';
  r := public.api_evening_due(timestamptz '2026-09-28 19:40+05:30');
  select count(*) into n from jsonb_array_elements(r) x where (x ->> 'company_id')::uuid = co;
  assert n = 1, 'due at 7:40 pm';
  assert (select jsonb_array_length(x -> 'recipients') from jsonb_array_elements(r) x where (x ->> 'company_id')::uuid = co) = 1, 'only people with a phone';
  r := public.api_evening_due(timestamptz '2026-09-28 19:50+05:30');
  assert not exists (select 1 from jsonb_array_elements(r) x where (x ->> 'company_id')::uuid = co), 'never twice the same day';
  perform public.api_push_result('https://push.example.com/abc', false, true);
  assert not exists (select 1 from private.push_subscriptions where endpoint = 'https://push.example.com/abc'), 'unsubscribed phone removed';
end $$;

do $$ begin
  assert not has_function_privilege('authenticated', 'public.api_day_data(uuid, date)', 'execute'), 'only the backend reads day data';
  assert not has_function_privilege('anon', 'public.api_evening_due(timestamptz)', 'execute'), 'only the backend runs the job';
  assert exists (select 1 from cron.job where jobname = 'evening-summary'), 'the evening job is scheduled';
end $$;
