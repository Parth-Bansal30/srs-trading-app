-- @fixtures fixtures business
-- 5 Nov 2026 (plan v2, F8): cash reaching ₹2,00,000 from one person in a day, or for one slip across days, is stopped
-- (staff can never save it); the owner can record cash that was really taken, with the reason → "To check" (important);
-- an offline entry is kept and flagged; a week across slips is only flagged; cash paid out over ₹10,000 a day is flagged,
-- ₹2,00,000 to a supplier is stopped.
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
create function pg_temp.args(who uuid, cust uuid, amt numeric) returns jsonb language sql as $$
  select jsonb_build_object('p_caller', who, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust, 'p_amount', amt, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', null)
$$;
create function pg_temp.pay(who uuid, cust uuid, amt numeric, acc uuid) returns uuid language sql as $$
  select (public.api_pay(who, 'api_record_payment', pg_temp.args(who, cust, amt), null, jsonb_build_object('account_id', acc)) ->> 'payment_id')::uuid
$$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  cust2 uuid := 'a2000000-0000-0000-0000-000000000002';
  drawer uuid; bank uuid; p uuid; r jsonb; sup uuid := gen_random_uuid(); b numeric; at timestamptz;
begin
  update public.people set perms = perms || '{"expenses":true,"stock":true}'::jsonb where id in (owner, acct);
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  bank := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"HDFC current","kind":"bank","staff_can":true}') ->> 'id')::uuid;

  -- ---------- 1. one person, one day ----------
  b := (public.api_cash_room(acct, cust, null) ->> 'day')::numeric;   -- (the fixtures may already have a little cash today)
  p := pg_temp.pay(acct, cust, 150000 - b, drawer);
  r := public.api_cash_room(acct, cust, null);
  assert (r ->> 'day')::numeric = 150000 and (r ->> 'room')::numeric = 49999, format('room: ₹49,999 more cash — %s', r);
  perform pg_temp.expect(format($q$select public.api_pay(%L, 'api_record_payment', %L::jsonb, null, %L::jsonb)$q$, acct, pg_temp.args(acct, cust, 60000), jsonb_build_object('account_id', drawer)),
    '23514', 'the second ₹60,000 cash is stopped');
  p := pg_temp.pay(acct, cust, 49999, drawer);
  p := (public.api_pay(acct, 'api_record_payment', pg_temp.args(acct, cust, 10001), null, jsonb_build_object('account_id', bank, 'method', 'UPI')) ->> 'payment_id')::uuid;
  assert p is not null, 'the rest by UPI is fine';
  -- staff can't record it anyway; the owner can, with the reason → To check (important)
  perform pg_temp.expect(format($q$select public.api_cash_reason_pay(%L, 'customer already gave it', 'api_record_payment', %L::jsonb, null, %L::jsonb)$q$,
    acct, pg_temp.args(acct, cust, 5000), jsonb_build_object('account_id', drawer)), '42501', 'staff: no exception');
  r := public.api_cash_reason_pay(owner, 'Customer handed it over before we could say', 'api_record_payment', pg_temp.args(owner, cust, 5000), null, jsonb_build_object('account_id', drawer));
  assert exists (select 1 from public.review_items where kind = 'cash_exception' and ref_id = (r ->> 'payment_id')::uuid and level = 'important'
                 and data ->> 'reason' like 'Customer handed%'), 'the owner''s record goes to To check';
  perform pg_temp.expect(format($q$select public.api_cash_reason_pay(%L, 'x', 'api_record_payment', %L::jsonb, null, %L::jsonb)$q$,
    owner, pg_temp.args(owner, cust, 5000), jsonb_build_object('account_id', drawer)), '22023', 'a reason is needed');

  -- ---------- 2. a cancelled cash payment does not count ----------
  r := public.api_reverse_payment(owner, gen_random_uuid(), 'h', (r ->> 'payment_id')::uuid, 'typed wrong');
  assert (public.api_cash_room(acct, cust, null) ->> 'day')::numeric = 199999, 'cancelled cash is not counted';

  -- ---------- 3. offline: kept, flagged as important ----------
  -- (an hour ago, but on the same shop day even just after midnight)
  at := greatest(now() - interval '1 hour', (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') + interval '1 second');
  p := (public.api_run(acct, 'api_record_payment', pg_temp.args(acct, cust, 30000), null, jsonb_build_object('account_id', drawer), at) ->> 'payment_id')::uuid;
  assert exists (select 1 from public.review_items where kind = 'cash_limit' and ref_id = p and level = 'important'), 'offline over the limit: kept, To check';

  -- ---------- 4. a week across slips: never stopped, only flagged ----------
  perform set_config('app.at', (now() - interval '3 days')::text, true);
  p := (public.api_pay(acct, 'api_record_payment', pg_temp.args(acct, cust2, 120000), null, jsonb_build_object('account_id', drawer)) ->> 'payment_id')::uuid;
  perform set_config('app.at', '', true);
  p := pg_temp.pay(acct, cust2, 90000, drawer);
  assert exists (select 1 from public.review_items where kind = 'cash_occasion' and ref_id = p), 'might be one occasion: To check';

  -- ---------- 5. cash paid out ----------
  insert into public.suppliers (id, company_id, name) values (sup, co, 'Gupta Iron Store');
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'amount', 45000, 'account_id', drawer));
  assert exists (select 1 from public.review_items where kind = 'cash_out' and ref_id = (r ->> 'expense_id')::uuid), 'over ₹10,000 cash in a day: flagged for the CA';
  perform pg_temp.expect(format($q$select public.api_save_expense(%L, gen_random_uuid(), 'h', '{"kind":"supplier","supplier_id":"%s","amount":160000,"account_id":"%s"}')$q$, owner, sup, drawer),
    '23514', '₹2,00,000 cash to a supplier in a day is stopped');
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'amount', 160000, 'account_id', bank, 'method', 'NEFT'));
  assert r ->> 'expense_id' is not null, 'by bank it is fine';
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'expense', 'category', 'tea', 'amount', 300, 'account_id', drawer));
  assert not exists (select 1 from public.review_items where kind = 'cash_out' and ref_id = (r ->> 'expense_id')::uuid), 'small cash with no payee: nothing';
  raise notice '28_cash_rules: all checks passed';
end $$;
