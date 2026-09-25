-- =====================================================================================
-- 4. Orders (slips), their items, cut lengths and weighing.
--
-- Stages: estimate → accepted → weighed → done (no skipping, no going back).
-- Each item keeps its OWN copy of the rate, cutting rate and density used, and each order
-- keeps the rules used (min inch, densities, time zone) and — once finished — its final
-- amounts, so any bill can be reproduced exactly later, whatever the rates are then.
-- The database refuses edits after acceptance and any change to a finished order.
-- =====================================================================================

-- Counters for internal numbers and slip numbers (handed out one at a time by the backend).
-- counter_key: 'internal' | 'daily:2026-09-22' | 'monthly:2026-09' | 'yearly:2026-2027'
create table private.slip_counters (
  company_id  uuid not null references public.companies(id) on delete restrict,
  counter_key text not null,
  last_value  bigint not null default 0 check (last_value >= 0),
  updated_at  timestamptz not null default now(),
  primary key (company_id, counter_key)
);

create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  internal_no     bigint not null check (internal_no > 0),       -- permanent, never resets
  slip_no         text not null check (length(slip_no) between 1 and 40), -- what people see; may reset daily/monthly/yearly
  slip_scheme     text not null check (slip_scheme in ('never','daily','monthly','yearly')),
  customer_id     uuid not null,
  status          text not null default 'estimate' check (status in ('estimate','accepted','weighed','done')),
  pricing_rules   jsonb not null default '{}' check (jsonb_typeof(pricing_rules) = 'object'), -- min_inch, family densities, time zone used
  -- set when finished (bill type chosen at pickup):
  bill_type       text check (bill_type in ('pakka','kacha')),
  gst_pct         numeric(5,2) check (gst_pct between 0 and 100),
  kacha_pct       numeric(5,2) check (kacha_pct between 0 and 100),
  total_weight    numeric(14,3) check (total_weight >= 0),
  base_amount     numeric(12,2) check (base_amount >= 0),      -- material + cutting before GST / no-bill %
  material_amount numeric(12,2) check (material_amount >= 0),  -- as shown on the slip (no-bill % spread in)
  cutting_amount  numeric(12,2) check (cutting_amount >= 0),
  gst_amount      numeric(12,2) check (gst_amount >= 0),
  total_amount    numeric(12,2) check (total_amount >= 0),
  pay_mode        text check (pay_mode in ('now','later','part')),
  in_khata        boolean not null default false,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  accepted_at     timestamptz,
  weighed_at      timestamptz,
  done_at         timestamptz,
  idempotency_key uuid,
  unique (company_id, id),
  unique (company_id, internal_no),
  unique (company_id, slip_no),
  unique (company_id, idempotency_key),
  foreign key (company_id, customer_id) references public.customers(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  constraint orders_finished_has_bill check (
    (status = 'done') = (bill_type is not null)
    and (status <> 'done' or (gst_pct is not null and kacha_pct is not null and done_at is not null and pay_mode is not null
         and total_amount is not null and base_amount is not null and material_amount is not null
         and cutting_amount is not null and gst_amount is not null and total_weight is not null))),
  constraint orders_total_adds_up check (total_amount is null or total_amount = material_amount + cutting_amount + gst_amount),
  constraint orders_kacha_has_no_gst check (bill_type is distinct from 'kacha' or gst_amount = 0)
);
create index orders_recent_idx   on public.orders (company_id, created_at desc);
create index orders_open_idx     on public.orders (company_id, status) where status <> 'done';
create index orders_customer_idx on public.orders (company_id, customer_id, created_at desc);
create index orders_done_idx     on public.orders (company_id, done_at desc) where status = 'done';
create index orders_bill_idx     on public.orders (company_id, bill_type, done_at desc) where status = 'done';

create table public.weigh_batches (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null,
  order_id     uuid not null,
  total_weight numeric(12,3) not null check (total_weight > 0),  -- the one scale reading
  weighed_by   uuid,
  weighed_at   timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, order_id) references public.orders(company_id, id) on delete cascade,
  foreign key (company_id, weighed_by) references public.people(company_id, id)
);
create index weigh_batches_order_idx on public.weigh_batches (company_id, order_id);

create table public.order_items (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  order_id       uuid not null,
  position       smallint not null check (position >= 0),
  material_id    uuid not null,
  grade_code     text not null,                                   -- copy of the grade name at the time
  shape          text not null check (shape in ('square','round','flat','block','hex','plate')),
  unit           text not null default 'mm' check (unit in ('mm','in')),
  dims           text[] not null check (cardinality(dims) between 1 and 3), -- as typed, e.g. {'2 1/2'}
  sell_rate      numeric(12,2) not null check (sell_rate >= 0),     -- copy: ₹/kg used on this slip
  cut_rate       numeric(12,2) not null check (cut_rate >= 0),      -- copy: ₹/sq in/cut used
  density        numeric(8,2) not null check (density > 0),         -- copy: kg/m³ used
  special_rate   boolean not null default false,
  actual_weight  numeric(12,3) check (actual_weight is null or actual_weight > 0),
  weigh_batch_id uuid,                                              -- set when weighed together with other items
  unique (company_id, id),
  unique (order_id, position),
  foreign key (company_id, order_id) references public.orders(company_id, id) on delete cascade,
  foreign key (company_id, material_id) references public.materials(company_id, id),
  foreign key (company_id, weigh_batch_id) references public.weigh_batches(company_id, id)
);
create index order_items_order_idx on public.order_items (company_id, order_id);
create index order_items_material_idx on public.order_items (company_id, material_id);

