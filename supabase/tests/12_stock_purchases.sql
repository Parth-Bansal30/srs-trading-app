-- @fixtures fixtures business
-- Purchases and stock (30 Sept 2026): stock item = grade + shape + HSN + rate; bills can't be saved twice;
-- stock goes down when a slip is weighed and comes back when it is deleted; counts, closing, cancelling a bill.
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
  sales uuid := 'aaaaaaa3-0000-0000-0000-000000000000';
  en8 uuid := 'a1000000-0000-0000-0000-000000000001';
  en24 uuid := 'a1000000-0000-0000-0000-000000000002';
  o4 uuid := 'a3000000-0000-0000-0000-000000000004';     -- accepted, EN24 round 80 mm, 500 advance
  it4 uuid := 'a4000000-0000-0000-0000-000000000004';
  bill jsonb; r jsonb; s75 uuid; s78 uuid; s8 uuid; sup uuid; p1 uuid; p2 uuid; n int; kg numeric;
begin
  assert (app.role_preset('owner') ->> 'stock')::boolean and not (app.role_preset('sales') ? 'stock'), 'owners have "stock"';
  update public.people set perms = perms || '{"stock":true,"delete":true}'::jsonb where id = owner;

  -- ---------- 1. a bill with two lines of the same grade + HSN at different rates ----------
  bill := jsonb_build_object('kind', 'bill', 'bill_no', '0412', 'bill_date', (now() at time zone 'Asia/Kolkata')::date, 'bill_type', 'pakka',
    'supplier', jsonb_build_object('name', 'Jalandhar Alloys', 'gstin', '03AAKFR5521L1Z4', 'city', 'Jalandhar'),
    'freight', 0, 'gst', 57510, 'total', 377010, 'pay_status', 'to_pay',
    'lines', jsonb_build_array(
      jsonb_build_object('description', 'Alloy Steel Round Bars', 'hsn', '722830', 'qty_kg', 2000, 'rate', 75, 'amount', 150000, 'material_id', en24, 'shape', 'round', 'desc_key', 'ALLOY STEEL ROUND BARS'),
      jsonb_build_object('description', 'Alloy Steel Round Bars', 'hsn', '722830', 'qty_kg', 1500, 'rate', 78, 'amount', 117000, 'material_id', en24, 'shape', 'round'),
      jsonb_build_object('description', 'MS Round Bars', 'hsn', '7214 99', 'qty_kg', 1000, 'rate', 52.5, 'amount', 52500, 'material_id', en8, 'shape', 'round')));
  perform pg_temp.expect(format($q$select public.api_save_purchase(%L, gen_random_uuid(), 'h', %L::jsonb)$q$, sales, bill), '42501', 'sales cannot enter bills');
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', bill);
  p1 := (r ->> 'purchase_id')::uuid; sup := (r ->> 'supplier_id')::uuid;
  assert jsonb_array_length(r -> 'lines') = 3 and not exists (select 1 from jsonb_array_elements(r -> 'lines') x where not (x ->> 'new')::boolean), 'three new stock items';
  select id into s75 from public.stock_items where company_id = co and material_id = en24 and rate = 75;
  select id into s78 from public.stock_items where company_id = co and material_id = en24 and rate = 78;
  select id into s8 from public.stock_items where company_id = co and material_id = en8;
  assert s75 <> s78, 'same grade + HSN but another rate → separate stock';
  assert (select hsn from public.stock_items where id = s8) = '721499', 'HSN saved as digits';
  assert app.stock_on_hand(s75) = 2000 and app.stock_on_hand(s78) = 1500 and app.stock_on_hand(s8) = 1000, 'stock in';
  assert (select total_kg = 4500 and items_amount = 319500 and total_amount = 377010 from public.purchases where id = p1), 'bill totals saved';
  assert exists (select 1 from private.purchase_names where company_id = co and desc_key = 'ALLOY STEEL ROUND BARS' and material_id = en24), 'name remembered';
  perform pg_temp.expect(format($q$select public.api_save_purchase(%L, gen_random_uuid(), 'h', %L::jsonb)$q$, owner, bill), '23505', 'same bill twice');
  perform pg_temp.expect(format($q$select public.api_save_purchase(%L, gen_random_uuid(), 'h', %L::jsonb)$q$, owner,
    jsonb_set(jsonb_set(bill, '{bill_type}', '"kacha"'), '{bill_no}', '"K-1"')), '23514', 'a bill without GST can''t have GST');

  -- ---------- 2. same grade + shape + HSN + rate from another bill → added to that stock ----------
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'bill', 'bill_no', '0413', 'bill_date', '2026-09-01', 'bill_type', 'pakka',
    'supplier', jsonb_build_object('id', sup), 'freight', 1000, 'gst', 6930, 'total', 45430,
    'lines', jsonb_build_array(jsonb_build_object('description', 'Alloy Steel Round Bars', 'hsn', '722830', 'qty_kg', 500, 'rate', 75, 'amount', 37500,
      'freight_share', 2, 'material_id', en24, 'shape', 'round'))));
  p2 := (r ->> 'purchase_id')::uuid;
  assert not (r -> 'lines' -> 0 ->> 'new')::boolean and (r -> 'lines' -> 0 ->> 'stock_item_id')::uuid = s75, 'added to the ₹75 stock';
  assert app.stock_on_hand(s75) = 2500, '2,000 + 500';
  assert (select cost from public.stock_items where id = s75) = 75.4, 'average cost with freight: (2000×75 + 500×77) / 2500';

  -- ---------- 3. who sees what ----------
  r := public.api_stock_data(weigher);
  assert not (r ->> 'can_cost')::boolean, 'weigher: no buying rates';
  assert (select bool_and(x -> 'rate' = 'null'::jsonb) from jsonb_array_elements(r -> 'items') x), 'rates hidden from the weigher';
  assert (select (x ->> 'on_hand')::numeric from jsonb_array_elements(r -> 'items') x where (x ->> 'id')::uuid = s75) = 2500, 'weigher sees kg';
  assert (select (x ->> 'rate')::numeric from jsonb_array_elements(public.api_stock_data(owner) -> 'items') x where (x ->> 'id')::uuid = s78) = 78, 'owner sees rates';
  perform pg_temp.expect(format($q$select public.api_purchases(%L, 10)$q$, weigher), '42501', 'only "stock" people see bills');

  -- ---------- 4. selling from a stock: off when weighed, back when the slip is deleted ----------
  perform pg_temp.expect(format($q$select public.api_set_item_stock(%L, gen_random_uuid(), 'h', %L, %L)$q$, owner, it4, s8), '23514', 'EN8 stock for an EN24 item');
  r := public.api_set_item_stock(weigher, gen_random_uuid(), 'h', it4, s75);
  assert (select stock_item_id from public.order_items where id = it4) = s75, 'the weigher picked the ₹75 stock';
  assert exists (select 1 from jsonb_array_elements(public.api_stock_data(owner) -> 'booked') b where (b ->> 'stock_item_id')::uuid = s75), 'shown as booked';
  r := public.api_record_weights(weigher, gen_random_uuid(), 'h', o4, jsonb_build_array(jsonb_build_object('item_id', it4, 'weight', 50)), '[]'::jsonb, true);
  assert app.stock_on_hand(s75) = 2450, 'weighed: 50 kg off';
  assert exists (select 1 from public.stock_moves where order_item_id = it4 and kind = 'sale' and qty_kg = -50), 'sale move linked to the item';
  perform pg_temp.expect(format($q$select public.api_set_item_stock(%L, gen_random_uuid(), 'h', %L, %L)$q$, owner, it4, s78), '23001', 'stock fixed once weighed');
  r := public.api_stock_item(owner, s75);
  assert jsonb_array_length(r -> 'moves') = 3 and r -> 'moves' -> 0 ->> 'kind' = 'sale' and r -> 'moves' -> 0 ->> 'slip_no' = '1044', 'history with the slip';
  assert (public.api_delete_check(owner, array[o4]) -> 'orders' -> 0 ->> 'stock_back_kg')::numeric = 50, 'delete says 50 kg go back';
  r := public.api_delete_orders(owner, gen_random_uuid(), 'h', array[o4], 'Test entry', 'credit', null);
  assert app.stock_on_hand(s75) = 2500, 'deleted: 50 kg back';
  assert exists (select 1 from public.stock_moves where order_item_id = it4 and kind = 'sale_undo' and qty_kg = 50 and note = 'Slip deleted'), 'undo move';

  -- ---------- 5. evening summary ----------
  r := public.api_day_stock(owner, null);
  assert (r #>> '{bought,n}')::int = 1 and (r #>> '{bought,kg}')::numeric = 4500, 'bought today (the 0413 bill is dated yesterday)';
  assert (r ->> 'sold_kg')::numeric = 0, 'sold and given back today';
  assert (select (g ->> 'kg')::numeric from jsonb_array_elements(r -> 'groups') g where g ->> 'code' = 'EN24') = 4000, 'EN24 round on hand';
  assert (public.api_day_stock(sales, null) #>> '{bought,amount}') is null, 'amounts only with "stock"';

  -- ---------- 6. cancelling a bill, counts, closing ----------
  r := public.api_purchase(owner, p2);
  assert (r ->> 'can_cancel')::boolean, 'all its stock is still there';
  r := public.api_purchase_cancel(owner, gen_random_uuid(), 'h', p2, 'Typed twice');
  assert app.stock_on_hand(s75) = 2000 and (select status from public.purchases where id = p2) = 'cancelled', 'bill cancelled, stock off';
  perform pg_temp.expect(format($q$select public.api_purchase_cancel(%L, gen_random_uuid(), 'h', %L, 'x')$q$, owner, p2), '23001', 'once only');
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'bill', 'bill_no', '0413', 'bill_date', '2026-09-01', 'bill_type', 'pakka',
    'supplier', jsonb_build_object('id', sup), 'freight', 0, 'gst', 6750, 'total', 44250,
    'lines', jsonb_build_array(jsonb_build_object('description', 'Alloy Steel Round Bars', 'hsn', '722830', 'qty_kg', 500, 'rate', 75, 'amount', 37500, 'material_id', en24, 'shape', 'round'))));
  assert r ->> 'purchase_id' is not null, 'a cancelled bill can be entered again';
  r := public.api_stock_count(owner, gen_random_uuid(), 'h', s8, 400, false, 'Counted on the rack');
  assert (r ->> 'diff')::numeric = -600 and app.stock_on_hand(s8) = 400, 'count: 600 kg less than the app said';
  assert not (public.api_purchase(owner, p1) ->> 'can_cancel')::boolean, 'part of bill 0412 is gone → can''t cancel';
  perform pg_temp.expect(format($q$select public.api_purchase_cancel(%L, gen_random_uuid(), 'h', %L, 'x')$q$, owner, p1), '23001', 'refused');
  r := public.api_stock_count(owner, gen_random_uuid(), 'h', s78, 1490, true, null);
  assert (select closed from public.stock_items where id = s78) and app.stock_on_hand(s78) = 1490, 'closed with what is left';
  assert exists (select 1 from public.stock_moves where stock_item_id = s78 and kind = 'scrap' and qty_kg = -10), '10 kg written off';
  perform pg_temp.expect(format($q$select public.api_stock_count(%L, gen_random_uuid(), 'h', %L, 1, false, 'x')$q$, weigher, s8), '42501', 'only owners correct stock');
  perform pg_temp.expect(format($q$update public.stock_moves set qty_kg = 1 where stock_item_id = %L$q$, s8), '23001', 'stock moves never change');
  r := public.api_set_low_stock(owner, gen_random_uuid(), 'h', en24, 3000);
  assert (select (g ->> 'low_kg')::numeric from jsonb_array_elements(public.api_day_stock(owner, null) -> 'groups') g where g ->> 'code' = 'EN24') = 3000, 'low-stock level';
end $$;
