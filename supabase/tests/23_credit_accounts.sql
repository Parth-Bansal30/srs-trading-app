-- @fixtures fixtures business
-- 4 Nov 2026 (plan v2, F3): overdraft / cash credit accounts — the owner sets the sanctioned limit on a bank account
-- only; a negative balance point is fine for them (never for cash); balances carry the limit and how many entries the
-- estimate is made of; a bank line can't be ticked against a cancelled payment.
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
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  cc uuid; upi uuid; drawer uuid; r jsonb; b jsonb; pid uuid; lid uuid;
begin
  update public.people set perms = perms || '{"expenses":true}'::jsonb where id = owner;
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  cc := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"HDFC CC","kind":"bank"}') ->> 'id')::uuid;
  upi := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"Shop UPI","kind":"upi"}') ->> 'id')::uuid;

  -- ---------- who / which accounts ----------
  perform pg_temp.expect(format($q$select public.api_account_credit(%L, gen_random_uuid(), 'h', %L, 'cc', 1500000)$q$, acct, cc), '42501', 'owners only');
  perform pg_temp.expect(format($q$select public.api_account_credit(%L, gen_random_uuid(), 'h', %L, 'cc', 1500000)$q$, owner, drawer), '22023', 'never the cash drawer');
  perform pg_temp.expect(format($q$select public.api_account_credit(%L, gen_random_uuid(), 'h', %L, 'od', 100000)$q$, owner, upi), '22023', 'never a UPI account');
  perform pg_temp.expect(format($q$select public.api_account_credit(%L, gen_random_uuid(), 'h', %L, 'cc', 0)$q$, owner, cc), '22023', 'a limit is needed');
  r := public.api_account_credit(owner, gen_random_uuid(), 'h', cc, 'cc', 1500000);
  assert (select credit_kind = 'cc' and credit_limit = 1500000 from public.money_accounts where id = cc), 'CC with ₹15,00,000 limit';
  assert (select (x ->> 'credit_limit')::numeric = 1500000 from jsonb_array_elements(public.api_accounts(owner, false)) x where x ->> 'id' = cc::text), 'the list shows the limit to the owner';
  assert (select x ->> 'credit_limit' is null and x ->> 'credit_kind' = 'cc' from jsonb_array_elements(public.api_accounts(acct, false)) x where x ->> 'id' = cc::text), 'staff see it is CC, not the limit';

  -- ---------- a negative balance point (the statement) is fine for the CC, never for cash ----------
  r := public.api_set_balance(owner, gen_random_uuid(), 'h', cc, -1123088, 'statement 31 Oct');
  -- (in one test transaction everything has the same now(): put the point an hour back so later entries count after it)
  alter table public.account_balances disable trigger account_balances_no_change;
  update public.account_balances set at = now() - interval '1 hour' where account_id = cc;
  alter table public.account_balances enable trigger account_balances_no_change;
  perform pg_temp.expect(format($q$select public.api_set_balance(%L, gen_random_uuid(), 'h', %L, -10, 'x')$q$, owner, drawer), '22023', 'cash can''t be below zero');
  -- ---------- entries since the point: a ₹2,00,000 payment out, a ₹1,57,270 customer NEFT ----------
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('category', 'other', 'amount', 200000, 'account_id', cc, 'paid_to', 'Shree Balaji Steel'));
  pid := (public.api_pay(owner, 'api_record_payment', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
    'p_amount', 157270, 'p_mode', 'Bank', 'p_side', 'pakka', 'p_note', 'NEFT'), null, jsonb_build_object('account_id', cc, 'method', 'NEFT')) ->> 'payment_id')::uuid;
  select x into b from jsonb_array_elements(public.api_account_balances(owner)) x where x ->> 'id' = cc::text;
  assert (b ->> 'balance')::numeric = -1165818 and (b ->> 'entries')::int = 2 and (b ->> 'credit_limit')::numeric = 1500000,
    format('used ₹11,65,818: the statement point + 2 entries (%s)', b);

  -- ---------- a statement closing below zero becomes the balance point ----------
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', cc, 'from', (now() at time zone 'Asia/Kolkata')::date,
    'to', (now() at time zone 'Asia/Kolkata')::date, 'opening', -1165818, 'closing', -1162818, 'adds_up', true, 'lines',
    jsonb_build_array(jsonb_build_object('day', (now() at time zone 'Asia/Kolkata')::date, 'amount', 3000, 'narration', 'UPI-A', 'balance', -1162818, 'fingerprint', 'credit-test-line-1'))));
  r := public.api_bank_balance(owner, gen_random_uuid(), 'h', (r ->> 'import_id')::uuid);
  assert (r ->> 'balance')::numeric = -1162818, 'a negative statement balance accepted for the CC';

  -- ---------- a tick racing a cancel is refused ----------
  select id into lid from public.bank_lines where account_id = cc and fingerprint = 'credit-test-line-1';
  pid := (public.api_pay(owner, 'api_record_payment', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
    'p_amount', 3000, 'p_mode', 'UPI', 'p_side', 'pakka', 'p_note', null), null, jsonb_build_object('account_id', cc, 'method', 'UPI')) ->> 'payment_id')::uuid;
  r := public.api_reverse_payment(owner, gen_random_uuid(), 'h', pid, 'wrong');
  perform pg_temp.expect(format($q$select public.api_bank_link(%L, gen_random_uuid(), 'h', %L, 'payment', %L, null)$q$, owner, lid, pid), '23001', 'not to a cancelled payment');

  -- ---------- back to a normal account ----------
  r := public.api_account_credit(owner, gen_random_uuid(), 'h', cc, null, null);
  assert (select credit_kind is null and credit_limit is null from public.money_accounts where id = cc), 'normal again';
  raise notice '23_credit_accounts: all checks passed';
end $$;
