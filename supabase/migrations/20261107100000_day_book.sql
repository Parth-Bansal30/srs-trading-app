-- 7 Nov 2026 (plan v2, step 11): the Day book — one day, a week or a month at a glance: sales (GST bill / no bill),
-- money in and out, what was bought, a rough profit, GST for the CA, and the stock as on any day. Read-only: it only
-- gathers what is already in the app (the sums are worked out by @srs/core on the server). No-bill figures are shown only
-- to people who may see them; bought / money out only to those with those permissions.

/** The shop's days in a range as [start, end) instants. */
create function app.day_start(p_company uuid, p_day date) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select (p_day::timestamp at time zone (select timezone from public.companies where id = p_company))
$$;

create function public.api_day_book(p_caller uuid, p_from date, p_to date, p_prev_from date, p_prev_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); tz text; t0 timestamptz; t1 timestamptz; k boolean; v_stock boolean; v_exp boolean;
begin
  perform app.require(c, 'money');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Choose the days.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  t0 := app.day_start(c.company_id, p_from); t1 := app.day_start(c.company_id, p_to + 1);
  k := app.has(c, 'kacha'); v_stock := app.has(c, 'stock'); v_exp := app.has(c, 'expenses');
  return jsonb_build_object(
    'kacha', k,
    -- finished slips (deleted ones are not sales)
    'slips', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'customer', cu.name, 'customer_id', o.customer_id,
        'bill', o.bill_type, 'total', o.total_amount, 'base', o.base_amount, 'gst', o.gst_amount, 'kg', o.total_weight,
        'at', o.done_at, 'day', (o.done_at at time zone tz)::date, 'direct', o.direct_purchase_id is not null,
        'paid', coalesce((select sum(p.amount) from public.payments p where p.company_id = o.company_id and p.order_id = o.id), 0),
        'items', (select coalesce(jsonb_agg(jsonb_build_object('g', i.grade_code, 'sh', i.shape, 'd', i.dims, 'u', i.unit, 'kg', i.actual_weight) order by i.position), '[]'::jsonb)
                  from public.order_items i where i.company_id = o.company_id and i.order_id = o.id),
        -- what the steel cost (only for people who may see costs, as on the stock screen): from the stock it came out of
        -- (its real cost per kg), or a direct delivery's bill
        'cost', case when not v_stock then null when o.direct_purchase_id is not null then
                  (select pu.total_amount - pu.gst_amount from public.purchases pu where pu.company_id = o.company_id and pu.id = o.direct_purchase_id and pu.status = 'saved')
                else (select case when count(*) > 0 then sum(-m.qty_kg * coalesce(nullif(si.cost, 0), si.rate)) end
                      from public.stock_moves m join public.stock_items si on si.company_id = m.company_id and si.id = m.stock_item_id
                      where m.company_id = o.company_id and m.order_id = o.id and m.kind in ('sale', 'sale_undo')) end)
      order by o.done_at desc)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.status = 'done' and o.done_at >= t0 and o.done_at < t1 and (k or o.bill_type = 'pakka')), '[]'::jsonb),
    'prev', case when p_prev_from is not null and p_prev_to is not null then (
      select jsonb_build_object('total', coalesce(sum(o.total_amount), 0), 'slips', count(*)) from public.orders o
      where o.company_id = c.company_id and o.status = 'done' and (k or o.bill_type = 'pakka')
        and o.done_at >= app.day_start(c.company_id, p_prev_from) and o.done_at < app.day_start(c.company_id, p_prev_to + 1)) end,
    -- money that really came in (no moves inside the khata, nothing cancelled), cash vs bank / UPI
    'money_in', coalesce((select jsonb_agg(jsonb_build_object('mode', pp.mode, 'amount', pp.amount, 'kind', p.kind, 'day', (p.received_at at time zone tz)::date))
      from public.payments p join public.payment_parts pp on pp.company_id = p.company_id and pp.payment_id = p.id
      where p.company_id = c.company_id and p.received_at >= t0 and p.received_at < t1 and p.amount > 0
        and p.kind not in ('reversal', 'transfer', 'join') and p.from_payment_id is null
        and not exists (select 1 from public.payments r where r.company_id = p.company_id and r.reverses_payment_id = p.id)
        and (k or (coalesce(p.side, (select o.bill_type from public.orders o where o.company_id = p.company_id and o.id = p.order_id)) is distinct from 'kacha'))), '[]'::jsonb),
    'money_out', case when v_exp then coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'category', e.category, 'amount', e.amount,
        'cash', a.kind in ('cash', 'safe'), 'gst', case when e.gst_bill then coalesce(e.gst_amount, 0) else 0 end, 'day', e.business_date))
      from public.expenses e join public.money_accounts a on a.company_id = e.company_id and a.id = e.account_id
      where e.company_id = c.company_id and e.status = 'ok' and e.business_date between p_from and p_to), '[]'::jsonb) end,
    'bought', case when v_stock then coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'supplier', s.name, 'supplier_id', p.supplier_id, 'bill_no', p.bill_no,
        'date', p.bill_date, 'bill', p.bill_type, 'total', p.total_amount, 'gst', p.gst_amount, 'kg', p.total_kg, 'effect', p.stock_effect,
        'first', (select l.description from public.purchase_lines l where l.company_id = p.company_id and l.purchase_id = p.id order by l.position limit 1),
        'paid', p.pay_status = 'paid', 'left', app.purchase_left(p.id),
        'due', case when s.credit_days is not null then p.bill_date + s.credit_days end) order by p.bill_date desc, p.created_at desc)
      from public.purchases p left join public.suppliers s on s.company_id = p.company_id and s.id = p.supplier_id
      where p.company_id = c.company_id and p.kind = 'bill' and p.status = 'saved' and p.bill_date between p_from and p_to
        and (k or p.bill_type = 'pakka')), '[]'::jsonb) end,
    -- every supplier bill still to pay today (not only this period)
    'to_pay', case when v_stock then (select jsonb_build_object('amount', coalesce(sum(x.left), 0), 'bills', count(*), 'oldest', min(x.bill_date))
      from (select p.bill_date, app.purchase_left(p.id) as left from public.purchases p
            where p.company_id = c.company_id and p.kind = 'bill' and p.status = 'saved' and p.pay_status <> 'paid'
              and p.stock_effect in ('stock', 'direct') and (k or p.bill_type = 'pakka')) x where x.left > 0) end);
