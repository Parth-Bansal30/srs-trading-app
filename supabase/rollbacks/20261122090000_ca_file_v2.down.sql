-- Undo 20261122090000_ca_file_v2: the CA's month, the Tally bill no. and the delete check as they were (6 Nov / 1 Oct 2026).

drop trigger if exists tally_cancel_card on public.orders;
drop function if exists app.tally_cancel_card();
drop function if exists public.api_tally_cancel(uuid, uuid, text, uuid, text, text, date);
drop function if exists public.api_ca_sent(uuid, uuid, text, text, text, int, numeric);
drop function if exists public.api_gst_bills(uuid, date, date);
drop function if exists public.api_slip_tally(uuid, uuid, text, uuid, text, date, boolean, numeric);
drop table if exists public.ca_sends;
delete from public.review_items where kind = 'tally_cancel';
alter table public.slip_gst drop constraint if exists slip_gst_cn, drop constraint if exists slip_gst_cn_by_fk,
  drop column if exists tally_total, drop column if exists cancel_how, drop column if exists cn_no, drop column if exists cn_date,
  drop column if exists cn_by, drop column if exists cn_at;

create function public.api_slip_tally(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_no text, p_date date, p_force boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; g public.slip_gst; v_no text := nullif(btrim(coalesce(p_no, '')), ''); twin int;
begin
  perform app.require(c, 'money', 'khata');
  prev := app.idem_start(c.company_id, p_key, 'slipTally', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where company_id = c.company_id and id = p_order;
  if o.id is null or o.status <> 'done' or o.bill_type is distinct from 'pakka' then
    raise exception 'Only a finished GST slip gets a Tally bill no.' using errcode = '22023';
  end if;
  if v_no is not null and length(v_no) > 40 then raise exception 'The Tally bill no. is too long.' using errcode = '22023'; end if;
  select * into g from public.slip_gst where company_id = c.company_id and order_id = o.id for update;
  if v_no is null and g.tally_no is not null and not app.has(c, 'settings') then
    raise exception 'Only the owner can take a Tally bill no. off.' using errcode = '42501';
  end if;
  if v_no is not null and not coalesce(p_force, false) then
    select x.slip_no into twin from public.slip_gst s join public.orders x on x.company_id = s.company_id and x.id = s.order_id
      where s.company_id = c.company_id and s.order_id <> o.id and lower(btrim(s.tally_no)) = lower(v_no) and x.status = 'done' limit 1;
    if twin is not null then
      raise exception 'Tally bill % is already on slip #% — the same bill on two slips?', v_no, twin using errcode = '23505';
    end if;
  end if;
  insert into public.slip_gst as s (company_id, order_id, tally_no, tally_date, tally_by, tally_at, updated_by, updated_at)
    values (c.company_id, o.id, v_no, case when v_no is not null then coalesce(p_date, (now() at time zone (select timezone from public.companies where id = c.company_id))::date) end,
            case when v_no is not null then c.id end, case when v_no is not null then now() end, c.id, now())
    on conflict (company_id, order_id) do update set tally_no = excluded.tally_no, tally_date = excluded.tally_date, tally_by = excluded.tally_by,
      tally_at = excluded.tally_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'tally_no', v_no));
end $$;

create or replace function public.api_gst_month(p_caller uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); tz text;
begin
  perform app.require(c, 'money', 'khata');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'Choose the month.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  return jsonb_build_object(
    'shop', (select jsonb_build_object('name', name, 'gstin', gstin, 'state', app.shop_state(id)) from public.companies where id = c.company_id),
    'settings', (select jsonb_build_object('gst_pct', gst_pct, 'min_inch', min_inch) from public.company_settings where company_id = c.company_id),
    'slips', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'date', (o.done_at at time zone tz)::date,
        'customer', cu.name, 'gstin', cu.gstin, 'gst_pct', o.gst_pct, 'base', o.base_amount, 'gst', o.gst_amount, 'total', o.total_amount,
        'material', o.material_amount, 'cutting', o.cutting_amount, 'min_inch', o.pricing_rules -> 'min_inch',
        'direct', o.direct_purchase_id is not null,
        'gst_details', case when g.order_id is not null then jsonb_build_object('delivery', g.delivery, 'dest_state', g.dest_state, 'pos', g.pos,
            'items', g.items, 'tally_no', g.tally_no, 'tally_date', g.tally_date) end,
        'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'material_id', i.material_id, 'grade_code', i.grade_code, 'shape', i.shape,
            'unit', i.unit, 'dims', i.dims, 'sell_rate', i.sell_rate, 'cut_rate', i.cut_rate, 'density', i.density, 'actual_weight', i.actual_weight,
            'by_weight', i.by_weight, 'hsn_now', m.hsn, 'gst_rate_now', m.gst_rate, 'hsn_checked_now', m.hsn_checked_at is not null,
            'lengths', (select coalesce(jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs, 'cuts', l.cuts) order by l.position), '[]'::jsonb)
                        from public.order_item_lengths l where l.company_id = i.company_id and l.order_item_id = i.id)) order by i.position), '[]'::jsonb)
          from public.order_items i join public.materials m on m.company_id = i.company_id and m.id = i.material_id
          where i.company_id = o.company_id and i.order_id = o.id)) order by o.done_at)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      left join public.slip_gst g on g.company_id = o.company_id and g.order_id = o.id
      where o.company_id = c.company_id and o.status = 'done' and o.bill_type = 'pakka'
        and (o.done_at at time zone tz)::date between p_from and p_to), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'bill_no', p.bill_no, 'date', p.bill_date, 'supplier', s.name, 'gstin', s.gstin,
        'gst', p.gst_amount, 'freight', p.freight, 'other', p.other_charges, 'round_off', p.round_off, 'total', p.total_amount, 'stock_effect', p.stock_effect,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('hsn', l.hsn, 'description', l.description, 'kg', l.qty_kg, 'amount', l.amount) order by l.position), '[]'::jsonb)
                  from public.purchase_lines l where l.company_id = p.company_id and l.purchase_id = p.id)) order by p.bill_date, p.created_at)
      from public.purchases p left join public.suppliers s on s.company_id = p.company_id and s.id = p.supplier_id
      where p.company_id = c.company_id and p.kind = 'bill' and p.bill_type = 'pakka' and p.status = 'saved' and p.bill_date between p_from and p_to), '[]'::jsonb));
end $$;

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
                                  and (p.kind in ('refund','transfer') or p.from_payment_id is not null)),
        'stock_back_kg', (select coalesce(-sum(m.qty_kg), 0) from public.stock_moves m where m.order_id = o.id and m.kind in ('sale','sale_undo'))
      ) order by o.internal_no)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.id = any (p_orders)));
end $$;

create or replace function public.api_slip_gst_get(p_caller uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'money');
  return (select jsonb_build_object('delivery', g.delivery, 'dest_state', g.dest_state, 'pos', g.pos, 'items', g.items, 'tally_no', g.tally_no,
      'tally_date', g.tally_date, 'tally_by', pe.display_name, 'shop_state', app.shop_state(c.company_id))
    from public.slip_gst g left join public.people pe on pe.company_id = g.company_id and pe.id = g.tally_by
    where g.company_id = c.company_id and g.order_id = p_order);
end $$;

revoke all on function public.api_slip_tally(uuid, uuid, text, uuid, text, date, boolean) from public, anon, authenticated;
grant execute on function public.api_slip_tally(uuid, uuid, text, uuid, text, date, boolean) to service_role;
