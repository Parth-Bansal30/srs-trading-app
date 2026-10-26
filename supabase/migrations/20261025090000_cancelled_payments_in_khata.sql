-- 25 Oct 2026 — the owner can cancel a wrong payment and give money back from a customer's account.
-- The rules were already in the database (a payment is cancelled once, a moved advance or money given back can't be
-- cancelled, a cancellation mirrors the payment's accounts so the cash book follows). New here: the khata data says
-- which payment a cancellation belongs to ('reverses') and who cancelled it ('by'), so the screen shows the payment
-- crossed out with the reason and the name instead of a second, minus line. (Owner-only is checked in the api.)
create or replace function public.api_khata_data(p_caller uuid, p_customer uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'money');
  k := app.has(c, 'kacha');
  return jsonb_build_object(
    'timezone', (select timezone from public.companies where id = c.company_id),
    'shop', (select coalesce(nullif(s.slip_header ->> 'name', ''), co.name) from public.companies co
               join public.company_settings s on s.company_id = co.id where co.id = c.company_id),
    'settings', (select jsonb_build_object('reminder_after_days', reminder_after_days, 'reminder_repeat_days', reminder_repeat_days)
                 from public.company_settings where company_id = c.company_id),
    'customers', coalesce((select jsonb_agg(jsonb_build_object('id', cu.id, 'name', cu.name, 'phone', cu.phone, 'active', cu.active) order by cu.name)
      from public.customers cu where cu.company_id = c.company_id and (p_customer is null or cu.id = p_customer)), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'customer_id', o.customer_id, 'status', o.status,
        'bill', o.bill_type, 'in_khata', o.in_khata, 'total', o.total_amount, 'done_at', o.done_at, 'created_at', o.created_at))
      from public.orders o where o.company_id = c.company_id and (p_customer is null or o.customer_id = p_customer)
        and (k or o.bill_type is distinct from 'kacha')
        and ((o.status = 'done' and o.in_khata) or exists (select 1 from public.payments p where p.order_id = o.id))), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'customer_id', p.customer_id, 'order_id', p.order_id,
        'amount', p.amount, 'mode', p.mode, 'kind', coalesce(r.kind, p.kind), 'side', p.side, 'note', p.note, 'at', p.received_at,
        'reverses', p.reverses_payment_id, 'by', case when p.reverses_payment_id is not null then pe.display_name end)
        order by p.received_at)
      from public.payments p left join public.payments r on r.id = p.reverses_payment_id
        left join public.orders o on o.id = p.order_id
        left join public.people pe on pe.company_id = p.company_id and pe.id = p.created_by
      where p.company_id = c.company_id and (p_customer is null or p.customer_id = p_customer)
        and (k or (coalesce(p.side, 'pakka') = 'pakka' and o.bill_type is distinct from 'kacha'))), '[]'::jsonb),
    'old_dues', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'customer_id', d.customer_id, 'side', d.side, 'ref', d.ref,
        'date', d.due_date, 'amount', d.amount, 'reverses_id', d.reverses_id, 'note', d.note))
      from public.old_dues d where d.company_id = c.company_id and (p_customer is null or d.customer_id = p_customer)
        and (k or d.side = 'pakka')), '[]'::jsonb),
    'last_reminders', coalesce((select jsonb_agg(jsonb_build_object('customer_id', x.customer_id, 'side', x.side, 'at', x.at))
      from (select customer_id, side, max(created_at) as at from public.reminders
            where company_id = c.company_id and (k or side = 'pakka') group by customer_id, side) x), '[]'::jsonb));
end $$;
