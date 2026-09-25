-- =====================================================================================
-- 1. Tenancy: companies, their settings, the people who work there, and login methods.
--
-- Every company-owned row carries company_id. Row Level Security (RLS) is switched on for
-- every table the moment it is created, and signed-in users may only READ rows of their
-- own company. Nobody writes through the public API directly: all changes go through
-- backend domain operations (Milestone 4) using the service role.
-- =====================================================================================

create schema if not exists app;      -- helper functions used by security rules (not exposed by the API)
create schema if not exists private;  -- internal tables never exposed by the API
revoke all on schema app, private from public, anon, authenticated;
grant usage on schema app to authenticated, service_role;
grant usage on schema private to service_role;

-- ---------- small validators ----------
create function app.is_valid_timezone(tz text) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from pg_catalog.pg_timezone_names where name = tz)
$$;

create function app.valid_perms(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
    where e.key not in ('new','orders','weigh','khata','today','rates','people','settings','money','kacha')
       or jsonb_typeof(e.value) <> 'boolean')
$$;

-- ---------- companies ----------
create table public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 200),
  legal_name  text check (legal_name is null or length(legal_name) <= 200),
  gstin       text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  phone       text check (phone is null or length(phone) <= 30),
  address     text check (address is null or length(address) <= 500),
  timezone    text not null default 'Asia/Kolkata' check (app.is_valid_timezone(timezone)),
  currency    text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
comment on table public.companies is 'One row per business using the platform (tenant). SRS Trading is the first.';

-- ---------- per-company settings ----------
create table public.company_settings (
  company_id          uuid primary key references public.companies(id) on delete restrict,
  gst_pct             numeric(5,2) not null default 18 check (gst_pct between 0 and 100),
  kacha_pct           numeric(5,2) not null default 10 check (kacha_pct between 0 and 100),
  min_inch            integer      not null default 1  check (min_inch between 0 and 12),
  default_unit        text         not null default 'mm' check (default_unit in ('mm','in')),
  show_weight_on_slip boolean      not null default true,
  weight_warn_pct     numeric(5,2) not null default 5  check (weight_warn_pct > 0 and weight_warn_pct <= 100),
  slip_numbering      text         not null default 'never' check (slip_numbering in ('never','daily','monthly','yearly')),
  family_density      jsonb        not null default '{"carbon":7850,"alloy":7850,"stainless":7930,"tool":7700}'
                        check (jsonb_typeof(family_density) = 'object'),
  slip_header         jsonb        not null default '{}' check (jsonb_typeof(slip_header) = 'object'), -- name/phone/GSTIN printed on slips
  updated_at          timestamptz  not null default now(),
  updated_by          uuid
);
comment on column public.company_settings.min_inch is 'Smallest inches per side for the cutting charge (prototype "minInch").';

-- ---------- people (staff) ----------
create table public.people (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete restrict,
  auth_user_id   uuid references auth.users(id) on delete set null,
  display_name   text not null check (length(btrim(display_name)) between 1 and 100),
  phone          text check (phone is null or length(phone) <= 30),
  role           text not null check (role in ('owner','sales','weigher','accounts','custom')),
  perms          jsonb not null default '{}' check (app.valid_perms(perms)),
  preferred_lang text not null default 'en' check (preferred_lang in ('en','hi','hn')),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, auth_user_id),
  unique (company_id, phone)
);
create index people_auth_user_idx on public.people (auth_user_id) where active;
comment on table public.people is 'Staff of a company. Identity (who) is separate from login methods (how) — see private.auth_credentials.';

alter table public.company_settings
  add constraint company_settings_updated_by_fk foreign key (company_id, updated_by) references public.people(company_id, id);

-- ---------- login methods (never exposed by the API) ----------
create table private.auth_credentials (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null,
  person_id       uuid not null,
  kind            text not null check (kind in ('pin','phone_otp','email','passkey')),
  identifier      text,             -- phone / email / passkey id, depending on kind
  secret_hash     text,             -- e.g. hashed PIN; never the PIN itself
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  foreign key (company_id, person_id) references public.people(company_id, id) on delete cascade
);
create unique index auth_credentials_one_active_pin on private.auth_credentials (person_id) where kind = 'pin' and revoked_at is null;
comment on table private.auth_credentials is 'How a person proves who they are. PIN today; phone/email/passkey/MFA can be added without touching people.';

-- ---------- who is asking? (used by every security rule) ----------
-- The signed-in user's active staff record. If their login token names a company
-- (app_metadata.company_id — set by the backend), only that company counts.
create function app.current_person_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from public.people p
  join public.companies c on c.id = p.company_id and c.active
  where p.auth_user_id = (select auth.uid())
    and p.active
    and (nullif((select auth.jwt()) -> 'app_metadata' ->> 'company_id', '') is null
         or p.company_id = ((select auth.jwt()) -> 'app_metadata' ->> 'company_id')::uuid)
  order by p.created_at
  limit 1
$$;

create function app.current_company_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.company_id from public.people p where p.id = (select app.current_person_id())
$$;

create function app.has_perm(perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (p.perms ->> perm)::boolean from public.people p where p.id = (select app.current_person_id())), false)
$$;

revoke all on function app.is_valid_timezone(text), app.valid_perms(jsonb), app.current_person_id(),
  app.current_company_id(), app.has_perm(text) from public, anon;
grant execute on function app.current_person_id(), app.current_company_id(), app.has_perm(text) to authenticated, service_role;
grant execute on function app.is_valid_timezone(text), app.valid_perms(jsonb) to authenticated, service_role;

-- ---------- security: read own company only; no direct writes ----------
alter table public.companies enable row level security;
alter table public.company_settings enable row level security;
alter table public.people enable row level security;
alter table private.auth_credentials enable row level security; -- no policies: nobody but the backend

create policy companies_read_own on public.companies for select to authenticated
  using (id = (select app.current_company_id()));
create policy settings_read_own on public.company_settings for select to authenticated
  using (company_id = (select app.current_company_id()));
create policy people_read_own_company on public.people for select to authenticated
  using (company_id = (select app.current_company_id()));

revoke all on public.companies, public.company_settings, public.people from anon;
revoke insert, update, delete, truncate, references, trigger on public.companies, public.company_settings, public.people from authenticated;
revoke all on private.auth_credentials from public, anon, authenticated;
