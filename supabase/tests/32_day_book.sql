-- @fixtures fixtures business
-- 7 Nov 2026 (plan v2, step 11): the Day book gathers what is in the app — finished slips with what their steel cost,
-- money that really came in (not cancelled, not moved inside the khata), money out, bills bought, what is still to pay,
-- sales per day, the stock as on a day. No-bill figures only for people who may see them.
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
  sup uuid := gen_random_uuid(); o1 uuid; d jsonb; s jsonb; today date := (now() at time zone 'Asia/Kolkata')::date; drawer uuid; p uuid;
begin
  update public.people set perms = perms || '{"stock":true,"expenses":true,"kacha":true}'::jsonb where id = owner;
  update public.people set perms = perms || '{"money":true,"khata":true,"orders":true,"kacha":false,"stock":false,"expenses":false}'::jsonb where id = acct;
  update public.companies set created_at = now() - interval '30 days' where id = co;
  update public.company_settings set gst_pct = 18 where company_id = co;
  insert into public.suppliers (id, company_id, name, credit_days) values (sup, co, 'P K Steel Traders', 30);
  select id into drawer from public.money_accounts where company_id = co and is_drawer;

  o1 := pg_temp.gst_slip(owner, sup, cust, 'PKT/951');
  p := (public.api_record_payment(owner, gen_random_uuid(), 'h', cust, 5000, 'Cash', 'pakka', 'part') ->> 'payment_id')::uuid;
  perform public.api_record_payment(owner, gen_random_uuid(), 'h', cust, 700, 'Cash', 'kacha', 'kacha money');
  d := public.api_day_book(owner, today - 2, today, today - 31, today - 3);
  s := (select x from jsonb_array_elements(d -> 'slips') x where (x ->> 'id')::uuid = o1);
  assert s is not null and (s ->> 'total')::numeric = 87320 and (s ->> 'direct')::boolean, 'the finished slip is a sale';
  assert (s ->> 'cost')::numeric = 70000, 'a direct delivery costs what its bill cost (before GST)';
  assert (s -> 'items' -> 0 ->> 'g') = 'EN8', 'with its steel';
  assert exists (select 1 from jsonb_array_elements(d -> 'money_in') x where (x ->> 'amount')::numeric = 5000 and x ->> 'mode' = 'Cash'), 'cash came in';
  assert exists (select 1 from jsonb_array_elements(d -> 'bought') x where x ->> 'bill_no' = 'PKT/951' and (x ->> 'left')::numeric = 70000
                 and (x ->> 'due')::date = (x ->> 'date')::date + 30), 'the bill bought, still to pay, due in 30 days';
  assert (d -> 'to_pay' ->> 'amount')::numeric >= 70000, 'still to pay suppliers';
  assert d -> 'prev' ? 'total', 'the period before, to compare';
  perform public.api_reverse_payment(owner, gen_random_uuid(), 'h', p, 'typed twice');
  d := public.api_day_book(owner, today - 1, today, null, null);
  assert not exists (select 1 from jsonb_array_elements(d -> 'money_in') x where (x ->> 'amount')::numeric = 5000), 'a cancelled payment is not money in';
  -- without the no-bill permission: no kacha money, no bought / money out without those permissions
  d := public.api_day_book(acct, today - 1, today, null, null);
  assert not exists (select 1 from jsonb_array_elements(d -> 'money_in') x where (x ->> 'amount')::numeric = 700), 'no-bill money is hidden';
  assert d -> 'bought' = 'null'::jsonb and d -> 'money_out' = 'null'::jsonb, 'bought / money out need their permissions';
  assert not exists (select 1 from jsonb_array_elements(d -> 'slips') x where x -> 'cost' <> 'null'::jsonb), 'what the steel cost needs the stock permission';
  assert not exists (select 1 from jsonb_array_elements(public.api_stock_on(acct, today, today - 30)) x where x -> 'cost' <> 'null'::jsonb),
    'stock costs need the stock permission';
  assert pg_temp.err(format($q$select public.api_day_book(%L, %L, %L, null, null)$q$, owner, today, today - 1)) = '22023', 'the days must make sense';
  s := public.api_sales_days(owner, today - 1, today);
  assert exists (select 1 from jsonb_array_elements(s) x where (x ->> 'total')::numeric >= 87320), 'sales per day';
  assert jsonb_typeof(public.api_stock_on(owner, today, today - 30)) = 'array', 'stock as on a day';
  raise notice '32_day_book: all checks passed';
end $$;
