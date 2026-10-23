-- =====================================================================================
-- 25. Is the supplier's GST number real and active? (owner decision 23 Oct 2026)
--   Fake GST bills are a known trap in steel: GST paid on a bill from a cancelled, suspended or
--   made-up GST number is not allowed back to the buyer, and can bring a notice.
--   * Every check is kept: from a GST data service (when the owner adds its key) or "I checked on the
--     GST portal" by a person. The supplier shows the latest: Active / Cancelled since … / Suspended.
--   * Entering a bill from a supplier whose number is cancelled or suspended shows a red warning.
--   * Suppliers with bills in the last 6 months are checked again every 30 days (service only), and the
--     evening summary says when one has been cancelled.
-- =====================================================================================

alter table public.suppliers add column gst_status text check (gst_status is null or gst_status in ('active','cancelled','suspended','inactive','not_found'));
alter table public.suppliers add column gst_checked_at timestamptz;
alter table public.suppliers add column gst_source text check (gst_source is null or gst_source in ('service','portal'));
alter table public.suppliers add column gst_legal_name text check (gst_legal_name is null or length(gst_legal_name) <= 200);
alter table public.suppliers add column gst_trade_name text check (gst_trade_name is null or length(gst_trade_name) <= 200);
alter table public.suppliers add column gst_reg_date date;
alter table public.suppliers add column gst_cancel_date date;

create table public.gstin_checks (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete restrict,
  gstin         text not null check (gstin ~ '^[0-9]{2}[0-9A-Z]{13}$'),
  status        text not null check (status in ('active','cancelled','suspended','inactive','not_found')),
  legal_name    text check (legal_name is null or length(legal_name) <= 200),
  trade_name    text check (trade_name is null or length(trade_name) <= 200),
  reg_date      date,
  cancel_date   date,
  taxpayer_type text check (taxpayer_type is null or length(taxpayer_type) <= 60),
  source        text not null check (source in ('service','portal')),
  note          text check (note is null or length(note) <= 300),
  checked_by    uuid,
  checked_at    timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, checked_by) references public.people(company_id, id)
);
create index gstin_checks_idx on public.gstin_checks (company_id, gstin, checked_at desc);
create trigger gstin_checks_no_change before update or delete on public.gstin_checks for each row execute function app.forbid_change();
create trigger gstin_checks_no_truncate before truncate on public.gstin_checks for each statement execute function app.forbid_change();
create trigger audit after insert on public.gstin_checks for each row execute function app.audit_row();
alter table public.gstin_checks enable row level security;
create policy gstin_checks_read on public.gstin_checks for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('stock')));
revoke all on public.gstin_checks from anon;
revoke insert, update, delete, truncate, references, trigger on public.gstin_checks from authenticated;

