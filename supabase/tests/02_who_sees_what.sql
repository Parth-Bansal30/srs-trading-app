-- @fixtures fixtures business
-- Every role, both companies: exactly the right rows, nothing else.
create temp table seen (who text, what text, n bigint);
grant all on seen to authenticated;

create function pg_temp.look(who text) returns void language plpgsql as $$
begin
  insert into seen select who, t, n from (values
    ('companies',              (select count(*) from public.companies)),
    ('people',                 (select count(*) from public.people)),
    ('materials',              (select count(*) from public.materials)),
    ('material_rates',         (select count(*) from public.material_rates)),
    ('current_material_rates', (select count(*) from public.current_material_rates)),
    ('customers',              (select count(*) from public.customers)),
    ('customer_rates',         (select count(*) from public.customer_rates)),
    ('orders',                 (select count(*) from public.orders)),
    ('kacha_orders',           (select count(*) from public.orders where bill_type = 'kacha')),
    ('order_items',            (select count(*) from public.order_items)),
    ('order_item_lengths',     (select count(*) from public.order_item_lengths)),
    ('payments',               (select count(*) from public.payments)),
    ('cash_closes',            (select count(*) from public.cash_closes)),
    ('audit_log',              (select count(*) from public.audit_log)),
    ('other_company_rows',     (select count(*) from public.orders o where o.company_id is distinct from (select app.current_company_id()))
                             + (select count(*) from public.payments p where p.company_id is distinct from (select app.current_company_id()))
                             + (select count(*) from public.audit_log a where a.company_id is distinct from (select app.current_company_id())))
  ) v(t, n);
end $$;
grant execute on function pg_temp.look(text) to authenticated;

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000a","session_id":"a0000000-0000-0000-0000-00000000000a","role":"authenticated"}'; select pg_temp.look('owner_a');
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000b","session_id":"a0000000-0000-0000-0000-00000000000b","role":"authenticated"}'; select pg_temp.look('weigher_a');
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000c","session_id":"a0000000-0000-0000-0000-00000000000c","role":"authenticated"}'; select pg_temp.look('sales_nokacha_a');
set local request.jwt.claims = '{"sub":"a0000000-0000-0000-0000-00000000000d","session_id":"a0000000-0000-0000-0000-00000000000d","role":"authenticated"}'; select pg_temp.look('accounts_a');
set local request.jwt.claims = '{"sub":"b0000000-0000-0000-0000-00000000000a","session_id":"b0000000-0000-0000-0000-00000000000a","role":"authenticated"}'; select pg_temp.look('owner_b');
set local request.jwt.claims = '{"sub":"c0000000-0000-0000-0000-000000000000","session_id":"c0000000-0000-0000-0000-000000000000","role":"authenticated"}'; select pg_temp.look('stranger');
reset role;

do $$
declare r record; bad text := '';
begin
  for r in
    select e.who, e.what, e.n as expected, coalesce(s.n, -1) as got
    from (values
      -- owner A: everything of A
      ('owner_a','companies',1), ('owner_a','people',5), ('owner_a','materials',2), ('owner_a','material_rates',4),
      ('owner_a','current_material_rates',2), ('owner_a','customers',2), ('owner_a','customer_rates',3), ('owner_a','orders',4),
      ('owner_a','kacha_orders',1), ('owner_a','order_items',4), ('owner_a','order_item_lengths',5), ('owner_a','payments',5),
      ('owner_a','cash_closes',1), ('owner_a','other_company_rows',0),
      -- weigher A: grades and customers, but no money at all
      ('weigher_a','materials',2), ('weigher_a','customers',2), ('weigher_a','material_rates',0), ('weigher_a','current_material_rates',0),
      ('weigher_a','customer_rates',0), ('weigher_a','orders',0), ('weigher_a','order_items',0), ('weigher_a','order_item_lengths',0),
      ('weigher_a','payments',0), ('weigher_a','cash_closes',0), ('weigher_a','audit_log',0),
      -- sales without kacha: no kacha order, no kacha payments, no cash count, no audit history
      ('sales_nokacha_a','orders',3), ('sales_nokacha_a','kacha_orders',0), ('sales_nokacha_a','order_items',3),
      ('sales_nokacha_a','order_item_lengths',4), ('sales_nokacha_a','payments',3), ('sales_nokacha_a','cash_closes',0),
      ('sales_nokacha_a','audit_log',0), ('sales_nokacha_a','material_rates',4),
      -- accounts (money + today, no kacha): same money view as sales, plus the cash count
      ('accounts_a','orders',3), ('accounts_a','kacha_orders',0), ('accounts_a','payments',3), ('accounts_a','cash_closes',1), ('accounts_a','audit_log',0),
      -- owner B: only B
      ('owner_b','companies',1), ('owner_b','people',1), ('owner_b','materials',1), ('owner_b','customers',1), ('owner_b','orders',1),
      ('owner_b','order_items',1), ('owner_b','payments',1), ('owner_b','cash_closes',1), ('owner_b','other_company_rows',0),
      -- signed in but not staff: nothing
      ('stranger','companies',0), ('stranger','people',0), ('stranger','materials',0), ('stranger','customers',0),
      ('stranger','orders',0), ('stranger','payments',0), ('stranger','audit_log',0)
    ) e(who, what, n)
    left join seen s on s.who = e.who and s.what = e.what
  loop
    if r.got <> r.expected then bad := bad || format(E'\n  %s / %s: expected %s, got %s', r.who, r.what, r.expected, r.got); end if;
  end loop;
  if bad <> '' then raise exception 'Visibility mismatch:%', bad; end if;
  assert (select n from seen where who = 'owner_a' and what = 'audit_log') > 0, 'owner A should see their audit history';
  assert (select n from seen where who = 'owner_b' and what = 'audit_log') > 0, 'owner B should see their audit history';
end $$;

-- Current rates: the latest rate that has started — not the old one, not the future one.
do $$ begin
  assert (select sell_rate from public.current_material_rates where material_id = 'a1000000-0000-0000-0000-000000000001') = 75,
    'EN8 current rate should be 75 (70 is old, 80 starts next month)';
  assert (select rate from public.current_customer_rates
          where customer_id = 'a2000000-0000-0000-0000-000000000001' and material_id = 'a1000000-0000-0000-0000-000000000002') is null,
    'Sharma special rate on EN24 was removed, so the current special rate is empty';
  assert (select count(*) from public.material_rates where material_id = 'a1000000-0000-0000-0000-000000000001') = 3,
    'all three EN8 rates are kept in history';
end $$;
