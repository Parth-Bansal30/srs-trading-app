-- @fixtures fixtures business
-- 5 Nov 2026 (plan v2, F7): every bill says what it changes. A bill from before the shop started the app must be given
-- opening stock / already accounted / reference only (nothing pre-chosen). A delivery straight to a customer: the supplier
-- is owed, the stock does not change, and its own slip (weights from the bill, no weighing, no stock) is linked both ways.
-- Cancelling the bill asks about the slip — never cancels it by itself.
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
create function pg_temp.bill(sup uuid, no text, day date, total numeric, eff text) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'bill', 'bill_no', no, 'bill_date', day, 'bill_type', 'pakka', 'supplier', jsonb_build_object('id', sup),
    'gst', 0, 'total', total, 'stock_effect', eff,
    'lines', jsonb_build_array(jsonb_build_object('description', 'MS Round 40', 'hsn', '7214', 'qty_kg', 2000, 'rate', total / 2000, 'amount', total,
      'material_id', 'a1000000-0000-0000-0000-000000000001', 'shape', 'round')))
$$;
create function pg_temp.items(kg numeric) returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('material_id', 'a1000000-0000-0000-0000-000000000001', 'grade_code', 'EN8', 'shape', 'round', 'unit', 'mm',
    'dims', jsonb_build_array('40'), 'sell_rate', 74, 'cut_rate', 0, 'density', 7850, 'special_rate', false, 'by_weight', true, 'kg', kg,
    'lengths', jsonb_build_array(jsonb_build_object('len', '', 'pcs', 1, 'cuts', 0))))
$$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  sup uuid := gen_random_uuid();
  start date; today date := (now() at time zone 'Asia/Kolkata')::date; r jsonb; p1 uuid; p2 uuid; o1 uuid; o2 uuid; it uuid; n int; d jsonb;
