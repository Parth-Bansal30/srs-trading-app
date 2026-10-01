-- =====================================================================================
-- 19. Purchases and stock (owner decisions 30 Sept 2026).
--   * A purchase bill (read from the mill's PDF / a photo, or typed in) is checked by a person
--     before it is saved. Every line becomes stock.
--   * A STOCK ITEM = grade + shape + HSN + rate per kg. A different rate or HSN is always a
--     separate item; when all four match, the weight is added to the existing item.
--   * Stock is a ledger of moves (never edited): bought, sold (when the slip is WEIGHED), given
--     back (slip cancelled / deleted after weighing), counted / written off, bill cancelled.
--   * Each order item can say which stock it comes from (picked when the order is made,
--     changeable until it is weighed). Selling without stock is allowed and shows up for the owner.
--   * New permission "stock": enter bills, correct stock, see buying rates and stock value.
-- =====================================================================================

-- ---------- a) the "stock" permission ----------
create or replace function app.valid_perms(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
    where e.key not in ('new','orders','weigh','khata','today','rates','people','settings','money','kacha','price','delete','stock')
       or jsonb_typeof(e.value) <> 'boolean')
$$;
create or replace function app.role_preset(role text) returns jsonb
language sql immutable set search_path = '' as $$
  select case role
    when 'owner'    then '{"new":true,"orders":true,"weigh":true,"khata":true,"today":true,"rates":true,"people":true,"settings":true,"money":true,"kacha":true,"price":true,"delete":true,"stock":true}'::jsonb
    when 'sales'    then '{"new":true,"orders":true,"money":true,"kacha":true}'::jsonb
    when 'weigher'  then '{"weigh":true,"orders":true}'::jsonb
    when 'accounts' then '{"orders":true,"khata":true,"today":true,"money":true}'::jsonb
    else '{}'::jsonb end
$$;
update public.people set perms = perms || '{"stock":true}'::jsonb where role = 'owner' and not (perms ? 'stock');

-- ---------- b) suppliers ----------
create table public.suppliers (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  name       text not null check (length(btrim(name)) between 1 and 120),
  gstin      text check (gstin is null or gstin ~ '^[0-9]{2}[0-9A-Z]{13}$'),
  phone      text check (phone is null or length(phone) <= 30),
  city       text check (city is null or length(city) <= 80),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, id)
);
create unique index suppliers_name_uq on public.suppliers (company_id, lower(btrim(name)));
create unique index suppliers_gstin_uq on public.suppliers (company_id, gstin) where gstin is not null;

-- ---------- c) stock items ----------
alter table public.materials add column low_stock_kg numeric(12,3) check (low_stock_kg is null or low_stock_kg >= 0);

create table public.stock_items (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  material_id uuid not null,
  shape       text check (shape is null or shape in ('square','round','flat','block','hex','plate')),  -- null = any / mixed
  hsn         text not null default '' check (hsn ~ '^[0-9]{0,8}$'),
  rate        numeric(12,3) not null check (rate >= 0),        -- ₹ per kg as on the bill
  cost        numeric(12,3) not null default 0 check (cost >= 0), -- real cost ₹/kg with freight share (average)
  label       text check (label is null or length(btrim(label)) between 1 and 60), -- the shop's own name for it
  closed      boolean not null default false,
  first_in    timestamptz not null default now(),
  last_in     timestamptz not null default now(),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, material_id) references public.materials(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id)
);
create unique index stock_items_key on public.stock_items (company_id, material_id, coalesce(shape, 'any'), hsn, rate);
create index stock_items_material_idx on public.stock_items (company_id, material_id);

