-- @fixtures fixtures business
-- The backend operations (api_*): what the "api" Edge Function calls after doing the maths.
-- Checks: permissions, companies never mix, retries never happen twice, slip numbers,
-- weighing rules, finishing, payment reversal → khata, cash count by shop date, settings, AI limit.

-- returns the error code a statement fails with, or 'ok'
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

-- A fresh company C with no orders yet (so the starting slip number can be set).
insert into public.companies (id, name) values ('33333333-3333-3333-3333-333333333333', 'Test Company C');
insert into public.company_settings (company_id) values ('33333333-3333-3333-3333-333333333333');
insert into public.people (id, company_id, display_name, role, perms, active) values
  ('ccccccc1-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'Owner C', 'owner',
   '{"new":true,"orders":true,"weigh":true,"khata":true,"today":true,"rates":true,"people":true,"settings":true,"money":true,"kacha":true}', true),
  ('ccccccc2-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'Weigher C', 'weigher', '{"weigh":true,"orders":true}', true),
  ('ccccccc3-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'Sales C (no kacha)', 'custom', '{"new":true,"orders":true,"money":true}', true);

do $$
declare
  owner uuid := 'ccccccc1-0000-0000-0000-000000000000';
  weigher uuid := 'ccccccc2-0000-0000-0000-000000000000';
  sales uuid := 'ccccccc3-0000-0000-0000-000000000000';
  r jsonb; r2 jsonb; mat_a uuid; mat_b uuid; cust uuid; o1 uuid; o2 uuid; o3 uuid; items jsonb; ids uuid[];
  k1 uuid := gen_random_uuid(); pay uuid; n int; today text;
begin
  -- ---------- materials, customers, rates ----------
  -- (rates set earlier in the day are inserted directly; two rate changes can't share one moment)
  r := public.api_create_material(owner, gen_random_uuid(), 'h', ' en31 ', 'alloy', 110, 5);
  assert r ->> 'code' = 'EN31', 'material code is cleaned up (trimmed, capitals)';
  assert (select sell_rate from public.current_material_rates where material_id = (r ->> 'material_id')::uuid) = 110, 'new material has its rate';
  perform pg_temp.expect(format($q$select public.api_create_material(%L, gen_random_uuid(), 'h', 'EN31', 'alloy', 1, 1)$q$, owner), '23505',
    'the same grade twice');
  perform pg_temp.expect(format($q$select public.api_create_material(%L, gen_random_uuid(), 'h', 'X', 'carbon', 1, 1)$q$, weigher), '42501',
    'weigher adding a material');
  insert into public.materials (id, company_id, code, family) values
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'EN8', 'carbon'),
    (gen_random_uuid(), '33333333-3333-3333-3333-333333333333', 'EN24', 'alloy');
  select id into mat_a from public.materials where company_id = '33333333-3333-3333-3333-333333333333' and code = 'EN8';
  select id into mat_b from public.materials where company_id = '33333333-3333-3333-3333-333333333333' and code = 'EN24';
  insert into public.material_rates (company_id, material_id, sell_rate, cut_rate, effective_from) values
    ('33333333-3333-3333-3333-333333333333', mat_a, 75, 3, now() - interval '1 day'),
    ('33333333-3333-3333-3333-333333333333', mat_b, 95, 4, now() - interval '1 day');
  r := public.api_create_customer(owner, gen_random_uuid(), 'h', ' Gupta Tools ', '98100 00001', null);
  cust := (r ->> 'id')::uuid;
  assert r ->> 'name' = 'Gupta Tools', 'customer name trimmed';
  insert into public.customer_rates (company_id, customer_id, material_id, rate, effective_from)
    values ('33333333-3333-3333-3333-333333333333', cust, mat_b, 90, now() - interval '1 day');
  r := public.api_change_material_rate(owner, gen_random_uuid(), 'h', mat_a, 78, 3, 'market up');
  perform pg_temp.expect(format($q$select public.api_change_material_rate(%L, gen_random_uuid(), 'h', %L, 1, 1, null)$q$, sales, mat_a), '42501',
    'sales changing a rate');
  perform pg_temp.expect(format($q$select public.api_change_material_rate(%L, gen_random_uuid(), 'h', 'a1000000-0000-0000-0000-000000000001', 1, 1, null)$q$, owner), '22023',
    'changing another company''s rate');
  r := public.api_set_customer_rate(owner, gen_random_uuid(), 'h', cust, mat_a, 76);
  r := public.api_set_customer_rate(owner, gen_random_uuid(), 'h', cust, mat_b, null);
  r := public.api_pricing_context(owner, cust, array[mat_a, mat_b]);
  assert (select (m ->> 'sell_rate')::numeric from jsonb_array_elements(r -> 'materials') m where m ->> 'code' = 'EN8') = 78, 'latest rate used';
  assert (select (m ->> 'special_rate')::numeric from jsonb_array_elements(r -> 'materials') m where m ->> 'code' = 'EN8') = 76, 'customer special rate shown';
  assert (select m -> 'special_rate' from jsonb_array_elements(r -> 'materials') m where m ->> 'code' = 'EN24') = 'null'::jsonb, 'special rate removed';
  assert r ->> 'timezone' = 'Asia/Kolkata', 'shop time zone passed to the maths';
  perform pg_temp.expect(format($q$select public.api_pricing_context(%L, 'a2000000-0000-0000-0000-000000000001', array[]::uuid[])$q$, owner), '22023',
    'pricing for another company''s customer');
  r := public.api_update_customer(owner, gen_random_uuid(), 'h', cust, '{"phone": "", "notes": "pays monthly"}');
  assert r -> 'phone' = 'null'::jsonb and r ->> 'notes' = 'pays monthly', 'customer edited';

  -- ---------- starting slip number (continue from the paper slip book) ----------
  r := public.api_change_settings(owner, gen_random_uuid(), 'h', '{"first_slip_no": 501}');
  assert (r ->> 'first_slip_no')::int = 501, 'first slip number saved';
  perform pg_temp.expect(format($q$select public.api_change_settings(%L, gen_random_uuid(), 'h', '{"first_slip_no": 5}')$q$,
    'aaaaaaa1-0000-0000-0000-000000000000'), '23514', 'first slip number once orders exist (company A)');
  perform pg_temp.expect(format($q$select public.api_change_settings(%L, gen_random_uuid(), 'h', '{"colour": "red"}')$q$, owner), '22023',
    'unknown setting');
  perform pg_temp.expect(format($q$select public.api_change_settings(%L, gen_random_uuid(), 'h', '{"gst_pct": 5}')$q$, sales), '42501',
    'sales changing settings');

  -- ---------- create orders ----------
  items := jsonb_build_array(
    jsonb_build_object('material_id', mat_a, 'grade_code', 'EN8', 'shape', 'round', 'unit', 'mm', 'dims', jsonb_build_array('32'),
      'sell_rate', 76, 'cut_rate', 3, 'density', 7850, 'special_rate', true, 'lengths', jsonb_build_array(jsonb_build_object('len', '300', 'pcs', 12))),
    jsonb_build_object('material_id', mat_a, 'grade_code', 'EN8', 'shape', 'square', 'unit', 'mm', 'dims', jsonb_build_array('50'),
      'sell_rate', 76, 'cut_rate', 3, 'density', 7850, 'lengths', jsonb_build_array(jsonb_build_object('len', '200', 'pcs', 4), jsonb_build_object('len', '150', 'pcs', 2))),
    jsonb_build_object('material_id', mat_b, 'grade_code', 'EN24', 'shape', 'flat', 'unit', 'in', 'dims', jsonb_build_array('2 1/2', '1'),
      'sell_rate', 95, 'cut_rate', 4, 'density', 7850, 'lengths', jsonb_build_array(jsonb_build_object('len', '10', 'pcs', 5))));
  r := public.api_create_order(owner, k1, 'hash-1', cust, '{"min_inch":1}', items, true, '{"amount": 500, "mode": "Cash"}');
  o1 := (r ->> 'order_id')::uuid;
  assert (r ->> 'internal_no')::int = 501 and r ->> 'slip_no' = '501', 'first slip continues from 501: ' || r::text;
  assert r ->> 'status' = 'accepted', 'accepted straight away';
  assert (select count(*) from public.order_items where order_id = o1) = 3, '3 items saved';
  assert (select count(*) from public.order_item_lengths l join public.order_items i on i.id = l.order_item_id where i.order_id = o1) = 4, '4 lengths saved';
  assert (select dims from public.order_items where order_id = o1 and position = 2) = '{"2 1/2",1}', 'sizes kept exactly as typed';
  assert (public.api_order_context(owner, o1) -> 'paid' ->> 'advance')::numeric = 500, 'advance taken with the order';

  -- retry of the SAME request (e.g. network dropped): same answer, nothing created twice
  r2 := public.api_create_order(owner, k1, 'hash-1', cust, '{"min_inch":1}', items, true, '{"amount": 500, "mode": "Cash"}');
  assert r2 ->> 'order_id' = r ->> 'order_id' and (r2 ->> 'replayed')::boolean, 'retry returns the first answer';
  assert (select count(*) from public.orders where company_id = '33333333-3333-3333-3333-333333333333') = 1, 'retry did not make a second order';
  assert (select count(*) from public.payments where order_id = o1) = 1, 'retry did not take the advance twice';
  perform pg_temp.expect(format($q$select public.api_create_order(%L, %L, 'hash-DIFFERENT', %L, '{}', %L, false)$q$, owner, k1, cust, items), '23505',
    'same request key reused for a different request');
  -- the key is per company: company A may use the same key value
  perform pg_temp.expect(format($q$select public.api_create_order('aaaaaaa1-0000-0000-0000-000000000000', %L, 'x', 'a2000000-0000-0000-0000-000000000001', '{}', %L, false)$q$,
    k1, replace(replace(items::text, mat_a::text, 'a1000000-0000-0000-0000-000000000001'), mat_b::text, 'a1000000-0000-0000-0000-000000000002')), 'ok',
    'another company using the same request key');

  r := public.api_create_order(owner, gen_random_uuid(), 'h', cust, '{"min_inch":1}', items, false);
  o2 := (r ->> 'order_id')::uuid;
  assert r ->> 'slip_no' = '502' and r ->> 'status' = 'estimate', 'second slip 502, estimate';
  perform pg_temp.expect(format($q$select public.api_change_settings(%L, gen_random_uuid(), 'h', '{"first_slip_no": 900}')$q$, owner), '23514',
    'first slip number after orders exist');

  -- daily numbering: the date tag in the shop's time zone, counting from 1; internal number carries on
  perform public.api_change_settings(owner, gen_random_uuid(), 'h', '{"slip_numbering": "daily"}');
  r := public.api_create_order(owner, gen_random_uuid(), 'h', cust, '{"min_inch":1}', items, false);
  o3 := (r ->> 'order_id')::uuid;
  assert r ->> 'slip_no' = app.slip_label('daily', now(), 'Asia/Kolkata', 1) and (r ->> 'internal_no')::int = 503, 'daily slip: ' || r::text;
  assert (select slip_period from public.orders where id = o3) = app.slip_counter_key('daily', now(), 'Asia/Kolkata'), 'slip remembers its period';
  perform public.api_change_settings(owner, gen_random_uuid(), 'h', '{"slip_numbering": "never"}');

  -- who may create
  perform pg_temp.expect(format($q$select public.api_create_order(%L, gen_random_uuid(), 'h', %L, '{}', %L, false)$q$, weigher, cust, items), '42501',
    'weigher creating an order');
  perform pg_temp.expect(format($q$select public.api_create_order('aaaaaaa5-0000-0000-0000-000000000000', gen_random_uuid(), 'h', 'a2000000-0000-0000-0000-000000000001', '{}', '[]', false)$q$),
    '42501', 'deactivated person creating an order');
  perform pg_temp.expect(format($q$select public.api_create_order('bbbbbbb1-0000-0000-0000-000000000000', gen_random_uuid(), 'h', %L, '{}', %L, false)$q$, cust, items),
    '23503', 'company B creating an order for company C''s customer');
  perform pg_temp.expect(format($q$select public.api_create_order(%L, gen_random_uuid(), 'h', %L, '{}', '[]', false)$q$, owner, cust), '22023',
    'order with no items');
  perform pg_temp.expect(format($q$select public.api_create_order(%L, gen_random_uuid(), 'h', %L, '{}', '[{"material_id":%s,"grade_code":"EN8","shape":"round","unit":"mm","dims":["32"],"sell_rate":1,"cut_rate":1,"density":7850,"lengths":[]}]', false)$q$,
    owner, cust, to_jsonb(mat_a)::text), '22023', 'item with no lengths');

  -- ---------- edit / accept ----------
  r := public.api_update_order(owner, gen_random_uuid(), 'h', o2, cust, jsonb_build_array(items -> 0));
  assert (select count(*) from public.order_items where order_id = o2) = 1, 'estimate edited: items replaced';
  perform pg_temp.expect(format($q$select public.api_update_order(%L, gen_random_uuid(), 'h', %L, %L, %L)$q$, owner, o1, cust, items), '23001',
    'editing an accepted order');
  perform pg_temp.expect(format($q$select public.api_accept_order(%L, gen_random_uuid(), 'h', %L)$q$, owner, o1), '23001', 'accepting twice');
  r := public.api_accept_order(owner, gen_random_uuid(), 'h', o2, null);
  assert r ->> 'status' = 'accepted', 'estimate accepted';
  perform pg_temp.expect(format($q$select public.api_add_advance(%L, gen_random_uuid(), 'h', %L, 100, 'UPI', null)$q$, weigher, o2), '42501',
    'weigher taking an advance');
  perform pg_temp.expect(format($q$select public.api_add_advance(%L, gen_random_uuid(), 'h', %L, 0, 'UPI', null)$q$, owner, o2), '22023', 'advance of 0');

  -- ---------- weighing ----------
  r := public.api_weighing_list(weigher, null);
  assert jsonb_array_length(r) = 2, 'weigher sees the 2 accepted orders';
  assert r::text !~ '(sell_rate|cut_rate|amount|special_rate|paid)', 'weighing list has NO rates or money';
  perform pg_temp.expect(format($q$select public.api_weighing_list(%L)$q$, sales), '42501', 'sales opening the weighing list');
  perform pg_temp.expect(format($q$select public.api_order_context(%L, %L)$q$, weigher, o1), '42501', 'weigher reading amounts');
  select array_agg(id order by position) into ids from public.order_items where order_id = o1;
  perform pg_temp.expect(format($q$select public.api_record_weights(%L, gen_random_uuid(), 'h', %L, '[]', %L, false)$q$, weigher, o1,
    jsonb_build_array(jsonb_build_object('total_weight', 40, 'parts', jsonb_build_array(jsonb_build_object('item_id', ids[1], 'weight', 20), jsonb_build_object('item_id', ids[3], 'weight', 20))))),
    '22023', 'weighing different grades together');
  perform pg_temp.expect(format($q$select public.api_record_weights(%L, gen_random_uuid(), 'h', %L, '[]', %L, false)$q$, weigher, o1,
    jsonb_build_array(jsonb_build_object('total_weight', 40, 'parts', jsonb_build_array(jsonb_build_object('item_id', ids[1], 'weight', 20), jsonb_build_object('item_id', ids[2], 'weight', 19.99))))),
    '22023', 'a split that does not add up to the scale reading');
  perform pg_temp.expect(format($q$select public.api_record_weights(%L, gen_random_uuid(), 'h', %L, '[]', %L, false)$q$, weigher, o1,
    jsonb_build_array(jsonb_build_object('total_weight', 20, 'parts', jsonb_build_array(jsonb_build_object('item_id', ids[1], 'weight', 20))))),
    '22023', 'weigh-together with one item');
  perform pg_temp.expect(format($q$select public.api_record_weights(%L, gen_random_uuid(), 'h', %L, '[{"item_id":"a4000000-0000-0000-0000-000000000004","weight":5}]', '[]', false)$q$, weigher, o1),
    '22023', 'weighing an item from another slip');
  perform pg_temp.expect(format($q$select public.api_record_weights(%L, gen_random_uuid(), 'h', %L, %L, '[]', true)$q$, weigher, o1,
    jsonb_build_array(jsonb_build_object('item_id', ids[3], 'weight', 17.4))), '23514', 'marking weighed with items missing');
  r := public.api_record_weights(weigher, gen_random_uuid(), 'h', o1, jsonb_build_array(jsonb_build_object('item_id', ids[3], 'weight', 17.4)),
    jsonb_build_array(jsonb_build_object('total_weight', 41.25, 'parts', jsonb_build_array(
      jsonb_build_object('item_id', ids[1], 'weight', 22.73), jsonb_build_object('item_id', ids[2], 'weight', 18.52)))), true);
  assert r ->> 'status' = 'weighed', 'weighed';
  assert (select count(distinct weigh_batch_id) from public.order_items where order_id = o1 and weigh_batch_id is not null) = 1, 'batch recorded once';
  assert (select total_weight from public.weigh_batches where order_id = o1) = 41.25, 'the one scale reading is kept';
  perform pg_temp.expect(format($q$select public.api_record_weights(%L, gen_random_uuid(), 'h', %L, %L, '[]', false)$q$, weigher, o1,
    jsonb_build_array(jsonb_build_object('item_id', ids[3], 'weight', 1))), '23001', 'changing weights after weighed');

  -- ---------- finishing ----------
  -- totals as @srs/core worked them out (made-up but consistent numbers)
  r := jsonb_build_object('bill', 'pakka', 'gst_pct', 18, 'kacha_pct', 10, 'pay_mode', 'now', 'paid_now', 798, 'pay_method', 'Cash', 'in_khata', false,
    'basis', jsonb_build_object('advance', 500, 'weights', jsonb_build_object(ids[1], 22.73, ids[2], 18.52, ids[3], 17.4)),
    'totals', jsonb_build_object('weight', 58.65, 'base', 1100, 'material', 1000, 'cutting', 100, 'gst', 198, 'total', 1298));
  perform pg_temp.expect(format($q$select public.api_finalize_order(%L, gen_random_uuid(), 'h', %L, %L)$q$, owner, o1,
    jsonb_set(r, '{basis,advance}', '400')), '40001', 'finishing with an out-of-date advance');
  perform pg_temp.expect(format($q$select public.api_finalize_order(%L, gen_random_uuid(), 'h', %L, %L)$q$, owner, o1,
    jsonb_set(r, '{basis,weights}', jsonb_build_object(ids[1], 22.73, ids[2], 18.52, ids[3], 17.5))), '40001', 'finishing with out-of-date weights');
  perform pg_temp.expect(format($q$select public.api_finalize_order(%L, gen_random_uuid(), 'h', %L, %L)$q$, owner, o1,
    jsonb_set(r, '{gst_pct}', '12')), '40001', 'finishing with an old GST %');
  perform pg_temp.expect(format($q$select public.api_finalize_order(%L, gen_random_uuid(), 'h', %L, %L)$q$, owner, o1,
    jsonb_set(r, '{in_khata}', 'true')), '22023', 'khata flag that does not match the payment');
  perform pg_temp.expect(format($q$select public.api_finalize_order(%L, gen_random_uuid(), 'h', %L, %L)$q$, sales, o1,
    jsonb_set(r, '{bill}', '"kacha"')), '42501', 'kacha bill by someone without kacha permission');
  perform pg_temp.expect(format($q$select public.api_finalize_order(%L, gen_random_uuid(), 'h', %L, %L)$q$, owner, o2, r), '23001',
    'finishing an order that is not weighed');
  perform pg_temp.expect(format($q$select public.api_finalize_order('bbbbbbb1-0000-0000-0000-000000000000', gen_random_uuid(), 'h', %L, %L)$q$, o1, r), '22023',
    'company B finishing company C''s order');
  r2 := public.api_finalize_order(owner, gen_random_uuid(), 'h', o1, r);
  assert r2 ->> 'status' = 'done' and not (r2 ->> 'in_khata')::boolean, 'finished, fully paid: ' || r2::text;
  assert (r2 -> 'paid' ->> 'total')::numeric = 1298, 'advance + pickup = bill';
  assert (select total_amount from public.orders where id = o1) = 1298, 'bill total saved';

  -- ---------- cancelling a payment ----------
  select id into pay from public.payments where order_id = o1 and kind = 'pickup';
  perform pg_temp.expect(format($q$select public.api_reverse_payment(%L, gen_random_uuid(), 'h', %L, '  ')$q$, owner, pay), '22023', 'cancelling without a reason');
  perform pg_temp.expect(format($q$select public.api_reverse_payment(%L, gen_random_uuid(), 'h', %L, 'x')$q$, sales, pay), '42501', 'sales cancelling a payment');
  r := public.api_reverse_payment(owner, gen_random_uuid(), 'h', pay, 'UPI failed, customer will pay later');
  assert (r ->> 'amount')::numeric = -798, 'exact opposite entry';
  assert (select in_khata from public.orders where id = o1), 'finished slip moved into the khata';
  assert (public.api_order_context(owner, o1) -> 'paid' ->> 'pickup')::numeric = 0, 'pickup counted as cancelled';
  perform pg_temp.expect(format($q$select public.api_reverse_payment(%L, gen_random_uuid(), 'h', %L, 'again')$q$, owner, pay), '23505', 'cancelling the same payment twice');

  -- ---------- khata payments ----------
  perform pg_temp.expect(format($q$select public.api_record_payment('aaaaaaa4-0000-0000-0000-000000000000', gen_random_uuid(), 'h', 'a2000000-0000-0000-0000-000000000002', 100, 'Cash', 'kacha', null)$q$),
    '42501', 'accounts (no kacha) taking a kacha payment');
  perform pg_temp.expect(format($q$select public.api_record_payment(%L, gen_random_uuid(), 'h', %L, -5, 'Cash', 'pakka', null)$q$, owner, cust), '22023', 'negative payment');
  perform pg_temp.expect(format($q$select public.api_record_payment(%L, gen_random_uuid(), 'h', %L, 5, 'Gold', 'pakka', null)$q$, owner, cust), '23514', 'unknown payment mode');
  r := public.api_record_payment(owner, gen_random_uuid(), 'h', cust, 798, 'UPI', 'pakka', 'Paytm');
  assert r ? 'payment_id', 'khata payment saved';

  -- ---------- cash count: filed under the shop's date, expected = today's cash ----------
  r := public.api_save_cash_count(owner, gen_random_uuid(), 'h', 480, 'short 20');
  today := to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD');
  assert r ->> 'business_date' = today, 'filed under the shop''s date';
  assert (r ->> 'expected')::numeric = 500, 'expected cash = 500 advance + 798 pickup − 798 cancelled: ' || r::text;
  assert (r ->> 'difference')::numeric = -20, 'difference shown';
  perform pg_temp.expect(format($q$select public.api_save_cash_count(%L, gen_random_uuid(), 'h', 1, null)$q$, weigher), '42501', 'weigher saving the cash count');

  -- ---------- Ask Claude daily limit ----------
  perform public.api_change_settings(owner, gen_random_uuid(), 'h', '{"ai_daily_limit": 2}');
  assert public.api_ai_take(weigher) and public.api_ai_take(owner) and not public.api_ai_take(owner), 'third question over the limit refused';
  r := public.api_ai_context(owner);
  assert r -> 'stock' @> '[{"code":"EN8"}]' and r ->> 'lang' is not null, 'AI gets the stock list and language';

  -- ---------- company details ----------
  r := public.api_change_settings(owner, gen_random_uuid(), 'h', '{"company": {"name": "Test Company C Pvt", "gstin": "07aaaaa1111a1z1"}}');
  assert (select gstin from public.companies where id = '33333333-3333-3333-3333-333333333333') = '07AAAAA1111A1Z1', 'GSTIN saved in capitals';

  -- ---------- nothing from company C leaked into A or B ----------
  assert (select count(*) from public.orders where company_id <> '33333333-3333-3333-3333-333333333333' and customer_id = cust) = 0, 'no mixing';
end $$;

-- ---------- slip labels in the shop's time zone (same rules as @srs/core) ----------
do $$
begin
  -- 21 Sep 19:00 UTC = 22 Sep 00:30 in India
  assert app.slip_label('daily', '2026-09-21 19:00+00', 'Asia/Kolkata', 1) = '22Sep-1', 'daily after Indian midnight';
  assert app.slip_label('daily', '2026-09-21 18:00+00', 'Asia/Kolkata', 7) = '21Sep-7', 'daily before Indian midnight';
  assert app.slip_label('monthly', '2026-09-30 19:00+00', 'Asia/Kolkata', 3) = 'Oct26-3', 'monthly rolls over at Indian midnight';
  assert app.slip_label('yearly', '2026-03-31 18:00+00', 'Asia/Kolkata', 9) = 'FY25-26-9', 'still last financial year (31 Mar 23:30)';
  assert app.slip_label('yearly', '2026-03-31 19:00+00', 'Asia/Kolkata', 1) = 'FY26-27-1', 'new financial year (1 Apr 00:30)';
  assert app.slip_label('never', now(), 'Asia/Kolkata', 1042) = '1042', 'continuous';
  assert app.slip_counter_key('yearly', '2027-01-15 10:00+00', 'Asia/Kolkata') = 'yearly:2026-2027', 'FY counter key';
  assert app.slip_counter_key('daily', '2026-09-21 19:00+00', 'Asia/Kolkata') = 'daily:2026-09-22', 'daily counter key';
  -- the same daily label a year later is a different period, so it is allowed
  assert app.slip_counter_key('daily', '2027-09-21 19:00+00', 'Asia/Kolkata') <> app.slip_counter_key('daily', '2026-09-21 19:00+00', 'Asia/Kolkata'),
    'next year''s 22Sep is a new period';
end $$;
insert into public.orders (company_id, internal_no, slip_no, slip_scheme, slip_period, customer_id)
  values ('11111111-1111-1111-1111-111111111111', 7001, '22Sep-1', 'daily', 'daily:2026-09-22', 'a2000000-0000-0000-0000-000000000001'),
         ('11111111-1111-1111-1111-111111111111', 7002, '22Sep-1', 'daily', 'daily:2027-09-22', 'a2000000-0000-0000-0000-000000000001');
select pg_temp.expect($q$insert into public.orders (company_id, internal_no, slip_no, slip_scheme, slip_period, customer_id)
  values ('11111111-1111-1111-1111-111111111111', 7003, '22Sep-1', 'daily', 'daily:2026-09-22', 'a2000000-0000-0000-0000-000000000001')$q$,
  '23505', 'the same slip number twice in one day');
select pg_temp.expect($q$update public.orders set slip_period = 'daily:2030-01-01' where internal_no = 7001$q$, '23001', 'moving a slip to another period');
