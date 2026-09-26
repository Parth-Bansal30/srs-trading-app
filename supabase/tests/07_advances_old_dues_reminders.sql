-- @fixtures fixtures business
-- Owner decisions of 26 Sept 2026: returning / moving / keeping an advance, cancelling orders,
-- old balances from the paper khata, reminders log, and the change-rate permission.

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

insert into public.companies (id, name) values ('44444444-4444-4444-4444-444444444444', 'Test Company D');
insert into public.company_settings (company_id) values ('44444444-4444-4444-4444-444444444444');
insert into public.people (id, company_id, display_name, role, perms, active) values
  ('ddddddd1-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'Owner D', 'owner', app.role_preset('owner'), true),
  ('ddddddd2-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'Sales D (no kacha)', 'custom', '{"new":true,"orders":true,"money":true}', true),
  ('ddddddd3-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'Accounts D', 'accounts', app.role_preset('accounts'), true),
  ('ddddddd4-0000-0000-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'Weigher D', 'weigher', app.role_preset('weigher'), true);
insert into public.materials (id, company_id, code, family) values
  ('d1000000-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'EN8', 'carbon');
insert into public.material_rates (company_id, material_id, sell_rate, cut_rate, effective_from) values
  ('44444444-4444-4444-4444-444444444444', 'd1000000-0000-0000-0000-000000000001', 75, 3, now() - interval '1 day');
insert into public.customers (id, company_id, name, phone) values
  ('d2000000-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'Mehta Engineering', '98111 00001'),
  ('d2000000-0000-0000-0000-000000000002', '44444444-4444-4444-4444-444444444444', 'Other Customer', null);

do $$
declare
  owner uuid := 'ddddddd1-0000-0000-0000-000000000000'; sales uuid := 'ddddddd2-0000-0000-0000-000000000000';
  acct uuid := 'ddddddd3-0000-0000-0000-000000000000'; weigher uuid := 'ddddddd4-0000-0000-0000-000000000000';
  cust uuid := 'd2000000-0000-0000-0000-000000000001'; other uuid := 'd2000000-0000-0000-0000-000000000002';
  items jsonb := '[{"material_id":"d1000000-0000-0000-0000-000000000001","grade_code":"EN8","shape":"round","unit":"mm","dims":["32"],"sell_rate":75,"cut_rate":3,"density":7850,"lengths":[{"len":"300","pcs":12}]}]';
  r jsonb; o1 uuid; o2 uuid; o3 uuid; o4 uuid; oo uuid; adv uuid; ref uuid; mv uuid; d1 uuid; d1r uuid; it uuid;
begin
  -- ---------- change-rate permission ----------
  assert app.role_preset('owner') ? 'price' and not (app.role_preset('sales') ? 'price'), 'owners have price, sales do not';
  assert app.valid_perms('{"price":true}'), 'price is a valid permission';

  -- ---------- orders with an advance ----------
  o1 := (public.api_create_order(owner, gen_random_uuid(), 'h', cust, '{"min_inch":1}', items, true, '{"amount":10000,"mode":"Cash"}') ->> 'order_id')::uuid;
  o2 := (public.api_create_order(owner, gen_random_uuid(), 'h', cust, '{"min_inch":1}', items, true, null) ->> 'order_id')::uuid;
  oo := (public.api_create_order(owner, gen_random_uuid(), 'h', other, '{"min_inch":1}', items, true, null) ->> 'order_id')::uuid;

  -- return part of it
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'refund', 4000, 'UPI', null, null, '  ')$q$, owner, o1),
    '22023', 'returning money without a reason');
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'refund', 4000, 'Adjust', null, null, 'x')$q$, owner, o1),
    '22023', 'returning money with no real payment mode');
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'refund', 100, 'Cash', null, null, 'x')$q$, weigher, o1),
    '42501', 'weigher returning an advance');
  r := public.api_adjust_advance(owner, gen_random_uuid(), 'h', o1, 'refund', 4000, 'UPI', null, null, 'Customer wants to pay whole bill by bank transfer');
  assert (r -> 'paid' ->> 'advance')::numeric = 6000, 'advance now 6,000: ' || r::text;
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'refund', 6000.01, 'Cash', null, null, 'x')$q$, owner, o1),
    '22023', 'returning more than is left');

  -- move to another order of the same customer
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'move', 100, null, %L, null, null)$q$, owner, o1, oo),
    '22023', 'moving to another customer''s order');
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'move', 100, null, %L, null, null)$q$, owner, o1, o1),
    '22023', 'moving to the same order');
  r := public.api_adjust_advance(owner, gen_random_uuid(), 'h', o1, 'move', 2000, null, o2, null, null);
  assert (app.order_paid(o1) ->> 'advance')::numeric = 4000 and (app.order_paid(o2) ->> 'advance')::numeric = 2000, 'moved 2,000';
  assert (select mode from public.payments where id = (r ->> 'linked_payment_id')::uuid) = 'Adjust', 'a move is not cash';

  -- keep as credit
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'credit', 1000, null, null, 'kacha', null)$q$, sales, o1),
    '42501', 'kacha credit by someone without kacha permission');
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'credit', 1000, null, null, null, null)$q$, owner, o1),
    '23514', 'credit without choosing the account (backstop: the payment rules refuse it; the api asks first with a friendly message)');
  r := public.api_adjust_advance(owner, gen_random_uuid(), 'h', o1, 'credit', 1000, null, null, 'pakka', null);
  assert exists (select 1 from public.payments where customer_id = cust and kind = 'khata' and mode = 'Adjust' and side = 'pakka' and amount = 1000), 'credit held';

  -- direct writes that would break the rules
  perform pg_temp.expect(format($q$insert into public.payments (company_id, customer_id, order_id, amount, mode, kind) values ('44444444-4444-4444-4444-444444444444', %L, %L, 500, 'Adjust', 'advance')$q$, cust, o2),
    '23514', 'an "Adjust" advance that was not moved from anywhere');
  perform pg_temp.expect(format($q$insert into public.payments (company_id, customer_id, order_id, amount, mode, kind) values ('44444444-4444-4444-4444-444444444444', %L, %L, 500, 'Cash', 'refund')$q$, cust, o2),
    '23514', 'a refund with a positive amount');

  -- cancelling
  perform pg_temp.expect(format($q$select public.api_cancel_order(%L, gen_random_uuid(), 'h', %L, 'customer changed mind')$q$, owner, o1),
    '23514', 'cancelling while 3,000 advance is still on it');
  select id into adv from public.payments where order_id = o1 and kind = 'advance';
  perform public.api_adjust_advance(owner, gen_random_uuid(), 'h', o1, 'refund', 3000, 'Cash', null, null, 'order cancelled');
  perform pg_temp.expect(format($q$select public.api_cancel_order(%L, gen_random_uuid(), 'h', %L, ' ')$q$, owner, o1), '22023', 'cancelling without a reason');
  perform pg_temp.expect(format($q$select public.api_cancel_order(%L, gen_random_uuid(), 'h', %L, 'x')$q$, weigher, o1), '42501', 'weigher cancelling');
  r := public.api_cancel_order(owner, gen_random_uuid(), 'h', o1, 'Customer changed his mind');
  assert r ->> 'status' = 'cancelled', 'cancelled';
  perform pg_temp.expect(format($q$select public.api_cancel_order(%L, gen_random_uuid(), 'h', %L, 'again')$q$, owner, o1), '23001', 'cancelling twice');
  perform pg_temp.expect(format($q$select public.api_add_advance(%L, gen_random_uuid(), 'h', %L, 100, 'Cash', null)$q$, owner, o1), '23514', 'advance on a cancelled order');
  perform pg_temp.expect(format($q$update public.orders set cancel_reason = 'edited' where id = %L$q$, o1), '23001', 'editing a cancelled order');
  perform pg_temp.expect(format($q$select public.api_reverse_payment(%L, gen_random_uuid(), 'h', %L, 'x')$q$, owner, adv), '23001', 'reversing a payment of a cancelled order');
  assert public.api_weighing_list(weigher, o1) = '[]'::jsonb, 'cancelled orders are not weighed';

  -- an advance that was partly moved can't be reversed in full
  o3 := (public.api_create_order(owner, gen_random_uuid(), 'h', cust, '{"min_inch":1}', items, true, '{"amount":5000,"mode":"Cash"}') ->> 'order_id')::uuid;
  perform public.api_adjust_advance(owner, gen_random_uuid(), 'h', o3, 'move', 3000, null, o2, null, null);
  select id into adv from public.payments where order_id = o3 and kind = 'advance';
  perform pg_temp.expect(format($q$select public.api_reverse_payment(%L, gen_random_uuid(), 'h', %L, 'x')$q$, owner, adv), '23514', 'reversing an advance that was partly moved');
  select id into mv from public.payments where order_id = o2 and mode = 'Adjust' limit 1;
  perform pg_temp.expect(format($q$select public.api_reverse_payment(%L, gen_random_uuid(), 'h', %L, 'x')$q$, owner, mv), '23514', 'reversing a moved advance');

  -- extra paid after finishing can be returned (only the extra)
  o4 := (public.api_create_order(owner, gen_random_uuid(), 'h', cust, '{"min_inch":1}', items, true, '{"amount":2000,"mode":"Cash"}') ->> 'order_id')::uuid;
  select id into it from public.order_items where order_id = o4;
  perform public.api_record_weights(owner, gen_random_uuid(), 'h', o4, jsonb_build_array(jsonb_build_object('item_id', it, 'weight', 22.73)), '[]', true);
  perform public.api_finalize_order(owner, gen_random_uuid(), 'h', o4, jsonb_build_object('bill', 'pakka', 'gst_pct', 18, 'kacha_pct', 10,
    'pay_mode', 'now', 'paid_now', 0, 'in_khata', true, 'basis', jsonb_build_object('advance', 2000, 'weights', jsonb_build_object(it, 22.73)),
    'totals', jsonb_build_object('weight', 22.73, 'base', 1100, 'material', 1000, 'cutting', 100, 'gst', 198, 'total', 1298)));
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'refund', 702.01, 'Cash', null, null, 'extra')$q$, owner, o4),
    '22023', 'returning more than the extra');
  perform pg_temp.expect(format($q$select public.api_adjust_advance(%L, gen_random_uuid(), 'h', %L, 'move', 100, null, %L, null, null)$q$, owner, o4, o2),
    '23001', 'moving money off a finished order');
  r := public.api_adjust_advance(owner, gen_random_uuid(), 'h', o4, 'refund', 702, 'Cash', null, null, 'extra advance returned');
  assert (app.order_paid(o4) ->> 'total')::numeric = 1298, 'now paid exactly the bill';
  select id into ref from public.payments where order_id = o4 and kind = 'refund';
  perform pg_temp.expect(format($q$select public.api_reverse_payment(%L, gen_random_uuid(), 'h', %L, 'x')$q$, owner, ref), '23514', 'reversing a returned-money entry');

  -- cash count: cash in 10,000 + 5,000 + 2,000 − cash out 3,000 − 702 (UPI refund and moves don't count)
  r := public.api_save_cash_count(owner, gen_random_uuid(), 'h', 13298, null);
  assert (r ->> 'expected')::numeric = 13298, 'expected cash counts returns: ' || r::text;

  -- ---------- old balances ----------
  r := public.api_add_old_due(acct, gen_random_uuid(), 'h', cust, 'pakka', null, current_date - 60, 20000, 'from paper khata');
  d1 := (r ->> 'old_due_id')::uuid;
  perform public.api_add_old_due(owner, gen_random_uuid(), 'h', cust, 'kacha', '553', current_date - 45, 5000, null);
  perform pg_temp.expect(format($q$select public.api_add_old_due(%L, gen_random_uuid(), 'h', %L, 'kacha', null, current_date - 5, 100, null)$q$, acct, cust),
    '42501', 'kacha old balance by someone without kacha permission');
  perform pg_temp.expect(format($q$select public.api_add_old_due(%L, gen_random_uuid(), 'h', %L, 'pakka', null, current_date - 5, 100, null)$q$, sales, cust),
    '42501', 'old balance by someone without khata permission');
  perform pg_temp.expect(format($q$select public.api_add_old_due(%L, gen_random_uuid(), 'h', %L, 'pakka', null, current_date + 5, 100, null)$q$, owner, cust),
    '23514', 'old balance dated in the future');
  perform pg_temp.expect(format($q$select public.api_add_old_due(%L, gen_random_uuid(), 'h', %L, 'pakka', null, current_date, 0, null)$q$, owner, cust),
    '22023', 'old balance of 0');
  perform pg_temp.expect(format($q$select public.api_add_old_due(%L, gen_random_uuid(), 'h', 'a2000000-0000-0000-0000-000000000001', 'pakka', null, current_date, 10, null)$q$, owner),
    '23503', 'old balance for another company''s customer');
  perform pg_temp.expect(format($q$update public.old_dues set amount = 1 where id = %L$q$, d1), '23001', 'editing an old balance');
  r := public.api_reverse_old_due(owner, gen_random_uuid(), 'h', d1, 'typed wrong amount');
  d1r := (r ->> 'reversal_id')::uuid;
  assert (select sum(amount) from public.old_dues where customer_id = cust and side = 'pakka') = 0, 'corrected to zero';
  perform pg_temp.expect(format($q$select public.api_reverse_old_due(%L, gen_random_uuid(), 'h', %L, 'again')$q$, owner, d1), '23505', 'correcting twice');
  perform pg_temp.expect(format($q$select public.api_reverse_old_due(%L, gen_random_uuid(), 'h', %L, 'x')$q$, owner, d1r), '23514', 'correcting a correction');

  -- ---------- khata data for the maths (limited to what the caller may see) ----------
  r := public.api_khata_data(owner, cust);
  assert jsonb_array_length(r -> 'old_dues') = 3 and r ->> 'timezone' = 'Asia/Kolkata', 'owner sees all old dues';
  assert exists (select 1 from jsonb_array_elements(r -> 'orders') o where o ->> 'status' = 'cancelled'), 'orders with payments included';
  r := public.api_khata_data(acct, cust);
  assert not exists (select 1 from jsonb_array_elements(r -> 'old_dues') d where d ->> 'side' = 'kacha'), 'no kacha for accounts';
  perform pg_temp.expect(format($q$select public.api_khata_data(%L)$q$, weigher), '42501', 'weigher reading the khata');

  -- ---------- reminders ----------
  perform pg_temp.expect(format($q$select public.api_record_reminder(%L, gen_random_uuid(), 'h', %L, 'pakka', 'whatsapp_link', '+919811100001', 'x', 100, '{}')$q$, sales, cust),
    '42501', 'reminder by someone without khata permission');
  perform pg_temp.expect(format($q$select public.api_record_reminder(%L, gen_random_uuid(), 'h', %L, 'kacha', 'whatsapp_link', '+919811100001', 'x', 100, '{}')$q$, acct, cust),
    '42501', 'kacha reminder by someone without kacha permission');
  perform pg_temp.expect(format($q$select public.api_record_reminder(%L, gen_random_uuid(), 'h', %L, 'pakka', 'whatsapp_link', '12345', 'x', 100, '{}')$q$, owner, cust),
    '23514', 'reminder to a wrong number');
  r := public.api_record_reminder(acct, gen_random_uuid(), 'h', cust, 'pakka', 'whatsapp_link', '+919811100001', 'Namaste…', 1298, '{1042}');
  assert r ? 'reminder_id', 'reminder logged';
  assert jsonb_array_length(public.api_khata_data(owner, cust) -> 'last_reminders') = 1, 'last reminder remembered';
  perform pg_temp.expect(format($q$select public.api_change_settings(%L, gen_random_uuid(), 'h', '{"reminder_after_days": 0}')$q$, owner), '23514', 'reminder after 0 days');
  r := public.api_change_settings(owner, gen_random_uuid(), 'h', '{"reminder_after_days": 20, "reminder_repeat_days": 10}');
  assert (r ->> 'reminder_after_days')::int = 20, 'reminder settings saved';
end $$;