-- ---------- d) purchase bills ----------
create table public.purchases (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  kind            text not null default 'bill' check (kind in ('bill','opening')),  -- opening = stock already in the godown
  supplier_id     uuid,
  bill_no         text check (bill_no is null or length(btrim(bill_no)) between 1 and 40),
  bill_date       date not null,
  bill_type       text not null check (bill_type in ('pakka','kacha')),
  items_amount    numeric(14,2) not null check (items_amount >= 0),
  freight         numeric(12,2) not null default 0 check (freight >= 0),
  other_charges   numeric(12,2) not null default 0 check (other_charges >= 0),
  gst_amount      numeric(12,2) not null default 0 check (gst_amount >= 0),
  round_off       numeric(8,2) not null default 0 check (abs(round_off) <= 100),
  total_amount    numeric(14,2) not null check (total_amount >= 0),
  total_kg        numeric(14,3) not null check (total_kg > 0),
  pay_status      text not null default 'to_pay' check (pay_status in ('paid','to_pay')),
  paid_at         timestamptz,
  file_key        text check (file_key is null or length(file_key) <= 200),
  read_by_ai      boolean not null default false,
  note            text check (note is null or length(note) <= 500),
  status          text not null default 'saved' check (status in ('saved','cancelled')),
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text check (cancel_reason is null or length(cancel_reason) between 1 and 500),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  idempotency_key uuid,
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, supplier_id) references public.suppliers(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  foreign key (company_id, cancelled_by) references public.people(company_id, id),
  constraint purchases_kacha_no_gst check (bill_type = 'pakka' or gst_amount = 0),
  constraint purchases_bill_has_supplier check (kind = 'opening' or supplier_id is not null),
  constraint purchases_cancelled check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
-- the same bill can't be saved twice (a cancelled one can be entered again)
create unique index purchases_bill_uq on public.purchases (company_id, supplier_id, lower(btrim(bill_no)))
  where bill_no is not null and status = 'saved';
create index purchases_recent_idx on public.purchases (company_id, bill_date desc, created_at desc);

create table public.purchase_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  purchase_id   uuid not null,
  position      smallint not null check (position >= 0),
  description   text not null check (length(btrim(description)) between 1 and 200),  -- as on the bill
  hsn           text not null default '' check (hsn ~ '^[0-9]{0,8}$'),
  qty_kg        numeric(14,3) not null check (qty_kg > 0),
  rate          numeric(12,3) not null check (rate >= 0),
  amount        numeric(14,2) not null check (amount >= 0),
  freight_share numeric(12,3) not null default 0 check (freight_share >= 0),
  stock_item_id uuid not null,
  unique (company_id, id),
  unique (purchase_id, position),
  foreign key (company_id, purchase_id) references public.purchases(company_id, id),
  foreign key (company_id, stock_item_id) references public.stock_items(company_id, id)
);
create index purchase_lines_purchase_idx on public.purchase_lines (company_id, purchase_id);
create index purchase_lines_stock_idx on public.purchase_lines (company_id, stock_item_id);

-- ---------- e) stock moves (the stock ledger; never edited) ----------
create table public.stock_moves (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  stock_item_id    uuid not null,
  kind             text not null check (kind in ('purchase','purchase_undo','sale','sale_undo','adjust','scrap')),
  qty_kg           numeric(14,3) not null check (qty_kg <> 0),   -- + in, − out
  purchase_line_id uuid,
  order_id         uuid,
  order_item_id    uuid,
  note             text check (note is null or length(note) <= 300),
  created_by       uuid,
  created_at       timestamptz not null default clock_timestamp(),
  unique (company_id, id),
  foreign key (company_id, stock_item_id) references public.stock_items(company_id, id),
  foreign key (company_id, purchase_line_id) references public.purchase_lines(company_id, id),
  foreign key (company_id, order_id) references public.orders(company_id, id),
  foreign key (company_id, order_item_id) references public.order_items(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  constraint stock_moves_sign check (kind = 'adjust' or (kind in ('purchase','sale_undo')) = (qty_kg > 0)),
  constraint stock_moves_purchase_link check ((kind in ('purchase','purchase_undo')) = (purchase_line_id is not null)),
  constraint stock_moves_sale_link check ((kind in ('sale','sale_undo')) = (order_item_id is not null and order_id is not null))
);
create index stock_moves_item_idx on public.stock_moves (company_id, stock_item_id, created_at);
create index stock_moves_day_idx on public.stock_moves (company_id, created_at desc);
create index stock_moves_order_idx on public.stock_moves (company_id, order_id) where order_id is not null;

create trigger stock_moves_no_change before update or delete on public.stock_moves for each row execute function app.forbid_change();
create trigger purchase_lines_no_change before update or delete on public.purchase_lines for each row execute function app.forbid_change();
create trigger audit after insert or update or delete on public.purchases for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.stock_items for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.suppliers for each row execute function app.audit_row();

-- what the bill called it → which grade / shape the shop saved it as (suggested next time)
create table private.purchase_names (
  company_id   uuid not null references public.companies(id) on delete restrict,
  supplier_key text not null default '',   -- supplier id, or '' for any supplier
  desc_key     text not null check (length(desc_key) between 1 and 200),
  material_id  uuid not null,
  shape        text check (shape is null or shape in ('square','round','flat','block','hex','plate')),
  updated_at   timestamptz not null default now(),
  primary key (company_id, supplier_key, desc_key),
  foreign key (company_id, material_id) references public.materials(company_id, id)
);
alter table private.purchase_names enable row level security;
revoke all on private.purchase_names from anon, authenticated;

-- ---------- f) reading: owners (stock permission) may read these tables; everyone else gets them from the api ----------
alter table public.suppliers enable row level security;
alter table public.stock_items enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_lines enable row level security;
alter table public.stock_moves enable row level security;
create policy suppliers_read on public.suppliers for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('stock')));
create policy stock_items_read on public.stock_items for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('stock')));
create policy purchases_read on public.purchases for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('stock'))
         and (bill_type = 'pakka' or (select app.has_perm('kacha'))));
