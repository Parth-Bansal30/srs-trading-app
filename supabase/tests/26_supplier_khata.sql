-- @fixtures fixtures business
-- 5 Nov 2026 (plan v2, F6): the supplier khata. Payments are set against bills as the person says (oldest first only
-- when just ticked); the rest is an advance. A bill's "paid" is kept right by the database. Credit notes (a return takes
-- the steel out of stock), opening balances, credit days. The old Paid tick = paid outside the app; a payment can be
-- linked to such a bill without lowering the due twice. Cancelling a payment opens its bills again (F1).
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
create function pg_temp.bill(sup uuid, no text, day date, total numeric, typ text default 'pakka', paid text default 'to_pay', kg numeric default 1000) returns uuid language sql as $$
  select (public.api_save_purchase('aaaaaaa1-0000-0000-0000-000000000000', gen_random_uuid(), 'h', jsonb_build_object('kind', 'bill', 'bill_no', no, 'bill_date', day,
    'bill_type', typ, 'supplier', jsonb_build_object('id', sup), 'gst', 0, 'total', total, 'pay_status', paid,
    'lines', jsonb_build_array(jsonb_build_object('description', 'MS Round', 'hsn', '7214', 'qty_kg', kg, 'rate', round(total / kg, 3), 'amount', total,
      'material_id', 'a1000000-0000-0000-0000-000000000001', 'shape', 'round')))) ->> 'purchase_id')::uuid
$$;
create function pg_temp.pay(sup uuid, amt numeric, acc uuid, p jsonb default '{}') returns uuid language sql as $$
  select (public.api_save_expense('aaaaaaa1-0000-0000-0000-000000000000', gen_random_uuid(), 'h',
    jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'amount', amt, 'account_id', acc) || p) ->> 'expense_id')::uuid
$$;
-- what the khata says we owe (opening + bills − payments − notes), as @srs/core works it out
create function pg_temp.due(who uuid, sup uuid) returns numeric language plpgsql as $$
declare d jsonb := public.api_supplier_data(who, sup);
begin
  return coalesce((select sum(case when x ->> 'direction' = 'owe' then 1 else -1 end * (x ->> 'amount')::numeric) from jsonb_array_elements(d -> 'openings') x), 0)
    + coalesce((select sum((x ->> 'total')::numeric) from jsonb_array_elements(d -> 'bills') x where x ->> 'settled' is null), 0)
    - coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(d -> 'payments') x), 0)
    - coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(d -> 'notes') x), 0);
