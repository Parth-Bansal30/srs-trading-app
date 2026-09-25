-- =====================================================================================
-- 9. Domain operations (backend only).
--
-- The backend (Edge Function "api") checks who is calling, does the steel maths with
-- @srs/core (the same rules as the approved prototype), then calls ONE of the api_*
-- functions below. Each one makes its whole change in a single all-or-nothing step,
-- re-checks the caller's permissions, and records the request key so a retried request
-- (e.g. after a network drop) returns the first result instead of happening twice.
-- Only the backend (service role) may call api_* functions.
-- =====================================================================================

-- ---------- new settings ----------
alter table public.company_settings
  add column first_slip_no bigint not null default 1 check (first_slip_no between 1 and 999999999),
  add column ai_daily_limit integer not null default 100 check (ai_daily_limit between 0 and 10000);
comment on column public.company_settings.first_slip_no is 'Number of the very first slip, e.g. to continue from the paper slip book. Can only be changed before the first order.';

-- Slip numbers that restart (daily/monthly/yearly) repeat in a later period — e.g. "22Sep-1" comes
-- back every year. So a slip number only has to be unique within its period (the counter it came from).
-- The permanent internal number stays unique for ever.
alter table public.orders add column slip_period text not null default 'internal' check (length(slip_period) between 1 and 40);
comment on column public.orders.slip_period is 'Which counter the slip number came from: internal, daily:YYYY-MM-DD, monthly:YYYY-MM, yearly:YYYY-YYYY.';
alter table public.orders drop constraint orders_company_id_slip_no_key;
alter table public.orders add constraint orders_slip_unique unique (company_id, slip_period, slip_no);
create index orders_slip_lookup_idx on public.orders (company_id, slip_no);

-- AI questions per company per day (cost control for the Ask Claude feature)
create table private.ai_usage (
  company_id uuid not null references public.companies(id) on delete restrict,
  day        date not null,
  questions  integer not null default 0 check (questions >= 0),
  primary key (company_id, day)
);
alter table private.ai_usage enable row level security;
revoke all on private.ai_usage from public, anon, authenticated;

-- ---------- a finished order may only move INTO the khata (after a payment reversal) ----------
create or replace function app.guard_order() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'estimate' then
      raise exception 'New orders start as an estimate.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'estimate' then
      raise exception 'Only an estimate can be deleted.' using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if old.status = 'done' then
    -- the only change ever allowed on a finished order: it goes into the khata because a payment was reversed
    if (to_jsonb(new) - 'in_khata') = (to_jsonb(old) - 'in_khata') and not old.in_khata and new.in_khata then
      return new;
    end if;
    raise exception 'A finished order cannot be changed. Record a correction instead.' using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.internal_no <> old.internal_no
     or new.slip_no <> old.slip_no or new.slip_scheme <> old.slip_scheme or new.slip_period <> old.slip_period
     or new.created_at <> old.created_at then
    raise exception 'An order''s number and date cannot be changed.' using errcode = 'restrict_violation';
  end if;
  if new.customer_id <> old.customer_id and old.status <> 'estimate' then
    raise exception 'The customer can only be changed while it is an estimate.' using errcode = 'restrict_violation';
  end if;
  if new.status <> old.status and (old.status, new.status) not in
     (('estimate','accepted'), ('accepted','weighed'), ('weighed','done')) then
    raise exception 'An order cannot go from % to %.', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'weighed' and old.status = 'accepted' then
    if not exists (select 1 from public.order_items i where i.order_id = new.id) then
      raise exception 'An order needs at least one item before it can be weighed.' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.order_items i where i.order_id = new.id and i.actual_weight is null) then
      raise exception 'Every item needs its weight before the order is marked weighed.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- ---------- helpers ----------
create function app.caller(p_caller uuid) returns public.people
language plpgsql stable security definer set search_path = '' as $$
declare p public.people;
begin
  select pe.* into p from public.people pe join public.companies c on c.id = pe.company_id and c.active
  where pe.id = p_caller and pe.active;
  if p.id is null then raise exception 'Your staff access is not active.' using errcode = '42501'; end if;
  return p;