create policy purchase_lines_read on public.purchase_lines for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('stock')));
create policy stock_moves_read on public.stock_moves for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('stock')));
revoke all on public.suppliers, public.stock_items, public.purchases, public.purchase_lines, public.stock_moves from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.suppliers, public.stock_items, public.purchases, public.purchase_lines, public.stock_moves from authenticated;

-- ---------- g) order items say which stock they come from ----------
alter table public.order_items add column stock_item_id uuid;
alter table public.order_items add constraint order_items_stock_fk foreign key (company_id, stock_item_id) references public.stock_items(company_id, id);
create index order_items_stock_idx on public.order_items (company_id, stock_item_id) where stock_item_id is not null;

-- Items: editable only while an estimate; weights only while waiting to be weighed; the stock it comes
-- from can be changed until it is weighed — and it must be stock of the same grade.
create or replace function app.guard_order_item() returns trigger
language plpgsql set search_path = '' as $$
declare st text; free_cols text[] := array['actual_weight','weigh_batch_id','stock_item_id'];
begin
  if tg_op in ('INSERT','UPDATE') and new.stock_item_id is not null and not exists (
       select 1 from public.stock_items s where s.id = new.stock_item_id and s.company_id = new.company_id and s.material_id = new.material_id) then
    raise exception 'That stock is not of the same grade as the item.' using errcode = 'check_violation';
  end if;
  select o.status into st from public.orders o
  where o.id = coalesce(new.order_id, old.order_id) and o.company_id = coalesce(new.company_id, old.company_id);
  if st is null then return coalesce(new, old); end if;  -- parent being deleted (estimate) or new order row
  if tg_op = 'UPDATE' then
    if new.order_id <> old.order_id or new.company_id <> old.company_id then
      raise exception 'An item cannot be moved to another order.' using errcode = 'restrict_violation';
    end if;
    if (to_jsonb(new) - free_cols) = (to_jsonb(old) - free_cols) then
      if new.stock_item_id is distinct from old.stock_item_id and st not in ('estimate','accepted') then
        raise exception 'The stock can only be changed before the slip is weighed.' using errcode = 'restrict_violation';
      end if;
      if (new.actual_weight is distinct from old.actual_weight or new.weigh_batch_id is distinct from old.weigh_batch_id) and st <> 'accepted' then
        raise exception 'Weights can only be entered while the order is waiting to be weighed.' using errcode = 'restrict_violation';
      end if;
      return new;
    end if;
  end if;
  if st <> 'estimate' then
    raise exception 'Items can only be changed while the order is an estimate.' using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end $$;

