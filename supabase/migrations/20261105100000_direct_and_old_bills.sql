-- 5 Nov 2026 (plan v2, F7): bills that don't go through the shop's stock.
-- Every purchase bill now says what it changes (purchases.stock_effect):
--   stock      into our stock + the supplier is owed (as before)
--   direct     straight to a customer (bill to us, ship to them): the supplier is owed, the stock does NOT change; a separate
--              slip for that customer is made from it (linked both ways, weights from the bill, no weighing, no stock)
--   opening    a bill from before the shop started the app, as opening stock: stock in, nothing owed
--   accounted  a bill from before the app that is already in the accounts: no stock, nothing owed (it goes in that month's
--              purchase register for the CA)
--   reference  kept for the record only: changes nothing
-- A bill dated before the shop started the app must be given one of the last three — none is chosen for the owner.

alter table public.purchases add column stock_effect text not null default 'stock'
  check (stock_effect in ('stock','direct','opening','accounted','reference'));
-- lines that don't go into stock keep their grade and shape themselves (no stock item)
alter table public.purchase_lines alter column stock_item_id drop not null,
  add column material_id uuid,
  add column shape text check (shape is null or shape in ('square','round','flat','block','hex','plate')),
  add constraint purchase_lines_material foreign key (company_id, material_id) references public.materials(company_id, id),
  add constraint purchase_lines_has_grade check (stock_item_id is not null or material_id is not null);
-- the slip made from a direct delivery; its items are sold by the weight on the bill (no sizes × lengths)
alter table public.orders add column direct_purchase_id uuid,
  add constraint orders_direct_purchase foreign key (company_id, direct_purchase_id) references public.purchases(company_id, id);
create index orders_direct_idx on public.orders (company_id, direct_purchase_id) where direct_purchase_id is not null;
alter table public.order_items add column by_weight boolean not null default false;

/**
 * The customer's slip for a direct delivery: { purchase_id, customer_id, rules, items } (items built by the api from the
 * bill's lines: grade, shape, size, the bill's kg, the rate for the customer, by_weight). It is made accepted and weighed
 * at once — the weights are the bill's — and never touches the stock. The owner finishes it like any slip (bill type, pay).
 */