end $$;

create function app.require(p public.people, variadic perms text[]) returns void
language plpgsql immutable set search_path = '' as $$
declare k text;
begin
  foreach k in array perms loop
    if not coalesce((p.perms ->> k)::boolean, false) then
      raise exception 'You don''t have permission for this (%).', k using errcode = '42501';
    end if;
  end loop;
end $$;

create function app.has(p public.people, perm text) returns boolean
language sql immutable set search_path = '' as $$ select coalesce((p.perms ->> perm)::boolean, false) $$;

-- Start a request: null = new, otherwise the saved answer of the earlier identical request.
create function app.idem_start(p_company uuid, p_key uuid, p_op text, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.idempotency_keys;
begin
  if p_key is null then raise exception 'Missing request key.' using errcode = '22023'; end if;
  insert into private.idempotency_keys (company_id, key, operation, request_hash)
    values (p_company, p_key, p_op, p_hash) on conflict (company_id, key) do nothing;
  if found then return null; end if;
  select * into r from private.idempotency_keys where company_id = p_company and key = p_key;
  if r.operation <> p_op or r.request_hash <> p_hash then
    raise exception 'This request key was already used for a different request.' using errcode = '23505';
  end if;
  return coalesce(r.response, '{}'::jsonb) || '{"replayed":true}'::jsonb;
end $$;

create function app.idem_done(p_company uuid, p_key uuid, p_response jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  update private.idempotency_keys set response = p_response where company_id = p_company and key = p_key;
  select p_response;
$$;

-- Hand out the next number of a counter — one at a time, even with many phones at once.
create function app.next_counter(p_company uuid, p_key text, p_start bigint default 1) returns bigint
language sql security definer set search_path = '' as $$
  insert into private.slip_counters (company_id, counter_key, last_value) values (p_company, p_key, p_start)
  on conflict (company_id, counter_key) do update set last_value = private.slip_counters.last_value + 1, updated_at = now()
  returning last_value
$$;

-- Slip numbers in the shop's own time zone (must match @srs/core slips.js — checked by db:parity-check).
create function app.slip_counter_key(p_scheme text, p_at timestamptz, p_tz text) returns text
language plpgsql stable set search_path = '' as $$
declare l timestamp := p_at at time zone p_tz; y int := extract(year from l)::int; m int := extract(month from l)::int; fy int;
begin
  if p_scheme = 'daily' then return 'daily:' || to_char(l, 'YYYY-MM-DD'); end if;
  if p_scheme = 'monthly' then return 'monthly:' || to_char(l, 'YYYY-MM'); end if;
  if p_scheme = 'yearly' then fy := case when m >= 4 then y else y - 1 end; return 'yearly:' || fy || '-' || (fy + 1); end if;
  return 'internal';
end $$;

create function app.slip_label(p_scheme text, p_at timestamptz, p_tz text, p_n bigint) returns text
language plpgsql stable set search_path = '' as $$
declare
  l timestamp := p_at at time zone p_tz;
  y int := extract(year from l)::int; m int := extract(month from l)::int; d int := extract(day from l)::int; fy int;
  mon text := (array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'])[m];
begin
  if p_scheme = 'daily' then return d || mon || '-' || p_n; end if;
  if p_scheme = 'monthly' then return mon || right(y::text, 2) || '-' || p_n; end if;
  if p_scheme = 'yearly' then
    fy := case when m >= 4 then y else y - 1 end;
    return 'FY' || right(fy::text, 2) || '-' || right((fy + 1)::text, 2) || '-' || p_n;
  end if;
  return p_n::text;
end $$;

-- Money already paid on an order, split by kind (reversals count against what they reversed).
create function app.order_paid(p_order uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'advance', coalesce(sum(p.amount) filter (where coalesce(o.kind, p.kind) = 'advance'), 0),
    'pickup',  coalesce(sum(p.amount) filter (where coalesce(o.kind, p.kind) = 'pickup'), 0),
    'total',   coalesce(sum(p.amount), 0))
  from public.payments p left join public.payments o on o.id = p.reverses_payment_id
  where p.order_id = p_order
$$;

-- Insert items + lengths from the backend's checked list.
create function app.insert_items(p_company uuid, p_order uuid, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare it jsonb; ln jsonb; i int := 0; j int; item_id uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item.' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (company_id, order_id, position, material_id, grade_code, shape, unit, dims,
                                    sell_rate, cut_rate, density, special_rate)
      values (p_company, p_order, i, (it ->> 'material_id')::uuid, it ->> 'grade_code', it ->> 'shape', it ->> 'unit',
              array(select jsonb_array_elements_text(it -> 'dims')), (it ->> 'sell_rate')::numeric, (it ->> 'cut_rate')::numeric,
              (it ->> 'density')::numeric, coalesce((it ->> 'special_rate')::boolean, false))
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

create function app.take_advance(caller public.people, p_order uuid, p_advance jsonb, p_key uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare amt numeric := nullif(p_advance ->> 'amount', '')::numeric; cust uuid;
begin
  if amt is null or amt = 0 then return; end if;
  perform app.require(caller, 'money');
  select customer_id into cust from public.orders where id = p_order and company_id = caller.company_id;
  insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, note, created_by)
    values (caller.company_id, cust, p_order, amt, p_advance ->> 'mode', 'advance', nullif(btrim(p_advance ->> 'note'), ''), caller.id);
end $$;

-- =====================================================================================
-- Reading what the backend needs (always limited to the caller's own company)
-- =====================================================================================
create function public.api_pricing_context(p_caller uuid, p_customer uuid, p_materials uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'new');
  if not exists (select 1 from public.customers where id = p_customer and company_id = c.company_id and active) then
    raise exception 'Choose a customer from your list.' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'settings', (select to_jsonb(s) from public.company_settings s where s.company_id = c.company_id),
    'timezone', (select timezone from public.companies where id = c.company_id),
    'materials', coalesce((select jsonb_agg(jsonb_build_object(
        'id', m.id, 'code', m.code, 'family', m.family, 'density_override', m.density_override, 'active', m.active,
        'sell_rate', r.sell_rate, 'cut_rate', r.cut_rate, 'special_rate', cr.rate))
      from public.materials m
      left join public.current_material_rates r on r.material_id = m.id
      left join public.current_customer_rates cr on cr.material_id = m.id and cr.customer_id = p_customer
      where m.company_id = c.company_id and m.id = any(p_materials)), '[]'::jsonb));
end $$;

create function public.api_order_context(p_caller uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); o public.orders;
begin
  perform app.require(c, 'money');
  select * into o from public.orders where id = p_order and company_id = c.company_id;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if o.bill_type = 'kacha' then perform app.require(c, 'kacha'); end if;
  return jsonb_build_object(
    'order', to_jsonb(o),
    'items', coalesce((select jsonb_agg(to_jsonb(i) || jsonb_build_object('lengths',
        (select coalesce(jsonb_agg(to_jsonb(l) order by l.position), '[]'::jsonb) from public.order_item_lengths l where l.order_item_id = i.id))
        order by i.position) from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'paid', app.order_paid(o.id),
    'settings', (select to_jsonb(s) from public.company_settings s where s.company_id = c.company_id),
    'timezone', (select timezone from public.companies where id = c.company_id));
end $$;

-- For the weigher: orders waiting to be weighed, with sizes and pieces but NO rates or amounts.
create function public.api_weighing_list(p_caller uuid, p_order uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'weigh');
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'slip_no', o.slip_no, 'status', o.status, 'created_at', o.created_at,
      'min_inch', coalesce((o.pricing_rules ->> 'min_inch')::int, 0),
      'customer', (select name from public.customers where id = o.customer_id),
      'items', (select jsonb_agg(jsonb_build_object(
          'id', i.id, 'material_id', i.material_id, 'grade_code', i.grade_code, 'shape', i.shape, 'unit', i.unit,
          'dims', to_jsonb(i.dims), 'density', i.density, 'actual_weight', i.actual_weight, 'weigh_batch_id', i.weigh_batch_id,
          'lengths', (select coalesce(jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs, 'cuts', l.cuts) order by l.position), '[]'::jsonb)
                      from public.order_item_lengths l where l.order_item_id = i.id)) order by i.position)
        from public.order_items i where i.order_id = o.id)) order by o.created_at)
    from public.orders o
    where o.company_id = c.company_id and o.status = 'accepted' and (p_order is null or o.id = p_order)), '[]'::jsonb);