create or replace function app.insert_items(p_company uuid, p_order uuid, p_items jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare it jsonb; ln jsonb; i int := 0; j int; item_id uuid;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'An order needs at least one item.' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    insert into public.order_items (company_id, order_id, position, material_id, grade_code, shape, unit, dims,
                                    sell_rate, cut_rate, density, special_rate, stock_item_id)
      values (p_company, p_order, i, (it ->> 'material_id')::uuid, it ->> 'grade_code', it ->> 'shape', it ->> 'unit',
              array(select jsonb_array_elements_text(it -> 'dims')), (it ->> 'sell_rate')::numeric, (it ->> 'cut_rate')::numeric,
              (it ->> 'density')::numeric, coalesce((it ->> 'special_rate')::boolean, false), nullif(it ->> 'stock_item_id', '')::uuid)
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

-- Stock follows the slip: weighed → the weight comes off its stock; cancelled or deleted after weighing → it goes back.
create function app.stock_follow_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare by_id uuid := nullif(current_setting('app.person_id', true), '')::uuid;
begin
  if new.status = old.status then return new; end if;
  if old.status = 'accepted' and new.status = 'weighed' then
    insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, order_id, order_item_id, created_by)
      select i.company_id, i.stock_item_id, 'sale', -i.actual_weight, i.order_id, i.id, by_id
      from public.order_items i
      where i.company_id = new.company_id and i.order_id = new.id and i.stock_item_id is not null and i.actual_weight > 0;
  elsif (new.status = 'cancelled' and old.status = 'weighed') or (new.status = 'deleted' and old.status in ('weighed','done')) then
    insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, order_id, order_item_id, note, created_by)
      select m.company_id, m.stock_item_id, 'sale_undo', -sum(m.qty_kg), m.order_id, m.order_item_id,
             case when new.status = 'deleted' then 'Slip deleted' else 'Order cancelled' end, by_id
      from public.stock_moves m
      where m.company_id = new.company_id and m.order_id = new.id and m.kind in ('sale','sale_undo')
      group by m.company_id, m.stock_item_id, m.order_id, m.order_item_id
      having sum(m.qty_kg) < 0;
  end if;
  return new;
end $$;
create trigger stock_follow after update of status on public.orders for each row execute function app.stock_follow_order();

-- ---------- h) operations (called only by the api function) ----------
create function app.stock_on_hand(p_item uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(qty_kg), 0) from public.stock_moves where stock_item_id = p_item
$$;

-- Everything the stock screen and the "take from which stock?" picker need. Buying rates and value only with "stock".
create function public.api_stock_data(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  if not (app.has(c, 'new') or app.has(c, 'weigh') or app.has(c, 'orders') or app.has(c, 'stock')) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  k := app.has(c, 'stock');
  return jsonb_build_object(
    'can_cost', k,
    'materials', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'code', m.code, 'family', m.family, 'low_kg', m.low_stock_kg, 'active', m.active) order by m.code)
      from public.materials m where m.company_id = c.company_id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'material_id', s.material_id, 'code', m.code, 'shape', s.shape, 'hsn', s.hsn, 'label', s.label, 'closed', s.closed,
        'first_in', s.first_in, 'last_in', s.last_in,
        'rate', case when k then s.rate end, 'cost', case when k then s.cost end,
        'on_hand', (select coalesce(sum(mv.qty_kg), 0) from public.stock_moves mv where mv.stock_item_id = s.id),
        'supplier', (select sp.name from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
                     left join public.suppliers sp on sp.id = p.supplier_id
                     where pl.stock_item_id = s.id and p.status = 'saved' order by p.bill_date desc, p.created_at desc limit 1)
      ) order by m.code, s.first_in)
      from public.stock_items s join public.materials m on m.id = s.material_id where s.company_id = c.company_id), '[]'::jsonb),
    -- items on open orders that will take from a stock (so we know what is already booked)
    'booked', coalesce((select jsonb_agg(jsonb_build_object('stock_item_id', i.stock_item_id, 'order_id', o.id, 'slip_no', o.slip_no,
        'shape', i.shape, 'unit', i.unit, 'dims', i.dims, 'density', i.density, 'min_inch', o.pricing_rules -> 'min_inch',
        'lengths', coalesce((select jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs, 'cuts', l.cuts) order by l.position)
          from public.order_item_lengths l where l.company_id = i.company_id and l.order_item_id = i.id), '[]'::jsonb)))
      from public.order_items i join public.orders o on o.company_id = i.company_id and o.id = i.order_id
      where i.company_id = c.company_id and i.stock_item_id is not null and o.status in ('estimate','accepted')), '[]'::jsonb));
end $$;