create function public.api_direct_slip(p_caller uuid, p_key uuid, p_hash text, p_purchase uuid, p_customer uuid, p_rules jsonb, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; pu public.purchases; r jsonb; oid uuid; it jsonb; k int := 0; ids uuid[];
begin
  perform app.require(c, 'new', 'money', 'stock');
  prev := app.idem_start(c.company_id, p_key, 'directSlip', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into pu from public.purchases where company_id = c.company_id and id = p_purchase for update;
  if pu.id is null or (pu.bill_type = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Bill not found.' using errcode = '22023'; end if;
  if pu.status <> 'saved' or pu.stock_effect <> 'direct' then raise exception 'This bill is not a delivery straight to a customer.' using errcode = '22023'; end if;
  if exists (select 1 from public.orders where company_id = c.company_id and direct_purchase_id = pu.id and status not in ('cancelled','deleted')) then
    raise exception 'This delivery already has its slip.' using errcode = '23505';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Add the steel.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_items) x where coalesce((x ->> 'by_weight')::boolean, false) is not true
             or coalesce(nullif(x ->> 'kg', '')::numeric, 0) <= 0) then
    raise exception 'Each line needs its weight from the bill.' using errcode = '22023';
  end if;
  r := public.api_create_order(p_caller, md5(p_key::text || ':order')::uuid, p_hash, p_customer, p_rules, p_items, true, null, null);
  oid := (r ->> 'order_id')::uuid;
  select array_agg(i.id order by i.position) into ids from public.order_items i where i.order_id = oid;
  for it in select * from jsonb_array_elements(p_items) loop
    k := k + 1;
    update public.order_items set actual_weight = round((it ->> 'kg')::numeric, 3) where id = ids[k];
  end loop;
  update public.orders set status = 'weighed', weighed_at = now(), direct_purchase_id = pu.id where id = oid;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', oid, 'slip_no', r ->> 'slip_no', 'status', 'weighed'));
end $$;

/** A direct slip's weights changed before it is finished (the bill's weights, corrected): { item_id → kg }. */
create function public.api_direct_weights(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_weights jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; x record; n int := 0;
begin
  perform app.require(c, 'new', 'money');
  prev := app.idem_start(c.company_id, p_key, 'directWeights', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where company_id = c.company_id and id = p_order for update;
  if o.id is null or o.direct_purchase_id is null then raise exception 'Direct slip not found.' using errcode = '22023'; end if;
  if o.status <> 'weighed' then raise exception 'Only a direct slip that is not finished yet can be changed.' using errcode = '23001'; end if;
  if jsonb_typeof(p_weights) <> 'object' then raise exception 'Enter the weights.' using errcode = '22023'; end if;
  update public.orders set status = 'accepted' where id = o.id;
  for x in select key, value from jsonb_each_text(p_weights) loop
    if nullif(x.value, '')::numeric is null or x.value::numeric <= 0 then raise exception 'Enter the weights.' using errcode = '22023'; end if;
    update public.order_items set actual_weight = round(x.value::numeric, 3) where company_id = c.company_id and order_id = o.id and id = x.key::uuid and by_weight;
    if found then n := n + 1; end if;
  end loop;
  update public.orders set status = 'weighed', weighed_at = now() where id = o.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'items', n));
end $$;

-- ---------- the functions that change ----------
create or replace function public.api_save_purchase(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.people := app.caller(p_caller); prev jsonb; sup uuid; pid uuid := gen_random_uuid(); ln jsonb; i int := 0;
  sid uuid; lid uuid; was_new boolean; onh numeric; qty numeric; cost_new numeric; out_lines jsonb := '[]'::jsonb;
  v_kind text := coalesce(p ->> 'kind', 'bill'); v_type text := p ->> 'bill_type'; v_no text := nullif(btrim(p ->> 'bill_no'), '');
  v_shape text; v_hsn text; v_rate numeric; v_mat uuid; dup record; kg_sum numeric := 0; amt_sum numeric := 0;
  v_eff text := coalesce(nullif(p ->> 'stock_effect', ''), 'stock'); v_start date; v_into boolean;
begin
  perform app.require(c, 'stock');
  if v_type = 'kacha' then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'savePurchase', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if v_kind not in ('bill','opening') then raise exception 'Unknown kind of purchase.' using errcode = '22023'; end if;
  -- what the bill changes (5 Nov 2026, F7): stock = into our stock + supplier due · direct = straight to a customer (due, no
  -- stock) · and for a bill from before the shop started the app, the owner MUST say: opening stock / already accounted /
  -- reference only (nothing is pre-chosen, nothing changes quietly)
  if v_eff not in ('stock','direct','opening','accounted','reference') then raise exception 'What does this bill change?' using errcode = '22023'; end if;
  select (co.created_at at time zone co.timezone)::date into v_start from public.companies co where co.id = c.company_id;
  if v_kind = 'opening' then
    v_eff := 'stock';
  elsif (p ->> 'bill_date')::date < v_start then
    if v_eff not in ('opening','accounted','reference') then
      raise exception 'This bill is from before you started the app (%) — choose: opening stock, already accounted, or reference only.', to_char(v_start, 'DD Mon YYYY') using errcode = '22023';
    end if;
  elsif v_eff not in ('stock','direct') then
    raise exception 'Opening stock / already accounted / reference only is only for bills from before you started the app.' using errcode = '22023';
  end if;
  v_into := v_eff in ('stock','opening');
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 or jsonb_array_length(p -> 'lines') > 100 then
    raise exception 'Add 1 to 100 lines.' using errcode = '22023';
  end if;

  -- supplier
  if v_kind = 'bill' then
    if nullif(p #>> '{supplier,id}', '') is not null then
      select id into sup from public.suppliers where id = (p #>> '{supplier,id}')::uuid and company_id = c.company_id;
      if sup is null then raise exception 'Supplier not found.' using errcode = '22023'; end if;
    else
      if nullif(btrim(p #>> '{supplier,name}'), '') is null then raise exception 'Write who the bill is from.' using errcode = '22023'; end if;
      select id into sup from public.suppliers where company_id = c.company_id
        and ((nullif(p #>> '{supplier,gstin}', '') is not null and gstin = upper(p #>> '{supplier,gstin}'))
             or lower(btrim(name)) = lower(btrim(p #>> '{supplier,name}')))
        order by (gstin = upper(coalesce(p #>> '{supplier,gstin}', ''))) desc nulls last limit 1;
      if sup is null then
        insert into public.suppliers (company_id, name, gstin, phone, city)
          values (c.company_id, btrim(p #>> '{supplier,name}'), nullif(upper(regexp_replace(coalesce(p #>> '{supplier,gstin}', ''), '\s', '', 'g')), ''),
                  nullif(btrim(p #>> '{supplier,phone}'), ''), nullif(btrim(p #>> '{supplier,city}'), ''))
          returning id into sup;
      end if;
    end if;
    if v_no is not null then
      select p2.bill_date, p2.created_at into dup from public.purchases p2
        where p2.company_id = c.company_id and p2.supplier_id = sup and lower(btrim(p2.bill_no)) = lower(v_no) and p2.status = 'saved';
      if found then
        raise exception 'Bill % from this supplier is already saved (bill date %).', v_no, to_char(dup.bill_date, 'DD Mon YYYY') using errcode = '23505';
      end if;
    end if;
  end if;

  -- totals must be plain numbers; the api already checked that they add up
  for ln in select * from jsonb_array_elements(p -> 'lines') loop
    kg_sum := kg_sum + (ln ->> 'qty_kg')::numeric;
    amt_sum := amt_sum + (ln ->> 'amount')::numeric;
  end loop;
  insert into public.purchases (id, company_id, kind, supplier_id, bill_no, bill_date, bill_type, items_amount, freight, other_charges,
                                gst_amount, round_off, total_amount, total_kg, pay_status, paid_at, file_key, read_by_ai, note, created_by, idempotency_key, stock_effect)
    values (pid, c.company_id, v_kind, sup, v_no, (p ->> 'bill_date')::date, v_type, round(amt_sum, 2),
            coalesce((p ->> 'freight')::numeric, 0), coalesce((p ->> 'other')::numeric, 0), coalesce((p ->> 'gst')::numeric, 0),
            coalesce((p ->> 'round_off')::numeric, 0), (p ->> 'total')::numeric, kg_sum,
            coalesce(p ->> 'pay_status', 'to_pay'), case when p ->> 'pay_status' = 'paid' then now() end,
            nullif(p ->> 'file_key', ''), coalesce((p ->> 'read_by_ai')::boolean, false), nullif(btrim(p ->> 'note'), ''), c.id, p_key, v_eff);

  for ln in select * from jsonb_array_elements(p -> 'lines') loop
    v_mat := (ln ->> 'material_id')::uuid;
    if not exists (select 1 from public.materials where id = v_mat and company_id = c.company_id) then
      raise exception 'Line %: choose a grade from your list.', i + 1 using errcode = '22023';
    end if;
    v_shape := nullif(ln ->> 'shape', '');
    v_hsn := regexp_replace(coalesce(ln ->> 'hsn', ''), '\D', '', 'g');
    v_rate := round((ln ->> 'rate')::numeric, 3);
    qty := round((ln ->> 'qty_kg')::numeric, 3);
    cost_new := round(v_rate + coalesce((ln ->> 'freight_share')::numeric, 0), 3);
    sid := null; was_new := false;
    if v_into then
    select id into sid from public.stock_items
      where company_id = c.company_id and material_id = v_mat and coalesce(shape, 'any') = coalesce(v_shape, 'any') and hsn = v_hsn and rate = v_rate;
    was_new := sid is null;
    if was_new then
      insert into public.stock_items (company_id, material_id, shape, hsn, rate, cost, label, created_by)
        values (c.company_id, v_mat, v_shape, v_hsn, v_rate, cost_new, nullif(btrim(ln ->> 'label'), ''), c.id) returning id into sid;
    else
      onh := greatest(app.stock_on_hand(sid), 0);
      update public.stock_items set
          cost = case when onh + qty > 0 then round((onh * cost + qty * cost_new) / (onh + qty), 3) else cost_new end,
          last_in = now(), closed = false,
          label = coalesce(nullif(btrim(ln ->> 'label'), ''), label)
        where id = sid;
    end if;
    end if;
    insert into public.purchase_lines (company_id, purchase_id, position, description, hsn, qty_kg, rate, amount, freight_share, stock_item_id, material_id, shape)
      values (c.company_id, pid, i, btrim(ln ->> 'description'), v_hsn, qty, v_rate, (ln ->> 'amount')::numeric,
              coalesce((ln ->> 'freight_share')::numeric, 0), sid, v_mat, v_shape) returning id into lid;
    if v_into then
      insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, purchase_line_id, created_by)
        values (c.company_id, sid, 'purchase', qty, lid, c.id);
    end if;
    if nullif(ln ->> 'desc_key', '') is not null then
      insert into private.purchase_names (company_id, supplier_key, desc_key, material_id, shape)
        values (c.company_id, coalesce(sup::text, ''), left(ln ->> 'desc_key', 200), v_mat, v_shape)
        on conflict (company_id, supplier_key, desc_key) do update set material_id = excluded.material_id, shape = excluded.shape, updated_at = now();
    end if;
    out_lines := out_lines || jsonb_build_object('line_id', lid, 'stock_item_id', sid, 'new', was_new);
    i := i + 1;
  end loop;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('purchase_id', pid, 'supplier_id', sup, 'lines', out_lines, 'kg', kg_sum, 'stock_effect', v_eff));
end $$;

create or replace function app.insert_items(p_company uuid, p_order uuid, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare it jsonb; ln jsonb; i int := 0; j int; item_id uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item.' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (id, company_id, order_id, position, material_id, grade_code, shape, unit, dims,
                                    sell_rate, cut_rate, density, special_rate, stock_item_id, by_weight)
      values (coalesce(nullif(it ->> 'id', '')::uuid, gen_random_uuid()), p_company, p_order, i, (it ->> 'material_id')::uuid, it ->> 'grade_code', it ->> 'shape', it ->> 'unit',
              array(select jsonb_array_elements_text(it -> 'dims')), (it ->> 'sell_rate')::numeric, (it ->> 'cut_rate')::numeric,
              (it ->> 'density')::numeric, coalesce((it ->> 'special_rate')::boolean, false), nullif(it ->> 'stock_item_id', '')::uuid,
              coalesce((it ->> 'by_weight')::boolean, false))
      returning id into item_id;
    j := 0;
    for ln in select * from jsonb_array_elements(it -> 'lengths') loop
      insert into public.order_item_lengths (company_id, order_item_id, position, len, pcs, cuts)
        values (p_company, item_id, j, nullif(ln ->> 'len', ''), (ln ->> 'pcs')::int, nullif(ln ->> 'cuts', '')::int);
      j := j + 1;
    end loop;
    if j = 0 then raise exception 'Item % has no lengths.', i + 1 using errcode = '22023'; end if;
    i := i + 1;
  end loop;
end $$;

create or replace function app.purchase_pay_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_left numeric;
begin
  if new.kind <> 'bill' then return new; end if;
  if new.stock_effect not in ('stock','direct') then   -- opening stock / already accounted / reference: nothing owed in the app
    new.pay_status := 'paid'; new.paid_at := coalesce(new.paid_at, now()); return new;
  end if;
  -- "Paid" chosen while saving a bill (no money recorded in the app, as before): paid outside the app
  if tg_op = 'INSERT' and new.pay_status = 'paid' and new.settled is null then
    new.settled := 'outside'; new.settled_at := now(); new.settled_by := nullif(current_setting('app.person_id', true), '')::uuid;
  end if;
  if new.settled = 'outside' then
    new.pay_status := 'paid'; new.paid_at := coalesce(new.settled_at, new.paid_at, now());
  elsif tg_op = 'INSERT' then
    new.pay_status := 'to_pay'; new.paid_at := null;
  else
    v_left := app.purchase_left(new.id) - (old.total_amount - new.total_amount);
    if v_left <= 0.5 then
      new.pay_status := 'paid'; new.paid_at := case when old.pay_status = 'paid' and old.settled is null then old.paid_at else now() end;
    else
      new.pay_status := 'to_pay'; new.paid_at := null;
    end if;
  end if;
  return new;
end $$;

create or replace function app.purchases_touch(p_company uuid, p_ids uuid[]) returns void
language sql security definer set search_path = '' as $$
  update public.purchases p set pay_status = p.pay_status
    where p.company_id = p_company and p.id = any(p_ids) and p.kind = 'bill'
      and (case when p.settled = 'outside' or p.stock_effect not in ('stock','direct') or app.purchase_left(p.id) <= 0.5 then 'paid' else 'to_pay' end) <> p.pay_status
$$;

create or replace function public.api_supplier_data(p_caller uuid, p_supplier uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; tz text;
begin
  if not (app.has(c, 'stock') or app.has(c, 'settings')) then perform app.require(c, 'stock'); end if;
  k := app.has(c, 'kacha');
  select timezone into tz from public.companies where id = c.company_id;
  return jsonb_build_object(
    'today', (now() at time zone tz)::date,
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'credit_days', s.credit_days, 'gstin', s.gstin, 'city', s.city, 'phone', s.phone) order by s.name)
      from public.suppliers s where s.company_id = c.company_id and (p_supplier is null or s.id = p_supplier) and (s.active or s.id = p_supplier)), '[]'::jsonb),
    'bills', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'supplier_id', p.supplier_id, 'bill_no', p.bill_no, 'date', p.bill_date, 'side', p.bill_type,
        'total', p.total_amount, 'kg', p.total_kg, 'settled', p.settled, 'settled_at', p.settled_at, 'created_at', p.created_at, 'gst', p.gst_amount, 'direct', p.stock_effect = 'direct') order by p.bill_date, p.created_at)
      from public.purchases p where p.company_id = c.company_id and p.kind = 'bill' and p.status = 'saved' and (p_supplier is null or p.supplier_id = p_supplier)
        and p.stock_effect in ('stock','direct') and (k or p.bill_type = 'pakka')), '[]'::jsonb),
    'openings', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'supplier_id', n.supplier_id, 'side', n.side, 'direction', n.direction, 'amount', n.amount,
        'date', n.note_date, 'note', n.note, 'by', pe.display_name))
      from public.supplier_notes n left join public.people pe on pe.company_id = n.company_id and pe.id = n.created_by
      where n.company_id = c.company_id and n.kind = 'opening' and n.status = 'ok' and (p_supplier is null or n.supplier_id = p_supplier) and (k or n.side = 'pakka')), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'supplier_id', n.supplier_id, 'kind', n.kind, 'side', n.side, 'purchase_id', n.purchase_id,
        'amount', n.amount, 'note_no', n.note_no, 'date', n.note_date, 'note', n.note, 'by', pe.display_name,
        'kg', (select sum(l.qty_kg) from public.supplier_note_lines l where l.company_id = n.company_id and l.note_id = n.id)) order by n.note_date)
      from public.supplier_notes n left join public.people pe on pe.company_id = n.company_id and pe.id = n.created_by
      where n.company_id = c.company_id and n.kind <> 'opening' and n.status = 'ok' and (p_supplier is null or n.supplier_id = p_supplier) and (k or n.side = 'pakka')), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(x order by x ->> 'at') from (
        select jsonb_build_object('id', e.id, 'supplier_id', e.supplier_id, 'at', e.paid_at, 'day', e.business_date, 'method', e.method, 'account', ma.name, 'note', e.note,
                 'by', pe.display_name, 'offline', e.entered_offline,
                 'amount', e.amount - case when k then 0 else coalesce((select sum(a.amount) from public.supplier_allocations a join public.purchases p
                     on p.company_id = a.company_id and p.id = a.purchase_id where a.company_id = e.company_id and a.expense_id = e.id and a.status = 'ok' and p.bill_type = 'kacha'), 0) end,
                 'cheque', (select q.number from public.cheques q where q.company_id = e.company_id and q.expense_id = e.id and q.status <> 'cancelled' limit 1)) x
          from public.expenses e
          join public.money_accounts ma on ma.company_id = e.company_id and ma.id = e.account_id
          left join public.people pe on pe.company_id = e.company_id and pe.id = e.created_by
          where e.company_id = c.company_id and e.kind = 'supplier' and e.status = 'ok' and (p_supplier is null or e.supplier_id = p_supplier)) t
        where (x ->> 'amount')::numeric > 0), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'expense_id', a.expense_id, 'purchase_id', a.purchase_id, 'opening_id', a.opening_id, 'amount', a.amount))
      from public.supplier_allocations a join public.expenses e on e.company_id = a.company_id and e.id = a.expense_id
      left join public.purchases p on p.company_id = a.company_id and p.id = a.purchase_id
      left join public.supplier_notes o on o.company_id = a.company_id and o.id = a.opening_id
      where a.company_id = c.company_id and a.status = 'ok' and e.status = 'ok' and (p_supplier is null or e.supplier_id = p_supplier)
        and (p.id is null or p.status = 'saved') and (k or coalesce(p.bill_type, o.side) = 'pakka')), '[]'::jsonb));