end $$;

-- =====================================================================================
-- Changes
-- =====================================================================================
create function public.api_create_order(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_rules jsonb,
                                        p_items jsonb, p_accept boolean default false, p_advance jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.people := app.caller(p_caller); prev jsonb; s public.company_settings; tz text;
  internal bigint; slip text; period text := 'internal'; n bigint; oid uuid := gen_random_uuid(); st text := 'estimate';
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'createOrder', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into s from public.company_settings where company_id = c.company_id;
  select timezone into tz from public.companies where id = c.company_id;
  internal := app.next_counter(c.company_id, 'internal', s.first_slip_no);
  if s.slip_numbering = 'never' then
    slip := internal::text;
  else
    period := app.slip_counter_key(s.slip_numbering, now(), tz);
    n := app.next_counter(c.company_id, period);
    slip := app.slip_label(s.slip_numbering, now(), tz, n);
  end if;
  insert into public.orders (id, company_id, internal_no, slip_no, slip_scheme, slip_period, customer_id, pricing_rules, created_by, idempotency_key)
    values (oid, c.company_id, internal, slip, s.slip_numbering, period, p_customer, coalesce(p_rules, '{}'), c.id, p_key);
  perform app.insert_items(c.company_id, oid, p_items);
  if p_accept then
    update public.orders set status = 'accepted', accepted_at = now() where id = oid;
    st := 'accepted';
    if p_advance is not null then perform app.take_advance(c, oid, p_advance, p_key); end if;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', oid, 'internal_no', internal, 'slip_no', slip, 'status', st));
end $$;

create function public.api_update_order(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_customer uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders;
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'updateOrder', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where id = p_order and company_id = c.company_id for update;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if o.status <> 'estimate' then raise exception 'Only an estimate can be edited.' using errcode = '23001'; end if;
  update public.orders set customer_id = p_customer where id = o.id;
  delete from public.order_items where order_id = o.id;
  perform app.insert_items(c.company_id, o.id, p_items);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'slip_no', o.slip_no, 'status', 'estimate'));
