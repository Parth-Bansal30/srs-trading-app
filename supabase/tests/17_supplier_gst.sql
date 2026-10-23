-- @fixtures fixtures business
-- Is the supplier's GST number active? (23 Oct 2026): checks are kept, the supplier shows the latest,
-- the evening warns about suppliers dealt with lately whose number is no longer active, the service
-- rechecks suppliers every 30 days, only people with the stock permission see or save any of it.
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
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  raj uuid; lsr uuid; old uuid; r jsonb; n int;
begin
  update public.people set perms = perms || '{"stock":true}'::jsonb where id = owner;
  insert into public.suppliers (company_id, name, gstin) values (co, 'Raj Steels', '07AAACR5055K1Z9') returning id into raj;
  insert into public.suppliers (company_id, name, gstin) values (co, 'Ludhiana Steel Rolling Mills', '03AAKFR5521L1Z4') returning id into lsr;
  insert into public.suppliers (company_id, name, gstin) values (co, 'Old Mill (no bills lately)', '06AAACO1234A1ZA') returning id into old;
  insert into public.purchases (company_id, supplier_id, bill_no, bill_date, bill_type, items_amount, gst_amount, total_amount, total_kg)
    values (co, raj, 'R-1', current_date - 20, 'pakka', 100000, 18000, 118000, 1000),
           (co, lsr, 'L-1', current_date - 40, 'pakka', 50000, 9000, 59000, 500),
           (co, old, 'O-1', current_date - 300, 'pakka', 1000, 180, 1180, 10);
  update public.purchases set pay_status = 'paid' where company_id = co and bill_no = 'O-1';

  -- ---------- 1. a person checks on the GST portal ----------
  perform pg_temp.expect(format($q$select public.api_gst_save(%L, gen_random_uuid(), 'h', '{"gstin":"07AAACR5055K1Z9","status":"cancelled"}')$q$, acct), '42501', 'stock permission');
  perform pg_temp.expect(format($q$select public.api_gst_save(%L, gen_random_uuid(), 'h', '{"gstin":"07-bad","status":"cancelled"}')$q$, owner), '22023', 'a real GST number');
  perform pg_temp.expect(format($q$select public.api_gst_save(%L, gen_random_uuid(), 'h', '{"gstin":"07AAACR5055K1Z9","status":"fine"}')$q$, owner), '22023', 'a known status');
  r := public.api_gst_save(owner, gen_random_uuid(), 'h', '{"gstin":"07aaacr5055k1z9","status":"cancelled","cancel_date":"2026-08-12","source":"portal","note":"seen on the portal"}');
  assert r ->> 'status' = 'cancelled' and r ->> 'source' = 'portal', 'saved';
  assert (select gst_status = 'cancelled' and gst_cancel_date = '2026-08-12' and gst_source = 'portal' and gst_checked_at is not null from public.suppliers where id = raj), 'the supplier shows it';
  assert (public.api_gst_last(owner, '07AAACR5055K1Z9', 7) ->> 'status') = 'cancelled', 'the last check';
  assert public.api_gst_last(owner, '03AAKFR5521L1Z4', 7) is null, 'never checked';
  perform pg_temp.expect(format($q$update public.gstin_checks set status = 'active' where gstin = '07AAACR5055K1Z9'$q$), '23001', 'checks are never changed');

  -- ---------- 2. the evening and the supplier list ----------
  r := public.api_gst_alerts(owner);
  assert jsonb_array_length(r) = 1 and (r -> 0 ->> 'id')::uuid = raj, format('Raj is flagged: %s', r);
  assert public.api_gst_alerts(acct) = '[]'::jsonb, 'no alerts without the stock permission (no error either)';
  -- a supplier with no bills lately and nothing to pay is not flagged
  perform public.api_gst_save(owner, gen_random_uuid(), 'h', '{"gstin":"06AAACO1234A1ZA","status":"suspended"}');
  assert jsonb_array_length(public.api_gst_alerts(owner)) = 1, 'old supplier not flagged';
  r := public.api_suppliers(owner);
  assert (r -> 0 ->> 'id')::uuid in (raj, old) and (r -> 0 ->> 'gst_status') in ('cancelled','suspended'), 'not-active numbers first';
  assert (select (x ->> 'gst_6m')::numeric = 18000 and (x ->> 'to_pay')::numeric = 118000 from jsonb_array_elements(r) x where (x ->> 'id')::uuid = raj), 'GST and unpaid from Raj';
  perform pg_temp.expect(format($q$select public.api_suppliers(%L)$q$, acct), '42501', 'suppliers: stock permission');
  assert (select x ->> 'gst_status' from jsonb_array_elements(public.api_purchase_context(owner) -> 'suppliers') x where (x ->> 'id')::uuid = raj) = 'cancelled', 'the bill screen knows';

  -- ---------- 3. the service checks again ----------
  r := public.api_gst_due(200);
  -- (the list is for all shops: look at this shop's numbers only)
  r := (select jsonb_agg(x) from jsonb_array_elements(r) x where (x ->> 'company_id')::uuid = co);
  assert exists (select 1 from jsonb_array_elements(r) x where x ->> 'gstin' = '07AAACR5055K1Z9'), 'portal-checked numbers are checked by the service too';
  assert exists (select 1 from jsonb_array_elements(r) x where x ->> 'gstin' = '03AAKFR5521L1Z4'), 'never checked';
  assert not exists (select 1 from jsonb_array_elements(r) x where x ->> 'gstin' = '06AAACO1234A1ZA'), 'no bills in 6 months: not checked again';
  perform public.api_gst_save_job(co, '{"gstin":"03AAKFR5521L1Z4","status":"active","legal_name":"LUDHIANA STEEL ROLLING MILLS PVT LTD","reg_date":"2017-07-01"}');
  assert (select gst_status = 'active' and gst_source = 'service' and gst_legal_name like 'LUDHIANA%' from public.suppliers where id = lsr), 'saved from the service';
  assert not exists (select 1 from jsonb_array_elements(public.api_gst_due(200)) x where x ->> 'gstin' = '03AAKFR5521L1Z4' and (x ->> 'company_id')::uuid = co), 'not again for 30 days';
  perform pg_temp.expect($q$select public.api_gst_save_job('11111111-1111-1111-1111-111111111111', '{"gstin":"x","status":"active"}')$q$, '22023', 'the job checks its input');
  -- active again: the cancel date goes
  perform public.api_gst_save_job(co, '{"gstin":"07AAACR5055K1Z9","status":"active"}');
  assert (select gst_status = 'active' and gst_cancel_date is null from public.suppliers where id = raj), 'active again';
  assert jsonb_array_length(public.api_gst_alerts(owner)) = 0, 'no more alert';
  select count(*) into n from public.gstin_checks where company_id = co and gstin = '07AAACR5055K1Z9';
  assert n = 2, 'history kept';
  -- another shop with the same supplier number sees nothing of ours
  update public.people set perms = perms || '{"stock":true}'::jsonb where id = 'bbbbbbb1-0000-0000-0000-000000000000';
  assert public.api_gst_last('bbbbbbb1-0000-0000-0000-000000000000', '07AAACR5055K1Z9', 7) is null, 'checks belong to the shop';
end $$;
