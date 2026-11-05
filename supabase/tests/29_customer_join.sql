-- @fixtures fixtures business
-- 6 Nov 2026 (plan v2, F9): the same customer twice and joining two customers (all names made up).
-- "Different person" is kept · a customer added offline with the same phone → "To check", nothing changed · a join moves
-- the balances with linked entries (old → ₹0, kept gets them), never an old slip or payment · the total stays the same ·
-- bank payers move, missing special rates are copied · join entries can't be cancelled on their own · undo only while
-- nothing is new, and it puts everything back.
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
/** A customer's balance per side from old balances and loose khata entries (no slips in this test). */
create function pg_temp.bal(cu uuid, sd text) returns numeric language sql as $$
  select coalesce((select sum(amount) from public.old_dues where customer_id = cu and side = sd), 0)
       - coalesce((select sum(amount) from public.payments where customer_id = cu and side = sd and order_id is null), 0)
$$;
create function pg_temp.newc(who uuid, nm text, ph text) returns uuid language sql as $$
  select (public.api_create_customer(who, gen_random_uuid(), 'h', nm, ph, null) ->> 'id')::uuid
$$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  mat uuid := 'a1000000-0000-0000-0000-000000000001';
  k uuid; o uuid; x uuid; k2 uuid; o2 uuid; r jsonb; ck jsonb; j uuid; drawer uuid; total0 numeric; p uuid;
  mv jsonb := '[{"side":"pakka","kind":"due","amount":4000},{"side":"kacha","kind":"credit","amount":500}]';
