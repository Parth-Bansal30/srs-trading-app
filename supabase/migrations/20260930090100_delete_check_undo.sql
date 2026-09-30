-- 18. Deleting a slip: tell the app, per slip, whether "the money was never really received"
-- (reverse every payment) is possible. It isn't when part of the money was already given back or
-- moved, or came in from another slip — then only "kept as credit" or "gave it back" are offered.
create or replace function public.api_delete_check(p_caller uuid, p_orders uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); n int;
begin
  perform app.require(c, 'delete');
  n := coalesce(cardinality(p_orders), 0);
  if n = 0 or n > 50 then raise exception 'Choose 1 to 50 slips.' using errcode = '22023'; end if;
  if (select count(*) from public.orders o where o.company_id = c.company_id and o.id = any (p_orders)
        and o.status <> 'deleted' and (app.has(c, 'kacha') or o.bill_type is distinct from 'kacha')) <> n then
    raise exception 'A slip is missing or already deleted.' using errcode = '22023';
  end if;
  return jsonb_build_object('phone', c.phone,
    'orders', (select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'status', o.status, 'customer', cu.name,
        'bill', o.bill_type, 'total', o.total_amount, 'in_khata', o.in_khata,
        'paid', (select coalesce(sum(p.amount), 0) from public.payments p where p.order_id = o.id),
        'can_undo', not exists (select 1 from public.payments p where p.order_id = o.id
                                  and (p.kind in ('refund','transfer') or p.from_payment_id is not null))) order by o.internal_no)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.id = any (p_orders)));
end $$;
revoke all on function public.api_delete_check(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.api_delete_check(uuid, uuid[]) to service_role;