-- One stock item: its moves, with the bill or slip behind each one.
create function public.api_stock_item(p_caller uuid, p_item uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; s public.stock_items;
begin
  if not (app.has(c, 'new') or app.has(c, 'weigh') or app.has(c, 'orders') or app.has(c, 'stock')) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  k := app.has(c, 'stock');
  select * into s from public.stock_items where id = p_item and company_id = c.company_id;
  if s.id is null then raise exception 'Stock not found.' using errcode = '22023'; end if;
  return jsonb_build_object(
    'item', jsonb_build_object('id', s.id, 'material_id', s.material_id, 'code', (select code from public.materials where id = s.material_id),
      'low_kg', (select low_stock_kg from public.materials where id = s.material_id),
      'shape', s.shape, 'hsn', s.hsn, 'label', s.label, 'closed', s.closed, 'first_in', s.first_in, 'last_in', s.last_in,
      'rate', case when k then s.rate end, 'cost', case when k then s.cost end, 'on_hand', app.stock_on_hand(s.id)),
    'can_cost', k,
    'moves', coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
        select jsonb_build_object('id', mv.id, 'kind', mv.kind, 'kg', mv.qty_kg, 'at', mv.created_at, 'note', mv.note, 'by', pe.display_name,
          'order_id', mv.order_id, 'slip_no', o.slip_no, 'customer', cu.name,
          'sell_rate', case when k then oi.sell_rate end,
          'purchase_id', p.id, 'bill_no', p.bill_no, 'supplier', sp.name, 'bill_date', p.bill_date) x
        from public.stock_moves mv
        left join public.people pe on pe.company_id = mv.company_id and pe.id = mv.created_by
        left join public.orders o on o.company_id = mv.company_id and o.id = mv.order_id
        left join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
        left join public.order_items oi on oi.company_id = mv.company_id and oi.id = mv.order_item_id
        left join public.purchase_lines pl on pl.company_id = mv.company_id and pl.id = mv.purchase_line_id
        left join public.purchases p on p.company_id = pl.company_id and p.id = pl.purchase_id
        left join public.suppliers sp on sp.company_id = p.company_id and sp.id = p.supplier_id
        where mv.company_id = c.company_id and mv.stock_item_id = s.id
          and (app.has(c, 'kacha') or (o.bill_type is distinct from 'kacha' and p.bill_type is distinct from 'kacha'))
        order by mv.created_at desc limit 300) q), '[]'::jsonb));
end $$;

-- What a new bill is matched against: suppliers, grades, earlier names, existing stock items.
create function public.api_purchase_context(p_caller uuid) returns jsonb
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
    'gst_pct', (select gst_pct from public.company_settings where company_id = c.company_id));
end $$;

-- Save a checked bill: supplier (found or added), the bill, each line into its stock item (found by
-- grade + shape + HSN + rate, or made), the stock moves, and the names to suggest next time.
-- Money figures were checked by the api with @srs/core; here everything is checked again for safety.
create function public.api_save_purchase(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.people := app.caller(p_caller); prev jsonb; sup uuid; pid uuid := gen_random_uuid(); ln jsonb; i int := 0;
  sid uuid; lid uuid; was_new boolean; onh numeric; qty numeric; cost_new numeric; out_lines jsonb := '[]'::jsonb;
  v_kind text := coalesce(p ->> 'kind', 'bill'); v_type text := p ->> 'bill_type'; v_no text := nullif(btrim(p ->> 'bill_no'), '');
  v_shape text; v_hsn text; v_rate numeric; v_mat uuid; dup record; kg_sum numeric := 0; amt_sum numeric := 0;
begin
  perform app.require(c, 'stock');
  if v_type = 'kacha' then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'savePurchase', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if v_kind not in ('bill','opening') then raise exception 'Unknown kind of purchase.' using errcode = '22023'; end if;
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
                                gst_amount, round_off, total_amount, total_kg, pay_status, paid_at, file_key, read_by_ai, note, created_by, idempotency_key)
    values (pid, c.company_id, v_kind, sup, v_no, (p ->> 'bill_date')::date, v_type, round(amt_sum, 2),
            coalesce((p ->> 'freight')::numeric, 0), coalesce((p ->> 'other')::numeric, 0), coalesce((p ->> 'gst')::numeric, 0),
            coalesce((p ->> 'round_off')::numeric, 0), (p ->> 'total')::numeric, kg_sum,
            coalesce(p ->> 'pay_status', 'to_pay'), case when p ->> 'pay_status' = 'paid' then now() end,
            nullif(p ->> 'file_key', ''), coalesce((p ->> 'read_by_ai')::boolean, false), nullif(btrim(p ->> 'note'), ''), c.id, p_key);

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
    insert into public.purchase_lines (company_id, purchase_id, position, description, hsn, qty_kg, rate, amount, freight_share, stock_item_id)
      values (c.company_id, pid, i, btrim(ln ->> 'description'), v_hsn, qty, v_rate, (ln ->> 'amount')::numeric,
              coalesce((ln ->> 'freight_share')::numeric, 0), sid) returning id into lid;
    insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, purchase_line_id, created_by)
      values (c.company_id, sid, 'purchase', qty, lid, c.id);
    if nullif(ln ->> 'desc_key', '') is not null then
      insert into private.purchase_names (company_id, supplier_key, desc_key, material_id, shape)
        values (c.company_id, coalesce(sup::text, ''), left(ln ->> 'desc_key', 200), v_mat, v_shape)
        on conflict (company_id, supplier_key, desc_key) do update set material_id = excluded.material_id, shape = excluded.shape, updated_at = now();
    end if;
    out_lines := out_lines || jsonb_build_object('line_id', lid, 'stock_item_id', sid, 'new', was_new);
    i := i + 1;
  end loop;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('purchase_id', pid, 'supplier_id', sup, 'lines', out_lines, 'kg', kg_sum));
