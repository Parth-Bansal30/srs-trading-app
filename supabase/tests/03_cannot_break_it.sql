-- @fixtures fixtures business
-- Everything here must be REFUSED by the database itself — even for the backend (postgres),
-- so no bug in any app or server code can ever do it. Each check expects a specific refusal.
create function pg_temp.refused(q text, why text, want text default null) returns void language plpgsql as $$
declare st text; msg text;
begin
  begin
    execute q;
  exception when others then
    get stacked diagnostics st = returned_sqlstate, msg = message_text;
    if want is not null and st <> want then
      raise exception 'TEST FAILED (%): refused, but for the wrong reason: [%] %', why, st, msg;
    end if;
    return;
  end;
  raise exception 'TEST FAILED: this should have been refused: %', why;
end $$;

create function pg_temp.allowed(q text, why text) returns void language plpgsql as $$
declare msg text;
begin
  execute q;
exception when others then
  get stacked diagnostics msg = message_text;
  raise exception 'TEST FAILED: this should have been allowed: % (%)', why, msg;
end $$;

-- ---------- order stages ----------
select pg_temp.refused($q$update public.orders set status = 'done' where id = 'a3000000-0000-0000-0000-000000000003'$q$,
  'estimate jumping straight to done', '23514');
select pg_temp.refused($q$update public.orders set status = 'estimate' where id = 'a3000000-0000-0000-0000-000000000004'$q$,
  'accepted going back to estimate', '23514');
select pg_temp.refused($q$insert into public.orders (company_id, internal_no, slip_no, slip_scheme, customer_id, status)
  values ('11111111-1111-1111-1111-111111111111', 1099, '1099', 'never', 'a2000000-0000-0000-0000-000000000001', 'accepted')$q$,
  'creating an order that skips the estimate stage', '23514');
select pg_temp.refused($q$update public.orders set pay_mode = 'later' where id = 'a3000000-0000-0000-0000-000000000001'$q$,
  'changing a finished order', '23001');
select pg_temp.refused($q$update public.orders set in_khata = true, pay_mode = 'later' where id = 'a3000000-0000-0000-0000-000000000001'$q$,
  'changing a finished order while moving it into the khata', '23001');
select pg_temp.refused($q$update public.orders set in_khata = false where id = 'a3000000-0000-0000-0000-000000000002'$q$,
  'taking a finished order out of the khata', '23001');
select pg_temp.refused($q$update public.orders set total_amount = 1 where id = 'a3000000-0000-0000-0000-000000000002'$q$,
  'changing the total of a finished bill', '23001');
select pg_temp.refused($q$update public.orders set slip_no = '9999' where id = 'a3000000-0000-0000-0000-000000000004'$q$,
  'renumbering a slip', '23001');
select pg_temp.refused($q$update public.orders set customer_id = 'a2000000-0000-0000-0000-000000000001' where id = 'a3000000-0000-0000-0000-000000000004'$q$,
  'changing the customer after acceptance', '23001');
select pg_temp.refused($q$delete from public.orders where id = 'a3000000-0000-0000-0000-000000000004'$q$,
  'deleting an accepted order', '23001');

-- ---------- items, lengths, weights ----------
select pg_temp.refused($q$update public.order_items set sell_rate = 1 where id = 'a4000000-0000-0000-0000-000000000004'$q$,
  'changing the rate after acceptance', '23001');
select pg_temp.refused($q$update public.order_item_lengths set pcs = 99 where order_item_id = 'a4000000-0000-0000-0000-000000000004'$q$,
  'changing pieces after acceptance', '23001');
select pg_temp.refused($q$update public.order_items set actual_weight = 5 where id = 'a4000000-0000-0000-0000-000000000003'$q$,
  'entering a weight on an estimate', '23001');
select pg_temp.refused($q$update public.order_items set actual_weight = 5 where id = 'a4000000-0000-0000-0000-000000000001'$q$,
  'changing a weight on a finished order', '23001');
select pg_temp.allowed($q$update public.order_items set actual_weight = 141.8 where id = 'a4000000-0000-0000-0000-000000000004'$q$,
  'entering a weight on an order waiting to be weighed');
select pg_temp.refused($q$update public.order_items set actual_weight = -3 where id = 'a4000000-0000-0000-0000-000000000004'$q$,
  'a negative weight', '23514');
select pg_temp.refused($q$insert into public.weigh_batches (company_id, order_id, total_weight)
  values ('11111111-1111-1111-1111-111111111111', 'a3000000-0000-0000-0000-000000000003', 10)$q$,
  'weighing an estimate', '23001');
