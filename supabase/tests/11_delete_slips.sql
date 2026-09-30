-- @fixtures fixtures business
-- Deleting slips (30 Sept 2026): owners only, any stage, money settled in the same step,
-- kept with who / when / why, counted nowhere, never changed again; staff can ask.
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
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  weigher uuid := 'aaaaaaa2-0000-0000-0000-000000000000';
  sales uuid := 'aaaaaaa3-0000-0000-0000-000000000000';   -- money, no kacha, no delete
  owner_b uuid := 'bbbbbbb1-0000-0000-0000-000000000000';
  o1 uuid := 'a3000000-0000-0000-0000-000000000001';  -- finished GST slip, paid 17,434.50 by UPI at pickup
  o2 uuid := 'a3000000-0000-0000-0000-000000000002';  -- finished no-bill slip in khata, 600 cash at pickup
  o3 uuid := 'a3000000-0000-0000-0000-000000000003';  -- estimate
  o4 uuid := 'a3000000-0000-0000-0000-000000000004';  -- accepted, 500 cash advance
  cu2 uuid := 'a2000000-0000-0000-0000-000000000002';
  r jsonb; k uuid := gen_random_uuid(); rid uuid; rid2 uuid; n int; tok text := 'test-token-' || md5(random()::text);
begin
  -- ---------- 0. the permission ----------
  assert (app.role_preset('owner') ->> 'delete')::boolean, 'owners can delete';
  assert not (app.role_preset('sales') ? 'delete') and not (app.role_preset('accounts') ? 'delete'), 'others cannot';
  assert app.valid_perms('{"delete":true}'::jsonb), 'delete is a real permission';
  update public.people set perms = perms || '{"delete":true}'::jsonb where id in (owner, owner_b);

  -- ---------- 1. staff ask; owners see the request ----------
  r := public.api_request_delete(weigher, gen_random_uuid(), 'h', o3, 'Customer did not come');
  rid := (r ->> 'request_id')::uuid;
  assert rid is not null and r ->> 'slip_no' = '1043', 'request saved';
  assert jsonb_array_length(r -> 'owners') = 1, 'the owner with the permission is told';
  r := public.api_request_delete(sales, gen_random_uuid(), 'h', o3, 'Typed twice');
  assert (r ->> 'request_id')::uuid = rid, 'one open request per slip';
  perform pg_temp.expect(format($q$select public.api_request_delete(%L, gen_random_uuid(), 'h', %L, 'x')$q$, weigher, o2), '22023', 'no-bill slip hidden without that permission');
  perform pg_temp.expect(format($q$select public.api_request_delete(%L, gen_random_uuid(), 'h', %L, '  ')$q$, weigher, o3), '22023', 'reason needed');
  r := public.api_deleted_slips(owner, null);
  assert jsonb_array_length(r -> 'requests') = 1 and r -> 'requests' -> 0 ->> 'by' = 'Weigher A', 'owner sees the request';
  assert jsonb_array_length(public.api_deleted_slips(owner, o3) -> 'requests') = 1, 'request of one slip';
  perform pg_temp.expect(format($q$select public.api_deleted_slips(%L, null)$q$, weigher), '42501', 'only owners see the list');
  r := public.api_decline_delete(owner, gen_random_uuid(), 'h', rid);
  assert r ->> 'outcome' = 'declined', 'owner can say not needed';
  perform pg_temp.expect(format($q$select public.api_decline_delete(%L, gen_random_uuid(), 'h', %L)$q$, owner, rid), '23001', 'closed once');
  rid2 := (public.api_request_delete(weigher, gen_random_uuid(), 'h', o3, 'Asked again') ->> 'request_id')::uuid;
  assert rid2 <> rid, 'a new request after a decline';

  -- ---------- 2. who may delete ----------
  perform pg_temp.expect(format($q$select public.api_delete_check(%L, array[%L]::uuid[])$q$, sales, o4), '42501', 'sales cannot');
  perform pg_temp.expect(format($q$select public.api_delete_orders(%L, gen_random_uuid(), 'h', array[%L]::uuid[], 'x', 'none', null)$q$, weigher, o3), '42501', 'weigher cannot');
  perform pg_temp.expect(format($q$select public.api_delete_check(%L, array[%L]::uuid[])$q$, owner_b, o4), '22023', 'another company''s slip is not found');
  r := public.api_delete_check(owner, array[o1, o4]);
  assert jsonb_array_length(r -> 'orders') = 2, 'both slips listed';
  assert (select (x ->> 'paid')::numeric from jsonb_array_elements(r -> 'orders') x where x ->> 'id' = o4::text) = 500, 'money on the slip shown';
  perform pg_temp.expect(format($q$select public.api_delete_check(%L, array[%L, gen_random_uuid()]::uuid[])$q$, owner, o1), '22023', 'a missing slip');
  assert (select bool_and((x ->> 'can_undo')::boolean) from jsonb_array_elements(r -> 'orders') x), 'plain payments can be undone';

  -- ---------- 3. the reason and the money must be clear ----------
  perform pg_temp.expect(format($q$select public.api_delete_orders(%L, gen_random_uuid(), 'h', array[%L]::uuid[], '  ', 'credit', null)$q$, owner, o4), '22023', 'reason needed');
  perform pg_temp.expect(format($q$select public.api_delete_orders(%L, gen_random_uuid(), 'h', array[%L]::uuid[], 'x', 'none', null)$q$, owner, o4), '22023', 'money taken must be settled');
  perform pg_temp.expect(format($q$select public.api_delete_orders(%L, gen_random_uuid(), 'h', array[%L]::uuid[], 'x', 'refund', null)$q$, owner, o4), '22023', 'how it was given back');

  -- ---------- 4. accepted slip, advance kept as credit ----------
  perform public.api_adjust_advance(owner, gen_random_uuid(), 'h', o4, 'refund', 100, 'Cash', null, null, 'part returned');
  assert not (public.api_delete_check(owner, array[o4]) -> 'orders' -> 0 ->> 'can_undo')::boolean, 'part given back → cannot "never received"';
  perform pg_temp.expect(format($q$select public.api_delete_orders(%L, gen_random_uuid(), 'h', array[%L]::uuid[], 'x', 'never', null)$q$, owner, o4), '23001', 'never refused then');
  r := public.api_delete_orders(owner, k, 'h', array[o4], 'Customer cancelled', 'credit', null);
  assert r -> 'deleted' -> 0 ->> 'was' = 'accepted', 'deleted from accepted';
  assert (select status = 'deleted' and deleted_from = 'accepted' and delete_reason = 'Customer cancelled' and deleted_by = owner and deleted_at is not null
          from public.orders where id = o4), 'record kept: who, why, from which stage';
  assert (select coalesce(sum(amount), 0) from public.payments where order_id = o4) = 0, 'nothing left on the slip';
  assert exists (select 1 from public.payments where customer_id = cu2 and order_id is null and kind = 'khata' and side = 'pakka'
                   and amount = 400 and from_payment_id is not null), 'customer keeps the 400 left as credit';
  r := public.api_delete_orders(owner, k, 'h', array[o4], 'Customer cancelled', 'credit', null);
  assert (r ->> 'replayed')::boolean, 'same request key: first answer, nothing twice';
  assert (public.api_idem_answer(owner, k, 'deleteSlips') ->> 'replayed')::boolean, 'answer found for a retry';
  assert public.api_idem_answer(owner, k, 'cancelOrder') is null, 'only for the same operation';
  perform pg_temp.expect(format($q$select public.api_delete_orders(%L, gen_random_uuid(), 'h', array[%L]::uuid[], 'x', 'none', null)$q$, owner, o4), '23001', 'already deleted');

  -- ---------- 5. finished GST slip: money never really received ----------
  insert into public.shared_docs (company_id, token, kind, order_id, customer_id, doc)
    values (co, tok, 'slip', o1, 'a2000000-0000-0000-0000-000000000001', '{"shop":{"name":"Shop A","phone":"99"},"slip":{"no":"1041"}}');
  assert public.shared_doc(tok) ? 'doc', 'link works before';
  r := public.api_delete_orders(owner, gen_random_uuid(), 'h', array[o1, o3], 'Test entry', 'never', null);
  assert jsonb_array_length(r -> 'deleted') = 2, 'two slips at once';
  assert (select count(*) from public.orders where id in (o1, o3) and status = 'deleted') = 2, 'both deleted';
  assert (select bill_type = 'pakka' and total_amount = 17434.50 and deleted_from = 'done' from public.orders where id = o1), 'the bill is kept for the record';
  assert exists (select 1 from public.payments where order_id = o1 and kind = 'reversal' and amount = -17434.50 and mode = 'UPI'), 'payment reversed';
  assert (select outcome from private.delete_requests where id = rid2) = 'deleted', 'the open request is closed';
  r := public.shared_doc(tok);
  assert (r ->> 'cancelled')::boolean and r ->> 'slip_no' = '1041' and r -> 'doc' is null, 'customer''s link says cancelled, shows nothing else';
  perform pg_temp.expect(format($q$select public.api_slip_data(%L, %L)$q$, owner, o1), '23514', 'a deleted slip cannot be sent');

  -- ---------- 6. finished no-bill slip in khata: money given back ----------
  perform pg_temp.expect(format($q$select public.api_delete_orders(%L, gen_random_uuid(), 'h', array[%L]::uuid[], 'x', 'refund', 'Cash')$q$, sales, o2), '42501', 'sales cannot');
  r := public.api_delete_orders(owner, gen_random_uuid(), 'h', array[o2], 'Wrong customer', 'refund', 'Cash');
  assert exists (select 1 from public.payments where order_id = o2 and kind = 'refund' and amount = -600 and mode = 'Cash'), 'money out recorded';

  -- ---------- 7. counted nowhere, never changed ----------
  r := public.api_day_data(owner, null);
  assert not exists (select 1 from jsonb_array_elements(r -> 'orders') x where x ->> 'id' in (o1::text, o2::text)), 'not in today''s sales';
  r := public.api_day_deleted(owner, null);
  select count(*) into n from jsonb_array_elements(r);
  assert n = 4, 'evening summary lists the 4 slips deleted today';
  assert jsonb_array_length(public.api_day_deleted(sales, null)) = 3, 'no-bill slip hidden without that permission';
  r := public.api_deleted_slips(owner, null);
  assert jsonb_array_length(r -> 'deleted') = 4 and jsonb_array_length(r -> 'requests') = 0, 'owner''s deleted list';
  perform pg_temp.expect(format($q$update public.orders set in_khata = true where id = %L$q$, o1), '23001', 'a deleted slip never changes');
  perform pg_temp.expect(format($q$update public.orders set status = 'done' where id = %L$q$, o4), '23001', 'no way back');
  perform pg_temp.expect(format($q$insert into public.payments (company_id, customer_id, order_id, amount, mode, kind) values (%L, %L, %L, 10, 'Cash', 'advance')$q$, co, cu2, o4),
    '23514', 'no new money on a deleted slip');

  -- ---------- 8. the database refuses a delete that skips the money or changes anything else ----------
  perform pg_temp.expect($q$update public.orders set status = 'deleted', deleted_at = now(), delete_reason = 'x', deleted_from = 'done'
    where id = 'b3000000-0000-0000-0000-000000000001'$q$, '23514', 'money on it still standing');
  perform pg_temp.expect($q$update public.orders set status = 'deleted', deleted_at = now(), delete_reason = 'x', deleted_from = 'weighed'
    where id = 'b3000000-0000-0000-0000-000000000001'$q$, '23001', 'stage must be the real one');
end $$;