end $$;

create or replace function public.api_purchases(p_caller uuid, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'stock');
  k := app.has(c, 'kacha');
  return coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', p.id, 'kind', p.kind, 'supplier', sp.name, 'supplier_id', p.supplier_id, 'bill_no', p.bill_no, 'bill_date', p.bill_date,
        'bill_type', p.bill_type, 'total', p.total_amount, 'kg', p.total_kg, 'pay_status', p.pay_status, 'status', p.status, 'settled', p.settled,
        'stock_effect', p.stock_effect, 'direct_order', (select jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'status', o.status) from public.orders o where o.company_id = p.company_id and o.direct_purchase_id = p.id order by o.created_at desc limit 1),
        'left', case when p.kind = 'bill' and p.status = 'saved' and p.settled is null and p.stock_effect in ('stock','direct') then app.purchase_left(p.id) else 0 end,
        'due_date', case when sp.credit_days is not null then p.bill_date + sp.credit_days end,
        'lines', (select count(*) from public.purchase_lines pl where pl.purchase_id = p.id), 'created_at', p.created_at) x
      from public.purchases p left join public.suppliers sp on sp.id = p.supplier_id
      where p.company_id = c.company_id and (k or p.bill_type = 'pakka')
      order by p.bill_date desc, p.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) q), '[]'::jsonb);