create table public.order_item_lengths (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  order_item_id uuid not null,
  position      smallint not null check (position >= 0),
  len           text check (len is null or length(len) <= 20),  -- as typed; empty for plates
  pcs           integer not null check (pcs > 0),
  cuts          integer check (cuts is null or cuts >= 0),      -- null = same as pieces
  unique (order_item_id, position),
  foreign key (company_id, order_item_id) references public.order_items(company_id, id) on delete cascade
);
create index order_item_lengths_item_idx on public.order_item_lengths (company_id, order_item_id);

-- ---------- stage rules, enforced by the database ----------
create function app.guard_order() returns trigger
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
    raise exception 'A finished order cannot be changed. Record a correction instead.' using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.internal_no <> old.internal_no
     or new.slip_no <> old.slip_no or new.slip_scheme <> old.slip_scheme or new.created_at <> old.created_at then
    raise exception 'An order''s number and date cannot be changed.' using errcode = 'restrict_violation';
  end if;
  if new.customer_id <> old.customer_id and old.status <> 'estimate' then
    raise exception 'The customer can only be changed while it is an estimate.' using errcode = 'restrict_violation';
  end if;
  if new.status <> old.status and (old.status, new.status) not in
     (('estimate','accepted'), ('accepted','weighed'), ('weighed','done')) then
    raise exception 'An order cannot go from % to %.', old.status, new.status using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- Items and lengths: editable only while the order is an estimate; weights only while it waits to be weighed.
create function app.guard_order_item() returns trigger
language plpgsql set search_path = '' as $$
declare st text;
begin
  select o.status into st from public.orders o
  where o.id = coalesce(new.order_id, old.order_id) and o.company_id = coalesce(new.company_id, old.company_id);
  if st is null then return coalesce(new, old); end if;  -- parent being deleted (estimate) or new order row
  if tg_op = 'UPDATE' then
    if new.order_id <> old.order_id or new.company_id <> old.company_id then
      raise exception 'An item cannot be moved to another order.' using errcode = 'restrict_violation';
    end if;
    if (to_jsonb(new) - 'actual_weight' - 'weigh_batch_id') = (to_jsonb(old) - 'actual_weight' - 'weigh_batch_id') then
      if st <> 'accepted' then
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

create function app.guard_order_item_length() returns trigger
language plpgsql set search_path = '' as $$
declare st text;
begin
  select o.status into st from public.order_items i join public.orders o on o.id = i.order_id
  where i.id = coalesce(new.order_item_id, old.order_item_id);
  if st is not null and st <> 'estimate' then
    raise exception 'Lengths can only be changed while the order is an estimate.' using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end $$;

create function app.guard_weigh_batch() returns trigger
language plpgsql set search_path = '' as $$
declare st text;
begin
  select o.status into st from public.orders o where o.id = new.order_id and o.company_id = new.company_id;
  if st is distinct from 'accepted' then
    raise exception 'Items can only be weighed while the order is waiting to be weighed.' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger guard before insert or update or delete on public.orders for each row execute function app.guard_order();
create trigger guard before insert or update or delete on public.order_items for each row execute function app.guard_order_item();
create trigger guard before insert or update or delete on public.order_item_lengths for each row execute function app.guard_order_item_length();
create trigger guard before insert on public.weigh_batches for each row execute function app.guard_weigh_batch();
create trigger weigh_batches_no_change before update or delete on public.weigh_batches for each row
  when (pg_trigger_depth() = 0) execute function app.forbid_change();  -- permanent record (cascade from an estimate delete is allowed)

create trigger audit after insert or update or delete on public.orders for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.order_items for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.order_item_lengths for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.weigh_batches for each row execute function app.audit_row();

-- ---------- security ----------
-- Orders show amounts, so reading them needs the 'money' permission; kacha orders also
-- need 'kacha'. Items, lengths and weighings are visible exactly when their order is.
-- (The weigher, who sees no money, gets a money-free weighing list from the backend — Milestone 4.)
alter table private.slip_counters enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_item_lengths enable row level security;
alter table public.weigh_batches enable row level security;

create policy orders_read on public.orders for select to authenticated
  using (company_id = (select app.current_company_id())
         and (select app.has_perm('money'))
         and (bill_type is distinct from 'kacha' or (select app.has_perm('kacha'))));
create policy order_items_read on public.order_items for select to authenticated
  using (company_id = (select app.current_company_id()) and exists (select 1 from public.orders o where o.id = order_id));
create policy order_item_lengths_read on public.order_item_lengths for select to authenticated
  using (company_id = (select app.current_company_id()) and exists (select 1 from public.order_items i where i.id = order_item_id));
create policy weigh_batches_read on public.weigh_batches for select to authenticated
  using (company_id = (select app.current_company_id()) and exists (select 1 from public.orders o where o.id = order_id));

revoke all on public.orders, public.order_items, public.order_item_lengths, public.weigh_batches from anon;
revoke insert, update, delete, truncate, references, trigger on public.orders, public.order_items,
  public.order_item_lengths, public.weigh_batches from authenticated;
revoke all on private.slip_counters from public, anon, authenticated;
revoke all on function app.guard_order(), app.guard_order_item(), app.guard_order_item_length(), app.guard_weigh_batch() from public, anon, authenticated;