begin
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  update public.people set perms = perms || '{"kacha":true}'::jsonb where id in (owner, acct);
  update public.people set perms = perms || '{"new":true}'::jsonb where id = acct;   -- (staff who add customers, not the owner)

  -- ---------- 1. the same customer twice ----------
  k := pg_temp.newc(owner, 'Sharma Engineering', '+91 98110 22334');
  x := (public.api_create_customer(owner, gen_random_uuid(), 'h', 'Sharma Engg (site)', '9811022334', null, null, array[k]) ->> 'id')::uuid;
  assert exists (select 1 from public.customer_not_same where customer_id = x and other_id = k), '"different person" is kept';
  assert not exists (select 1 from public.review_items where kind = 'maybe_same_customer' and ref_id = x), 'asked on the phone: no card';
  r := public.api_run(acct, 'api_create_customer', jsonb_build_object('p_caller', acct, 'p_key', gen_random_uuid(), 'p_hash', 'h',
         'p_name', 'Sharma Engg.', 'p_phone', '098110-22334', 'p_notes', null), null, null, now() - interval '5 minutes');
  o := (r ->> 'id')::uuid;
  assert exists (select 1 from public.review_items where kind = 'maybe_same_customer' and ref_id = o and ref2_id = k), 'added offline, same phone: To check';
  assert (select joined_into is null from public.customers where id = o), 'nothing changed by itself';
  assert app.norm_name('M/s. Sharma Engg. & Co.') = 'sharma eng' and app.phone10('+91 98110-22334') = '9811022334', 'the same cleaning as the phone';

  -- ---------- 2. join: preview stamp, moves, the total ----------
  insert into public.old_dues (company_id, customer_id, side, due_date, amount) values (co, k, 'pakka', current_date - 20, 10000), (co, k, 'kacha', current_date - 20, 2000),
    (co, o, 'pakka', current_date - 10, 4000);
  perform public.api_record_payment(owner, gen_random_uuid(), 'h', o, 500, 'Cash', 'kacha', 'extra');
  insert into public.bank_payers (company_id, key, action, customer_id) values (co, 'upi:sharmaengg@okhdfc', 'payment', o);
  insert into public.customer_rates (company_id, customer_id, material_id, rate) values (co, o, mat, 71);
  total0 := pg_temp.bal(k, 'pakka') + pg_temp.bal(k, 'kacha') + pg_temp.bal(o, 'pakka') + pg_temp.bal(o, 'kacha');
  assert total0 = 15500, format('the two khatas before: %s', total0);
  ck := public.api_customer_join_check(owner, k, o);
  perform pg_temp.expect(format($q$select public.api_customer_join(%L, gen_random_uuid(), 'h', %L, %L, %L::jsonb, %L, null)$q$, acct, k, o, mv, ck ->> 'stamp'), '42501', 'owner only');
  perform pg_temp.expect(format($q$select public.api_customer_join(%L, gen_random_uuid(), 'h', %L, %L, %L::jsonb, 'stale', null)$q$, owner, k, o, mv), '40001', 'changed after the preview');
  r := public.api_customer_join(owner, gen_random_uuid(), 'h', k, o, mv, ck ->> 'stamp', 'same firm, two names');
  j := (r ->> 'join_id')::uuid;
  assert (pg_temp.bal(o, 'pakka'), pg_temp.bal(o, 'kacha')) = (0::numeric, 0::numeric), 'the old customer is at ₹0';
  assert (pg_temp.bal(k, 'pakka'), pg_temp.bal(k, 'kacha')) = (14000::numeric, 1500::numeric), 'the kept customer has it all';
  assert pg_temp.bal(k, 'pakka') + pg_temp.bal(k, 'kacha') + pg_temp.bal(o, 'pakka') + pg_temp.bal(o, 'kacha') = total0, 'the total is the same';
  assert (select joined_into = k from public.customers where id = o), 'marked "joined into"';
  assert (select count(*) from public.payments where join_id = j and mode = 'Adjust' and kind = 'join') = 2, 'no money: two join entries';
  assert exists (select 1 from public.payments where customer_id = o and kind = 'khata' and amount = 500), 'the old payment is still where it was';
  assert (select customer_id from public.bank_payers where company_id = co and key = 'upi:sharmaengg@okhdfc') = k, 'the bank payer now means the kept customer';
  assert exists (select 1 from public.customer_rates where customer_id = k and material_id = mat and rate = 71), 'the special rate is copied';
  assert exists (select 1 from public.review_items where kind = 'maybe_same_customer' and ref_id = o and status = 'done'), 'the To check card is answered';
  assert exists (select 1 from public.audit_log where entity_type = 'customer_joins' and entity_id = j::text), 'the join is in the audit log';
  assert jsonb_array_length(public.api_customer_joins(owner, k)) = 1, 'the kept customer links to the history';
  p := (select id from public.payments where join_id = j and customer_id = o);
  perform pg_temp.expect(format($q$select public.api_reverse_payment(%L, gen_random_uuid(), 'h', %L, 'oops')$q$, owner, p), '23514', 'a join entry can''t be cancelled on its own');
  perform pg_temp.expect(format($q$select public.api_customer_join(%L, gen_random_uuid(), 'h', %L, %L, '[]', %L, null)$q$, owner, k, o, ck ->> 'stamp'), '22023', 'joined once');

  -- undo after something new: refused, with the reason
  perform public.api_record_payment(owner, gen_random_uuid(), 'h', k, 1000, 'Cash', 'pakka', null);
  perform pg_temp.expect(format($q$select public.api_customer_join_undo(%L, gen_random_uuid(), 'h', %L, null)$q$, owner, j), '22023', 'new entries: no undo');

  -- ---------- 3. undo with nothing new puts everything back ----------
  k2 := pg_temp.newc(owner, 'Gupta Iron Store', null);
  o2 := pg_temp.newc(owner, 'Gupta Iron Stor', null);
  insert into public.old_dues (company_id, customer_id, side, due_date, amount) values (co, k2, 'pakka', current_date - 5, 3000), (co, o2, 'pakka', current_date - 5, 1200);
  insert into public.customer_rates (company_id, customer_id, material_id, rate) values (co, o2, mat, 69);
  ck := public.api_customer_join_check(owner, k2, o2);
  r := public.api_customer_join(owner, gen_random_uuid(), 'h', k2, o2, '[{"side":"pakka","kind":"due","amount":1200}]', ck ->> 'stamp', null);
  j := (r ->> 'join_id')::uuid;
  assert pg_temp.bal(k2, 'pakka') = 4200 and pg_temp.bal(o2, 'pakka') = 0, 'joined';
  perform pg_temp.expect(format($q$select public.api_customer_join_undo(%L, gen_random_uuid(), 'h', %L, null)$q$, acct, j), '42501', 'staff can''t undo');
  r := public.api_customer_join_undo(owner, gen_random_uuid(), 'h', j, 'joined by mistake');
  assert pg_temp.bal(k2, 'pakka') = 3000 and pg_temp.bal(o2, 'pakka') = 1200, 'undo: both balances back';
  assert (select joined_into is null from public.customers where id = o2), 'undo: the mark is gone';
  assert (select status = 'undone' from public.customer_joins where id = j), 'the join is kept, marked undone';
  assert (select rate is null from public.customer_rates where customer_id = k2 and material_id = mat order by effective_from desc limit 1), 'the copied rate is taken off again';
  assert (select count(*) from public.payments where join_id = j) = 2, 'the entry and its exact opposite (nothing deleted)';
  perform pg_temp.expect(format($q$select public.api_customer_join_undo(%L, gen_random_uuid(), 'h', %L, null)$q$, owner, j), '22023', 'undone once');

  -- ---------- 4. open slips stay with their customer: finish or cancel them first ----------
  x := pg_temp.newc(owner, 'Laxmi Tools', null);
  perform public.api_create_order(owner, gen_random_uuid(), 'h', x, '{"min_inch":1}', jsonb_build_array(jsonb_build_object('material_id', mat, 'grade_code', 'EN8',
    'shape', 'round', 'unit', 'mm', 'dims', jsonb_build_array('40'), 'sell_rate', 74, 'cut_rate', 0, 'density', 7850, 'special_rate', false,
    'lengths', jsonb_build_array(jsonb_build_object('len', '300', 'pcs', 2, 'cuts', 0)))), false, null);
  ck := public.api_customer_join_check(owner, k2, x);
  assert jsonb_array_length(ck -> 'open_slips') = 1, 'the preview shows the open slip';
  perform pg_temp.expect(format($q$select public.api_customer_join(%L, gen_random_uuid(), 'h', %L, %L, '[]', %L, null)$q$, owner, k2, x, ck ->> 'stamp'), '22023', 'open slip: refused');
  raise notice '29_customer_join: all checks passed';
end $$;