-- Save one check (from the service or a person) and put it on the supplier(s) with that number.
create function app.save_gst_check(p_company uuid, p_by uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.gstin_checks; v_gstin text := upper(btrim(coalesce(p ->> 'gstin', '')));
begin
  insert into public.gstin_checks (company_id, gstin, status, legal_name, trade_name, reg_date, cancel_date, taxpayer_type, source, note, checked_by)
    values (p_company, v_gstin, p ->> 'status', nullif(left(btrim(coalesce(p ->> 'legal_name', '')), 200), ''),
            nullif(left(btrim(coalesce(p ->> 'trade_name', '')), 200), ''), nullif(p ->> 'reg_date', '')::date, nullif(p ->> 'cancel_date', '')::date,
            nullif(left(btrim(coalesce(p ->> 'taxpayer_type', '')), 60), ''), coalesce(p ->> 'source', 'portal'),
            nullif(left(btrim(coalesce(p ->> 'note', '')), 300), ''), p_by)
    returning * into g;
  update public.suppliers set gst_status = g.status, gst_checked_at = g.checked_at, gst_source = g.source,
      gst_legal_name = coalesce(g.legal_name, case when g.source = 'service' then null else gst_legal_name end),
      gst_trade_name = coalesce(g.trade_name, case when g.source = 'service' then null else gst_trade_name end),
      gst_reg_date = coalesce(g.reg_date, gst_reg_date), gst_cancel_date = case when g.status = 'active' then null else coalesce(g.cancel_date, gst_cancel_date) end
    where company_id = p_company and gstin = v_gstin;
  return jsonb_build_object('id', g.id, 'gstin', g.gstin, 'status', g.status, 'legal_name', g.legal_name, 'trade_name', g.trade_name,
    'reg_date', g.reg_date, 'cancel_date', g.cancel_date, 'source', g.source, 'checked_at', g.checked_at);
end $$;

-- The last check of a GST number in this shop (a check younger than p_days is used again instead of paying for a new one).
create function public.api_gst_last(p_caller uuid, p_gstin text, p_days integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'stock');
  return (select jsonb_build_object('gstin', g.gstin, 'status', g.status, 'legal_name', g.legal_name, 'trade_name', g.trade_name,
      'reg_date', g.reg_date, 'cancel_date', g.cancel_date, 'source', g.source, 'checked_at', g.checked_at, 'by', pe.display_name)
    from public.gstin_checks g left join public.people pe on pe.company_id = g.company_id and pe.id = g.checked_by
    where g.company_id = c.company_id and g.gstin = upper(btrim(p_gstin)) and g.checked_at > now() - make_interval(days => greatest(coalesce(p_days, 0), 0))
    order by g.checked_at desc limit 1);
end $$;

-- p: { gstin, status, legal_name, trade_name, reg_date, cancel_date, taxpayer_type, source: service | portal, note }
create function public.api_gst_save(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb;
begin
  perform app.require(c, 'stock');
  prev := app.idem_start(c.company_id, p_key, 'gstSave', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if upper(btrim(coalesce(p ->> 'gstin', ''))) !~ '^[0-9]{2}[0-9A-Z]{13}$' then raise exception 'That GST number has a mistake. Please check it.' using errcode = '22023'; end if;
  if (p ->> 'status') not in ('active','cancelled','suspended','inactive','not_found') then raise exception 'Choose what the GST portal says.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, app.save_gst_check(c.company_id, c.id, p));
end $$;

-- Suppliers with their GST status, and what the shop bought from them / still owes them.
create function public.api_suppliers(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'stock');
  k := app.has(c, 'kacha');
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'gstin', s.gstin, 'city', s.city, 'phone', s.phone,
      'gst_status', s.gst_status, 'gst_checked_at', s.gst_checked_at, 'gst_source', s.gst_source, 'gst_legal_name', s.gst_legal_name,
      'gst_trade_name', s.gst_trade_name, 'gst_reg_date', s.gst_reg_date, 'gst_cancel_date', s.gst_cancel_date,
      'bills_6m', (select count(*) from public.purchases p where p.company_id = s.company_id and p.supplier_id = s.id and p.status = 'saved'
                     and p.bill_date > current_date - 183 and (p.bill_type = 'pakka' or k)),
      'gst_6m', (select coalesce(sum(p.gst_amount), 0) from public.purchases p where p.company_id = s.company_id and p.supplier_id = s.id and p.status = 'saved'
                     and p.bill_date > current_date - 183 and p.bill_type = 'pakka'),
      'to_pay', (select coalesce(sum(p.total_amount), 0) from public.purchases p where p.company_id = s.company_id and p.supplier_id = s.id and p.status = 'saved'
                     and p.pay_status = 'to_pay' and (p.bill_type = 'pakka' or k)),
      'last_bill', (select max(p.bill_date) from public.purchases p where p.company_id = s.company_id and p.supplier_id = s.id and p.status = 'saved' and (p.bill_type = 'pakka' or k)))
      order by (s.gst_status in ('cancelled','suspended','inactive','not_found')) desc nulls last, s.name)
    from public.suppliers s where s.company_id = c.company_id and s.active), '[]'::jsonb);
end $$;