end $$;

create or replace function public.api_purchase(p_caller uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); p public.purchases; cd int;
begin
  perform app.require(c, 'stock');
  select * into p from public.purchases where id = p_id and company_id = c.company_id;
  if p.id is null or (p.bill_type = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Bill not found.' using errcode = '22023'; end if;
  select credit_days into cd from public.suppliers where id = p.supplier_id;
  return jsonb_build_object(
    'purchase', to_jsonb(p) - 'idempotency_key',
    'supplier', (select jsonb_build_object('id', id, 'name', name, 'gstin', gstin, 'phone', phone, 'city', city, 'credit_days', credit_days) from public.suppliers where id = p.supplier_id),
    'by', (select display_name from public.people where id = p.created_by),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', pl.id, 'description', pl.description, 'hsn', pl.hsn, 'kg', pl.qty_kg, 'rate', pl.rate,
        'amount', pl.amount, 'freight_share', pl.freight_share, 'stock_item_id', pl.stock_item_id, 'code', m.code, 'shape', coalesce(s.shape, pl.shape), 'label', s.label,
        'material_id', coalesce(s.material_id, pl.material_id), 'on_hand', case when s.id is not null then app.stock_on_hand(s.id) end) order by pl.position)
      from public.purchase_lines pl left join public.stock_items s on s.id = pl.stock_item_id
      left join public.materials m on m.id = coalesce(s.material_id, pl.material_id)
      where pl.purchase_id = p.id), '[]'::jsonb),
    'direct_order', (select jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'status', o.status, 'customer', cu.name)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = p.company_id and o.direct_purchase_id = p.id and o.status not in ('cancelled','deleted') order by o.created_at desc limit 1),
    'left', case when p.kind = 'bill' and p.status = 'saved' and p.settled is null and p.stock_effect in ('stock','direct') then app.purchase_left(p.id) else 0 end,
    'due_date', case when p.kind = 'bill' and cd is not null then p.bill_date + cd end,
    'paid_by', coalesce((select jsonb_agg(jsonb_build_object('expense_id', e.id, 'amount', a.amount, 'day', e.business_date, 'method', e.method, 'account', ma.name) order by e.paid_at)
      from public.supplier_allocations a join public.expenses e on e.company_id = a.company_id and e.id = a.expense_id
      join public.money_accounts ma on ma.company_id = e.company_id and ma.id = e.account_id
      where a.company_id = p.company_id and a.purchase_id = p.id and a.status = 'ok' and e.status = 'ok'), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'amount', n.amount, 'note_no', n.note_no, 'date', n.note_date) order by n.note_date)
      from public.supplier_notes n where n.company_id = p.company_id and n.purchase_id = p.id and n.status = 'ok'), '[]'::jsonb),
    -- a bill can be cancelled only while all of its stock is still there
    'can_cancel', p.status = 'saved' and not exists (
      select 1 from (select pl.stock_item_id, sum(pl.qty_kg) q from public.purchase_lines pl where pl.purchase_id = p.id and pl.stock_item_id is not null group by pl.stock_item_id) t
      where app.stock_on_hand(t.stock_item_id) < t.q));