end $$;

create function public.api_purchases(p_caller uuid, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'stock');
  k := app.has(c, 'kacha');
  return coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', p.id, 'kind', p.kind, 'supplier', sp.name, 'bill_no', p.bill_no, 'bill_date', p.bill_date,
        'bill_type', p.bill_type, 'total', p.total_amount, 'kg', p.total_kg, 'pay_status', p.pay_status, 'status', p.status,
        'lines', (select count(*) from public.purchase_lines pl where pl.purchase_id = p.id), 'created_at', p.created_at) x
      from public.purchases p left join public.suppliers sp on sp.id = p.supplier_id
      where p.company_id = c.company_id and (k or p.bill_type = 'pakka')
      order by p.bill_date desc, p.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) q), '[]'::jsonb);
end $$;

create function public.api_purchase(p_caller uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); p public.purchases;
begin
  perform app.require(c, 'stock');
  select * into p from public.purchases where id = p_id and company_id = c.company_id;
  if p.id is null or (p.bill_type = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Bill not found.' using errcode = '22023'; end if;
  return jsonb_build_object(
    'purchase', to_jsonb(p) - 'idempotency_key',
    'supplier', (select jsonb_build_object('id', id, 'name', name, 'gstin', gstin, 'phone', phone, 'city', city) from public.suppliers where id = p.supplier_id),
    'by', (select display_name from public.people where id = p.created_by),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', pl.id, 'description', pl.description, 'hsn', pl.hsn, 'kg', pl.qty_kg, 'rate', pl.rate,
        'amount', pl.amount, 'freight_share', pl.freight_share, 'stock_item_id', pl.stock_item_id, 'code', m.code, 'shape', s.shape, 'label', s.label,
        'on_hand', app.stock_on_hand(s.id)) order by pl.position)
      from public.purchase_lines pl join public.stock_items s on s.id = pl.stock_item_id join public.materials m on m.id = s.material_id
      where pl.purchase_id = p.id), '[]'::jsonb),
    -- a bill can be cancelled only while all of its stock is still there
    'can_cancel', p.status = 'saved' and not exists (
      select 1 from (select pl.stock_item_id, sum(pl.qty_kg) q from public.purchase_lines pl where pl.purchase_id = p.id group by pl.stock_item_id) t
      where app.stock_on_hand(t.stock_item_id) < t.q));
end $$;