-- For the evening: suppliers whose GST number is no longer active and that the shop dealt with lately (or still has to pay).
create function public.api_gst_alerts(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  if not app.has(c, 'stock') then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'gstin', s.gstin, 'status', s.gst_status,
      'cancel_date', s.gst_cancel_date, 'checked_at', s.gst_checked_at) order by s.name)
    from public.suppliers s where s.company_id = c.company_id and s.active and s.gst_status in ('cancelled','suspended','inactive','not_found')
      and exists (select 1 from public.purchases p where p.company_id = s.company_id and p.supplier_id = s.id and p.status = 'saved'
                  and (p.bill_date > current_date - 183 or p.pay_status = 'to_pay'))), '[]'::jsonb);
end $$;

-- The service checks again (job): GST numbers of suppliers with bills in the last 6 months, not checked by the
-- service for 30 days — a few at a time, across shops.
create function public.api_gst_due(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('company_id', x.company_id, 'gstin', x.gstin)), '[]'::jsonb)
  from (select distinct on (s.company_id, s.gstin) s.company_id, s.gstin
        from public.suppliers s join public.companies co on co.id = s.company_id and co.active
        where s.active and s.gstin is not null
          and (s.gst_checked_at is null or s.gst_source = 'portal' or s.gst_checked_at < now() - interval '30 days')
          and not exists (select 1 from public.gstin_checks g where g.company_id = s.company_id and g.gstin = s.gstin and g.source = 'service'
                          and g.checked_at > now() - interval '30 days')
          and exists (select 1 from public.purchases p where p.company_id = s.company_id and p.supplier_id = s.id and p.status = 'saved'
                      and p.bill_date > current_date - 183)
        order by s.company_id, s.gstin limit greatest(1, least(coalesce(p_limit, 20), 200))) x
$$;
create function public.api_gst_save_job(p_company uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if upper(btrim(coalesce(p ->> 'gstin', ''))) !~ '^[0-9]{2}[0-9A-Z]{13}$' or (p ->> 'status') not in ('active','cancelled','suspended','inactive','not_found') then
    raise exception 'Wrong check.' using errcode = '22023';
  end if;
  return app.save_gst_check(p_company, null, p || '{"source":"service"}'::jsonb);
end $$;

-- The bill screen also gets each supplier's GST status.
create or replace function public.api_purchase_context(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'stock');
  return jsonb_build_object(
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'gstin', gstin, 'phone', phone, 'city', city,
        'gst_status', gst_status, 'gst_checked_at', gst_checked_at, 'gst_source', gst_source, 'gst_legal_name', gst_legal_name,
        'gst_trade_name', gst_trade_name, 'gst_cancel_date', gst_cancel_date) order by name)
      from public.suppliers where company_id = c.company_id and active), '[]'::jsonb),
    'materials', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'family', family, 'active', active) order by code)
      from public.materials where company_id = c.company_id), '[]'::jsonb),
    'names', coalesce((select jsonb_agg(jsonb_build_object('supplier_key', supplier_key, 'desc_key', desc_key, 'material_id', material_id, 'shape', shape))
      from private.purchase_names where company_id = c.company_id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'material_id', s.material_id, 'shape', s.shape, 'hsn', s.hsn, 'rate', s.rate,
        'label', s.label, 'on_hand', app.stock_on_hand(s.id)))
      from public.stock_items s where s.company_id = c.company_id), '[]'::jsonb),
    'gst_pct', (select gst_pct from public.company_settings where company_id = c.company_id),
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

revoke all on function app.save_gst_check(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.api_gst_last(uuid, text, integer), public.api_gst_save(uuid, uuid, text, jsonb), public.api_suppliers(uuid),
  public.api_gst_alerts(uuid), public.api_gst_due(integer), public.api_gst_save_job(uuid, jsonb), public.api_purchase_context(uuid)
  from public, anon, authenticated;
grant execute on function public.api_gst_last(uuid, text, integer), public.api_gst_save(uuid, uuid, text, jsonb), public.api_suppliers(uuid),
  public.api_gst_alerts(uuid), public.api_gst_due(integer), public.api_gst_save_job(uuid, jsonb), public.api_purchase_context(uuid)
  to service_role;
