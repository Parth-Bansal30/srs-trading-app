-- @fixtures fixtures business
-- 22 Nov 2026: the CA's file matched with Tally (made-up data). The Tally bill's total is kept and a difference shows;
-- the date defaults to the slip's day; staff can't swap a Tally no. once set; deleting a GST slip that has a Tally bill
-- keeps it on its month, raises an important Review card and goes to the CA until the bill is cancelled or a credit note
-- is made; the GST bills list; the month carries GST expenses, supplier credit notes, the supplier's GST status, old
-- GST slips without a Tally bill, and when the file was sent.
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
/** A direct-delivery GST slip of 1,000 kg × ₹74 (₹87,320 with GST), finished on the khata. */
create function pg_temp.gst_slip(owner uuid, sup uuid, cust uuid, no text) returns uuid language plpgsql as $$
declare p uuid; o uuid; it uuid;
begin
  p := (public.api_save_purchase(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'bill', 'bill_no', no, 'bill_date', current_date, 'bill_type', 'pakka',
    'supplier', jsonb_build_object('id', sup), 'gst', 12600, 'total', 82600, 'stock_effect', 'direct',
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
  sup uuid := gen_random_uuid(); bank uuid; o1 uuid; o2 uuid; o3 uuid; r jsonb; m jsonb; b jsonb; today date; card public.review_items;
begin
  update public.people set perms = perms || '{"stock":true,"expenses":true,"delete":true}'::jsonb where id = owner;
  update public.people set perms = perms || '{"money":true,"khata":true}'::jsonb where id = acct;
  update public.companies set gstin = '07AABCS1429B1ZW', created_at = now() - interval '400 days' where id = co;
  update public.company_settings set gst_pct = 18 where company_id = co;
  insert into public.suppliers (id, company_id, name, gstin, gst_status) values (sup, co, 'P K Steel Traders', '06AABCS1429B1ZY', 'cancelled');
  today := (now() at time zone 'Asia/Kolkata')::date;

  -- ---------- 1. the Tally bill's total, the date, who may change it ----------
  o1 := pg_temp.gst_slip(owner, sup, cust, 'PKT/951');
  o2 := pg_temp.gst_slip(owner, sup, cust, 'PKT/952');
  r := public.api_slip_tally(acct, gen_random_uuid(), 'h', o1, 'SRS/26-27/0131', null, false, 87320);
  assert (r ->> 'differs')::boolean = false, 'the same total';
  assert (select tally_date = (o.done_at at time zone 'Asia/Kolkata')::date and tally_total = 87320
          from public.slip_gst g join public.orders o on o.id = g.order_id where g.order_id = o1), 'the date is the slip''s day; the total kept';
  r := public.api_slip_tally(acct, gen_random_uuid(), 'h', o1, 'SRS/26-27/0131', null, false, 87500);
  assert (r ->> 'differs')::boolean, 'a different Tally total shows at once';
  perform pg_temp.expect(format($q$select public.api_slip_tally(%L, gen_random_uuid(), 'h', %L, 'SRS/26-27/0139', null, false, null)$q$, acct, o1), '42501',
    'staff can''t swap a Tally no. once set');
  r := public.api_slip_tally(owner, gen_random_uuid(), 'h', o1, 'SRS/26-27/0131', null, false, 87320);
  assert (public.api_slip_gst_get(acct, o1) ->> 'tally_total')::numeric = 87320, 'the slip page shows the Tally total';
  r := public.api_slip_tally(acct, gen_random_uuid(), 'h', o2, 'SRS/26-27/0133', current_date, false, null);
  perform pg_temp.expect(format($q$select public.api_slip_tally(%L, gen_random_uuid(), 'h', %L, 'SRS/26-27/0131', null, false, -5)$q$, owner, o2), '22023', 'a total below zero');

  -- ---------- 2. the GST bills list ----------
  b := public.api_gst_bills(acct, today - 31, today);
  assert (select (x ->> 'tally_total')::numeric = 87320 and x ->> 'tally_no' = 'SRS/26-27/0131' and x ->> 'status' = 'done'
          from jsonb_array_elements(b -> 'bills') x where (x ->> 'id')::uuid = o1), 'the bill with its Tally no. and total';
  assert b -> 'last_tally' ->> 'no' = 'SRS/26-27/0133', 'the last Tally no. typed (to suggest the next)';
  assert (b ->> 'waiting_before')::int >= 0, 'older ones still waiting';
  perform pg_temp.expect(format($q$select public.api_gst_bills(%L, current_date, current_date - 1)$q$, acct), '22023', 'the days must make sense');

  -- ---------- 3. deleting a GST slip that has a Tally bill ----------
  r := public.api_delete_check(owner, array[o1]);
  assert r -> 'orders' -> 0 ->> 'tally_no' = 'SRS/26-27/0131', 'the delete sheet sees the Tally bill';
  r := public.api_delete_orders(owner, gen_random_uuid(), 'h', array[o1], 'Customer returned the steel', 'none', null);
  select * into card from public.review_items where company_id = co and kind = 'tally_cancel' and ref_id = o1;
  assert card.id is not null and card.level = 'important' and card.status = 'open' and card.data ->> 'tally_no' = 'SRS/26-27/0131', 'an important card for the owner';
  o3 := pg_temp.gst_slip(owner, sup, cust, 'PKT/953');
  r := public.api_delete_orders(owner, gen_random_uuid(), 'h', array[o3], 'Typed twice', 'none', null);
  assert not exists (select 1 from public.review_items where kind = 'tally_cancel' and ref_id = o3), 'no Tally bill: no card';

  m := public.api_gst_month(acct, today - 31, today);
  assert exists (select 1 from jsonb_array_elements(m -> 'slips') x where (x ->> 'id')::uuid = o1 and x ->> 'status' = 'deleted' and x ->> 'deleted_on' is not null),
    'kept on its month, marked deleted';
  assert not exists (select 1 from jsonb_array_elements(m -> 'slips') x where (x ->> 'id')::uuid = o3), 'deleted without a Tally bill: gone, as in Tally';
  assert (select count(*) from jsonb_array_elements(m -> 'cancelled') x where (x ->> 'id')::uuid = o1 and x ->> 'tally_no' = 'SRS/26-27/0131') = 1, 'listed for the CA';
  b := public.api_gst_bills(acct, today - 31, today);
  assert exists (select 1 from jsonb_array_elements(b -> 'bills') x where (x ->> 'id')::uuid = o1 and x ->> 'status' = 'deleted'), 'and in the GST bills list';
  perform pg_temp.expect(format($q$select public.api_slip_tally(%L, gen_random_uuid(), 'h', %L, 'SRS/26-27/0131', null, true, null)$q$, owner, o1), '22023',
    'a deleted slip gets no new Tally no.');
  perform pg_temp.expect(format($q$select public.api_slip_tally(%L, gen_random_uuid(), 'h', %L, ' srs/26-27/0131 ', null, false, null)$q$, owner, o2), '23505',
    'a deleted slip''s Tally no. still counts as used');

  -- ---------- 4. what the CA did in Tally ----------
  perform pg_temp.expect(format($q$select public.api_tally_cancel(%L, gen_random_uuid(), 'h', %L, 'credit_note', null, null)$q$, acct, o1), '22023', 'a credit note needs its no.');
  perform pg_temp.expect(format($q$select public.api_tally_cancel(%L, gen_random_uuid(), 'h', %L, 'bill_cancelled', null, null)$q$, acct, o2), '22023', 'only a deleted slip');
  perform pg_temp.expect(format($q$select public.api_tally_cancel(%L, gen_random_uuid(), 'h', %L, 'other', null, null)$q$, acct, o1), '22023', 'cancelled or credit note');
  r := public.api_tally_cancel(acct, gen_random_uuid(), 'h', o1, 'credit_note', 'CN/26-27/004', null);
  assert (select cancel_how = 'credit_note' and cn_no = 'CN/26-27/004' and cn_date is not null and cn_by = acct from public.slip_gst where order_id = o1), 'the credit note kept';
  assert (select status = 'done' and answer like 'Credit note CN/26-27/004%' from public.review_items where id = card.id), 'the card is closed';
  r := public.api_tally_cancel(owner, gen_random_uuid(), 'h', o1, 'bill_cancelled', 'ignored', null);
  assert (select cancel_how = 'bill_cancelled' and cn_no is null and cn_date is null from public.slip_gst where order_id = o1), 'changed: the bill was cancelled instead';

  -- ---------- 5. the rest of the month: expenses, credit notes, supplier status, sent ----------
  bank := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"SBI current","kind":"bank"}') ->> 'id')::uuid;
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('category', 'blade', 'amount', 4720, 'account_id', bank, 'gst_bill', true,
         'gst_amount', 720, 'bill_no', 'B-77', 'seller_gstin', '07aaacr5055k1z9', 'paid_to', 'Blade dealer'));
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('category', 'tea', 'amount', 50, 'account_id', bank));
  r := public.api_supplier_note(owner, gen_random_uuid(), 'h', jsonb_build_object('supplier_id', sup, 'kind', 'rate', 'amount', 1180, 'note_no', 'PK-CN-1',
         'purchase_id', (select direct_purchase_id from public.orders where id = o2)));
  r := public.api_ca_sent(acct, gen_random_uuid(), 'h', to_char(today, 'YYYY-MM'), 'share', 2, 174640);
  perform pg_temp.expect(format($q$select public.api_ca_sent(%L, gen_random_uuid(), 'h', '2026-13', 'share', 1, 1)$q$, acct), '22023', 'a real month');
  m := public.api_gst_month(owner, date_trunc('month', today)::date, today);   -- (the month, as the phone asks)
  assert (select count(*) from jsonb_array_elements(m -> 'expenses') x where x ->> 'bill_no' = 'B-77' and (x ->> 'gst_amount')::numeric = 720) = 1, 'the GST expense bill';
  assert not exists (select 1 from jsonb_array_elements(m -> 'expenses') x where x ->> 'category' = 'tea'), 'no GST bill: not for the CA';
  assert exists (select 1 from jsonb_array_elements(m -> 'supplier_notes') x where x ->> 'note_no' = 'PK-CN-1' and (x -> 'bill' ->> 'gst')::numeric = 12600), 'the credit note with its bill';
  assert exists (select 1 from jsonb_array_elements(m -> 'purchases') x where x ->> 'bill_no' = 'PKT/952' and x ->> 'gst_status' = 'cancelled'), 'the supplier''s GST status';
  assert m -> 'unpaid180' is not null and jsonb_typeof(m -> 'unpaid180') = 'array', 'unpaid 180 days (none here)';
  assert m -> 'sent' -> 0 ->> 'how' = 'share' and (m -> 'sent' -> 0 ->> 'slips')::int = 2, 'last sent';
  m := public.api_gst_month(acct, today - 31, today);
  assert m -> 'expenses' = 'null'::jsonb or m -> 'expenses' is null, 'expenses only for people who may see them';
  assert (select count(*) from jsonb_array_elements(public.api_gst_month(acct, today + 40, today + 60) -> 'pending_before') x
          where (x ->> 'id')::uuid = o2) = 0, 'a slip with a Tally no. is not pending';
  raise notice '35_ca_file_v2: all checks passed';
end $$;
