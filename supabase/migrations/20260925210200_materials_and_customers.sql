-- =====================================================================================
-- 3. Materials (grades), customers, and their rate HISTORY.
--
-- Rates are never overwritten: every change adds a new row with the time it takes effect.
-- The "current rate" is simply the latest row. Old bills keep the rate they were made
-- with (orders store their own copy), and rate changes over time stay available for reports.
-- Designed to grow later into grade → shapes → sizes → size-specific rates and cutting rules.
-- =====================================================================================

create table public.materials (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  code             text not null check (code ~ '^[A-Z0-9][A-Z0-9 ._/-]{0,39}$'),  -- e.g. EN8, SS304
  family           text not null check (family in ('carbon','alloy','stainless','tool')),
  density_override numeric(8,2) check (density_override is null or density_override between 1000 and 25000), -- kg/m³
  active           boolean not null default true,
  info             jsonb check (info is null or jsonb_typeof(info) = 'object'),  -- what it is / good for / watch out / alternatives (en, hi, hn)
  created_at       timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, code)
);

create table public.material_rates (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  material_id    uuid not null,
  sell_rate      numeric(12,2) not null check (sell_rate >= 0),   -- ₹ per kg
  cut_rate       numeric(12,2) not null check (cut_rate >= 0),    -- ₹ per sq inch per cut
  effective_from timestamptz not null default now(),
  note           text check (note is null or length(note) <= 500),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  foreign key (company_id, material_id) references public.materials(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  unique (material_id, effective_from)
);
create index material_rates_lookup_idx on public.material_rates (company_id, material_id, effective_from desc);

create view public.current_material_rates with (security_invoker = true) as
  select distinct on (r.material_id) r.*
  from public.material_rates r
  where r.effective_from <= now()
  order by r.material_id, r.effective_from desc;

create table public.customers (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  name       text not null check (length(btrim(name)) between 1 and 200),
  phone      text check (phone is null or length(phone) <= 30),
  notes      text check (notes is null or length(notes) <= 1000),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (company_id, id)
);
create index customers_name_idx on public.customers (company_id, lower(name));
create index customers_phone_idx on public.customers (company_id, phone) where phone is not null;

-- Special rate for one customer on one grade. rate = null means "special rate removed".
create table public.customer_rates (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null,
  customer_id    uuid not null,
  material_id    uuid not null,
  rate           numeric(12,2) check (rate is null or rate >= 0),
  effective_from timestamptz not null default now(),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  foreign key (company_id, customer_id) references public.customers(company_id, id),
  foreign key (company_id, material_id) references public.materials(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  unique (customer_id, material_id, effective_from)
);
create index customer_rates_lookup_idx on public.customer_rates (company_id, customer_id, material_id, effective_from desc);

create view public.current_customer_rates with (security_invoker = true) as
  select distinct on (r.customer_id, r.material_id) r.*
  from public.customer_rates r
  where r.effective_from <= now()
  order by r.customer_id, r.material_id, r.effective_from desc;

-- ---------- history is permanent ----------
create trigger material_rates_no_change before update or delete on public.material_rates for each row execute function app.forbid_change();
create trigger material_rates_no_truncate before truncate on public.material_rates for each statement execute function app.forbid_change();
create trigger customer_rates_no_change before update or delete on public.customer_rates for each row execute function app.forbid_change();
create trigger customer_rates_no_truncate before truncate on public.customer_rates for each statement execute function app.forbid_change();

create trigger audit after insert or update or delete on public.materials for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.material_rates for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.customers for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.customer_rates for each row execute function app.audit_row();

-- ---------- security ----------
-- Grade names and customers: every staff member of the company (the weigher needs them).
-- Rates are money: only people with the 'money' or 'rates' permission.
alter table public.materials enable row level security;
alter table public.material_rates enable row level security;
alter table public.customers enable row level security;
alter table public.customer_rates enable row level security;

create policy materials_read_own on public.materials for select to authenticated
  using (company_id = (select app.current_company_id()));
create policy customers_read_own on public.customers for select to authenticated
  using (company_id = (select app.current_company_id()));
create policy material_rates_read on public.material_rates for select to authenticated
  using (company_id = (select app.current_company_id()) and ((select app.has_perm('money')) or (select app.has_perm('rates'))));
create policy customer_rates_read on public.customer_rates for select to authenticated
  using (company_id = (select app.current_company_id()) and ((select app.has_perm('money')) or (select app.has_perm('rates'))));

revoke all on public.materials, public.material_rates, public.customers, public.customer_rates,
  public.current_material_rates, public.current_customer_rates from anon;
revoke insert, update, delete, truncate, references, trigger on public.materials, public.material_rates, public.customers,
  public.customer_rates, public.current_material_rates, public.current_customer_rates from authenticated;
grant select on public.current_material_rates, public.current_customer_rates to authenticated;
