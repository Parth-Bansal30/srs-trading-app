-- The customer's slip gets each item's HSN from the stock it was taken from (agreed 30 Sept 2026:
-- "the GST slip's HSN comes from that stock item"). Only the HSN — never the buying rate.
-- The api shows it on GST slips only.
create or replace function public.api_slip_data(p_caller uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); o public.orders;
begin
  perform app.require(c, 'money');
  select * into o from public.orders where id = p_order and company_id = c.company_id;
  if o.id is null then raise exception 'Slip not found.' using errcode = '22023'; end if;
  if o.status <> 'done' then raise exception 'The slip is ready to send after pickup.' using errcode = '23514'; end if;
  if o.bill_type = 'kacha' then perform app.require(c, 'kacha'); end if;
  return public.api_doc_header(p_caller, o.customer_id) || jsonb_build_object(
    'order', jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'done_at', o.done_at, 'bill', o.bill_type, 'gst_pct', o.gst_pct,
      'total_weight', o.total_weight, 'material', o.material_amount, 'cutting', o.cutting_amount, 'gst', o.gst_amount, 'total', o.total_amount),
    'items', coalesce((select jsonb_agg(jsonb_build_object('grade', i.grade_code, 'shape', i.shape, 'unit', i.unit, 'dims', i.dims,
        'weight', i.actual_weight, 'hsn', nullif(s.hsn, ''),
        'lengths', (select coalesce(jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs) order by l.position), '[]'::jsonb)
                    from public.order_item_lengths l where l.order_item_id = i.id))
        order by i.position)
      from public.order_items i left join public.stock_items s on s.id = i.stock_item_id and s.company_id = o.company_id
      where i.order_id = o.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('at', p.received_at, 'amount', p.amount, 'mode', p.mode,
        'kind', coalesce(r.kind, p.kind)) order by p.received_at)
      from public.payments p left join public.payments r on r.id = p.reverses_payment_id
      where p.order_id = o.id), '[]'::jsonb));
end $$;

revoke all on function public.api_slip_data(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_slip_data(uuid, uuid) to service_role;
