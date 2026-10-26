-- @fixtures fixtures business
-- Bank statement → khata (25 Oct 2026): a statement's lines are kept once per account; each is added (on the bank's date,
-- into the bank account), linked to an entry already in the app, or skipped; payers are remembered; the closing balance
-- becomes the account's balance point. Owners only.
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
  today date := (now() at time zone 'Asia/Kolkata')::date;
  d1 date := today - 6; d2 date := today - 5; d3 date := today - 1; d4 date := today;
  drawer uuid; sbi uuid; r jsonb; imp uuid; lines jsonb; l1 uuid; l2 uuid; l3 uuid; l4 uuid; l5 uuid; pid uuid; d jsonb; n int; x record;
begin
  update public.people set perms = perms || '{"expenses":true,"stock":true}'::jsonb where id = owner;
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  sbi := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"SBI current","kind":"bank"}') ->> 'id')::uuid;
  -- a payment already in the app (₹798 by UPI into SBI, the day before the bank shows it)
  r := public.api_pay(owner, 'api_record_payment', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
         'p_amount', 798, 'p_mode', 'UPI', 'p_side', 'pakka', 'p_note', 'Paytm'), null, jsonb_build_object('account_id', sbi, 'method', 'UPI'));
  pid := (r ->> 'payment_id')::uuid;

  lines := jsonb_build_array(
    jsonb_build_object('day', d1, 'amount', 25000, 'narration', 'UPI/CR/1/SHARMA ENGG/sharmaeng@okhdfcbank', 'balance', 125000, 'fingerprint', d1 || '|25000.00|125000.00||sharma'),
    jsonb_build_object('day', d2, 'amount', -17.70, 'narration', 'SMS ALERT CHARGES', 'balance', 124982.30, 'fingerprint', d2 || '|-17.70|124982.30||sms alert'),
    jsonb_build_object('day', d3, 'amount', -10000, 'narration', 'ATM WDL', 'balance', 114982.30, 'fingerprint', d3 || '|-10000.00|114982.30||atm wdl'),
    jsonb_build_object('day', d3, 'amount', 798, 'narration', 'UPI/CR/2/SHARMA ENGG/sharmaeng@okhdfcbank', 'balance', 115780.30, 'fingerprint', d3 || '|798.00|115780.30||sharma 2'),
    jsonb_build_object('day', d4, 'amount', 900, 'narration', 'UPI/CR/3/SOMEONE/x@ybl', 'balance', 116680.30, 'fingerprint', d4 || '|900.00|116680.30||someone'));

  -- ---------- 1. keep the lines (owners only), once per account ----------
  perform pg_temp.expect(format($q$select public.api_bank_save(%L, gen_random_uuid(), 'h', %L)$q$, acct,
    jsonb_build_object('account_id', sbi, 'lines', lines)), '42501', 'the accounts person: not without the settings permission');
  perform pg_temp.expect(format($q$select public.api_bank_save(%L, gen_random_uuid(), 'h', %L)$q$, owner,
    jsonb_build_object('account_id', drawer, 'lines', lines)), '22023', 'not into the cash drawer');
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', sbi, 'file_name', 'sbi-oct.xlsx', 'from', d1, 'to', d4,
         'opening', 100000, 'closing', 116680.30, 'adds_up', true, 'lines', lines));
  imp := (r ->> 'import_id')::uuid;
  assert (r ->> 'new')::int = 5 and (r ->> 'seen')::int = 0, 'five new lines';
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', sbi, 'lines', lines));
  assert (r ->> 'new')::int = 0 and (r ->> 'seen')::int = 5, 'the same statement again adds nothing';
  select id into l1 from public.bank_lines where import_id = imp and amount = 25000;
  select id into l2 from public.bank_lines where import_id = imp and amount = -17.70;
  select id into l3 from public.bank_lines where import_id = imp and amount = -10000;
  select id into l4 from public.bank_lines where import_id = imp and amount = 798;
  select id into l5 from public.bank_lines where import_id = imp and amount = 900;

  -- ---------- 2. what the review needs ----------
  d := public.api_bank_data(owner, sbi, imp);
  assert jsonb_array_length(d -> 'lines') = 5, 'the five lines';
  assert exists (select 1 from jsonb_array_elements(d -> 'moves') m where m ->> 'ref' = pid::text and (m ->> 'amount')::numeric = 798 and m ->> 'src' = 'payment'), 'the ₹798 payment is among the app''s entries';
  assert (d ->> 'drawer')::uuid = drawer, 'the drawer (for cash moved)';
  perform pg_temp.expect(format($q$select public.api_bank_data(%L, %L, %L)$q$, acct, sbi, imp), '42501', 'owners only');

  -- ---------- 3. add: a customer's payment, on the bank's date, into SBI ----------
  perform pg_temp.expect(format($q$select public.api_bank_run(%L, gen_random_uuid(), 'h', %L, 'api_record_payment', %L, 'UPI', null)$q$, owner, l1,
    jsonb_build_object('p_caller', owner, 'p_customer', cust, 'p_amount', 24000, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', 'x')), '22023', 'the amount must be the line''s');
  r := public.api_bank_run(owner, gen_random_uuid(), 'h', l1, 'api_record_payment',
         jsonb_build_object('p_caller', owner, 'p_customer', cust, 'p_amount', 25000, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', 'From the bank statement'),
         'UPI', jsonb_build_object('key', 'upi:sharmaeng@okhdfcbank', 'action', 'payment', 'customer_id', cust));
  assert r ->> 'status' = 'added', 'added';
  select * into x from public.payments where id = (r ->> 'payment_id')::uuid;
  assert (x.received_at at time zone 'Asia/Kolkata')::date = d1, 'on the bank''s date, not today';
  assert x.mode = 'UPI' and x.kind = 'khata' and x.amount = 25000, 'a UPI khata payment';
  assert (select account_id = sbi and amount = 25000 from public.payment_parts where payment_id = x.id), 'into SBI';
  assert (select payment_id = x.id and status = 'added' from public.bank_lines where id = l1), 'the line points to it';
  assert exists (select 1 from public.bank_payers where company_id = co and key = 'upi:sharmaeng@okhdfcbank' and customer_id = cust), 'the payer is remembered';
  perform pg_temp.expect(format($q$select public.api_bank_run(%L, gen_random_uuid(), 'h', %L, 'api_record_payment', %L, 'UPI', null)$q$, owner, l1,
    jsonb_build_object('p_caller', owner, 'p_customer', cust, 'p_amount', 25000, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', 'x')), '23001', 'a line is added once');

  -- ---------- 4. add: bank charges as an expense, cash taken out at the ATM as a move to the drawer ----------
  r := public.api_bank_run(owner, gen_random_uuid(), 'h', l2, 'api_save_expense', jsonb_build_object('kind', 'expense', 'category', 'bank', 'note', 'SMS charges'), null, null);
  assert (select account_id = sbi and amount = 17.70 and category = 'bank' and business_date = d2 from public.expenses where id = (r ->> 'expense_id')::uuid), 'bank charges, from SBI, on that day';
  r := public.api_bank_run(owner, gen_random_uuid(), 'h', l3, 'api_save_transfer', jsonb_build_object('note', 'ATM'), null, null);
  assert (select from_account = sbi and to_account = drawer and amount = 10000 and reason = 'withdraw' and business_date = d3
            from public.money_transfers where id = (r ->> 'transfer_id')::uuid), 'SBI → drawer, on that day';
  perform pg_temp.expect(format($q$select public.api_bank_run(%L, gen_random_uuid(), 'h', %L, 'api_save_expense', '{}', null, null)$q$, owner, l5), '22023', 'an expense is money going out');

  -- ---------- 5. link: the ₹798 already in the app ----------
  perform pg_temp.expect(format($q$select public.api_bank_link(%L, gen_random_uuid(), 'h', %L, 'payment', %L, null)$q$, owner, l5, pid), '22023', 'different amounts');
  r := public.api_bank_link(owner, gen_random_uuid(), 'h', l4, 'payment', pid, null);
  assert (select status = 'linked' and payment_id = pid from public.bank_lines where id = l4), 'linked, nothing new added';
  assert (select count(*) from public.payments where customer_id = cust and amount = 798) = 1, 'still one ₹798 payment';

  -- ---------- 6. skip (and remember), open again ----------
  r := public.api_bank_mark(owner, gen_random_uuid(), 'h', l5, 'skipped', 'my own money', jsonb_build_object('key', 'upi:x@ybl', 'action', 'skip'));
  assert (select status = 'skipped' and note = 'my own money' from public.bank_lines where id = l5), 'skipped';
  assert exists (select 1 from public.bank_payers where company_id = co and key = 'upi:x@ybl' and action = 'skip'), 'remembered as not shop money';
  r := public.api_bank_mark(owner, gen_random_uuid(), 'h', l5, 'open', null, null);
  assert (select status = 'open' from public.bank_lines where id = l5), 'open again';
  perform pg_temp.expect(format($q$select public.api_bank_mark(%L, gen_random_uuid(), 'h', %L, 'open', null, null)$q$, owner, l1), '23001', 'an added line is cancelled from its own screen');

  -- ---------- 7. balances out ----------
  r := public.api_bank_balance(owner, gen_random_uuid(), 'h', imp);
  assert (select balance = 116680.30 and source = 'passbook' and (at at time zone 'Asia/Kolkata')::date = d4 from public.account_balances where id = (r ->> 'balance_id')::uuid),
    'the closing balance is SBI''s balance point at the end of the statement''s last day';
  assert (app.account_balance(co, sbi, now()) ->> 'balance')::numeric = 116680.30, 'SBI now = the statement''s closing (nothing after it)';

  -- ---------- 8. too old ----------
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', sbi, 'lines',
         jsonb_build_array(jsonb_build_object('day', today - 500, 'amount', 50, 'narration', 'old', 'fingerprint', 'old line 500 days ago'))));
  select id into l1 from public.bank_lines where fingerprint = 'old line 500 days ago';
  perform pg_temp.expect(format($q$select public.api_bank_run(%L, gen_random_uuid(), 'h', %L, 'api_record_payment', %L, null, null)$q$, owner, l1,
    jsonb_build_object('p_caller', owner, 'p_customer', cust, 'p_amount', 50, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', 'x')), '22023', 'more than 400 days back');
end $$;