end $$;

/** Sales per shop day (the calendar's colours and the month's bars). */
create function public.api_sales_days(p_caller uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); tz text; k boolean;
begin
  perform app.require(c, 'money');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Choose the days.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  k := app.has(c, 'kacha');
  return coalesce((select jsonb_agg(jsonb_build_object('day', d, 'total', total, 'slips', n) order by d) from (
      select (o.done_at at time zone tz)::date as d, sum(o.total_amount) as total, count(*) as n from public.orders o
      where o.company_id = c.company_id and o.status = 'done' and (k or o.bill_type = 'pakka')
        and o.done_at >= app.day_start(c.company_id, p_from) and o.done_at < app.day_start(c.company_id, p_to + 1)
      group by 1) x), '[]'::jsonb);
end $$;

/** The stock as it was at the end of a day, and what came in / went out from p_from to that day; what it is now. */
create function public.api_stock_on(p_caller uuid, p_day date, p_from date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); t0 timestamptz; t1 timestamptz; v_cost boolean;
begin
  perform app.require(c, 'orders');
  v_cost := app.has(c, 'stock');   -- what the steel cost: only for people who may see costs
  if p_day is null then raise exception 'Choose the day.' using errcode = '22023'; end if;
  t1 := app.day_start(c.company_id, p_day + 1);
  t0 := app.day_start(c.company_id, coalesce(p_from, p_day));
  return coalesce((select jsonb_agg(jsonb_build_object('material_id', m.id, 'code', m.code, 'shape', si.shape, 'stock_item_id', si.id, 'label', si.label,
        'cost', case when v_cost then coalesce(nullif(si.cost, 0), si.rate) end,
        'then', coalesce((select sum(x.qty_kg) from public.stock_moves x where x.company_id = si.company_id and x.stock_item_id = si.id and x.created_at < t1), 0),
        'in', coalesce((select sum(x.qty_kg) from public.stock_moves x where x.company_id = si.company_id and x.stock_item_id = si.id
                        and x.created_at >= t0 and x.created_at < t1 and x.qty_kg > 0 and x.kind in ('purchase')), 0),
        'out', coalesce((select -sum(x.qty_kg) from public.stock_moves x where x.company_id = si.company_id and x.stock_item_id = si.id
                         and x.created_at >= t0 and x.created_at < t1 and x.kind in ('sale', 'sale_undo')), 0),
        'now', coalesce((select sum(x.qty_kg) from public.stock_moves x where x.company_id = si.company_id and x.stock_item_id = si.id), 0))
      order by m.code, si.shape)
    from public.stock_items si join public.materials m on m.company_id = si.company_id and m.id = si.material_id
    where si.company_id = c.company_id
      and exists (select 1 from public.stock_moves x where x.company_id = si.company_id and x.stock_item_id = si.id and x.created_at < t1)), '[]'::jsonb);
end $$;

revoke all on function app.day_start(uuid, date), public.api_day_book(uuid, date, date, date, date), public.api_sales_days(uuid, date, date),
  public.api_stock_on(uuid, date, date) from public, anon, authenticated;
grant execute on function public.api_day_book(uuid, date, date, date, date), public.api_sales_days(uuid, date, date),
  public.api_stock_on(uuid, date, date) to service_role;
