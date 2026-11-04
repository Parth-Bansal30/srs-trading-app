-- @fixtures fixtures business
-- 4 Nov 2026 (plan v2, F5 with D1 / D2): the cheque / DD register. A cheque from a customer is noted when it comes in and
-- does NOT lower the khata; only the owner's confirm of its clearing line in the statement makes the payment (bank's date,
-- that account, no "twice?" card). A return after the confirm puts the due back exactly once (F1); a return before it
-- never touched the khata. Supplier cheques follow their supplier payment. Nothing is matched or posted by itself.
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
create function pg_temp.line(acc uuid, amt numeric, txt text, bal numeric) returns uuid language plpgsql as $$
declare owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000'; r jsonb;
begin
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', acc, 'lines',
         jsonb_build_array(jsonb_build_object('day', (now() at time zone 'Asia/Kolkata')::date, 'amount', amt, 'narration', txt, 'balance', bal,
           'fingerprint', 'cheque-test-' || txt || '-' || bal))));
  return (select id from public.bank_lines where import_id = (r ->> 'import_id')::uuid limit 1);
end $$;
create function pg_temp.chq(who uuid, p jsonb) returns uuid language sql as $$
  select (public.api_cheque_add(who, gen_random_uuid(), 'h', p) ->> 'cheque_id')::uuid
$$;
create function pg_temp.paid(cust uuid) returns numeric language sql as $$
  select coalesce(sum(amount), 0) from public.payments where customer_id = cust
$$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  sales uuid := 'aaaaaaa3-0000-0000-0000-000000000000';   -- money, no khata
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';    -- khata + money, no kacha, not the owner
  ownerb uuid := 'bbbbbbb1-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  sup uuid := gen_random_uuid();
  bank uuid; drawer uuid; q1 uuid; q2 uuid; q3 uuid; q4 uuid; q5 uuid; q6 uuid; l1 uuid; l2 uuid; l3 uuid; l4 uuid; l5 uuid; l6 uuid;
  eid uuid; pid uuid; before numeric; r jsonb; k uuid; n int; ch public.cheques;