end $$;

create function public.api_accept_order(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_advance jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders;
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'acceptOrder', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where id = p_order and company_id = c.company_id for update;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if o.status <> 'estimate' then raise exception 'This order is already accepted.' using errcode = '23001'; end if;
  update public.orders set status = 'accepted', accepted_at = now() where id = o.id;
  if p_advance is not null then perform app.take_advance(c, o.id, p_advance, p_key); end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'slip_no', o.slip_no, 'status', 'accepted'));
end $$;

create function public.api_add_advance(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_amount numeric, p_mode text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders;
begin
  perform app.require(c, 'money');
  prev := app.idem_start(c.company_id, p_key, 'addAdvance', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where id = p_order and company_id = c.company_id for update;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the advance amount.' using errcode = '22023'; end if;
  perform app.take_advance(c, o.id, jsonb_build_object('amount', p_amount, 'mode', p_mode, 'note', p_note), p_key);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'paid', app.order_paid(o.id)));
end $$;

-- Weights: single items, and batches weighed together (split already worked out by @srs/core).
create function public.api_record_weights(p_caller uuid, p_key uuid, p_hash text, p_order uuid,
                                          p_weights jsonb, p_batches jsonb, p_submit boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; w jsonb; b jsonb; bid uuid; parts numeric; grades int; cnt int; st text;
begin
  perform app.require(c, 'weigh');
  prev := app.idem_start(c.company_id, p_key, 'recordWeights', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where id = p_order and company_id = c.company_id for update;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if o.status <> 'accepted' then raise exception 'Weights can only be entered while the order is waiting to be weighed.' using errcode = '23001'; end if;
  for w in select * from jsonb_array_elements(coalesce(p_weights, '[]')) loop
    update public.order_items set actual_weight = (w ->> 'weight')::numeric, weigh_batch_id = null
      where id = (w ->> 'item_id')::uuid and order_id = o.id;
    if not found then raise exception 'That item is not on this slip.' using errcode = '22023'; end if;
  end loop;
  for b in select * from jsonb_array_elements(coalesce(p_batches, '[]')) loop
    select count(*), count(distinct i.material_id), coalesce(sum((pt ->> 'weight')::numeric), 0)
      into cnt, grades, parts
      from jsonb_array_elements(b -> 'parts') pt join public.order_items i on i.id = (pt ->> 'item_id')::uuid and i.order_id = o.id;
    if cnt < 2 or cnt <> jsonb_array_length(b -> 'parts') then raise exception 'Weigh-together needs 2 or more items from this slip.' using errcode = '22023'; end if;
    if grades <> 1 then raise exception 'Only items of the same grade can be weighed together.' using errcode = '22023'; end if;
    if parts <> (b ->> 'total_weight')::numeric then raise exception 'The split must add up exactly to the scale reading.' using errcode = '22023'; end if;
    insert into public.weigh_batches (company_id, order_id, total_weight, weighed_by)
      values (c.company_id, o.id, (b ->> 'total_weight')::numeric, c.id) returning id into bid;
    update public.order_items i set actual_weight = (pt ->> 'weight')::numeric, weigh_batch_id = bid
      from jsonb_array_elements(b -> 'parts') pt where i.id = (pt ->> 'item_id')::uuid and i.order_id = o.id;
  end loop;
  st := o.status;
  if p_submit then update public.orders set status = 'weighed', weighed_at = now() where id = o.id; st := 'weighed'; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'status', st,
    'weights', (select jsonb_agg(jsonb_build_object('item_id', id, 'weight', actual_weight, 'batch', weigh_batch_id) order by position)
                from public.order_items where order_id = o.id)));
