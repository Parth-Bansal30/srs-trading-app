-- @fixtures fixtures business
-- Bank statements (3 Nov 2026): the next statement covers the same days in another kind of file — nothing is saved twice
-- (day + amount + balance, counted) · lines from before the shop started the app are kept but skipped · a UPI payment
-- written in Shop UPI is found in the bank statement and ticking it moves that money into the bank (opening it again undoes it).
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
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  today date := (now() at time zone 'Asia/Kolkata')::date;
  bank uuid; upi uuid; r jsonb; a jsonb; b jsonb; imp uuid; d jsonb; pid uuid; lid uuid; tid uuid; n int; m jsonb;
  ln jsonb := '[]'::jsonb;
begin
  update public.companies set created_at = now() - interval '20 days' where id = co;   -- the shop started the app 20 days ago
  bank := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"YES current","kind":"bank"}') ->> 'id')::uuid;
  upi := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"Shop UPI","kind":"upi"}') ->> 'id')::uuid;

  -- ---------- 1. statement A (a PDF): one line from before the app, a +500 −500 +500 day, two more ----------
  a := jsonb_build_array(
    jsonb_build_object('day', today - 40, 'amount', 7000, 'narration', 'NEFT Cr-OLD PAYER', 'balance', 7000, 'fingerprint', 'a|1|old payer'),
    jsonb_build_object('day', today - 12, 'amount', 500, 'narration', '000000005577 CHQ DEPOSIT DELHI-BOB', 'balance', 7500, 'fingerprint', 'a|2|chq dep'),
    jsonb_build_object('day', today - 12, 'amount', -500, 'narration', 'CHQ RETURN 5577', 'balance', 7000, 'fingerprint', 'a|3|chq return'),
    jsonb_build_object('day', today - 12, 'amount', 500, 'narration', '000000005577 CHQ DEPOSIT DELHI-BOB Customer Id: 1234567', 'balance', 7500, 'fingerprint', 'a|4|chq dep again'),
    jsonb_build_object('day', today - 10, 'amount', 2500, 'narration', 'IMPS-MOHIT VERMA', 'balance', 10000, 'fingerprint', 'a|5|imps mohit'));
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', bank, 'file_name', 'aug-sep.pdf', 'lines', a));
  imp := (r ->> 'import_id')::uuid;
  assert (r ->> 'new')::int = 5 and (r ->> 'old')::int = 1, format('A: 5 kept, 1 before the app (%s)', r);
  assert (select status from public.bank_lines where import_id = imp and amount = 7000) = 'skipped', 'the old line is skipped';
  assert (select note from public.bank_lines where import_id = imp and amount = 7000) = 'Before the app was started', 'and says why';
  assert (select count(*) from public.bank_lines where import_id = imp and amount = 500) = 2, 'both +500 lines of one day stay';

  -- ---------- 2. statement B (Excel: other text, other marks) for the same days and a new one: only the new one is saved ----------
  b := jsonb_build_array(
    jsonb_build_object('day', today - 12, 'amount', 500, 'narration', 'CHQ DEPOSIT DELHI-BOB', 'ref', '5577', 'balance', 7500, 'fingerprint', 'statement-b-1'),
    jsonb_build_object('day', today - 12, 'amount', -500, 'narration', 'CHQ RETURN', 'ref', '5577', 'balance', 7000, 'fingerprint', 'statement-b-2'),
    jsonb_build_object('day', today - 12, 'amount', 500, 'narration', 'CHQ DEPOSIT DELHI-BOB', 'ref', '5577', 'balance', 7500, 'fingerprint', 'statement-b-3'),
    jsonb_build_object('day', today - 10, 'amount', 2500, 'narration', 'IMPS/MOHIT VERMA/SBIN', 'balance', 10000, 'fingerprint', 'statement-b-4'),
    jsonb_build_object('day', today - 5, 'amount', 1200, 'narration', 'UPI-SHARMA ENGG-SHARMA@OKSBI', 'balance', 11200, 'fingerprint', 'statement-b-5'),
    jsonb_build_object('day', today - 5, 'amount', 1200, 'narration', 'UPI-SHARMA ENGG-SHARMA@OKSBI', 'balance', 12400, 'fingerprint', 'statement-b-6'));
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', bank, 'file_name', 'sep-oct.xlsx', 'lines', b));
  assert (r ->> 'new')::int = 2 and (r ->> 'seen')::int = 4, format('B: the 4 lines of A are not saved again, 2 new (%s)', r);
  assert (select count(*) from public.bank_lines where account_id = bank) = 7, 'seven lines in all';
  -- the same file a third time adds nothing; a line with no balance still falls back to the mark
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', bank, 'lines', b));
  assert (r ->> 'new')::int = 0, 'B again: nothing';
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', bank, 'lines',
         jsonb_build_array(jsonb_build_object('day', today - 2, 'amount', 300, 'narration', 'X', 'fingerprint', 'no-balance-line-1')))) ;
  assert (r ->> 'new')::int = 1, 'no balance: kept';
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', bank, 'lines',
         jsonb_build_array(jsonb_build_object('day', today - 2, 'amount', 300, 'narration', 'X', 'fingerprint', 'no-balance-line-1')))) ;
  assert (r ->> 'new')::int = 0, 'no balance: the same mark is not saved twice';

  -- ---------- 3. a UPI payment written in Shop UPI is found in the bank statement ----------
  r := public.api_pay(owner, 'api_record_payment', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
         'p_amount', 1850, 'p_mode', 'UPI', 'p_side', 'pakka', 'p_note', null), null, jsonb_build_object('account_id', upi, 'method', 'UPI'));
  pid := (r ->> 'payment_id')::uuid;
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', bank, 'lines',
         jsonb_build_array(jsonb_build_object('day', today, 'amount', 1850, 'narration', 'UPI-A CUSTOMER-X@YBL', 'balance', 14250, 'fingerprint', 'upi-statement-1'),
                           jsonb_build_object('day', today, 'amount', -1850, 'narration', 'UPI-OUT', 'balance', 12400, 'fingerprint', 'upi-statement-2'))));
  imp := (r ->> 'import_id')::uuid;
  d := public.api_bank_data(owner, bank, imp);
  assert d ->> 'shop' is not null and (d ->> 'start')::date = today - 20, 'the shop''s name and start day come along';
  select x into m from jsonb_array_elements(d -> 'moves') x where x ->> 'ref' = pid::text;
  assert m ->> 'via' = 'Shop UPI' and m ->> 'customer_id' = cust::text, format('the Shop UPI payment is offered (%s)', m);
  select id into lid from public.bank_lines where import_id = imp and amount = -1850;
  perform pg_temp.expect(format($q$select public.api_bank_link(%L, gen_random_uuid(), 'h', %L, 'payment', %L, null)$q$, owner, lid, pid), '22023', 'not to money going out');
  select id into lid from public.bank_lines where import_id = imp and amount = 1850;
  r := public.api_bank_link(owner, gen_random_uuid(), 'h', lid, 'payment', pid, null);
  assert (r ->> 'moved_from')::uuid = upi, 'linked, and the money moved from Shop UPI';
  select settle_id into tid from public.bank_lines where id = lid;
  assert (select from_account = upi and to_account = bank and amount = 1850 and business_date = today and status = 'ok' from public.money_transfers where id = tid),
    'one transfer Shop UPI → bank on the bank''s day';
  d := public.api_bank_data(owner, bank, imp);
  assert (select bool_and((x ->> 'linked')::boolean) from jsonb_array_elements(d -> 'moves') x where x ->> 'ref' in (pid::text, tid::text)),
    'the payment and its transfer are both done (never offered for another line)';
  -- opening the line again cancels the transfer
  r := public.api_bank_mark(owner, gen_random_uuid(), 'h', lid, 'open', null, null);
  assert (select status from public.money_transfers where id = tid) = 'cancelled', 'the transfer is cancelled';
  assert (select settle_id is null and status = 'open' from public.bank_lines where id = lid), 'the line is open again';
  raise notice '21_bank_twice: all checks passed';
end $$;
