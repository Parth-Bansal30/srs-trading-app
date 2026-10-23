-- @fixtures fixtures business
-- Money out and the cash book (23 Oct 2026): shop expenses (who may enter which kind, cancel / change,
-- never edited), paying a supplier marks his bills, money moved between accounts, the drawer as a cash
-- book (opening + in − out, cash taken home at closing), passbook balances, the evening's money out.
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
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  ownerb uuid := 'bbbbbbb1-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  drawer uuid; sbi uuid; ptm uuid; home uuid; sup uuid; bill1 uuid; bill2 uuid; e1 uuid; e2 uuid; e3 uuid; t1 uuid; r jsonb; cb jsonb;
  v_in numeric; v_out numeric; v_exp numeric; today date := (now() at time zone 'Asia/Kolkata')::date; n int;
begin
  -- ---------- 1. the permission ----------
  assert app.valid_perms('{"expenses":true}'), 'expenses is a permission';
  assert (app.role_preset('owner') ->> 'expenses')::boolean and (app.role_preset('accounts') ->> 'expenses')::boolean, 'owner and accounts get it';
  assert not (app.role_preset('sales') ? 'expenses') and not (app.role_preset('weigher') ? 'expenses'), 'sales and weighing do not';
  update public.people set perms = perms || '{"expenses":true,"stock":true}'::jsonb where id = owner;
  update public.people set perms = perms || '{"expenses":true}'::jsonb where id = acct;

  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  sbi := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"SBI current","kind":"bank"}') ->> 'id')::uuid;
  ptm := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"Papa Paytm","kind":"paytm","owner":"personal","staff_can":false}') ->> 'id')::uuid;
  perform pg_temp.expect(format($q$select public.api_save_account(%L, gen_random_uuid(), 'h', '{"name":"Locker","kind":"safe"}')$q$, owner), 'ok', 'cash kept at home / locker is a kind of account');
  assert app.part_mode('safe', null) = 'Cash', 'cash at home is Cash';

  -- ---------- 2. who may enter which expense ----------
  r := public.api_save_expense(acct, gen_random_uuid(), 'h', jsonb_build_object('category', 'tea', 'amount', 120, 'account_id', drawer, 'paid_to', 'Chai wala'));
  e1 := (r ->> 'expense_id')::uuid;
  assert (select kind = 'expense' and category = 'tea' and amount = 120 and business_date = today and created_by = acct and status = 'ok' from public.expenses where id = e1), 'accounts person enters tea';
  assert (r ->> 'mode') = 'Cash', 'from the drawer = Cash';
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, sales, jsonb_build_object('category', 'tea', 'amount', 10, 'account_id', drawer)), '42501', 'sales has no expenses permission');
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, weigher, jsonb_build_object('category', 'tea', 'amount', 10, 'account_id', drawer)), '42501', 'nor the weigher');
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('kind', 'owner', 'amount', 10, 'account_id', drawer)), '42501', 'owner''s own money: owners only');
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('category', 'tea', 'amount', 10, 'account_id', ptm)), '22023', 'owners-only account');
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('category', 'tea', 'amount', 0, 'account_id', drawer)), '22023', 'an amount');
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('category', 'Bad Key', 'amount', 10, 'account_id', drawer)), '23514', 'category keys only');
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('category', 'tea', 'amount', 10, 'account_id', drawer, 'at', now() + interval '1 day')), '22023', 'not in the future');
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('category', 'tea', 'amount', 10, 'account_id', drawer, 'at', now() - interval '5 days')), '22023', 'staff: only a few days back');
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('category', 'rent', 'amount', 25000, 'account_id', sbi, 'method', 'NEFT', 'at', now() - interval '20 days'));
  assert (select business_date = ((now() - interval '20 days') at time zone 'Asia/Kolkata')::date and method = 'NEFT' from public.expenses where id = (r ->> 'expense_id')::uuid), 'owner: a past day; NEFT kept for a bank';
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('category', 'tea', 'amount', 10, 'account_id', drawer, 'method', 'NEFT'));
  assert (select method is null from public.expenses where id = (r ->> 'expense_id')::uuid), 'no NEFT from the cash drawer';
  -- a GST bill (the CA may claim the GST)
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('category', 'blade', 'amount', 4720, 'account_id', sbi, 'gst_bill', true,
         'gst_amount', 720, 'bill_no', 'B-77', 'seller_gstin', '07aaacr5055k1z9', 'paid_to', 'Bahco dealer'));
  e2 := (r ->> 'expense_id')::uuid;
  assert (select gst_bill and gst_amount = 720 and seller_gstin = '07AAACR5055K1Z9' and bill_no = 'B-77' from public.expenses where id = e2), 'GST bill details';
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, owner, jsonb_build_object('category', 'blade', 'amount', 100, 'account_id', sbi, 'gst_bill', true, 'gst_amount', 100)), '22023', 'GST is less than the amount');
  perform pg_temp.expect(format($q$insert into public.expenses (company_id, category, amount, account_id, business_date, gst_amount) values (%L, 'tea', 5, %L, current_date, 1)$q$, co, drawer), '23514', 'no GST without a GST bill');
  -- a retry gives the first answer
  r := public.api_save_expense(acct, '00000000-0000-4000-8000-0000000000e1', 'h', jsonb_build_object('category', 'labour', 'amount', 800, 'account_id', drawer));
  assert (public.api_save_expense(acct, '00000000-0000-4000-8000-0000000000e1', 'h', jsonb_build_object('category', 'labour', 'amount', 800, 'account_id', drawer)) ->> 'expense_id') = (r ->> 'expense_id'), 'same key = same expense';
  e3 := (r ->> 'expense_id')::uuid;
  assert (select count(*) from public.expenses where company_id = co and category = 'labour') = 1, 'saved once';

  -- ---------- 3. never edited: cancel, or change (= cancel + corrected entry) ----------
  perform pg_temp.expect(format($q$update public.expenses set amount = 1 where id = %L$q$, e1), '23001', 'amount never changes');
  perform pg_temp.expect(format($q$delete from public.expenses where id = %L$q$, e1), '23001', 'never deleted');
  r := public.api_save_expense(acct, gen_random_uuid(), 'h', jsonb_build_object('category', 'tea', 'amount', 150, 'account_id', drawer, 'replaces_id', e1));
  assert (select status = 'cancelled' and cancel_reason = 'Changed' from public.expenses where id = e1), 'the old one is cancelled';
  assert (select replaces_id = e1 and amount = 150 from public.expenses where id = (r ->> 'expense_id')::uuid), 'the new one says what it corrects';
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('category', 'tea', 'amount', 160, 'account_id', drawer, 'replaces_id', e1)), '23001', 'changed only once');
  perform pg_temp.expect(format($q$select public.api_cancel_expense(%L, gen_random_uuid(), 'h', %L, 'mine?')$q$, acct, e2), '42501', 'staff can''t cancel the owner''s expense');
  perform pg_temp.expect(format($q$select public.api_cancel_expense(%L, gen_random_uuid(), 'h', %L, ' ')$q$, acct, e3), '22023', 'a reason');
  perform public.api_cancel_expense(acct, gen_random_uuid(), 'h', e3, 'entered by mistake');
  assert (select status = 'cancelled' and cancelled_by = acct and cancel_reason = 'entered by mistake' from public.expenses where id = e3), 'cancelled by its maker the same day';
  perform pg_temp.expect(format($q$select public.api_cancel_expense(%L, gen_random_uuid(), 'h', %L, 'again')$q$, owner, e3), '23001', 'once');
  perform pg_temp.expect(format($q$update public.expenses set status = 'ok', cancelled_at = null, cancelled_by = null, cancel_reason = null where id = %L$q$, e3), '23001', 'a cancelled expense stays cancelled');

  -- ---------- 4. paying a supplier marks his bills paid ----------
  insert into public.suppliers (company_id, name) values (co, 'Ludhiana Steel Rolling Mills') returning id into sup;
  insert into public.purchases (company_id, supplier_id, bill_no, bill_date, bill_type, items_amount, total_amount, total_kg)
    values (co, sup, 'L-1', today - 10, 'pakka', 100000, 118000, 1000) returning id into bill1;
  insert into public.purchases (company_id, supplier_id, bill_no, bill_date, bill_type, items_amount, total_amount, total_kg)
    values (co, sup, 'L-2', today - 5, 'pakka', 50000, 59000, 500) returning id into bill2;
  r := public.api_expenses(owner, today - 30, today);
  assert (select jsonb_array_length(x -> 'unpaid') from jsonb_array_elements(r -> 'suppliers') x where (x ->> 'id')::uuid = sup) = 2, 'two bills to pay';
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'amount', 10, 'account_id', drawer)), '42501', 'supplier payments: stock permission');
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, owner, jsonb_build_object('kind', 'supplier', 'amount', 10, 'account_id', sbi)), '22023', 'which supplier');
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'purchase_ids', jsonb_build_array(bill1), 'amount', 118000, 'account_id', sbi, 'method', 'RTGS'));
  assert (select pay_status = 'paid' from public.purchases where id = bill1) and (select pay_status = 'to_pay' from public.purchases where id = bill2), 'L-1 paid';
  assert (select category = 'supplier' from public.expenses where id = (r ->> 'expense_id')::uuid), 'its own category';
  perform public.api_cancel_expense(owner, gen_random_uuid(), 'h', (r ->> 'expense_id')::uuid, 'wrong bill');
  assert (select pay_status = 'to_pay' from public.purchases where id = bill1), 'cancelled payment: the bill is to pay again';
  -- the owner's own money
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'owner', 'amount', 5000, 'account_id', drawer, 'category', 'tea'));
  assert (select kind = 'owner' and category = 'home' from public.expenses where id = (r ->> 'expense_id')::uuid), 'owner took for home';

  -- ---------- 5. moving money ----------
  perform pg_temp.expect(format($q$select public.api_save_transfer(%L, gen_random_uuid(), 'h', %L)$q$, sales, jsonb_build_object('from_account', drawer, 'to_account', sbi, 'amount', 100)), '42501', 'sales can''t move money');
  perform pg_temp.expect(format($q$select public.api_save_transfer(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('from_account', drawer, 'to_account', drawer, 'amount', 100)), '22023', 'two accounts');
  perform pg_temp.expect(format($q$select public.api_save_transfer(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('from_account', ptm, 'to_account', sbi, 'amount', 100)), '22023', 'owners-only account');
  perform pg_temp.expect(format($q$select public.api_save_transfer(%L, gen_random_uuid(), 'h', %L)$q$, acct, jsonb_build_object('from_account', drawer, 'to_account', sbi, 'amount', 100, 'reason', 'close')), '22023', 'closing moves come only from the cash count');
  r := public.api_save_transfer(acct, gen_random_uuid(), 'h', jsonb_build_object('from_account', drawer, 'to_account', sbi, 'amount', 300, 'reason', 'deposit', 'method', 'Cheque'));
  t1 := (r ->> 'transfer_id')::uuid;
  assert (select reason = 'deposit' and method = 'Cheque' and amount = 300 from public.money_transfers where id = t1), 'deposit with how';
  perform pg_temp.expect(format($q$update public.money_transfers set amount = 1 where id = %L$q$, t1), '23001', 'moves never change');

  -- ---------- 6. the cash book ----------
  perform public.api_record_payment(owner, gen_random_uuid(), 'h', cust, 10000, 'Cash', 'pakka', null);   -- a good day's cash
  -- before the drawer was ever counted, the day starts at zero: cash in today − cash out today
  select coalesce(sum(pp.amount) filter (where pp.amount > 0), 0), coalesce(-sum(pp.amount) filter (where pp.amount < 0), 0) into v_in, v_out
    from public.payment_parts pp join public.payments p on p.id = pp.payment_id
    where pp.company_id = co and pp.account_id = drawer and (p.received_at at time zone 'Asia/Kolkata')::date = today;
  cb := public.api_cash_book(acct, null);
  assert (cb ->> 'opening')::numeric = 0, 'no opening before the first count';
  assert (cb ->> 'in')::numeric = v_in, format('cash in = drawer payments (%s vs %s)', cb ->> 'in', v_in);
  -- out today from the drawer: tea 150 (the 120 was changed), tea 10, owner 5000, deposit 300 (labour 800 cancelled)
  assert (cb ->> 'out')::numeric = v_out + 150 + 10 + 5000 + 300, format('cash out = expenses + deposit (%s)', cb ->> 'out');
  v_exp := (cb ->> 'expected')::numeric;
  assert v_exp = v_in - v_out - 5460, format('should be in the drawer (%s)', v_exp);
  perform pg_temp.expect(format($q$select public.api_cash_book(%L, null)$q$, sales), '42501', 'the cash book: money + today');
  -- (inside one test transaction the clock stands still, so "earlier" is a time given to the entry)
  -- a count a minute ago, before today's entries: 2000 was in the drawer then (the app expected 0)
  assert v_exp > 0, format('a good day: %s in, %s out, %s expected', v_in, v_out, v_exp);
  r := public.api_close_cash(acct, gen_random_uuid(), 'h', 2000, 'opening cash', 0, null, now() - interval '1 minute');
  assert (r ->> 'expected')::numeric = 0 and (r ->> 'difference')::numeric = 2000, format('first count: %s', r);
  cb := public.api_cash_book(acct, null);
  assert (cb ->> 'expected')::numeric = v_exp + 2000, format('the count carries on: 2000 + today (%s)', cb ->> 'expected');
  -- closing: count, take most of it home, the rest stays for tomorrow
  perform pg_temp.expect(format($q$select public.api_close_cash(%L, gen_random_uuid(), 'h', 1000, null, 1000.01, null, null)$q$, acct), '22023', 'can''t take out more than counted');
  r := public.api_close_cash(acct, gen_random_uuid(), 'h', v_exp + 2000 - 50, 'short 50?', v_exp - 50, null, null);
  assert (r ->> 'difference')::numeric = -50 and (r ->> 'expected')::numeric = v_exp + 2000 and (r ->> 'left')::numeric = 2000, format('count: %s', r);
  select id into home from public.money_accounts where company_id = co and kind = 'safe' and name = 'Locker';
  assert (r ->> 'taken_to')::uuid = home, 'cash goes to the cash-kept-outside account (Locker here)';
  assert (select taken_out = v_exp - 50 and taken_to = home and opening = 0 and counted_cash = v_exp + 1950 from public.cash_closes
          where company_id = co and business_date = today order by closed_at desc, counted_cash desc limit 1), 'remembered with the count';
  assert exists (select 1 from public.account_balances where company_id = co and account_id = drawer and balance = 2000 and expected = v_exp + 2000 and source = 'count'), 'a balance point: what stayed';
  assert exists (select 1 from public.money_transfers where company_id = co and from_account = drawer and to_account = home and reason = 'close' and amount = v_exp - 50), 'taken home = moved, not spent';
  assert (app.account_balance(co, home, now()) ->> 'balance')::numeric = v_exp - 50, 'the locker has it';
  cb := public.api_cash_book(acct, null);
  assert (cb ->> 'expected')::numeric = 2000, format('after closing: 2000 stays (%s)', cb ->> 'expected');
  assert jsonb_array_length(cb -> 'counts') = 2, 'both counts in the book';
  -- tomorrow starts with what stayed
  cb := app.cash_book(co, today + 1);
  assert (cb ->> 'opening')::numeric = 2000 and (cb ->> 'expected')::numeric = 2000, format('tomorrow opens with 2000 (%s)', cb);
  -- counting again: carries on from the last count
  r := public.api_close_cash(acct, gen_random_uuid(), 'h', 2000, null, 0, null, null);
  assert (r ->> 'expected')::numeric = 2000 and (r ->> 'difference')::numeric = 0, format('second count (%s)', r);
  -- the old door still works and keeps the book
  r := public.api_save_cash_count(acct, gen_random_uuid(), 'h', 2000, null);
  assert (r ->> 'expected')::numeric = 2000 and (r ->> 'taken_out')::numeric = 0, 'old cash count = a count without taking out';
  -- no account for cash kept outside yet: "Cash at home" is made the first time
  update public.money_accounts set hidden = true where id = home;
  r := public.api_close_cash(owner, gen_random_uuid(), 'h', 2000, null, 700, null, null);
  assert (select name = 'Cash at home' and kind = 'safe' and not staff_can from public.money_accounts where id = (r ->> 'taken_to')::uuid), 'made the first time';
  assert (public.api_cash_book(acct, null) ->> 'expected')::numeric = 1300, 'left 1300';
  update public.money_accounts set hidden = false where id = home;

  -- ---------- 7. balances (owners) ----------
  r := public.api_account_balances(owner);
  assert (select (x ->> 'balance')::numeric = 1300 and (x ->> 'known')::boolean from jsonb_array_elements(r) x where (x ->> 'id')::uuid = drawer), 'drawer now 1300';
  assert (select not (x ->> 'known')::boolean from jsonb_array_elements(r) x where (x ->> 'id')::uuid = sbi), 'SBI: no passbook figure yet';
  perform pg_temp.expect(format($q$select public.api_account_balances(%L)$q$, acct), '42501', 'balances for owners');
  r := public.api_set_balance(owner, gen_random_uuid(), 'h', ptm, 1500, 'Paytm app');
  assert (r ->> 'expected') is null, 'first figure: nothing to compare';
  assert (select source from public.account_balances where account_id = ptm order by at desc limit 1) = 'start', 'the start';
  -- SBI's passbook an hour ago said 100000 (the clock stands still in a test, so it is put in directly)
  insert into public.account_balances (company_id, account_id, at, balance, source, created_by) values (co, sbi, now() - interval '1 hour', 100000, 'start', owner);
  r := public.api_save_transfer(owner, gen_random_uuid(), 'h', jsonb_build_object('from_account', sbi, 'to_account', drawer, 'amount', 5000, 'reason', 'withdraw'));
  -- after it: blade −4720, cash deposited +300, cash withdrawn −5000 (the supplier payment was cancelled)
  r := public.api_set_balance(owner, gen_random_uuid(), 'h', sbi, 90570, 'bank charges?');
  assert (r ->> 'expected')::numeric = 90580, format('expected 100000 − 4720 + 300 − 5000 (%s)', r);
  assert (app.account_balance(co, sbi, now()) ->> 'balance')::numeric = 90570, 'now the passbook figure';
  r := public.api_account_book(owner, sbi, today - 1, today);
  assert jsonb_array_length(r -> 'points') = 2 and (select source from public.account_balances where account_id = sbi order by at desc, created_at desc limit 1) = 'passbook' and exists (select 1 from jsonb_array_elements(r -> 'moves') x where (x ->> 'src') = 'transfer_out' and (x ->> 'amount')::numeric = -5000), 'the book has points and moves';
  perform pg_temp.expect(format($q$select public.api_set_balance(%L, gen_random_uuid(), 'h', %L, -1, null)$q$, owner, drawer), '22023', 'cash can''t be below zero');

  -- ---------- 8. the evening: money out by permission ----------
  r := public.api_day_money(acct, null);
  assert not exists (select 1 from jsonb_array_elements(r -> 'expenses') x where x ->> 'kind' = 'owner'), 'the accounts person never sees the owner''s own';
  assert exists (select 1 from jsonb_array_elements(r -> 'expenses') x where x ->> 'category' = 'tea'), 'but sees the tea';
  assert not exists (select 1 from jsonb_array_elements(r -> 'expenses') x where (x ->> 'id')::uuid = e3), 'cancelled ones are not money out';
  assert (r -> 'cash_book') is not null and jsonb_array_length(r -> 'transfers') >= 1, 'cash book and moves';
  r := public.api_day_money(owner, null);
  assert exists (select 1 from jsonb_array_elements(r -> 'expenses') x where x ->> 'kind' = 'owner'), 'owners see their own';
  r := public.api_day_money(sales, null);
  assert jsonb_array_length(r -> 'expenses') = 0 and jsonb_array_length(r -> 'transfers') = 0 and (r -> 'cash_book') = 'null'::jsonb, 'sales: none of it';
  r := public.api_expenses(acct, today - 30, today);
  assert not exists (select 1 from jsonb_array_elements(r -> 'items') x where x ->> 'kind' in ('owner','supplier')), 'list follows the same rules';
  assert jsonb_array_length(r -> 'suppliers') = 0, 'no supplier bills without the stock permission';
  perform pg_temp.expect(format($q$select public.api_expenses(%L, current_date, current_date - 1)$q$, acct), '22023', 'dates in order');

  -- ---------- 9. companies stay apart ----------
  update public.people set perms = perms || '{"expenses":true}'::jsonb where id = ownerb;
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', %L)$q$, ownerb, jsonb_build_object('category', 'tea', 'amount', 10, 'account_id', drawer)), '22023', 'another shop''s account');
  perform pg_temp.expect(format($q$select public.api_cancel_expense(%L, gen_random_uuid(), 'h', %L, 'x')$q$, ownerb, e2), '22023', 'another shop''s expense');
  perform pg_temp.expect(format($q$select public.api_account_book(%L, %L, current_date, current_date)$q$, ownerb, sbi), '22023', 'another shop''s book');
  assert public.api_expense_file(ownerb, e2) is null, 'no file of another shop';
  select count(*) into n from public.expenses where company_id = '22222222-2222-2222-2222-222222222222';
  assert n = 0, 'nothing leaked into B';

  -- ---------- 10. app users can't read or write these tables ----------
  assert not has_table_privilege('authenticated', 'public.expenses', 'select'), 'expenses only through the api';
  assert not has_table_privilege('authenticated', 'public.money_transfers', 'insert'), 'moves only through the api';
end $$;