select pg_temp.allowed($q$insert into public.weigh_batches (id, company_id, order_id, total_weight)
  values ('a6000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'a3000000-0000-0000-0000-000000000004', 142)$q$,
  'weighing an accepted order');
select pg_temp.refused($q$update public.weigh_batches set total_weight = 1 where id = 'a6000000-0000-0000-0000-000000000001'$q$,
  'changing a recorded scale reading', '23001');
select pg_temp.allowed($q$update public.order_item_lengths set pcs = 11 where order_item_id = 'a4000000-0000-0000-0000-000000000003' and position = 0$q$,
  'editing pieces on an estimate');
select pg_temp.allowed($q$delete from public.orders where id = 'a3000000-0000-0000-0000-000000000003'$q$,
  'deleting an estimate (with its items and lengths)');
do $$ begin
  assert not exists (select 1 from public.order_items where order_id = 'a3000000-0000-0000-0000-000000000003'), 'estimate items should go with it';
  assert not exists (select 1 from public.order_item_lengths where order_item_id = 'a4000000-0000-0000-0000-000000000003'), 'estimate lengths should go with it';
end $$;

-- ---------- finished-bill rules ----------
-- can't mark as weighed while an item has no weight: add a second, unweighed item first... items are locked after
-- acceptance, so use a fresh accepted order instead.
insert into public.orders (id, company_id, internal_no, slip_no, slip_scheme, customer_id)
  values ('a3000000-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 1045, '1045', 'never', 'a2000000-0000-0000-0000-000000000001');
insert into public.order_items (company_id, order_id, position, material_id, grade_code, shape, dims, sell_rate, cut_rate, density)
  values ('11111111-1111-1111-1111-111111111111', 'a3000000-0000-0000-0000-000000000005', 0, 'a1000000-0000-0000-0000-000000000001', 'EN8', 'round', '{40}', 75, 3, 7850);
update public.orders set status = 'accepted' where id = 'a3000000-0000-0000-0000-000000000005';
select pg_temp.refused($q$update public.orders set status = 'weighed' where id = 'a3000000-0000-0000-0000-000000000005'$q$,
  'marking an order weighed while an item has no weight', '23514');
update public.orders set status = 'weighed', weighed_at = now() where id = 'a3000000-0000-0000-0000-000000000004';
select pg_temp.refused($q$update public.orders set status = 'done', done_at = now() where id = 'a3000000-0000-0000-0000-000000000004'$q$,
  'finishing without choosing a bill type and amounts', '23514');
select pg_temp.refused($q$update public.orders set status = 'done', done_at = now(), bill_type = 'pakka', gst_pct = 18, kacha_pct = 10, pay_mode = 'later',
  total_weight = 141.8, base_amount = 1000, material_amount = 900, cutting_amount = 100, gst_amount = 180, total_amount = 1100
  where id = 'a3000000-0000-0000-0000-000000000004'$q$, 'a total that does not add up', '23514');
select pg_temp.refused($q$update public.orders set status = 'done', done_at = now(), bill_type = 'kacha', gst_pct = 18, kacha_pct = 10, pay_mode = 'later',
  total_weight = 141.8, base_amount = 1000, material_amount = 900, cutting_amount = 100, gst_amount = 180, total_amount = 1180
  where id = 'a3000000-0000-0000-0000-000000000004'$q$, 'GST on a no-bill (kacha) order', '23514');
select pg_temp.allowed($q$update public.orders set status = 'done', done_at = now(), bill_type = 'pakka', gst_pct = 18, kacha_pct = 10, pay_mode = 'later',
  total_weight = 141.8, base_amount = 1000, material_amount = 900, cutting_amount = 100, gst_amount = 180, total_amount = 1180, in_khata = true
  where id = 'a3000000-0000-0000-0000-000000000004'$q$, 'finishing with a correct bill');

-- ---------- payments are permanent ----------
select pg_temp.refused($q$update public.payments set amount = 1 where id = 'a5000000-0000-0000-0000-000000000001'$q$,
  'editing a payment', '23001');
select pg_temp.refused($q$delete from public.payments where id = 'a5000000-0000-0000-0000-000000000001'$q$,
  'deleting a payment', '23001');
select pg_temp.refused($q$truncate public.payments$q$, 'wiping all payments');
select pg_temp.refused($q$insert into public.payments (company_id, customer_id, order_id, amount, mode, kind)
  values ('11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000001', 'a3000000-0000-0000-0000-000000000001', 50, 'Cash', 'advance')$q$,
  'an advance on a finished order', '23514');
select pg_temp.refused($q$insert into public.payments (company_id, customer_id, amount, mode, kind)
  values ('11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000001', 50, 'Cash', 'khata')$q$,
  'a khata payment without saying pakka or kacha', '23514');
select pg_temp.refused($q$insert into public.payments (company_id, customer_id, amount, mode, kind, side)
  values ('11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000001', -50, 'Cash', 'khata', 'pakka')$q$,
  'a negative payment that is not a reversal', '23514');
select pg_temp.refused($q$insert into public.payments (company_id, customer_id, amount, mode, kind, side)
  values ('11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000001', 50, 'Gold', 'khata', 'pakka')$q$,
  'an unknown payment mode', '23514');
-- a correction: the exact opposite of the original
select pg_temp.refused($q$insert into public.payments (company_id, customer_id, amount, mode, kind, side, reverses_payment_id)
  values ('11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000001', -90, 'Cash', 'reversal', 'pakka', 'a5000000-0000-0000-0000-000000000001')$q$,
  'a reversal for a different amount', '23514');
select pg_temp.allowed($q$insert into public.payments (id, company_id, customer_id, amount, mode, kind, side, reverses_payment_id, note)
  values ('a5000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000001', -100, 'Cash', 'reversal', 'pakka',
          'a5000000-0000-0000-0000-000000000001', 'entered twice by mistake')$q$, 'reversing a payment entered by mistake');
select pg_temp.refused($q$insert into public.payments (company_id, customer_id, amount, mode, kind, side, reverses_payment_id)
  values ('11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000001', -100, 'Cash', 'reversal', 'pakka', 'a5000000-0000-0000-0000-000000000001')$q$,
  'reversing the same payment twice', '23505');
select pg_temp.refused($q$insert into public.payments (company_id, customer_id, amount, mode, kind, side, reverses_payment_id)
  values ('11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000001', 100, 'Cash', 'reversal', 'pakka', 'a5000000-0000-0000-0000-000000000002')$q$,
  'reversing a reversal', '23514');

-- ---------- rate history is permanent ----------
select pg_temp.refused($q$update public.material_rates set sell_rate = 1$q$, 'rewriting old rates', '23001');
select pg_temp.refused($q$delete from public.customer_rates$q$, 'deleting special-rate history', '23001');
select pg_temp.refused($q$update public.cash_closes set counted_cash = 0$q$, 'editing a saved cash count', '23001');
select pg_temp.refused($q$update public.audit_log set action = 'insert'$q$, 'editing the audit history', '23001');
select pg_temp.refused($q$delete from public.audit_log$q$, 'deleting the audit history', '23001');

-- ---------- companies can never mix ----------
select pg_temp.refused($q$insert into public.orders (company_id, internal_no, slip_no, slip_scheme, customer_id)
  values ('22222222-2222-2222-2222-222222222222', 2002, '2002', 'never', 'a2000000-0000-0000-0000-000000000001')$q$,
  'company B making an order for company A''s customer', '23503');
insert into public.orders (id, company_id, internal_no, slip_no, slip_scheme, customer_id)
  values ('a3000000-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 1046, '1046', 'never', 'a2000000-0000-0000-0000-000000000001');
select pg_temp.refused($q$insert into public.order_items (company_id, order_id, position, material_id, grade_code, shape, dims, sell_rate, cut_rate, density)
  values ('11111111-1111-1111-1111-111111111111', 'a3000000-0000-0000-0000-000000000006', 0, 'b1000000-0000-0000-0000-000000000001', 'MS', 'flat', '{1,1}', 1, 1, 7850)$q$,
  'company A using company B''s material', '23503');
select pg_temp.refused($q$insert into public.payments (company_id, customer_id, amount, mode, kind, side)
  values ('11111111-1111-1111-1111-111111111111', 'b2000000-0000-0000-0000-000000000001', 50, 'Cash', 'khata', 'pakka')$q$,
  'company A taking a payment from company B''s customer', '23503');
select pg_temp.refused($q$insert into public.material_rates (company_id, material_id, sell_rate, cut_rate)
  values ('22222222-2222-2222-2222-222222222222', 'a1000000-0000-0000-0000-000000000001', 1, 1)$q$,
  'company B setting a rate on company A''s material', '23503');
select pg_temp.refused($q$insert into public.orders (company_id, internal_no, slip_no, slip_scheme, customer_id)
  values ('11111111-1111-1111-1111-111111111111', 5000, '1041', 'never', 'a2000000-0000-0000-0000-000000000001')$q$,
  'two slips with the same number in one company', '23505');
select pg_temp.allowed($q$insert into public.orders (company_id, internal_no, slip_no, slip_scheme, customer_id)
  values ('22222222-2222-2222-2222-222222222222', 1041, '1041', 'never', 'b2000000-0000-0000-0000-000000000001')$q$,
  'another company using the same slip number');

-- ---------- the audit history records who did what ----------
select set_config('app.person_id', 'aaaaaaa4-0000-0000-0000-000000000000', true);
insert into public.payments (id, company_id, customer_id, amount, mode, kind, side)
  values ('a5000000-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'a2000000-0000-0000-0000-000000000002', 321, 'UPI', 'khata', 'kacha');
do $$ begin
  assert exists (select 1 from public.audit_log where entity_type = 'payments' and entity_id = 'a5000000-0000-0000-0000-000000000009'
                 and action = 'insert' and person_id = 'aaaaaaa4-0000-0000-0000-000000000000'
                 and (after ->> 'amount')::numeric = 321 and company_id = '11111111-1111-1111-1111-111111111111'),
    'the payment should be in the audit history with who recorded it';
  assert exists (select 1 from public.audit_log where entity_type = 'orders' and entity_id = 'a3000000-0000-0000-0000-000000000004'
                 and before ->> 'status' = 'weighed' and after ->> 'status' = 'done'),
    'finishing an order should be in the audit history with before and after';
end $$;