end $$;

-- Finish: bill type, totals (worked out by @srs/core), pickup payment.
-- p_final.basis = what the totals were worked out from; if anything changed meanwhile, refuse (retry).
create function public.api_finalize_order(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_final jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; s public.company_settings; paid jsonb; t jsonb := p_final -> 'totals';
  bill text := p_final ->> 'bill'; now_amt numeric := coalesce(nullif(p_final ->> 'paid_now', '')::numeric, 0);
begin
  perform app.require(c, 'money');
  if bill = 'kacha' then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'finalizeOrder', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where id = p_order and company_id = c.company_id for update;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if o.status <> 'weighed' then raise exception 'Only a weighed order can be finished.' using errcode = '23001'; end if;
  select * into s from public.company_settings where company_id = c.company_id;
  paid := app.order_paid(o.id);
  if (paid ->> 'advance')::numeric <> (p_final #>> '{basis,advance}')::numeric
     or s.gst_pct <> (p_final ->> 'gst_pct')::numeric or s.kacha_pct <> (p_final ->> 'kacha_pct')::numeric
     or exists (select 1 from public.order_items i where i.order_id = o.id
                and i.actual_weight is distinct from (p_final -> 'basis' -> 'weights' ->> i.id::text)::numeric) then
    raise exception 'Something on this slip changed while finishing. Please check and try again.' using errcode = '40001';
  end if;
  -- same rule as @srs/core staysInKhata: in the khata unless paid exactly the bill total
  if (p_final ->> 'in_khata')::boolean is distinct from (round((paid ->> 'total')::numeric + now_amt, 2) <> (t ->> 'total')::numeric) then
    raise exception 'Khata status does not match the payment.' using errcode = '22023';
  end if;
  update public.orders set status = 'done', done_at = now(), bill_type = bill,
      gst_pct = s.gst_pct, kacha_pct = s.kacha_pct, pay_mode = p_final ->> 'pay_mode',
      in_khata = (p_final ->> 'in_khata')::boolean,
      total_weight = (t ->> 'weight')::numeric, base_amount = (t ->> 'base')::numeric,
      material_amount = (t ->> 'material')::numeric, cutting_amount = (t ->> 'cutting')::numeric,
      gst_amount = (t ->> 'gst')::numeric, total_amount = (t ->> 'total')::numeric
    where id = o.id;
  if now_amt > 0 then
    insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, note, created_by)
      values (c.company_id, o.customer_id, o.id, now_amt, p_final ->> 'pay_method', 'pickup', nullif(btrim(p_final ->> 'note'), ''), c.id);
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'slip_no', o.slip_no, 'status', 'done',
    'bill', bill, 'total', (t ->> 'total')::numeric, 'in_khata', (p_final ->> 'in_khata')::boolean, 'paid', app.order_paid(o.id)));