create function public.api_purchase_paid(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_paid boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; rid uuid;
begin
  perform app.require(c, 'stock');
  prev := app.idem_start(c.company_id, p_key, 'purchasePaid', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.purchases set pay_status = case when p_paid then 'paid' else 'to_pay' end, paid_at = case when p_paid then now() end
    where id = p_id and company_id = c.company_id and (bill_type = 'pakka' or app.has(c, 'kacha')) returning id into rid;
  if rid is null then raise exception 'Bill not found.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('purchase_id', rid, 'pay_status', case when p_paid then 'paid' else 'to_pay' end));
end $$;

-- A bill entered wrongly: cancel it (its stock is taken off again) — only while all of that stock is still there.
create function public.api_purchase_cancel(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; p public.purchases; why text := btrim(coalesce(p_reason, ''));
begin
  perform app.require(c, 'stock');
  if why = '' then raise exception 'Write why the bill is cancelled.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'purchaseCancel', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into p from public.purchases where id = p_id and company_id = c.company_id for update;
  if p.id is null or (p.bill_type = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Bill not found.' using errcode = '22023'; end if;
  if p.status <> 'saved' then raise exception 'This bill is already cancelled.' using errcode = '23001'; end if;
  perform 1 from public.stock_items s where s.id in (select stock_item_id from public.purchase_lines where purchase_id = p.id) for update;
  if exists (select 1 from (select pl.stock_item_id, sum(pl.qty_kg) q from public.purchase_lines pl where pl.purchase_id = p.id group by pl.stock_item_id) t
             where app.stock_on_hand(t.stock_item_id) < t.q) then
    raise exception 'Some of this stock is already sold. Correct the stock count instead.' using errcode = '23001';
  end if;
  insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, purchase_line_id, note, created_by)
    select pl.company_id, pl.stock_item_id, 'purchase_undo', -pl.qty_kg, pl.id, 'Bill cancelled: ' || left(why, 200), c.id
    from public.purchase_lines pl where pl.purchase_id = p.id;
  update public.purchases set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = left(why, 500) where id = p.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('purchase_id', p.id, 'status', 'cancelled'));
end $$;

-- Correct the stock: p_count = the kg really there (a count), or close it (what's left is scrap / weight difference).
create function public.api_stock_count(p_caller uuid, p_key uuid, p_hash text, p_item uuid, p_count numeric, p_close boolean, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; s public.stock_items; onh numeric; diff numeric;
begin
  perform app.require(c, 'stock');
  prev := app.idem_start(c.company_id, p_key, 'stockCount', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into s from public.stock_items where id = p_item and company_id = c.company_id for update;
  if s.id is null then raise exception 'Stock not found.' using errcode = '22023'; end if;
  if p_count is null or p_count < 0 or p_count > 10000000 then raise exception 'Enter the kg that are really there.' using errcode = '22023'; end if;
  onh := app.stock_on_hand(s.id);
  diff := round(p_count - onh, 3);
  if diff <> 0 then
    insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, note, created_by)
      values (c.company_id, s.id, case when p_close and diff < 0 then 'scrap' else 'adjust' end, diff,
              coalesce(nullif(btrim(p_note), ''), case when p_close then 'Stock finished' else 'Stock counted' end), c.id);
  end if;
  if p_close then update public.stock_items set closed = true where id = s.id; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('stock_item_id', s.id, 'was', onh, 'now', p_count, 'diff', diff, 'closed', coalesce(p_close, false)));
end $$;

create function public.api_set_low_stock(p_caller uuid, p_key uuid, p_hash text, p_material uuid, p_kg numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; mid uuid;
begin
  perform app.require(c, 'stock');
  prev := app.idem_start(c.company_id, p_key, 'setLowStock', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_kg is not null and (p_kg < 0 or p_kg > 10000000) then raise exception 'Enter the kg.' using errcode = '22023'; end if;
  update public.materials set low_stock_kg = p_kg where id = p_material and company_id = c.company_id returning id into mid;
  if mid is null then raise exception 'Grade not found.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('material_id', mid, 'low_kg', p_kg));
end $$;

-- Change which stock an item comes from (until it is weighed). p_stock null = sell without stock.
create function public.api_set_item_stock(p_caller uuid, p_key uuid, p_hash text, p_item uuid, p_stock uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; iid uuid;
begin
  if not (app.has(c, 'new') or app.has(c, 'weigh')) then raise exception 'Not allowed.' using errcode = '42501'; end if;
  prev := app.idem_start(c.company_id, p_key, 'setItemStock', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.order_items set stock_item_id = p_stock where id = p_item and company_id = c.company_id returning id into iid;
  if iid is null then raise exception 'Item not found.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('item_id', iid, 'stock_item_id', p_stock));
end $$;

-- Stock for the evening summary: bought and sold that day, on hand, low and below-zero stock, sold without stock.
create function public.api_day_stock(p_caller uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; kc boolean; v_tz text; v_s timestamptz; v_e timestamptz; v_day date;
begin
  perform app.require(c, 'money');
  k := app.has(c, 'stock'); kc := app.has(c, 'kacha');
  select timezone into v_tz from public.companies where id = c.company_id;
  v_day := coalesce(p_day, (now() at time zone v_tz)::date);
  v_s := v_day::timestamp at time zone v_tz; v_e := v_s + interval '1 day';
  return jsonb_build_object(
    'can_cost', k,
    'bought', (select jsonb_build_object('n', count(*), 'kg', coalesce(sum(total_kg), 0), 'amount', case when k then coalesce(sum(total_amount), 0) end)
      from public.purchases where company_id = c.company_id and status = 'saved' and bill_date = v_day and (kc or bill_type = 'pakka')),
    'sold_kg', (select coalesce(-sum(qty_kg), 0) from public.stock_moves
      where company_id = c.company_id and kind in ('sale','sale_undo') and created_at >= v_s and created_at < v_e),
    'groups', coalesce((select jsonb_agg(g order by g ->> 'code') from (
        select jsonb_build_object('material_id', m.id, 'code', m.code, 'shape', s.shape, 'low_kg', m.low_stock_kg,
          'kg', sum(app.stock_on_hand(s.id)), 'value', case when k then sum(greatest(app.stock_on_hand(s.id), 0) * s.cost) end,
          'negative', bool_or(app.stock_on_hand(s.id) < 0)) g
        from public.stock_items s join public.materials m on m.id = s.material_id
        where s.company_id = c.company_id and not s.closed
        group by m.id, m.code, m.low_stock_kg, s.shape) q), '[]'::jsonb),
    'no_stock', coalesce((select jsonb_agg(distinct o.slip_no)
      from public.order_items i join public.orders o on o.company_id = i.company_id and o.id = i.order_id
      where i.company_id = c.company_id and i.stock_item_id is null and o.weighed_at >= v_s and o.weighed_at < v_e
        and o.status in ('weighed','done') and (kc or o.bill_type is distinct from 'kacha')), '[]'::jsonb));
end $$;

-- Deleting a slip also says how much weight goes back to stock.
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

revoke all on function app.stock_on_hand(uuid), app.stock_follow_order() from public, anon, authenticated;
revoke all on function public.api_stock_data(uuid), public.api_stock_item(uuid, uuid), public.api_purchase_context(uuid),
  public.api_save_purchase(uuid, uuid, text, jsonb), public.api_purchases(uuid, int), public.api_purchase(uuid, uuid),
  public.api_purchase_paid(uuid, uuid, text, uuid, boolean), public.api_purchase_cancel(uuid, uuid, text, uuid, text),
  public.api_stock_count(uuid, uuid, text, uuid, numeric, boolean, text), public.api_set_low_stock(uuid, uuid, text, uuid, numeric),
  public.api_set_item_stock(uuid, uuid, text, uuid, uuid), public.api_day_stock(uuid, date), public.api_delete_check(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.api_stock_data(uuid), public.api_stock_item(uuid, uuid), public.api_purchase_context(uuid),
  public.api_save_purchase(uuid, uuid, text, jsonb), public.api_purchases(uuid, int), public.api_purchase(uuid, uuid),
  public.api_purchase_paid(uuid, uuid, text, uuid, boolean), public.api_purchase_cancel(uuid, uuid, text, uuid, text),
  public.api_stock_count(uuid, uuid, text, uuid, numeric, boolean, text), public.api_set_low_stock(uuid, uuid, text, uuid, numeric),
  public.api_set_item_stock(uuid, uuid, text, uuid, uuid), public.api_day_stock(uuid, date), public.api_delete_check(uuid, uuid[])
  to service_role;

-- ---------- i) the purchase bill files (PDF / photo), private; only the api reads and writes them ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('bills', 'bills', false, 10485760, array['application/pdf','image/jpeg','image/png','image/webp'])
  on conflict (id) do nothing;
