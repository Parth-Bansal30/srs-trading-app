-- @fixtures fixtures business
-- Slips and statements for the customer (snapshots + secret links), customer GST/address, UPI ID.
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
  gst_slip uuid := 'a3000000-0000-0000-0000-000000000001'; -- done, GST bill, Sharma Engineering
  nb_slip uuid := 'a3000000-0000-0000-0000-000000000002';  -- done, no bill, Rana Tools
  open_slip uuid := 'a3000000-0000-0000-0000-000000000004'; -- accepted
  sharma uuid := 'a2000000-0000-0000-0000-000000000001'; rana uuid := 'a2000000-0000-0000-0000-000000000002';
  r jsonb; r2 jsonb; k uuid := gen_random_uuid(); t1 text; t2 text;
begin
  -- ---------- 1. slip data for the customer ----------
  update public.companies set address = 'Shop 12, Steel Market, New Delhi 110001', phone = '90000 00100' where id = '11111111-1111-1111-1111-111111111111';
  update public.company_settings set upi_id = 'srs.sample@upi' where company_id = '11111111-1111-1111-1111-111111111111';
  r := public.api_slip_data(owner, gst_slip);
  assert r -> 'order' ->> 'slip_no' = '1041' and (r -> 'order' ->> 'total')::numeric = 17434.50, 'slip totals';
  assert r -> 'shop' ->> 'address' = 'Shop 12, Steel Market, New Delhi 110001', 'shop address';
  assert r -> 'upi' ->> 'id' = 'srs.sample@upi', 'UPI ID';
  assert jsonb_array_length(r -> 'items') = 1 and (r -> 'items' -> 0 -> 'lengths' -> 0 ->> 'pcs')::int = 5, 'items with lengths';
  assert (r -> 'payments' -> 0 ->> 'amount')::numeric = 17434.50, 'payment on the slip';
  assert not (r::text ~* 'sell_rate|cut_rate|note'), 'no rates or notes in the slip data';
  perform pg_temp.expect(format('select public.api_slip_data(%L, %L)', owner, open_slip), '23514', 'open order has no slip yet');
  perform pg_temp.expect(format('select public.api_slip_data(%L, %L)', weigher, gst_slip), '42501', 'weigher sees no money');
  perform pg_temp.expect(format('select public.api_slip_data(%L, %L)', sales, nb_slip), '42501', 'no-bill slip needs that permission');
  perform pg_temp.expect(format('select public.api_slip_data(%L, %L)', 'bbbbbbb1-0000-0000-0000-000000000000', gst_slip), '22023', 'other company''s slip');

  -- ---------- 2. one link per slip and language; re-sending keeps the link ----------
  r := public.api_save_doc(owner, k, 'h1', 'slip', gst_slip, sharma, 'en', '{"v":1,"kind":"slip","total":1}', true, false);
  t1 := r ->> 'token';
  assert length(t1) >= 20 and (r ->> 'send_count')::int = 1, 'link made and counted as sent';
  r2 := public.api_save_doc(owner, k, 'h1', 'slip', gst_slip, sharma, 'en', '{"v":1,"kind":"slip","total":1}', true, false);
  assert (r2 - 'replayed') = r and (r2 ->> 'replayed')::boolean, 'same request key → same answer, nothing twice';
  r2 := public.api_save_doc(owner, gen_random_uuid(), 'h2', 'slip', gst_slip, sharma, 'en', '{"v":1,"kind":"slip","total":2}', false, false);
  assert r2 ->> 'token' = t1 and (r2 ->> 'send_count')::int = 1, 'same link, not sent again (print/PDF)';
  r2 := public.api_save_doc(owner, gen_random_uuid(), 'h3', 'slip', gst_slip, sharma, 'hi', '{"v":1,"kind":"slip"}', true, false);
  assert r2 ->> 'token' <> t1, 'Hindi copy has its own link';
  perform pg_temp.expect(format('select public.api_save_doc(%L, %L, %L, %L, %L, %L, %L, %L, true, false)', owner, gen_random_uuid(), 'h', 'slip', gst_slip, rana, 'en', '{}'), '22023', 'wrong customer for the slip');
  perform pg_temp.expect(format('select public.api_save_doc(%L, %L, %L, %L, %L, %L, %L, %L, true, false)', sales, gen_random_uuid(), 'h', 'slip', nb_slip, rana, 'en', '{}'), '42501', 'no-bill slip needs the permission');
  perform pg_temp.expect(format('select public.api_save_doc(%L, %L, %L, %L, null, %L, %L, %L, true, true)', sales, gen_random_uuid(), 'h', 'statement', rana, 'en', '{}'), '42501', 'statement needs khata permission');
  r := public.api_save_doc(owner, gen_random_uuid(), 'h4', 'statement', null, rana, 'en', '{"v":1,"kind":"statement","closing":5}', true, true);
  t2 := r ->> 'token';
  r2 := public.api_save_doc(owner, gen_random_uuid(), 'h5', 'statement', null, rana, 'en', '{"v":1,"kind":"statement","closing":5}', true, true);
  assert r2 ->> 'token' <> t2, 'every statement gets its own link';
  perform pg_temp.expect(format('select public.api_save_doc(%L, %L, %L, %L, %L, %L, %L, %L, true, false)', owner, gen_random_uuid(), 'h', 'slip', open_slip, rana, 'en', '{}'), '23514', 'no link before pickup');

  -- ---------- 3. the customer opens the link without logging in ----------
  perform set_config('role', 'anon', true);
  r := public.shared_doc(t1);
  assert r ->> 'kind' = 'slip' and (r -> 'doc' ->> 'total')::int = 2, 'customer sees the latest snapshot';
  assert public.shared_doc('not-a-real-token-at-all-000') is null, 'wrong token → nothing';
  assert public.shared_doc('') is null and public.shared_doc(null) is null, 'empty token → nothing';
  begin
    perform count(*) from public.shared_docs;
    raise exception 'TEST FAILED: visitors could list documents';
  exception when insufficient_privilege then null;
  end;
  reset role;
  assert (select open_count from public.shared_docs where token = t1) = 1, 'opening is counted';
  update public.companies set active = false where id = '11111111-1111-1111-1111-111111111111';
  assert public.shared_doc(t1) is null, 'a closed company''s links stop working';
  update public.companies set active = true where id = '11111111-1111-1111-1111-111111111111';

  -- ---------- 4. customers: GST number and address; settings: UPI ID ----------
  r := public.api_update_customer(owner, gen_random_uuid(), 'h', rana, '{"gstin":"03aakfr5521l1z4","address":" Focal Point, Ludhiana "}');
  assert r ->> 'gstin' = '03AAKFR5521L1Z4' and r ->> 'address' = 'Focal Point, Ludhiana', 'saved in capitals, trimmed';
  perform pg_temp.expect(format('select public.api_update_customer(%L, %L, %L, %L, %L)', owner, gen_random_uuid(), 'h', rana, '{"gstin":"12345"}'), '23514', 'bad GST number refused');
  r := public.api_update_customer(owner, gen_random_uuid(), 'h', rana, '{"gstin":""}');
  assert r ->> 'gstin' is null, 'GST number can be removed';
  r := public.api_change_settings(owner, gen_random_uuid(), 'h', '{"upi_id":"srstrading@okaxis"}');
  assert r ->> 'upi_id' = 'srstrading@okaxis', 'UPI ID saved';
  perform pg_temp.expect(format('select public.api_change_settings(%L, %L, %L, %L)', owner, gen_random_uuid(), 'h', '{"upi_id":"no spaces allowed@x"}'), '23514', 'bad UPI ID refused');
  r := public.api_change_settings(owner, gen_random_uuid(), 'h', '{"company":{"city":"New Delhi"}}');
  assert (select city from public.companies where id = '11111111-1111-1111-1111-111111111111') = 'New Delhi', 'city can be changed';