end $$;

-- A payment from the Khata screen (not tied to one slip).
create function public.api_record_payment(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_amount numeric,
                                          p_mode text, p_side text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; pid uuid;
begin
  perform app.require(c, 'money', 'khata');
  if p_side = 'kacha' then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'recordPayment', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount received.' using errcode = '22023'; end if;
  insert into public.payments (company_id, customer_id, amount, mode, kind, side, note, created_by, idempotency_key)
    values (c.company_id, p_customer, p_amount, p_mode, 'khata', p_side, nullif(btrim(p_note), ''), c.id, p_key) returning id into pid;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('payment_id', pid, 'amount', p_amount));
end $$;

-- Cancel a wrong payment with an exact opposite entry. If it was paid on a finished slip, that slip goes into the khata.
create function public.api_reverse_payment(p_caller uuid, p_key uuid, p_hash text, p_payment uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; orig public.payments; ord public.orders; rid uuid;
begin
  perform app.require(c, 'money', 'khata');
  if nullif(btrim(p_note), '') is null then raise exception 'Write why this payment is being cancelled.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'reversePayment', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into orig from public.payments where id = p_payment and company_id = c.company_id;
  if orig.id is null then raise exception 'Payment not found.' using errcode = '22023'; end if;
  select * into ord from public.orders where id = orig.order_id;
  if orig.side = 'kacha' or ord.bill_type = 'kacha' then perform app.require(c, 'kacha'); end if;
  insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, side, note, reverses_payment_id, created_by)
    values (c.company_id, orig.customer_id, orig.order_id, -orig.amount, orig.mode, 'reversal', orig.side, btrim(p_note), orig.id, c.id)
    returning id into rid;
  if ord.status = 'done' and not ord.in_khata then update public.orders set in_khata = true where id = ord.id; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('reversal_id', rid, 'reverses', orig.id, 'amount', -orig.amount));
end $$;

