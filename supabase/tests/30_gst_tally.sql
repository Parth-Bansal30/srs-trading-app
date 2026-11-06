-- @fixtures fixtures business
-- 6 Nov 2026 (plan v2, F10): GST details for the CA's Tally bills (made-up data). The place of supply follows the same
-- rules as the phone and is never assumed; a direct delivery is always "CA to check"; HSN and rate are saved with the slip
-- the first time; the Tally bill no. is kept, the same number on two slips is refused unless confirmed; the pending list
-- and the month for the CA.
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
create function pg_temp.items(kg numeric) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('material_id', 'a1000000-0000-0000-0000-000000000001', 'grade_code', 'EN8', 'shape', 'round', 'unit', 'mm',
    'dims', jsonb_build_array('40'), 'sell_rate', 74, 'cut_rate', 0, 'density', 7850, 'special_rate', false, 'by_weight', true, 'kg', kg,
    'lengths', jsonb_build_array(jsonb_build_object('len', '', 'pcs', 1, 'cuts', 0))))
$$;
/** A direct-delivery GST slip of 1,000 kg × ₹74, finished on the khata. */
create function pg_temp.gst_slip(owner uuid, sup uuid, cust uuid, no text) returns uuid language plpgsql as $$
declare p uuid; o uuid; it uuid;
begin
  p := (public.api_save_purchase(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'bill', 'bill_no', no, 'bill_date', current_date, 'bill_type', 'pakka',
    'supplier', jsonb_build_object('id', sup), 'gst', 0, 'total', 70000, 'stock_effect', 'direct',
    'lines', jsonb_build_array(jsonb_build_object('description', 'MS Round 40', 'hsn', '7214', 'qty_kg', 1000, 'rate', 70, 'amount', 70000,
      'material_id', 'a1000000-0000-0000-0000-000000000001', 'shape', 'round')))) ->> 'purchase_id')::uuid;
  o := (public.api_direct_slip(owner, gen_random_uuid(), 'h', p, cust, '{"min_inch":1}', pg_temp.items(1000)) ->> 'order_id')::uuid;
  select id into it from public.order_items where order_id = o;
  perform public.api_finalize_order(owner, gen_random_uuid(), 'h', o, jsonb_build_object('bill', 'pakka', 'gst_pct', 18, 'kacha_pct',
    (select kacha_pct from public.company_settings where company_id = '11111111-1111-1111-1111-111111111111'),
    'pay_mode', 'later', 'paid_now', 0, 'in_khata', true,
    'basis', jsonb_build_object('advance', 0, 'weights', jsonb_build_object(it, 1000)),
    'totals', jsonb_build_object('weight', 1000, 'base', 74000, 'material', 74000, 'cutting', 0, 'gst', 13320, 'total', 87320)));
  return o;
end $$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  mat uuid := 'a1000000-0000-0000-0000-000000000001';
  sup uuid := gen_random_uuid(); o1 uuid; o2 uuid; r jsonb; m jsonb;
