-- @fixtures fixtures business
-- 4 Nov 2026 (plan v2, F1 + F2): cancelling a payment / expense / money move puts its bank line back into "Needs you"
-- (and undoes the UPI → bank move); possible double payments raise ONE review card with both entries' facts — never a
-- block, never a delete — also for two phones offline; answering a card is kept with who and when.
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
create function pg_temp.pay(who uuid, cust uuid, amt numeric, acc uuid, mode text default 'UPI') returns uuid language plpgsql as $$
begin
  return (public.api_pay(who, 'api_record_payment', jsonb_build_object('p_caller', who, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
    'p_amount', amt, 'p_mode', mode, 'p_side', 'pakka', 'p_note', null), null, jsonb_build_object('account_id', acc, 'method', case when mode = 'Cash' then null else mode end)) ->> 'payment_id')::uuid;
end $$;
create function pg_temp.line(acc uuid, amt numeric, txt text, bal numeric) returns uuid language plpgsql as $$
declare owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000'; r jsonb;
begin
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', acc, 'lines',
         jsonb_build_array(jsonb_build_object('day', (now() at time zone 'Asia/Kolkata')::date, 'amount', amt, 'narration', txt, 'balance', bal,
           'fingerprint', 'review-test-' || txt || '-' || bal))));
  return (select id from public.bank_lines where import_id = (r ->> 'import_id')::uuid limit 1);