end $$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  sales uuid := 'aaaaaaa3-0000-0000-0000-000000000000';
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  s1 uuid := gen_random_uuid(); s2 uuid := gen_random_uuid(); s3 uuid := gen_random_uuid();
  bank uuid; drawer uuid; b1 uuid; b2 uuid; b3 uuid; b4 uuid; e1 uuid; e2 uuid; e3 uuid; r jsonb; op uuid; item uuid; nid uuid; d jsonb; n int;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  update public.companies set created_at = now() - interval '60 days' where id = co;
  update public.people set perms = perms || '{"stock":true,"delete":true,"expenses":true}'::jsonb where id = owner;
  update public.people set perms = perms || '{"stock":true}'::jsonb where id = sales;   -- stock, no kacha, not the owner
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  bank := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"HDFC current","kind":"bank"}') ->> 'id')::uuid;
  insert into public.suppliers (id, company_id, name) values (s1, co, 'Mehta Bright Steel'), (s2, co, 'Gupta Iron Store'), (s3, co, 'P K Steel Traders');

  -- ---------- 1. part paid; credit days ----------
  r := public.api_supplier_settings(owner, gen_random_uuid(), 'h', s1, 30);
  assert (select credit_days = 30 from public.suppliers where id = s1), 'credit days saved';
  b1 := pg_temp.bill(s1, 'SBM/1184', today - 7, 125670);
  assert (select pay_status = 'to_pay' from public.purchases where id = b1), 'a new bill is to pay';
  e1 := pg_temp.pay(s1, 80000, bank, jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchase_id', b1, 'amount', 80000))));
  assert app.purchase_left(b1) = 45670 and (select pay_status = 'to_pay' from public.purchases where id = b1), '₹45,670 still to pay';
  assert pg_temp.due(owner, s1) = 45670, 'the due';
  e2 := pg_temp.pay(s1, 45670, drawer, jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchase_id', b1, 'amount', 45670))));
  assert (select pay_status = 'paid' and paid_at is not null from public.purchases where id = b1), 'paid when nothing is left';

  -- ---------- 2. the person's split counts; just ticking = oldest first ----------
  b2 := pg_temp.bill(s2, 'G-1', today - 30, 60000);
  b3 := pg_temp.bill(s2, 'G-2', today - 10, 82400);
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', '{"kind":"supplier","supplier_id":"%s","amount":100000,"account_id":"%s","allocations":[{"purchase_id":"%s","amount":100000}]}')$q$,
    owner, s2, bank, b3), '22023', 'more than the newer bill owes is refused');
  e1 := pg_temp.pay(s2, 100000, bank, jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchase_id', b3, 'amount', 82400))));
  assert (select pay_status from public.purchases where id = b3) = 'paid' and app.purchase_left(b2) = 60000, 'the newer bill paid as the owner chose';
  assert pg_temp.due(owner, s2) = 60000 + 82400 - 100000, 'the rest is an advance (the due goes down by the whole payment)';
  r := public.api_cancel_expense(owner, gen_random_uuid(), 'h', e1, 'typed wrong');
  assert (select pay_status from public.purchases where id = b3) = 'to_pay' and app.purchase_left(b3) = 82400, 'cancelling the payment opens its bill again (F1)';
  e1 := pg_temp.pay(s2, 100000, bank, jsonb_build_object('purchase_ids', jsonb_build_array(b3, b2)));
  assert app.purchase_left(b2) = 0 and app.purchase_left(b3) = 42400, 'ticked only: oldest first (₹60,000 + ₹40,000)';
  assert (select purchase_ids @> array[b2, b3] from public.expenses where id = e1), 'the bills are kept on the payment';
  -- set again: the old split is undone (kept), the new one counts
  r := public.api_supplier_allocate(owner, gen_random_uuid(), 'h', e1, jsonb_build_array(jsonb_build_object('purchase_id', b3, 'amount', 82400)));
  assert (r ->> 'advance')::numeric = 17600 and app.purchase_left(b2) = 60000 and app.purchase_left(b3) = 0, 'set again';
  assert (select count(*) from public.supplier_allocations where expense_id = e1 and status = 'undone') = 2, 'the old split is kept, undone';
  -- a corrected payment: its bills follow the new entry
  e2 := (public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'supplier', 'supplier_id', s2, 'amount', 100000, 'account_id', bank,
          'replaces_id', e1, 'note', 'UTR added', 'allocations', jsonb_build_array(jsonb_build_object('purchase_id', b3, 'amount', 82400)))) ->> 'expense_id')::uuid;
  assert app.purchase_left(b3) = 0 and (select status from public.expenses where id = e1) = 'cancelled', 'changed: the new entry pays the bill';

  -- ---------- 3. an advance before any bill ----------
  e3 := pg_temp.pay(s3, 50000, bank);
  assert pg_temp.due(owner, s3) = -50000, 'money with the supplier';
  b4 := pg_temp.bill(s3, 'PK-9', today, 82400);
  assert pg_temp.due(owner, s3) = 32400, 'the next bill: ₹32,400 due';

  -- ---------- 4. a return: credit note + the steel out of stock; cancelled = back ----------
  select pl.stock_item_id into item from public.purchase_lines pl where pl.purchase_id = b4;
  perform pg_temp.expect(format($q$select public.api_supplier_note(%L, gen_random_uuid(), 'h', '{"supplier_id":"%s","kind":"return","amount":14200}')$q$, owner, s3),
    '22023', 'a return needs the steel and kg');
  r := public.api_supplier_note(owner, gen_random_uuid(), 'h', jsonb_build_object('supplier_id', s3, 'kind', 'return', 'purchase_id', b4, 'amount', 14200,
    'note_no', 'CN-14', 'lines', jsonb_build_array(jsonb_build_object('stock_item_id', item, 'kg', 200))));
  nid := (r ->> 'note_id')::uuid;
  assert pg_temp.due(owner, s3) = 32400 - 14200 and app.purchase_left(b4) = 82400 - 14200, 'the due and the bill go down by ₹14,200';
  assert exists (select 1 from public.stock_moves where kind = 'return_out' and qty_kg = -200 and stock_item_id = item), 'the stock goes down by 200 kg';
  perform pg_temp.expect(format($q$select public.api_supplier_note(%L, gen_random_uuid(), 'h', '{"supplier_id":"%s","kind":"return","amount":10,"lines":[{"stock_item_id":"%s","kg":999999}]}')$q$,
    owner, s3, item), '23514', 'cannot send back more than is in stock');
  r := public.api_supplier_note_cancel(owner, gen_random_uuid(), 'h', nid, 'note was wrong');
  assert pg_temp.due(owner, s3) = 32400 and exists (select 1 from public.stock_moves where kind = 'return_undo' and qty_kg = 200 and stock_item_id = item), 'cancelled: due and stock back';
  r := public.api_supplier_note(owner, gen_random_uuid(), 'h', jsonb_build_object('supplier_id', s3, 'kind', 'rate', 'amount', 1500, 'note', 'rate difference'));
  assert pg_temp.due(owner, s3) = 30900, 'a rate difference note without a bill';

  -- ---------- 5. opening balance (owner): cleared by payments first ----------
  perform pg_temp.expect(format($q$select public.api_supplier_opening(%L, gen_random_uuid(), 'h', '{"supplier_id":"%s","amount":240000}')$q$, sales, s1), '42501', 'opening = owner only');
  op := (public.api_supplier_opening(owner, gen_random_uuid(), 'h', jsonb_build_object('supplier_id', s1, 'amount', 240000, 'direction', 'owe')) ->> 'opening_id')::uuid;
  assert pg_temp.due(owner, s1) = 240000, 'the opening is in the due';
  e3 := pg_temp.pay(s1, 100000, bank, jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('opening_id', op, 'amount', 100000))));
  assert app.opening_left(op) = 140000, 'paid against the opening';
  -- changed later: the payment moves to the new opening
  op := (public.api_supplier_opening(owner, gen_random_uuid(), 'h', jsonb_build_object('supplier_id', s1, 'amount', 250000, 'direction', 'owe', 'note', 'old diary checked')) ->> 'opening_id')::uuid;
  assert app.opening_left(op) = 150000 and pg_temp.due(owner, s1) = 150000, 'a changed opening keeps its payment';
  assert (select count(*) from public.supplier_notes where supplier_id = s1 and kind = 'opening' and status = 'cancelled') = 1, 'the old one is kept, cancelled';

  -- ---------- 6. the old Paid tick: paid outside the app; a payment linked to it moves nothing twice ----------
  b1 := pg_temp.bill(s3, 'PKT/316', today - 200, 1347560, 'pakka', 'paid');
  assert (select settled = 'outside' and pay_status = 'paid' from public.purchases where id = b1), 'saved as paid = paid outside the app';
  assert pg_temp.due(owner, s3) = 30900, 'out of the due';
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', '{"kind":"supplier","supplier_id":"%s","amount":1347560,"account_id":"%s","allocations":[{"purchase_id":"%s","amount":1347560}]}')$q$,
    owner, s3, bank, b1), '22023', 'not set against it by mistake');
  e1 := pg_temp.pay(s3, 1347560, bank, jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchase_id', b1, 'amount', 1347560, 'outside', true))));
  assert (select settled is null and pay_status = 'paid' from public.purchases where id = b1), 'linked: the mark is off, the bill is paid by this payment';
  assert pg_temp.due(owner, s3) = 30900, 'the due did not move';
  -- the tick can't be put on a bill with payments set against it
  perform pg_temp.expect(format($q$select public.api_purchase_paid(%L, gen_random_uuid(), 'h', %L, true)$q$, owner, b4), 'ok', 'a bill with nothing set against it can be marked');
  r := public.api_purchase_paid(owner, gen_random_uuid(), 'h', b4, false);
  b2 := pg_temp.bill(s2, 'G-3', today, 1000);
  e3 := pg_temp.pay(s2, 400, bank, jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchase_id', b2, 'amount', 400))));
  perform pg_temp.expect(format($q$select public.api_purchase_paid(%L, gen_random_uuid(), 'h', %L, true)$q$, owner, b2), '23001', 'part paid: record the rest as a payment');

  -- ---------- 7. kacha bills only for kacha people ----------
  b3 := pg_temp.bill(s2, 'K-1', today, 5000, 'kacha');
  e3 := pg_temp.pay(s2, 7000, drawer, jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchase_id', b3, 'amount', 5000))));
  d := public.api_supplier_data(sales, s2);
  assert not exists (select 1 from jsonb_array_elements(d -> 'bills') x where x ->> 'side' = 'kacha'), 'no kacha bill';
  assert (select (x ->> 'amount')::numeric from jsonb_array_elements(d -> 'payments') x where (x ->> 'id')::uuid = e3) = 2000, 'only the part not set against kacha bills';
  assert not exists (select 1 from jsonb_array_elements(d -> 'allocations') x where (x ->> 'purchase_id')::uuid = b3), 'no kacha allocation';
  perform pg_temp.expect(format($q$select public.api_supplier_allocate(%L, gen_random_uuid(), 'h', %L, '[]')$q$, sales, e3), '42501', 'a kacha split is the owner''s');

  -- ---------- 8. saved offline: a split that no longer fits is cut, and the owner is told ----------
  b4 := pg_temp.bill(s1, 'SBM/2001', today, 10000);
  e3 := pg_temp.pay(s1, 15000, drawer, jsonb_build_object('offline', true, 'allocations', jsonb_build_array(jsonb_build_object('purchase_id', b4, 'amount', 12000))));
  assert app.purchase_left(b4) = 0 and exists (select 1 from public.review_items where kind = 'supplier_check' and ref_id = e3), 'cut to the bill, a To check card';

  -- ---------- 9. a bill cancelled: what was paid on it is money with the supplier again ----------
  b1 := pg_temp.bill(s1, 'SBM/2002', today, 3000);
  e3 := pg_temp.pay(s1, 3000, drawer, jsonb_build_object('allocations', jsonb_build_array(jsonb_build_object('purchase_id', b1, 'amount', 3000))));
  r := public.api_purchase_cancel(owner, gen_random_uuid(), 'h', b1, 'entered twice');
  assert (select status from public.supplier_allocations where purchase_id = b1) = 'undone', 'its split is undone';
  assert pg_temp.due(owner, s1) = 150000 - 3000 + 10000 - 15000 + 0, 'the payment now lowers the due as an advance';

  -- ---------- 10. the old ticks after the conversion (made like before the migration) ----------
  assert exists (select 1 from pg_tables where schemaname = 'private' and tablename = 'f6_pay_status_before'), 'the ticks before are kept for the undo';
  perform pg_temp.expect(format($q$select public.api_supplier_data(%L, null)$q$, 'aaaaaaa2-0000-0000-0000-000000000000'), '42501', 'the weigher: no supplier khata');
  raise notice '26_supplier_khata: all checks passed';
end $$;