-- Daily cash count, filed under the shop's own date; expected cash worked out here.
create function public.api_save_cash_count(p_caller uuid, p_key uuid, p_hash text, p_counted numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; tz text; d date; expected numeric;
begin
  perform app.require(c, 'money', 'today');
  prev := app.idem_start(c.company_id, p_key, 'saveCashCount', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_counted is null or p_counted < 0 then raise exception 'Enter the cash you counted.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  d := (now() at time zone tz)::date;
  select coalesce(sum(amount), 0) into expected from public.payments
    where company_id = c.company_id and mode = 'Cash' and (received_at at time zone tz)::date = d;
  insert into public.cash_closes (company_id, business_date, expected_cash, counted_cash, note, closed_by)
    values (c.company_id, d, expected, p_counted, nullif(btrim(p_note), ''), c.id);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('business_date', d, 'expected', expected, 'counted', p_counted, 'difference', p_counted - expected));
end $$;

-- Rates, materials, customers, settings
create function public.api_change_material_rate(p_caller uuid, p_key uuid, p_hash text, p_material uuid,
                                                p_sell numeric, p_cut numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; rid uuid;
begin
  perform app.require(c, 'rates');
  prev := app.idem_start(c.company_id, p_key, 'changeMaterialRate', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if not exists (select 1 from public.materials where id = p_material and company_id = c.company_id) then
    raise exception 'Material not found.' using errcode = '22023';
  end if;
  insert into public.material_rates (company_id, material_id, sell_rate, cut_rate, note, created_by)
    values (c.company_id, p_material, p_sell, p_cut, nullif(btrim(p_note), ''), c.id) returning id into rid;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('rate_id', rid, 'material_id', p_material, 'sell_rate', p_sell, 'cut_rate', p_cut));
end $$;

create function public.api_create_material(p_caller uuid, p_key uuid, p_hash text, p_code text, p_family text,
                                           p_sell numeric, p_cut numeric, p_density numeric default null, p_info jsonb default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; mid uuid;
begin
  perform app.require(c, 'rates');
  prev := app.idem_start(c.company_id, p_key, 'createMaterial', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  insert into public.materials (company_id, code, family, density_override, info)
    values (c.company_id, upper(btrim(p_code)), p_family, p_density, p_info) returning id into mid;
  insert into public.material_rates (company_id, material_id, sell_rate, cut_rate, created_by)
    values (c.company_id, mid, p_sell, p_cut, c.id);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('material_id', mid, 'code', upper(btrim(p_code))));
end $$;

create function public.api_update_material(p_caller uuid, p_key uuid, p_hash text, p_material uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; m public.materials;
begin
  perform app.require(c, 'rates');
  prev := app.idem_start(c.company_id, p_key, 'updateMaterial', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.materials set
      active = coalesce((p_changes ->> 'active')::boolean, active),
      density_override = case when p_changes ? 'density_override' then nullif(p_changes ->> 'density_override', '')::numeric else density_override end,
      info = case when p_changes ? 'info' then p_changes -> 'info' else info end
    where id = p_material and company_id = c.company_id returning * into m;
  if m.id is null then raise exception 'Material not found.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, to_jsonb(m));
end $$;

create function public.api_create_customer(p_caller uuid, p_key uuid, p_hash text, p_name text, p_phone text, p_notes text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; cu public.customers;
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'createCustomer', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  insert into public.customers (company_id, name, phone, notes)
    values (c.company_id, btrim(p_name), nullif(btrim(p_phone), ''), nullif(btrim(p_notes), '')) returning * into cu;
  return app.idem_done(c.company_id, p_key, to_jsonb(cu));
end $$;

create function public.api_update_customer(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; cu public.customers;
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'updateCustomer', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.customers set
      name = coalesce(nullif(btrim(p_changes ->> 'name'), ''), name),
      phone = case when p_changes ? 'phone' then nullif(btrim(p_changes ->> 'phone'), '') else phone end,
      notes = case when p_changes ? 'notes' then nullif(btrim(p_changes ->> 'notes'), '') else notes end,
      active = coalesce((p_changes ->> 'active')::boolean, active)
    where id = p_customer and company_id = c.company_id returning * into cu;
  if cu.id is null then raise exception 'Customer not found.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, to_jsonb(cu));
end $$;

-- p_rate = null removes the special rate.
create function public.api_set_customer_rate(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_material uuid, p_rate numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb;
begin
  perform app.require(c, 'rates');
  prev := app.idem_start(c.company_id, p_key, 'setCustomerRate', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  insert into public.customer_rates (company_id, customer_id, material_id, rate, created_by)
    values (c.company_id, p_customer, p_material, p_rate, c.id);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('customer_id', p_customer, 'material_id', p_material, 'rate', p_rate));
end $$;

create function public.api_change_settings(p_caller uuid, p_key uuid, p_hash text, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; s public.company_settings; bad text; co jsonb := p_changes -> 'company';
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'changeSettings', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select string_agg(k, ', ') into bad from jsonb_object_keys(p_changes) k
    where k not in ('gst_pct','kacha_pct','min_inch','default_unit','show_weight_on_slip','weight_warn_pct','slip_numbering',
                    'family_density','slip_header','unlock_hours','first_slip_no','ai_daily_limit','company');
  if bad is not null then raise exception 'Unknown setting: %', bad using errcode = '22023'; end if;
  if p_changes ? 'first_slip_no' and exists (select 1 from public.orders where company_id = c.company_id) then
    raise exception 'The first slip number can only be set before the first order.' using errcode = '23514';
  end if;
  update public.company_settings set
      gst_pct = coalesce((p_changes ->> 'gst_pct')::numeric, gst_pct),
      kacha_pct = coalesce((p_changes ->> 'kacha_pct')::numeric, kacha_pct),
      min_inch = coalesce((p_changes ->> 'min_inch')::int, min_inch),
      default_unit = coalesce(p_changes ->> 'default_unit', default_unit),
      show_weight_on_slip = coalesce((p_changes ->> 'show_weight_on_slip')::boolean, show_weight_on_slip),
      weight_warn_pct = coalesce((p_changes ->> 'weight_warn_pct')::numeric, weight_warn_pct),
      slip_numbering = coalesce(p_changes ->> 'slip_numbering', slip_numbering),
      family_density = coalesce(p_changes -> 'family_density', family_density),
      slip_header = coalesce(p_changes -> 'slip_header', slip_header),
      unlock_hours = coalesce((p_changes ->> 'unlock_hours')::int, unlock_hours),
      first_slip_no = coalesce((p_changes ->> 'first_slip_no')::bigint, first_slip_no),
      ai_daily_limit = coalesce((p_changes ->> 'ai_daily_limit')::int, ai_daily_limit),
      updated_at = now(), updated_by = c.id
    where company_id = c.company_id returning * into s;
  if co is not null then
    update public.companies set
        name = coalesce(nullif(btrim(co ->> 'name'), ''), name),
        legal_name = case when co ? 'legal_name' then nullif(btrim(co ->> 'legal_name'), '') else legal_name end,
        gstin = case when co ? 'gstin' then nullif(upper(btrim(co ->> 'gstin')), '') else gstin end,
        phone = case when co ? 'phone' then nullif(btrim(co ->> 'phone'), '') else phone end,
        address = case when co ? 'address' then nullif(btrim(co ->> 'address'), '') else address end
      where id = c.company_id;
  end if;
  return app.idem_done(c.company_id, p_key, to_jsonb(s));
end $$;

-- Ask Claude: count one question against today's limit. Returns false when the limit is reached.
create function public.api_ai_take(p_caller uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); lim int; tz text; used int;
begin
  select ai_daily_limit into lim from public.company_settings where company_id = c.company_id;
  select timezone into tz from public.companies where id = c.company_id;
  insert into private.ai_usage (company_id, day, questions) values (c.company_id, (now() at time zone tz)::date, 1)
    on conflict (company_id, day) do update set questions = private.ai_usage.questions + 1
    returning questions into used;
  return used <= lim;
end $$;

create function public.api_ai_context(p_caller uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('lang', c.preferred_lang,
    'stock', coalesce((select jsonb_agg(jsonb_build_object('code', m.code, 'family', m.family) order by m.code)
                       from public.materials m where m.company_id = c.company_id and m.active), '[]'::jsonb))
  from app.caller(p_caller) c
$$;

-- ---------- only the backend may call these ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'api\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app' and p.proname in ('caller','require','has','idem_start','idem_done','next_counter',
             'slip_counter_key','slip_label','order_paid','insert_items','take_advance') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