begin
  update public.people set perms = perms || '{"stock":true}'::jsonb where id = owner;
  update public.people set perms = perms || '{"money":true,"khata":true}'::jsonb where id = acct;
  update public.companies set gstin = '07AABCS1429B1ZW', created_at = now() - interval '30 days' where id = co;
  update public.company_settings set gst_pct = 18 where company_id = co;
  insert into public.suppliers (id, company_id, name) values (sup, co, 'P K Steel Traders');

  -- ---------- 1. place of supply: the same rules as the phone, never assumed ----------
  assert app.place_of_supply('07', 'ours', '06') = '{"from":"07","to":"06","kind":"inter","sure":true,"reason":null}'::jsonb, 'Delhi → Haryana · IGST';
  assert app.place_of_supply('07', 'pickup', '07') ->> 'kind' = 'local', 'Delhi → Delhi: CGST + SGST';
  assert app.place_of_supply('07', 'pickup', null) @> '{"sure":false,"reason":"no_dest"}', 'not known: CA to check';
  assert app.place_of_supply(null, 'pickup', '07') @> '{"sure":false,"reason":"no_shop"}', 'no shop GST number: CA to check';
  assert app.place_of_supply('07', 'direct', '06') @> '{"from":"07","to":"06","sure":false,"reason":"direct"}', 'bill-to / ship-to: CA to check';

  -- ---------- 2. a grade's HSN and rate, checked by the CA ----------
  perform pg_temp.expect(format($q$select public.api_material_gst(%L, gen_random_uuid(), 'h', %L, '7214', 18, true)$q$, acct, mat), '42501', 'owner only');
  r := public.api_material_gst(owner, gen_random_uuid(), 'h', mat, '7214', 18, true);
  assert (select hsn = '7214' and gst_rate = 18 and hsn_checked_at is not null from public.materials where id = mat), 'checked by the CA';
  r := public.api_material_gst(owner, gen_random_uuid(), 'h', mat, '7215', 18, true);
  r := public.api_material_gst(owner, gen_random_uuid(), 'h', mat, '7214', 18, false);
  assert (select hsn_checked_at is null from public.materials where id = mat), 'a change takes the tick off';
  r := public.api_material_gst(owner, gen_random_uuid(), 'h', mat, '7214', 18, true);
  perform pg_temp.expect(format($q$select public.api_material_gst(%L, gen_random_uuid(), 'h', %L, '72', 18, true)$q$, owner, mat), '23514', 'HSN is 4, 6 or 8 digits');

  -- ---------- 3. where the steel went, saved with the slip ----------
  o1 := pg_temp.gst_slip(owner, sup, cust, 'PKT/901');
  assert (select status = 'done' and bill_type = 'pakka' from public.orders where id = o1), 'a finished GST slip';
  r := public.api_gst_context(acct, cust);
  assert r ->> 'shop_state' = '07', 'the shop''s state from its GST number';
  r := public.api_slip_gst(acct, gen_random_uuid(), 'h', o1, 'ours', '06');
  assert r -> 'pos' @> '{"sure":false,"reason":"direct"}' and r ->> 'delivery' = 'direct', 'a direct delivery is always "CA to check"';
  assert (select items -> 0 ->> 'hsn' = '7214' and (items -> 0 ->> 'hsn_checked')::boolean from public.slip_gst where order_id = o1), 'HSN saved with the slip';
  assert (select dest_state = '06' from public.customers where id = cust), 'where it goes is remembered';
  r := public.api_material_gst(owner, gen_random_uuid(), 'h', mat, '7215', 18, false);
  r := public.api_slip_gst(acct, gen_random_uuid(), 'h', o1, 'ours', '07');
  assert (select items -> 0 ->> 'hsn' = '7214' and dest_state = '07' from public.slip_gst where order_id = o1), 'a later grade change does not alter the slip';
  r := public.api_material_gst(owner, gen_random_uuid(), 'h', mat, '7214', 18, true);

  -- ---------- 4. the Tally bill no. ----------
  o2 := pg_temp.gst_slip(owner, sup, cust, 'PKT/902');
  assert (public.api_tally_pending(acct) -> 'count')::int >= 2, 'both wait for their Tally bill';
  r := public.api_slip_tally(acct, gen_random_uuid(), 'h', o1, 'SRS/26-27/0142', null, false);
  assert (select tally_no = 'SRS/26-27/0142' and tally_date is not null and tally_by = acct from public.slip_gst where order_id = o1), 'kept';
  assert not exists (select 1 from jsonb_array_elements(public.api_tally_pending(acct) -> 'slips') x where (x ->> 'id')::uuid = o1), 'off the pending list';
  perform pg_temp.expect(format($q$select public.api_slip_tally(%L, gen_random_uuid(), 'h', %L, ' srs/26-27/0142 ', null, false)$q$, acct, o2), '23505', 'the same bill on two slips?');
  r := public.api_slip_tally(acct, gen_random_uuid(), 'h', o2, 'SRS/26-27/0142', null, true);
  assert (select tally_no from public.slip_gst where order_id = o2) = 'SRS/26-27/0142', 'saved when confirmed';
  perform pg_temp.expect(format($q$select public.api_slip_gst(%L, gen_random_uuid(), 'h', %L, 'pickup', '07')$q$, acct, o1), '42501', 'the Tally bill is made: only the owner changes it');
  perform pg_temp.expect(format($q$select public.api_slip_tally(%L, gen_random_uuid(), 'h', %L, null, null, false)$q$, acct, o2), '42501', 'only the owner takes it off');
  r := public.api_slip_tally(owner, gen_random_uuid(), 'h', o2, null, null, false);
  assert (select tally_no is null from public.slip_gst where order_id = o2), 'taken off by the owner';

  -- ---------- 5. the month for the CA ----------
  m := public.api_gst_month(acct, current_date - 31, (now() at time zone 'Asia/Kolkata')::date);   -- (the shop's day)
  assert m -> 'shop' ->> 'state' = '07', 'the shop';
  assert (select count(*) from jsonb_array_elements(m -> 'slips') x where (x ->> 'id')::uuid in (o1, o2)) = 2, 'both GST slips';
  assert (select x -> 'gst_details' ->> 'tally_no' from jsonb_array_elements(m -> 'slips') x where (x ->> 'id')::uuid = o1) = 'SRS/26-27/0142', 'with the Tally no.';
  assert (select jsonb_array_length(x -> 'items') = 1 and (x -> 'items' -> 0 ->> 'by_weight')::boolean from jsonb_array_elements(m -> 'slips') x where (x ->> 'id')::uuid = o1), 'and its items';
  assert not exists (select 1 from jsonb_array_elements(m -> 'slips') x join public.orders o on o.id = (x ->> 'id')::uuid where o.bill_type <> 'pakka'), 'no-bill slips never appear';
  assert exists (select 1 from jsonb_array_elements(m -> 'purchases') x where x ->> 'bill_no' = 'PKT/901' and x ->> 'stock_effect' = 'direct'), 'the GST purchase bills';
  perform pg_temp.expect(format($q$select public.api_slip_gst(%L, gen_random_uuid(), 'h', %L, 'pickup', '07')$q$, owner, gen_random_uuid()), '22023', 'only a finished GST slip');
  raise notice '30_gst_tally: all checks passed';
end $$;