begin
  update public.companies set created_at = now() - interval '30 days' where id = co;
  start := ((now() - interval '30 days') at time zone 'Asia/Kolkata')::date;
  update public.people set perms = perms || '{"stock":true,"delete":true}'::jsonb where id = owner;
  insert into public.suppliers (id, company_id, name) values (sup, co, 'P K Steel Traders');

  -- ---------- 1. a bill from before the app: must be told what it is ----------
  perform pg_temp.expect(format($q$select public.api_save_purchase(%L, gen_random_uuid(), 'h', %L::jsonb)$q$, owner, pg_temp.bill(sup, 'OLD-1', start - 250, 100000, null)),
    '22023', 'an old bill with no choice is refused');
  perform pg_temp.expect(format($q$select public.api_save_purchase(%L, gen_random_uuid(), 'h', %L::jsonb)$q$, owner, pg_temp.bill(sup, 'NEW-0', today, 100000, 'opening')),
    '22023', 'opening stock / accounted / reference is only for old bills');
  select count(*) into n from public.stock_moves where company_id = co;
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', pg_temp.bill(sup, 'OLD-1', start - 250, 100000, 'opening'));
  assert (select count(*) from public.stock_moves where company_id = co) = n + 1, 'opening stock: the steel comes into stock';
  assert (select pay_status = 'paid' and stock_effect = 'opening' from public.purchases where id = (r ->> 'purchase_id')::uuid), 'nothing owed for it';
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', pg_temp.bill(sup, 'OLD-2', start - 200, 50000, 'accounted'));
  p1 := (r ->> 'purchase_id')::uuid;
  assert (select count(*) from public.stock_moves where company_id = co) = n + 1, 'already accounted: no stock';
  assert (select stock_item_id is null and material_id is not null and shape = 'round' from public.purchase_lines where purchase_id = p1), 'its lines keep the grade';
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', pg_temp.bill(sup, 'OLD-3', start - 100, 20000, 'reference'));
  assert (select count(*) from public.stock_moves where company_id = co) = n + 1, 'reference only: nothing';
  d := public.api_supplier_data(owner, sup);
  assert jsonb_array_length(d -> 'bills') = 0, 'none of the old bills is owed to the supplier';
  r := public.api_purchase_cancel(owner, gen_random_uuid(), 'h', p1, 'entered by mistake', null);
  assert (select status from public.purchases where id = p1) = 'cancelled', 'a bill without stock can be cancelled';

  -- ---------- 2. straight to a customer: owed, no stock; its own slip, no weighing ----------
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', pg_temp.bill(sup, 'PKT/316', today, 1347560, 'direct'));
  p1 := (r ->> 'purchase_id')::uuid;
  assert (select count(*) from public.stock_moves where company_id = co) = n + 1, 'direct: the stock does not change';
  d := public.api_supplier_data(owner, sup);
  assert (select (x ->> 'total')::numeric from jsonb_array_elements(d -> 'bills') x where (x ->> 'id')::uuid = p1) = 1347560, 'the supplier is owed';
  perform pg_temp.expect(format($q$select public.api_direct_slip(%L, gen_random_uuid(), 'h', %L, %L, '{}', '[{"by_weight":true}]')$q$, owner, p1, cust), '22023', 'each line needs its weight');
  r := public.api_direct_slip(owner, gen_random_uuid(), 'h', p1, cust, '{"min_inch":1}', pg_temp.items(2000));
  o1 := (r ->> 'order_id')::uuid;
  assert (select status = 'weighed' and direct_purchase_id = p1 and weighed_at is not null from public.orders where id = o1), 'the slip is ready to finish, linked to its bill';
  assert (select by_weight and actual_weight = 2000 and stock_item_id is null from public.order_items where order_id = o1), 'sold by the bill''s weight';
  assert not exists (select 1 from public.stock_moves where order_id = o1), 'no stock moves for it';
  assert not exists (select 1 from jsonb_array_elements(public.api_weighing_list(owner)) x where (x ->> 'id')::uuid = o1), 'never in the weighing list';
  perform pg_temp.expect(format($q$select public.api_direct_slip(%L, gen_random_uuid(), 'h', %L, %L, '{}', %L::jsonb)$q$, owner, p1, cust, pg_temp.items(1)), '23505', 'one slip per delivery');
  select id into it from public.order_items where order_id = o1;
  r := public.api_direct_weights(owner, gen_random_uuid(), 'h', o1, jsonb_build_object(it, 1985.5));
  assert (select actual_weight from public.order_items where id = it) = 1985.5 and (select status from public.orders where id = o1) = 'weighed', 'the weight corrected, still ready';
  assert not exists (select 1 from public.stock_moves where order_id = o1), 'still no stock';
  r := public.api_purchase(owner, p1);
  assert (r -> 'direct_order' ->> 'id')::uuid = o1, 'the bill opens its slip';
  assert (r -> 'lines' -> 0 ->> 'code') = 'EN8' and (r -> 'lines' -> 0 ->> 'on_hand') is null, 'the bill''s line shows the grade (no stock)';

  -- ---------- 3. cancelling the bill asks about the slip ----------
  perform pg_temp.expect(format($q$select public.api_purchase_cancel(%L, gen_random_uuid(), 'h', %L, 'wrong supplier', null)$q$, owner, p1), '22023', 'asks first');
  assert (select status from public.purchases where id = p1) = 'saved' and (select status from public.orders where id = o1) = 'weighed', 'nothing changed until answered';
  r := public.api_purchase_cancel(owner, gen_random_uuid(), 'h', p1, 'wrong supplier', 'keep');
  assert (select status from public.purchases where id = p1) = 'cancelled' and (select status from public.orders where id = o1) = 'weighed', 'kept the slip';
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', pg_temp.bill(sup, 'PKT/317', today, 500000, 'direct'));
  p2 := (r ->> 'purchase_id')::uuid;
  o2 := (public.api_direct_slip(owner, gen_random_uuid(), 'h', p2, cust, '{"min_inch":1}', pg_temp.items(800)) ->> 'order_id')::uuid;
  r := public.api_purchase_cancel(owner, gen_random_uuid(), 'h', p2, 'typed twice', 'cancel');
  assert (select status from public.orders where id = o2) = 'cancelled', 'cancelled together when the owner says so';
  -- a normal bill still works as before
  r := public.api_save_purchase(owner, gen_random_uuid(), 'h', pg_temp.bill(sup, 'NEW-1', today, 100000, null));
  assert (select stock_effect = 'stock' from public.purchases where id = (r ->> 'purchase_id')::uuid)
     and (select count(*) from public.stock_moves where company_id = co) = n + 2, 'a normal bill: into stock';
  raise notice '27_direct_and_old_bills: all checks passed';
end $$;
