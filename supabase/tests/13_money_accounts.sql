-- @fixtures fixtures business
-- Money accounts (6 Oct 2026): the shop's own list (cash drawer always there), a payment split across
-- accounts must add up, staff only use accounts they're allowed, corrections mirror the parts,
-- refunds leave from one account, the drawer only expects cash, evening ticks.
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
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  o4 uuid := 'a3000000-0000-0000-0000-000000000004';     -- accepted, 500 cash advance
  drawer uuid; sbi uuid; ptm uuid; old uuid; r jsonb; pid uuid; n int; exp1 numeric; exp2 numeric; args jsonb; newco uuid;
begin
  update public.people set perms = perms || '{"khata":true}'::jsonb where id = sales;  -- sales who also collects khata payments
  -- ---------- 1. every shop has its cash drawer; older cash payments are in it ----------
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  assert drawer is not null and (select count(*) from public.money_accounts where company_id = co) = 1, 'only Shop cash to start with';
  assert not exists (select 1 from public.payments p where p.company_id = co and p.mode = 'Cash'
                     and not exists (select 1 from public.payment_parts pp where pp.payment_id = p.id and pp.account_id = drawer)), 'cash payments are in the drawer';
  assert not exists (select 1 from public.payment_parts pp join public.payments p on p.id = pp.payment_id where p.company_id = co and p.mode = 'UPI'), 'UPI before accounts: not placed';
  newco := gen_random_uuid();
  insert into public.companies (id, name) values (newco, 'New Shop Test');
  assert exists (select 1 from public.money_accounts where company_id = newco and is_drawer and name = 'Shop cash'), 'a new shop gets its drawer';

  -- ---------- 2. the owner adds his own accounts ----------
  perform pg_temp.expect(format($q$select public.api_save_account(%L, gen_random_uuid(), 'h', '{"name":"SBI","kind":"bank"}')$q$, sales), '42501', 'sales cannot add accounts');
  sbi := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"SBI current","kind":"bank","owner":"firm","number":"50100012347730"}') ->> 'id')::uuid;
  ptm := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"Paytm 99•••876","kind":"paytm","owner":"personal","staff_can":false}') ->> 'id')::uuid;
  old := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"Old UPI","kind":"upi","owner":"personal"}') ->> 'id')::uuid;
  perform pg_temp.expect(format($q$select public.api_save_account(%L, gen_random_uuid(), 'h', '{"name":"sbi CURRENT","kind":"upi"}')$q$, owner), '23505', 'two accounts with one name');
  perform pg_temp.expect(format($q$select public.api_save_account(%L, gen_random_uuid(), 'h', '{"name":"Pocket","kind":"cash"}')$q$, owner), '22023', 'only one cash drawer');
  r := public.api_save_account(owner, gen_random_uuid(), 'h', jsonb_build_object('id', drawer, 'name', 'Galla', 'kind', 'bank', 'hidden', true));
  assert (select name = 'Galla' and kind = 'cash' and not hidden and is_drawer from public.money_accounts where id = drawer), 'the drawer can be renamed, never hidden or changed';
  perform public.api_save_account(owner, gen_random_uuid(), 'h', jsonb_build_object('id', old, 'name', 'Old UPI', 'kind', 'upi', 'hidden', true));
  perform public.api_order_accounts(owner, gen_random_uuid(), 'h', array[ptm, sbi, drawer]);
  assert (select position from public.money_accounts where id = ptm) < (select position from public.money_accounts where id = sbi), 'reordered';
  assert (select position from public.money_accounts where id = drawer) = 0, 'the drawer stays first';

  -- who may choose what
  r := public.api_accounts(sales, false);
  assert (select array_agg((x ->> 'id')::uuid order by (x ->> 'id')) from jsonb_array_elements(r) x) = (select array_agg(i order by i) from unnest(array[drawer, sbi]) i), 'sales: drawer and SBI only';
  assert (select bool_and(x -> 'number' = 'null'::jsonb) from jsonb_array_elements(r) x), 'staff don''t get account numbers';
  assert jsonb_array_length(public.api_accounts(owner, false)) = 3 and jsonb_array_length(public.api_accounts(owner, true)) = 4, 'owner: + Paytm; Settings: + hidden';
  perform pg_temp.expect(format($q$select public.api_accounts(%L, true)$q$, sales), '42501', 'Settings list for owners');
  perform pg_temp.expect(format($q$select public.api_accounts(%L, false)$q$, weigher), '42501', 'the weigher takes no money');

  -- ---------- 3. a payment split across accounts ----------
  args := jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust, 'p_amount', 3000,
                             'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', null);
  perform pg_temp.expect(format($q$select public.api_pay(%L, 'api_record_payment', %L, %L, null)$q$, owner, args,
    jsonb_build_array(jsonb_build_object('account_id', drawer, 'amount', 1000), jsonb_build_object('account_id', sbi, 'amount', 1500))), '22023', 'parts must add up');
  assert not exists (select 1 from public.payments where idempotency_key = (args ->> 'p_key')::uuid), 'nothing saved when it does not add up';
  r := public.api_pay(owner, 'api_record_payment', args, jsonb_build_array(
    jsonb_build_object('account_id', drawer, 'amount', 1000), jsonb_build_object('account_id', sbi, 'amount', 1500, 'method', 'RTGS'),
    jsonb_build_object('account_id', ptm, 'amount', 500)), null);
  pid := (r ->> 'payment_id')::uuid;
  assert (select mode from public.payments where id = pid) = 'Cash+UPI+Bank', 'the payment''s mode comes from its parts';
  assert (select count(*) = 3 and sum(amount) = 3000 from public.payment_parts where payment_id = pid), 'three parts';
  assert (select mode = 'Bank' and method = 'RTGS' from public.payment_parts where payment_id = pid and account_id = sbi), 'RTGS into SBI = Bank';
  assert (select mode from public.payment_parts where payment_id = pid and account_id = ptm) = 'UPI', 'Paytm = UPI';
  r := public.api_pay(owner, 'api_record_payment', args, jsonb_build_array(jsonb_build_object('account_id', drawer, 'amount', 3000)), null);
  assert (r ->> 'payment_id')::uuid = pid and (select count(*) from public.payment_parts where payment_id = pid) = 3, 'a retry gives the first answer, parts unchanged';
  -- staff and hidden accounts
  perform pg_temp.expect(format($q$select public.api_pay(%L, 'api_record_payment', %L, %L, null)$q$, sales,
    jsonb_set(jsonb_set(args, '{p_caller}', to_jsonb(sales)), '{p_key}', to_jsonb(gen_random_uuid())),
    jsonb_build_array(jsonb_build_object('account_id', ptm, 'amount', 3000))), '22023', 'owners-only account');
  perform pg_temp.expect(format($q$select public.api_pay(%L, 'api_record_payment', %L, %L, null)$q$, owner,
    jsonb_set(args, '{p_key}', to_jsonb(gen_random_uuid())), jsonb_build_array(jsonb_build_object('account_id', old, 'amount', 3000))), '22023', 'hidden account');
  perform pg_temp.expect(format($q$select public.api_pay(%L, 'api_record_payment', %L, %L, null)$q$, owner,
    jsonb_set(args, '{p_key}', to_jsonb(gen_random_uuid())),
    jsonb_build_array(jsonb_build_object('account_id', sbi, 'amount', 1500), jsonb_build_object('account_id', sbi, 'amount', 1500))), '22023', 'same account twice');
  perform pg_temp.expect(format($q$select public.api_pay(%L, 'api_cancel_order', %L, null, null)$q$, owner, args), '22023', 'only money operations');
  perform pg_temp.expect(format($q$select public.api_pay(%L, 'api_record_payment', %L, null, null)$q$, sales, args), '22023', 'someone else''s request');
  -- staff with an allowed account; one account = its own mode
  r := public.api_pay(sales, 'api_record_payment', jsonb_build_object('p_caller', sales, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
         'p_amount', 700, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', 'NEFT ref 123'), null, jsonb_build_object('account_id', sbi, 'method', 'UPI'));
  assert (select mode from public.payments where id = (r ->> 'payment_id')::uuid) = 'UPI', 'UPI into the bank account';
  assert (select account_id = sbi and amount = 700 from public.payment_parts where payment_id = (r ->> 'payment_id')::uuid), 'all of it in SBI';

  -- ---------- 4. a correction mirrors the parts ----------
  r := public.api_reverse_payment(owner, gen_random_uuid(), 'h', pid, 'typed twice');
  assert (select mode from public.payments where id = (r ->> 'reversal_id')::uuid) = 'Cash+UPI+Bank', 'same mode';
  assert (select count(*) = 3 and sum(amount) = -3000 and min(amount) = -1500 from public.payment_parts where payment_id = (r ->> 'reversal_id')::uuid), 'each part taken back';

  -- ---------- 5. money given back leaves from one account ----------
  r := public.api_pay(owner, 'api_adjust_advance', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_order', o4,
         'p_action', 'refund', 'p_amount', 200, 'p_mode', 'Cash', 'p_target', null, 'p_side', null, 'p_note', 'customer asked'),
       null, jsonb_build_object('account_id', sbi, 'method', 'IMPS'));
  assert exists (select 1 from public.payments p join public.payment_parts pp on pp.payment_id = p.id
                 where p.order_id = o4 and p.kind = 'refund' and p.amount = -200 and p.mode = 'Bank' and pp.account_id = sbi and pp.amount = -200), 'refund from SBI';

  -- ---------- 6. the drawer only expects the cash part ----------
  select sum(pp.amount) into exp1 from public.payment_parts pp join public.payments p on p.id = pp.payment_id
    where p.company_id = co and pp.mode = 'Cash' and (p.received_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date;
  r := public.api_save_cash_count(owner, gen_random_uuid(), 'h', 0, null);
  exp2 := (r ->> 'expected')::numeric;
  assert exp2 = exp1, format('expected cash = cash parts (%s vs %s)', exp2, exp1);
  assert exp2 = (select coalesce(sum(amount), 0) from public.payments where company_id = co and mode = 'Cash'
                 and (received_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date), 'split (+1000 −1000) leaves the old cash total';

  -- ---------- 7. the evening, account by account ----------
  r := public.api_day_accounts(owner, null);
  assert (select count(*) from jsonb_array_elements(r -> 'parts') x where (x ->> 'account_id')::uuid = sbi) = 4, 'SBI: split, reversal, staff UPI, refund';
  assert jsonb_array_length(r -> 'checks') = 0, 'nothing ticked';
  perform pg_temp.expect(format($q$select public.api_day_accounts(%L, null)$q$, sales), '42501', 'tally for owners');
  perform public.api_check_account(owner, gen_random_uuid(), 'h', sbi, (now() at time zone 'Asia/Kolkata')::date, true);
  perform public.api_check_account(owner, gen_random_uuid(), 'h', sbi, (now() at time zone 'Asia/Kolkata')::date, true);
  assert (public.api_day_accounts(owner, null) -> 'checks') = jsonb_build_array(sbi), 'ticked once';
  perform public.api_check_account(owner, gen_random_uuid(), 'h', sbi, (now() at time zone 'Asia/Kolkata')::date, false);
  assert jsonb_array_length(public.api_day_accounts(owner, null) -> 'checks') = 0, 'unticked';
  perform pg_temp.expect(format($q$select public.api_check_account(%L, gen_random_uuid(), 'h', %L, current_date + 3, true)$q$, owner, sbi), '22023', 'no ticks for the future');
  r := public.api_day_data(owner, null);
  assert exists (select 1 from jsonb_array_elements(r -> 'payments') x where (x ->> 'id')::uuid = pid and jsonb_array_length(x -> 'parts') = 3), 'day data has the parts';

  -- ---------- 8. it can't be broken ----------
  perform pg_temp.expect(format($q$update public.payment_parts set amount = 1 where payment_id = %L$q$, pid), '23001', 'parts never change');
  perform pg_temp.expect(format($q$insert into public.payments (company_id, customer_id, amount, mode, kind, side) values (%L, %L, 5, 'Cash+Gold', 'khata', 'pakka')$q$, co, cust), '23514', 'only real modes');
  perform pg_temp.expect(format($q$update public.money_accounts set hidden = true where id = %L$q$, drawer), '23514', 'the drawer is never hidden');
end $$;
