-- Undo 20261113090000_slip_line_amounts: api_slip_data as it was (6 Nov 2026, F10).

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
    -- a GST slip's place of supply and Tally bill no. (6 Nov 2026, F10)
    'gst_details', (select jsonb_build_object('pos', g.pos, 'delivery', g.delivery, 'tally_no', g.tally_no) from public.slip_gst g
                    where g.company_id = o.company_id and g.order_id = o.id and o.bill_type = 'pakka'),
    'items', coalesce((select jsonb_agg(jsonb_build_object('grade', i.grade_code, 'shape', i.shape, 'unit', i.unit, 'dims', i.dims,
        'weight', i.actual_weight, 'by_weight', i.by_weight,
        -- a direct delivery's item: the HSN of the supplier's bill line it came from (same order)
        -- the HSN saved with the slip (F10), else the stock's, the direct delivery's bill line, the grade's
        'hsn', coalesce((select nullif(x ->> 'hsn', '') from public.slip_gst g, jsonb_array_elements(g.items) x
                          where g.company_id = o.company_id and g.order_id = o.id and (x ->> 'item_id')::uuid = i.id),
                        nullif(s.hsn, ''), (select nullif(pl.hsn, '') from public.purchase_lines pl join public.orders o2 on o2.id = i.order_id
                                             where pl.purchase_id = o2.direct_purchase_id and pl.position = i.position),
                        (select m.hsn from public.materials m where m.company_id = o.company_id and m.id = i.material_id)),
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