end $$;

-- ---------- 5. in the app: who sees the sent documents ----------
insert into auth.sessions (id, user_id) values
  ('d1000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a'),
  ('d1000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000c'),
  ('d1000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000b');
insert into private.session_unlocks (session_id, company_id, person_id, expires_at) values
  ('d1000000-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000000', now() + interval '1 hour'),
  ('d1000000-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'aaaaaaa3-0000-0000-0000-000000000000', now() + interval '1 hour'),
  ('d1000000-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'aaaaaaa2-0000-0000-0000-000000000000', now() + interval '1 hour');
create function pg_temp.as_session(uid uuid, sid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'session_id', sid, 'role', 'authenticated')::text, true);
end $$;
grant execute on all functions in schema pg_temp to authenticated;
select pg_temp.as_session('a0000000-0000-0000-0000-00000000000a', 'd1000000-0000-0000-0000-00000000000a');
do $$ begin assert (select count(*) from public.shared_docs) = 4, 'owner sees all 4 sent documents'; end $$;
reset role;
select pg_temp.as_session('a0000000-0000-0000-0000-00000000000c', 'd1000000-0000-0000-0000-00000000000c');
do $$ begin assert (select count(*) from public.shared_docs) = 2, 'sales without no-bill permission sees only the GST slip copies'; end $$;
reset role;
select pg_temp.as_session('a0000000-0000-0000-0000-00000000000b', 'd1000000-0000-0000-0000-00000000000b');
do $$ begin assert (select count(*) from public.shared_docs) = 0, 'weigher sees none'; end $$;
reset role;
do $$ begin
  assert has_function_privilege('anon', 'public.shared_doc(text)', 'execute'), 'visitors can open a link';
  assert not has_function_privilege('anon', 'public.api_save_doc(uuid, uuid, text, text, uuid, uuid, text, jsonb, boolean, boolean)', 'execute'), 'only the backend saves';
  assert not has_function_privilege('authenticated', 'public.api_slip_data(uuid, uuid)', 'execute'), 'only the backend reads slip data';
end $$;
