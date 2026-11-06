-- 6 Nov 2026 (plan v2, F10): GST details for the CA's Tally bills. The app makes no GST invoice and keeps no GST bill
-- numbers of its own: it collects the facts for each finished GST slip (how the steel went, where it is going, HSN and
-- rate per grade saved at that moment), works out the place of supply (never assumed — "CA to check" when unsure), and
-- keeps the Tally bill number the CA gives it. A slip's GST details live in their own table, so a finished slip itself
-- never changes.

-- ---------- grades: HSN, rate, checked by the CA ----------
alter table public.materials
  add column hsn text check (hsn is null or hsn ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
  add column gst_rate numeric(5,2) check (gst_rate is null or gst_rate in (0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28, 40)),
  add column hsn_checked_by uuid,
  add column hsn_checked_at timestamptz,
  add constraint materials_hsn_checked_fk foreign key (company_id, hsn_checked_by) references public.people(company_id, id),
  add constraint materials_hsn_checked_pair check ((hsn_checked_by is null) = (hsn_checked_at is null));

-- where this customer's steel usually goes (remembered once answered, never assumed)
alter table public.customers add column dest_state text check (dest_state is null or dest_state ~ '^[0-9]{2}$');

-- ---------- one finished GST slip's details ----------
create table public.slip_gst (
  company_id  uuid not null references public.companies(id) on delete restrict,
  order_id    uuid not null,
  delivery    text check (delivery is null or delivery in ('pickup','ours','direct')),
  dest_state  text check (dest_state is null or dest_state ~ '^[0-9]{2}$'),
  pos         jsonb not null default '{}'::jsonb,   -- { from, to, kind: local | inter | null, sure, reason }
  items       jsonb not null default '[]'::jsonb,   -- [{ item_id, hsn, gst_rate, hsn_checked }] saved when it was first set
  tally_no    text check (tally_no is null or length(btrim(tally_no)) between 1 and 40),
  tally_date  date,
  tally_by    uuid,
  tally_at    timestamptz,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  primary key (company_id, order_id),
  foreign key (company_id, order_id) references public.orders(company_id, id),
  foreign key (company_id, tally_by) references public.people(company_id, id),
  foreign key (company_id, updated_by) references public.people(company_id, id)
);
create index slip_gst_tally_idx on public.slip_gst (company_id, lower(btrim(tally_no))) where tally_no is not null;
alter table public.slip_gst enable row level security;
revoke all on public.slip_gst from anon, authenticated;
create trigger audit after insert or update on public.slip_gst for each row execute function app.audit_row();

/** The place of supply — the same rules as core placeOfSupply. */
create function app.place_of_supply(p_shop text, p_delivery text, p_dest text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('from', f, 'to', t, 'kind', case when f is not null and t is not null then case when f = t then 'local' else 'inter' end end,
    'sure', f is not null and p_delivery is distinct from 'direct' and t is not null,
    'reason', case when f is null then 'no_shop' when p_delivery = 'direct' then 'direct' when t is null then 'no_dest' end)
  from (select case when p_shop ~ '^[0-9]{2}$' and p_shop not in ('97','99') then p_shop end as f,
               case when p_dest ~ '^[0-9]{2}$' and p_dest not in ('97','99') then p_dest end as t) x
$$;
create function app.shop_state(p_company uuid) returns text language sql stable security definer set search_path = '' as $$
  select left(gstin, 2) from public.companies where id = p_company and gstin ~ '^[0-9]{2}'
$$;

/** What the pickup / slip screen needs: the shop's state, the customer's state from its GST number, where it usually goes. */
create function public.api_gst_context(p_caller uuid, p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'money');
  return jsonb_build_object('shop_state', app.shop_state(c.company_id),
    'customer', (select jsonb_build_object('gstin_state', case when gstin ~ '^[0-9]{2}' then left(gstin, 2) end, 'dest_state', dest_state)
                 from public.customers where company_id = c.company_id and id = p_customer));
end $$;

/**
 * Where a finished GST slip's steel went (from the pickup screen, or later from the slip): saves the place of supply and,
 * the first time, each item's HSN and rate as the grade has them now. Fixed once the CA has given the Tally bill
 * (only the owner can change it then).
 */
create function public.api_slip_gst(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_delivery text, p_dest text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; g public.slip_gst; v_del text; v_pos jsonb; v_items jsonb;
begin
  perform app.require(c, 'money');
  prev := app.idem_start(c.company_id, p_key, 'slipGst', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where company_id = c.company_id and id = p_order;
  if o.id is null or o.status <> 'done' or o.bill_type is distinct from 'pakka' then
    raise exception 'Only a finished GST slip has GST details.' using errcode = '22023';
  end if;
  if p_delivery is not null and p_delivery not in ('pickup','ours','direct') then raise exception 'How did the steel go?' using errcode = '22023'; end if;
  if p_dest is not null and (p_dest !~ '^[0-9]{2}$' or p_dest in ('97','99')) then raise exception 'Choose the state.' using errcode = '22023'; end if;
  select * into g from public.slip_gst where company_id = c.company_id and order_id = o.id for update;
  if g.tally_no is not null and not app.has(c, 'settings') then
    raise exception 'The Tally bill % is already made for this slip — ask the owner to change it.', g.tally_no using errcode = '42501';
  end if;
  v_del := case when o.direct_purchase_id is not null then 'direct' else p_delivery end;   -- a direct delivery is always one
  v_pos := app.place_of_supply(app.shop_state(c.company_id), v_del, p_dest);
  select coalesce(jsonb_agg(jsonb_build_object('item_id', i.id, 'hsn', m.hsn, 'gst_rate', m.gst_rate, 'hsn_checked', m.hsn_checked_at is not null) order by i.position), '[]'::jsonb)
    into v_items from public.order_items i join public.materials m on m.company_id = i.company_id and m.id = i.material_id
    where i.company_id = c.company_id and i.order_id = o.id;
  insert into public.slip_gst as s (company_id, order_id, delivery, dest_state, pos, items, updated_by, updated_at)
    values (c.company_id, o.id, v_del, p_dest, v_pos, v_items, c.id, now())
    on conflict (company_id, order_id) do update set delivery = excluded.delivery, dest_state = excluded.dest_state, pos = excluded.pos,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at;   -- (the HSN / rate saved the first time stay)
  if p_dest is not null then
    update public.customers set dest_state = p_dest where company_id = c.company_id and id = o.customer_id and dest_state is distinct from p_dest;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'delivery', v_del, 'dest_state', p_dest, 'pos', v_pos));
end $$;

/** The Tally bill no. the CA gave a GST slip. The same number on another slip is refused unless the person confirms. */
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

/** A grade's HSN and GST rate (owner); changing either takes the CA's tick off until it is checked again. */
create function public.api_material_gst(p_caller uuid, p_key uuid, p_hash text, p_material uuid, p_hsn text, p_rate numeric, p_checked boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; m public.materials; v_hsn text := nullif(btrim(coalesce(p_hsn, '')), ''); v_chk boolean;
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'materialGst', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into m from public.materials where company_id = c.company_id and id = p_material for update;
  if m.id is null then raise exception 'Which grade?' using errcode = '22023'; end if;
  v_chk := coalesce(p_checked, false) and v_hsn is not null;
  update public.materials set hsn = v_hsn, gst_rate = p_rate,
      hsn_checked_by = case when v_chk then case when m.hsn_checked_at is not null and m.hsn is not distinct from v_hsn and m.gst_rate is not distinct from p_rate then m.hsn_checked_by else c.id end end,
      hsn_checked_at = case when v_chk then case when m.hsn_checked_at is not null and m.hsn is not distinct from v_hsn and m.gst_rate is not distinct from p_rate then m.hsn_checked_at else now() end end
    where company_id = c.company_id and id = m.id returning * into m;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('id', m.id, 'hsn', m.hsn, 'gst_rate', m.gst_rate, 'checked_at', m.hsn_checked_at));
end $$;

/**
 * A month for the CA: every finished GST slip (with its items, GST details and Tally no.) and every GST purchase bill
 * (with its lines and the supplier's state). No-bill slips never appear.
 */
create function public.api_gst_month(p_caller uuid, p_from date, p_to date) returns jsonb
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

/** Finished GST slips still waiting for their Tally bill (newest first) and how many. */
create function public.api_tally_pending(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'money', 'khata');
  return jsonb_build_object(
    'count', (select count(*) from public.orders o left join public.slip_gst g on g.company_id = o.company_id and g.order_id = o.id
              where o.company_id = c.company_id and o.status = 'done' and o.bill_type = 'pakka' and g.tally_no is null),
    'slips', coalesce((select jsonb_agg(x order by x ->> 'done_at' desc) from (
        select jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'customer', cu.name, 'total', o.total_amount, 'done_at', o.done_at,
          'pos', g.pos, 'delivery', g.delivery) as x
        from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
        left join public.slip_gst g on g.company_id = o.company_id and g.order_id = o.id
        where o.company_id = c.company_id and o.status = 'done' and o.bill_type = 'pakka' and g.tally_no is null
        order by o.done_at desc limit 200) y), '[]'::jsonb));
end $$;

/** One slip's GST details (the slip page). */
create function public.api_slip_gst_get(p_caller uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'money');
  return (select jsonb_build_object('delivery', g.delivery, 'dest_state', g.dest_state, 'pos', g.pos, 'items', g.items, 'tally_no', g.tally_no,
      'tally_date', g.tally_date, 'tally_by', pe.display_name, 'shop_state', app.shop_state(c.company_id))
    from public.slip_gst g left join public.people pe on pe.company_id = g.company_id and pe.id = g.tally_by
    where g.company_id = c.company_id and g.order_id = p_order);
end $$;

-- the slip paper / WhatsApp text: the HSN saved with the slip, the place of supply and the split
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

revoke all on function app.place_of_supply(text, text, text), app.shop_state(uuid), public.api_gst_context(uuid, uuid),
  public.api_slip_gst(uuid, uuid, text, uuid, text, text), public.api_slip_tally(uuid, uuid, text, uuid, text, date, boolean),
  public.api_material_gst(uuid, uuid, text, uuid, text, numeric, boolean), public.api_gst_month(uuid, date, date),
  public.api_tally_pending(uuid), public.api_slip_gst_get(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_gst_context(uuid, uuid), public.api_slip_gst(uuid, uuid, text, uuid, text, text),
  public.api_slip_tally(uuid, uuid, text, uuid, text, date, boolean), public.api_material_gst(uuid, uuid, text, uuid, text, numeric, boolean),
  public.api_gst_month(uuid, date, date), public.api_tally_pending(uuid), public.api_slip_gst_get(uuid, uuid) to service_role;