begin
  update public.companies set created_at = now() - interval '30 days' where id = co;
  update public.people set perms = perms || '{"expenses":true}'::jsonb where id in (owner, acct);
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  bank := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"BoB current","kind":"bank"}') ->> 'id')::uuid;
  insert into public.suppliers (id, company_id, name) values (sup, co, 'Gupta Iron Store');

  -- ---------- 1. noted when it comes in: no payment, the khata does not change ----------
  before := pg_temp.paid(cust);
  perform pg_temp.expect(format($q$select public.api_cheque_add(%L, gen_random_uuid(), 'h', '{"direction":"in","number":"004512","amount":25000,"customer_id":"%s","side":"pakka"}')$q$, sales, cust),
    '42501', 'a person without the khata cannot note a customer cheque');
  perform pg_temp.expect(format($q$select public.api_cheque_add(%L, gen_random_uuid(), 'h', '{"direction":"in","number":"004512","amount":25000,"customer_id":"%s","side":"kacha"}')$q$, acct, cust),
    '42501', 'kacha cheques only for kacha people');
  perform pg_temp.expect(format($q$select public.api_cheque_add(%L, gen_random_uuid(), 'h', '{"direction":"in","number":"","amount":25000,"customer_id":"%s"}')$q$, acct, cust),
    '22023', 'the number is needed');
  q1 := pg_temp.chq(acct, jsonb_build_object('direction', 'in', 'number', '004512', 'bank_name', 'bob', 'amount', 25000, 'customer_id', cust, 'side', 'pakka'));
  select * into ch from public.cheques where id = q1;
  assert ch.status = 'received' and ch.bank_name = 'BOB' and ch.payment_id is null, 'noted as received';
  assert pg_temp.paid(cust) = before, 'a received cheque does not lower the khata (D2)';
  r := public.api_cheque_mark(acct, gen_random_uuid(), 'h', q1, 'deposited', bank, null);
  assert (select status = 'deposited' and account_id = bank from public.cheques where id = q1), 'deposited into the bank';
  assert pg_temp.paid(cust) = before, 'still no khata change';

  -- ---------- 2. the owner confirms the clearing line: the payment is made now (no "twice?" card) ----------
  pid := (public.api_pay(owner, 'api_record_payment', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
    'p_amount', 25000, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', null), null, jsonb_build_object('account_id', drawer)) ->> 'payment_id')::uuid;   -- a ₹25,000 in cash too
  before := pg_temp.paid(cust);
  l1 := pg_temp.line(bank, 25000, 'CHQ DEP 004512 DELHI-BOB', 125000);
  perform pg_temp.expect(format($q$select public.api_cheque_clear(%L, gen_random_uuid(), 'h', %L, %L, null, null)$q$, acct, q1, l1), '42501', 'only the owner confirms');
  k := gen_random_uuid();
  r := public.api_cheque_clear(owner, k, 'h', q1, l1, null, null);
  select * into ch from public.cheques where id = q1;
  assert ch.status = 'cleared' and ch.payment_id is not null and ch.clear_line_id = l1, 'cleared, with its payment and line';
  assert pg_temp.paid(cust) = before + 25000, 'now the khata goes down by ₹25,000';
  assert (select status = 'added' and payment_id = ch.payment_id from public.bank_lines where id = l1), 'the line is done';
  assert (select mode = 'Cheque' and note like 'Cheque 004512 · BOB%' from public.payments where id = ch.payment_id), 'a cheque payment with its number';
  assert not exists (select 1 from public.review_items where kind = 'twin_payment' and (ref_id = ch.payment_id or ref2_id = ch.payment_id)), 'no "same payment twice?" card for a cheque';
  assert (public.api_cheque_clear(owner, k, 'h', q1, l1, null, null) ->> 'cheque_id')::uuid = q1, 'the same request again: the same answer';
  assert pg_temp.paid(cust) = before + 25000, '…and nothing twice';
  perform pg_temp.expect(format($q$select public.api_cheque_clear(%L, gen_random_uuid(), 'h', %L, %L, null, null)$q$, owner, q1, l1), '23001', 'already cleared');

  -- ---------- 3. it comes back after the confirm: the due comes back once; charges only when ticked ----------
  l2 := pg_temp.line(bank, -25000, 'CHQ RETURN 004512 FUNDS INSUFFICIENT', 100000);
  l3 := pg_temp.line(bank, -354, 'CHQ RTN CHGS INCL GST', 99646);
  before := pg_temp.paid(cust);
  perform pg_temp.expect(format($q$select public.api_cheque_return(%L, gen_random_uuid(), 'h', %L, %L, null, 0, null)$q$, owner, q1, l3), '22023', 'the charges line is not the cheque coming back');
  r := public.api_cheque_return(owner, gen_random_uuid(), 'h', q1, l2, null, 0, 'funds insufficient');
  select * into ch from public.cheques where id = q1;
  assert ch.status = 'returned' and ch.return_line_id = l2 and ch.payment_id is not null and ch.return_charges is null, 'returned, its payment still linked for the record';
  assert pg_temp.paid(cust) = before - 25000, 'the due is back by exactly ₹25,000';
  assert exists (select 1 from public.payments where reverses_payment_id = ch.payment_id), 'through a cancel of the payment (F1), never a delete';
  assert (select status = 'skipped' and note like 'Cheque 004512 returned%' from public.bank_lines where id = l1), 'the clearing line is closed with why';
  assert (select status = 'skipped' from public.bank_lines where id = l2), 'the return line is closed';
  assert (select status = 'open' from public.bank_lines where id = l3), 'the charges line stays for the owner (bank charges)';
  assert not exists (select 1 from public.old_dues where customer_id = cust and note like '%004512 return charges%'), 'no charge on the khata unless ticked';
  perform pg_temp.expect(format($q$select public.api_cheque_return(%L, gen_random_uuid(), 'h', %L, %L, null, 0, null)$q$, owner, q1, l2), '23001', 'already returned');

  -- the charges ticked onto the khata (another cheque)
  q2 := pg_temp.chq(owner, jsonb_build_object('direction', 'in', 'number', '220011', 'amount', 15000, 'customer_id', cust, 'side', 'kacha'));
  l4 := pg_temp.line(bank, 15000, 'CLG 220011 SBI', 114646);
  r := public.api_cheque_clear(owner, gen_random_uuid(), 'h', q2, l4, null, null);
  l5 := pg_temp.line(bank, -15000, 'OW RTN 220011', 99646.01);
  r := public.api_cheque_return(owner, gen_random_uuid(), 'h', q2, l5, null, 354, null);
  assert (select amount = 354 and side = 'kacha' from public.old_dues where customer_id = cust and note = 'Cheque 220011 return charges'), 'ticked: ₹354 on the customer''s khata';
  assert (select return_charges = 354 from public.cheques where id = q2), 'kept on the cheque';

  -- ---------- 4. returned before the confirm (deposit and return in one statement): the khata never changed ----------
  q3 := pg_temp.chq(owner, jsonb_build_object('direction', 'in', 'number', '000777', 'amount', 9000, 'customer_id', cust, 'side', 'pakka'));
  l4 := pg_temp.line(bank, 9000, 'CHQ DEP 777 PNB', 108646.01);
  l5 := pg_temp.line(bank, -9000, 'CHQ RETURN 777 PNB', 99646.02);
  before := pg_temp.paid(cust);
  r := public.api_cheque_return(owner, gen_random_uuid(), 'h', q3, l5, l4, 0, 'signature differs');
  assert pg_temp.paid(cust) = before, 'no payment made, none cancelled';
  assert (select count(*) from public.bank_lines where id in (l4, l5) and status = 'skipped') = 2, 'deposit and return closed together';
  assert (select status = 'returned' and clear_line_id = l4 and payment_id is null from public.cheques where id = q3), 'returned, never cleared';

  -- ---------- 5. not in the register: the owner chooses the customer; nothing until then ----------
  l6 := pg_temp.line(bank, 12000, 'CLG 778899 HDFC', 111646.02);
  perform pg_temp.expect(format($q$select public.api_cheque_clear(%L, gen_random_uuid(), 'h', null, %L, null, '{"number":"778899"}')$q$, owner, l6), '22023', 'the customer must be chosen');
  before := pg_temp.paid(cust);
  r := public.api_cheque_clear(owner, gen_random_uuid(), 'h', null, l6, null, jsonb_build_object('customer_id', cust, 'side', 'pakka', 'number', '778899', 'bank_name', 'HDFC'));
  assert (select status = 'cleared' and amount = 12000 and number = '778899' and note like 'Not in the register%' from public.cheques where id = (r ->> 'cheque_id')::uuid), 'noted and cleared in one step';
  assert pg_temp.paid(cust) = before + 12000, 'paid once';

  -- ---------- 6. register ₹25,000 vs statement ₹2,500: a note is needed; the bank's amount is paid ----------
  q4 := pg_temp.chq(owner, jsonb_build_object('direction', 'in', 'number', '991100', 'amount', 25000, 'customer_id', cust, 'side', 'pakka'));
  l1 := pg_temp.line(bank, 2500, 'CHQ DEP 991100', 114146.02);
  perform pg_temp.expect(format($q$select public.api_cheque_clear(%L, gen_random_uuid(), 'h', %L, %L, null, null)$q$, owner, q4, l1), '22023', 'different amounts need a note');
  before := pg_temp.paid(cust);
  r := public.api_cheque_clear(owner, gen_random_uuid(), 'h', q4, l1, 'register typed wrong; cheque was 2,500', null);
  assert pg_temp.paid(cust) = before + 2500, 'the bank''s amount is what is paid';
  -- its payment cancelled from the khata: the cheque is waiting again, never left "cleared"
  r := public.api_reverse_payment(owner, gen_random_uuid(), 'h', (select payment_id from public.cheques where id = q4), 'wrong customer');
  assert (select status = 'deposited' and payment_id is null from public.cheques where id = q4), 'back to waiting';
  assert (select status = 'open' from public.bank_lines where id = l1), 'its line is open again (F1)';

  -- ---------- 7. a DD cannot bounce ----------
  q5 := pg_temp.chq(owner, jsonb_build_object('direction', 'in', 'instrument', 'dd', 'number', '445566', 'amount', 40000, 'customer_id', cust, 'side', 'pakka'));
  l2 := pg_temp.line(bank, -40000, 'DD RETURN 445566', 74146.02);
  perform pg_temp.expect(format($q$select public.api_cheque_return(%L, gen_random_uuid(), 'h', %L, %L, null, 0, null)$q$, owner, q5, l2), '22023', 'a DD has no return step');
  r := public.api_cheque_mark(owner, gen_random_uuid(), 'h', q5, 'cancelled', null, 'customer took it back');
  assert (select status = 'cancelled' from public.cheques where id = q5), 'cancelled instead';

  -- ---------- 8. the same cheque noted twice: kept, and the owner is asked ----------
  q6 := pg_temp.chq(acct, jsonb_build_object('direction', 'in', 'number', '4512', 'amount', 25000, 'customer_id', cust, 'side', 'pakka'));
  assert exists (select 1 from public.review_items where kind = 'cheque_twice' and ref_id = q6 and ref2_id = q1), 'a "noted twice" card (leading zeros ignored)';

  -- ---------- 9. a cheque given to a supplier ----------
  eid := (public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'amount', 80000,
            'account_id', bank, 'method', 'Cheque')) ->> 'expense_id')::uuid;
  perform pg_temp.expect(format($q$select public.api_cheque_add(%L, gen_random_uuid(), 'h', '{"direction":"out","number":"118244","amount":8000,"expense_id":"%s"}')$q$, owner, eid),
    '22023', 'the cheque must be the payment''s amount');
  q1 := pg_temp.chq(owner, jsonb_build_object('direction', 'out', 'number', '118244', 'amount', 80000, 'expense_id', eid));
  assert (select status = 'given' and supplier_id = sup and account_id = bank from public.cheques where id = q1), 'given, with its supplier and account';
  l1 := pg_temp.line(bank, -80000, 'CLG DR 118244', 34146.02);
  r := public.api_cheque_clear(owner, gen_random_uuid(), 'h', q1, l1, null, null);
  assert (select status = 'linked' and expense_id = eid from public.bank_lines where id = l1), 'the line is ticked against that supplier payment (nothing new added)';
  assert (select status = 'cleared' and clear_line_id = l1 from public.cheques where id = q1), 'cashed';
  r := public.api_bank_mark(owner, gen_random_uuid(), 'h', l1, 'open', null, null);
  assert (select status = 'given' and clear_line_id is null from public.cheques where id = q1), 'the tick taken back: waiting again';
  r := public.api_bank_link(owner, gen_random_uuid(), 'h', l1, 'expense', eid, null);
  assert (select status = 'cleared' from public.cheques where id = q1), 'ticked in the normal review: cashed too';
  -- our cheque comes back: the supplier payment is cancelled (he is owed again)
  l2 := pg_temp.line(bank, 80000, 'CHQ RET 118244 INSUFF', 114146.03);
  r := public.api_cheque_return(owner, gen_random_uuid(), 'h', q1, l2, null, 0, null);
  assert (select status = 'cancelled' from public.expenses where id = eid), 'its supplier payment is cancelled';
  assert (select status = 'returned' and expense_id = eid from public.cheques where id = q1), 'returned';
  assert (select count(*) from public.bank_lines where id in (l1, l2) and status = 'skipped') = 2, 'both lines closed';
  -- a supplier cheque with no payment written yet: confirming adds the supplier payment from the bank line
  q2 := pg_temp.chq(owner, jsonb_build_object('direction', 'out', 'number', '118245', 'amount', 5000, 'supplier_id', sup));
  l3 := pg_temp.line(bank, -5000, 'CHQ PAID 118245', 109146.03);
  r := public.api_cheque_clear(owner, gen_random_uuid(), 'h', q2, l3, null, null);
  assert (select e.kind = 'supplier' and e.supplier_id = sup and e.amount = 5000 and e.method = 'Cheque'
          from public.expenses e join public.cheques q on q.expense_id = e.id where q.id = q2), 'the supplier payment is added';
  -- a supplier cheque torn up: its payment is cancelled with it
  eid := (public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'amount', 6000,
            'account_id', bank, 'method', 'Cheque')) ->> 'expense_id')::uuid;
  q3 := pg_temp.chq(owner, jsonb_build_object('direction', 'out', 'number', '118246', 'amount', 6000, 'expense_id', eid));
  r := public.api_cheque_mark(owner, gen_random_uuid(), 'h', q3, 'cancelled', null, 'wrote a new one');
  assert (select status = 'cancelled' from public.expenses where id = eid), 'the supplier payment is cancelled with the cheque';
  -- a supplier payment corrected: its cheque moves to the new entry
  eid := (public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'amount', 7000,
            'account_id', bank, 'method', 'Cheque')) ->> 'expense_id')::uuid;
  q4 := pg_temp.chq(owner, jsonb_build_object('direction', 'out', 'number', '118247', 'amount', 7000, 'expense_id', eid));
  r := public.api_save_expense(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'supplier', 'supplier_id', sup, 'amount', 7000,
            'account_id', bank, 'method', 'Cheque', 'note', 'bill no. added', 'replaces_id', eid));
  assert (select status = 'given' and expense_id = (r ->> 'expense_id')::uuid from public.cheques where id = q4), 'the cheque follows the corrected payment';

  -- ---------- 10. who sees what ----------
  r := public.api_cheques(owner, 120, null);
  assert jsonb_array_length(r) >= 10, 'the owner sees the register';
  assert (select count(*) from jsonb_array_elements(public.api_cheques(acct, 120, null)) x where x ->> 'side' = 'kacha') = 0, 'no kacha cheques without kacha';
  assert (select count(*) from jsonb_array_elements(public.api_cheques(sales, 120, null)) x where x ->> 'direction' = 'in') = 0, 'no customer cheques without the khata';
  assert (select count(*) from jsonb_array_elements(public.api_cheques(owner, 120, cust))) >= 6, 'one customer''s cheques';
  perform pg_temp.expect(format($q$select public.api_cheque_mark(%L, gen_random_uuid(), 'h', %L, 'cancelled', null, 'x')$q$, ownerb, q6), '22023', 'another company''s cheque is not found');
  perform pg_temp.expect(format($q$select public.api_cheques(%L, 120, null)$q$, 'aaaaaaa2-0000-0000-0000-000000000000'), '42501', 'the weigher: no register');
  raise notice '25_cheques: all checks passed';
end $$;