end $$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  bank uuid; upi uuid; drawer uuid; p1 uuid; p2 uuid; p3 uuid; l1 uuid; l2 uuid; l3 uuid; l4 uuid; tid uuid; eid uuid; r jsonb; n int; card public.review_items;
begin
  update public.companies set created_at = now() - interval '30 days' where id = co;
  update public.people set perms = perms || '{"expenses":true}'::jsonb where id in (owner, acct);
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  bank := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"HDFC current","kind":"bank"}') ->> 'id')::uuid;
  upi := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"Shop UPI","kind":"upi"}') ->> 'id')::uuid;

  -- ---------- F1.1 a payment ticked in the bank, then cancelled ----------
  p1 := pg_temp.pay(owner, cust, 5000, bank);
  l1 := pg_temp.line(bank, 5000, 'NEFT CR SHARMA', 105000);
  r := public.api_bank_link(owner, gen_random_uuid(), 'h', l1, 'payment', p1, null);
  r := public.api_reverse_payment(owner, gen_random_uuid(), 'h', p1, 'wrong customer');
  assert (select status = 'open' and payment_id is null and note like 'Payment cancelled on %' from public.bank_lines where id = l1),
    'the bank line is back in "Needs you" with why';
  assert (select count(*) from public.payments where id = p1 or reverses_payment_id = p1) = 2, 'the payment and its cancel are both kept';

  -- ---------- F1.2 a Shop UPI payment ticked (moved into the bank), then cancelled ----------
  p2 := pg_temp.pay(owner, cust, 1850, upi);
  l2 := pg_temp.line(bank, 1850, 'UPI SHARMA', 106850);
  r := public.api_bank_link(owner, gen_random_uuid(), 'h', l2, 'payment', p2, null);
  select settle_id into tid from public.bank_lines where id = l2;
  assert tid is not null, 'the UPI money was moved into the bank';
  r := public.api_reverse_payment(owner, gen_random_uuid(), 'h', p2, 'customer paid twice by mistake');
  assert (select status from public.money_transfers where id = tid) = 'cancelled', 'the UPI → bank move is cancelled';
  assert (select status = 'open' and settle_id is null from public.bank_lines where id = l2), 'the line is open again';

  -- ---------- F1.3 an expense added from a bank line, then cancelled ----------
  l3 := pg_temp.line(bank, -4820, 'BSES RAJDHANI', 102030);
  r := public.api_bank_run(owner, gen_random_uuid(), 'h', l3, 'api_save_expense',
         jsonb_build_object('kind', 'expense', 'category', 'electricity', 'amount', 4820, 'account_id', bank, 'paid_to', 'BSES'), null, null);
  select expense_id into eid from public.bank_lines where id = l3;
  assert eid is not null, 'expense added from the line';
  r := public.api_cancel_expense(owner, gen_random_uuid(), 'h', eid, 'paid from the other account');
  assert (select status = 'open' and note like 'Expense cancelled on %' from public.bank_lines where id = l3), 'expense cancel reopens the line';

  -- ---------- F1.4 a money move ticked, then cancelled ----------
  tid := (public.api_save_transfer(owner, gen_random_uuid(), 'h', jsonb_build_object('from_account', drawer, 'to_account', bank, 'amount', 3000, 'reason', 'deposit')) ->> 'transfer_id')::uuid;
  l4 := pg_temp.line(bank, 3000, 'CASH DEP', 105030);
  r := public.api_bank_link(owner, gen_random_uuid(), 'h', l4, 'transfer_in', tid, null);
  r := public.api_cancel_transfer(owner, gen_random_uuid(), 'h', tid, 'typed twice');
  assert (select status = 'open' and transfer_id is null from public.bank_lines where id = l4), 'a cancelled move reopens its line';

  -- ---------- F1.6 after the cancel, the line can be ticked to the right new payment ----------
  p3 := pg_temp.pay(owner, cust, 5000, bank);
  r := public.api_bank_link(owner, gen_random_uuid(), 'h', l1, 'payment', p3, null);
  assert (select status = 'linked' and payment_id = p3 from public.bank_lines where id = l1), 'linked to the right payment';

  -- ---------- F2.1 / F2.2 a twin raises one card, never blocks ----------
  -- (p3 ₹5,000 has no twin: p1 ₹5,000 was cancelled)
  assert not exists (select 1 from public.review_items where kind = 'twin_payment' and ref_id = p3), 'a cancelled payment is no twin';
  p1 := pg_temp.pay(owner, cust, 2000, drawer, 'Cash');
  p2 := pg_temp.pay(owner, cust, 2000, bank, 'UPI');
  select * into card from public.review_items where kind = 'twin_payment' and ref_id = p2 and ref2_id = p1;
  assert card.id is not null and card.status = 'open', 'the second ₹2,000 raises a card';
  assert card.data -> 'twin' ->> 'mode' = 'Cash' and card.data -> 'new' ->> 'mode' = 'UPI' and (card.data ->> 'amount')::numeric = 2000, 'with both entries'' facts';
  assert (select count(*) from public.payments where customer_id = cust and amount = 2000 and kind = 'khata') = 2, 'both payments saved';
  -- the accountant says "different payment" while saving: noted, but stays open for the owner
  r := public.api_payment_twin_seen(acct, gen_random_uuid(), 'h', p2);
  assert (select status = 'open' and answer like 'Different payment%' from public.review_items where id = card.id), 'staff answer noted, card stays open';
  r := public.api_review_answer(owner, gen_random_uuid(), 'h', card.id, 'done', 'Both real: cash in the morning, UPI in the evening');
  assert (select status = 'done' and answered_by = owner and answered_at is not null from public.review_items where id = card.id), 'owner closes it, with who and when';
  -- cancelling one of a twin pair closes its card
  p1 := pg_temp.pay(owner, cust, 7777, bank);
  p2 := pg_temp.pay(owner, cust, 7777, bank);
  r := public.api_reverse_payment(owner, gen_random_uuid(), 'h', p2, 'typed twice');
  assert (select status = 'done' and answer = 'One of them was cancelled' from public.review_items where kind = 'twin_payment' and ref_id = p2), 'the cancel answers the card';

  -- ---------- F2.4 two phones offline ----------
  perform set_config('app.at', (now() - interval '2 hours')::text, true);
  p1 := pg_temp.pay(owner, cust, 3000, drawer, 'Cash');
  perform set_config('app.at', (now() - interval '1 hour')::text, true);
  p2 := pg_temp.pay(owner, cust, 3000, drawer, 'Cash');
  perform set_config('app.at', '', true);
  assert (select level = 'important' from public.review_items where kind = 'twin_payment' and ref_id = p2 and ref2_id = p1), 'offline twins: an important card';

  -- ---------- the list: owners / money people, kacha cards only with kacha ----------
  r := public.api_review_list(owner, false);
  assert (r ->> 'open')::int >= 1, 'open cards listed';
  perform pg_temp.expect(format($q$select public.api_review_list(%L, false)$q$, 'aaaaaaa2-0000-0000-0000-000000000000'), '42501', 'the weigher (no money permission): no review list');
  raise notice '22_review_and_cancel: all checks passed';
end $$;
