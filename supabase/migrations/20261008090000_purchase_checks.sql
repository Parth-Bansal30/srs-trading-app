-- Smart checks on purchase bills (8 Oct 2026): the bill screen gets what the shop paid for each grade
-- lately (last 8 bill lines per grade) and the bills of the last 120 days (to spot a bill typed twice).
-- The checks themselves are in @srs/core purchaseChecks and only warn.
create or replace function public.api_purchase_context(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'stock');
  return jsonb_build_object(
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'gstin', gstin, 'phone', phone, 'city', city) order by name)
      from public.suppliers where company_id = c.company_id and active), '[]'::jsonb),
    'materials', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'family', family, 'active', active) order by code)
      from public.materials where company_id = c.company_id), '[]'::jsonb),
    'names', coalesce((select jsonb_agg(jsonb_build_object('supplier_key', supplier_key, 'desc_key', desc_key, 'material_id', material_id, 'shape', shape))
      from private.purchase_names where company_id = c.company_id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'material_id', s.material_id, 'shape', s.shape, 'hsn', s.hsn, 'rate', s.rate,
        'label', s.label, 'on_hand', app.stock_on_hand(s.id)))
      from public.stock_items s where s.company_id = c.company_id), '[]'::jsonb),
    'gst_pct', (select gst_pct from public.company_settings where company_id = c.company_id),
    -- for the smart checks: what the shop paid for each grade lately, and the bills of the last 120 days
    'history', jsonb_build_object(
      'rates', coalesce((select jsonb_agg(x) from (
          select jsonb_build_object('material_id', r.material_id, 'rate', r.rate, 'date', r.bill_date, 'supplier', r.supplier) x
          from (select s.material_id, pl.rate, p.bill_date, su.name supplier,
                       row_number() over (partition by s.material_id order by p.bill_date desc, p.created_at desc) n
                from public.purchase_lines pl
                join public.purchases p on p.company_id = pl.company_id and p.id = pl.purchase_id
                join public.stock_items s on s.company_id = pl.company_id and s.id = pl.stock_item_id
                left join public.suppliers su on su.company_id = p.company_id and su.id = p.supplier_id
                where pl.company_id = c.company_id and p.status = 'saved' and p.kind = 'bill'
                  and (p.bill_type = 'pakka' or app.has(c, 'kacha'))) r
          where r.n <= 8) t), '[]'::jsonb),
      'bills', coalesce((select jsonb_agg(jsonb_build_object('supplier_id', p.supplier_id, 'bill_no', p.bill_no, 'date', p.bill_date,
          'kg', p.total_kg, 'total', p.total_amount) order by p.bill_date desc)
        from public.purchases p where p.company_id = c.company_id and p.status = 'saved' and p.kind = 'bill'
          and p.bill_date >= current_date - 120 and (p.bill_type = 'pakka' or app.has(c, 'kacha'))), '[]'::jsonb)));
end $$;

revoke all on function public.api_purchase_context(uuid) from public, anon, authenticated;
grant execute on function public.api_purchase_context(uuid) to service_role;