end $$;

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
    'start', (select (co.created_at at time zone co.timezone)::date from public.companies co where co.id = c.company_id),
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

drop function public.api_purchase_cancel(uuid, uuid, text, uuid, text);
create function public.api_purchase_cancel(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_reason text, p_slip text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; p public.purchases; why text := btrim(coalesce(p_reason, '')); o public.orders;
begin
  perform app.require(c, 'stock');
  if why = '' then raise exception 'Write why the bill is cancelled.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'purchaseCancel', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into p from public.purchases where id = p_id and company_id = c.company_id for update;
  if p.id is null or (p.bill_type = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Bill not found.' using errcode = '22023'; end if;
  if p.status <> 'saved' then raise exception 'This bill is already cancelled.' using errcode = '23001'; end if;
  -- a delivery straight to a customer: its slip is never cancelled by itself — the person says what to do with it
  select * into o from public.orders where company_id = c.company_id and direct_purchase_id = p.id and status not in ('cancelled','deleted') order by created_at desc limit 1;
  if o.id is not null then
    if p_slip is null or p_slip not in ('cancel','keep') then
      raise exception 'Slip #% came from this delivery — cancel it too, or keep it?', o.slip_no using errcode = '22023';
    end if;
    if p_slip = 'cancel' then
      if o.status = 'done' then raise exception 'Slip #% is finished — delete it from the slip first, or keep it.', o.slip_no using errcode = '23001'; end if;
      perform public.api_cancel_order(p_caller, md5(p_key::text || ':slip')::uuid, p_hash, o.id, left('Its purchase bill was cancelled: ' || why, 300));
    end if;
  end if;
  perform 1 from public.stock_items s where s.id in (select stock_item_id from public.purchase_lines where purchase_id = p.id and stock_item_id is not null) for update;
  if exists (select 1 from (select pl.stock_item_id, sum(pl.qty_kg) q from public.purchase_lines pl where pl.purchase_id = p.id and pl.stock_item_id is not null group by pl.stock_item_id) t
             where app.stock_on_hand(t.stock_item_id) < t.q) then
    raise exception 'Some of this stock is already sold. Correct the stock count instead.' using errcode = '23001';
  end if;
  insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, purchase_line_id, note, created_by)
    select pl.company_id, pl.stock_item_id, 'purchase_undo', -pl.qty_kg, pl.id, 'Bill cancelled: ' || left(why, 200), c.id
    from public.purchase_lines pl where pl.purchase_id = p.id and pl.stock_item_id is not null;
  update public.purchases set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = left(why, 500) where id = p.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('purchase_id', p.id, 'status', 'cancelled'));
end $$;

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
        'weight', i.actual_weight, 'by_weight', i.by_weight,
        -- a direct delivery's item: the HSN of the supplier's bill line it came from (same order)
        'hsn', coalesce(nullif(s.hsn, ''), (select nullif(pl.hsn, '') from public.purchase_lines pl join public.orders o2 on o2.id = i.order_id
                                             where pl.purchase_id = o2.direct_purchase_id and pl.position = i.position)),
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

revoke all on function public.api_direct_slip(uuid, uuid, text, uuid, uuid, jsonb, jsonb), public.api_direct_weights(uuid, uuid, text, uuid, jsonb),
  public.api_purchase_cancel(uuid, uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.api_direct_slip(uuid, uuid, text, uuid, uuid, jsonb, jsonb), public.api_direct_weights(uuid, uuid, text, uuid, jsonb),
  public.api_purchase_cancel(uuid, uuid, text, uuid, text, text) to service_role;
