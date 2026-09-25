-- =====================================================================================
-- 2. Platform: automatic audit history, "can't be changed" protection, repeat-request
--    protection (idempotency) and a background-jobs table for later.
-- =====================================================================================

-- ---------- audit history: who did what, when (written by the database itself) ----------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete restrict,
  person_id   uuid,                 -- staff member who did it (null = system)
  action      text not null check (action in ('insert','update','delete')),
  entity_type text not null,        -- table name, e.g. 'orders'
  entity_id   text,
  before      jsonb,
  after       jsonb,
  request_id  uuid,                 -- ties together everything one app action changed
  at          timestamptz not null default now()
);
create index audit_log_company_at_idx on public.audit_log (company_id, at desc);
create index audit_log_entity_idx on public.audit_log (company_id, entity_type, entity_id, at desc);
comment on table public.audit_log is 'Append-only history of every change to business data. Filled automatically by triggers.';

-- The backend sets app.person_id / app.request_id for each action; signed-in users are found automatically.
create function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b jsonb; a jsonb; cid uuid; pid uuid;
begin
  if tg_op in ('UPDATE','DELETE') then b := to_jsonb(old) - 'secret_hash'; end if;
  if tg_op in ('INSERT','UPDATE') then a := to_jsonb(new) - 'secret_hash'; end if;
  if tg_op = 'UPDATE' and a = b then return new; end if;  -- nothing actually changed
  cid := coalesce((a ->> 'company_id')::uuid, (b ->> 'company_id')::uuid);
  if cid is null and tg_table_name = 'companies' then cid := coalesce((a ->> 'id')::uuid, (b ->> 'id')::uuid); end if;
  pid := coalesce(nullif(current_setting('app.person_id', true), '')::uuid, app.current_person_id());
  insert into public.audit_log (company_id, person_id, action, entity_type, entity_id, before, after, request_id)
  values (cid, pid, lower(tg_op), tg_table_name, coalesce(a ->> 'id', b ->> 'id', a ->> 'company_id', b ->> 'company_id'),
          b, a, nullif(current_setting('app.request_id', true), '')::uuid);
  return coalesce(new, old);
end $$;

-- ---------- "can't be changed" protection for money and history records ----------
create function app.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% records cannot be changed or deleted. Add a correcting entry instead.', tg_table_name
    using errcode = 'restrict_violation';
end $$;

create trigger audit_log_no_update before update or delete on public.audit_log for each row execute function app.forbid_change();
create trigger audit_log_no_truncate before truncate on public.audit_log for each statement execute function app.forbid_change();

-- ---------- repeat-request protection ----------
-- If a phone retries createOrder / recordPayment after a network drop, the backend finds
-- the same key here and returns the first result instead of doing it twice.
create table private.idempotency_keys (
  company_id   uuid not null references public.companies(id) on delete restrict,
  key          uuid not null,
  operation    text not null,
  request_hash text not null,        -- same key + different request = rejected
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (company_id, key)
);
create index idempotency_keys_created_idx on private.idempotency_keys (created_at);

-- ---------- background jobs (table only; the worker comes later) ----------
-- For PDFs, WhatsApp/email sending, imports/exports, accounting sync, AI tasks.
create table private.jobs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete restrict,
  job_type    text not null,
  payload     jsonb not null default '{}',
  status      text not null default 'pending' check (status in ('pending','running','done','failed','cancelled')),
  attempts    integer not null default 0 check (attempts >= 0),
  run_after   timestamptz not null default now(),
  last_error  text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index jobs_ready_idx on private.jobs (run_after) where status = 'pending';

-- ---------- audit the tenancy tables from migration 1 ----------
create trigger audit after insert or update or delete on public.companies for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.company_settings for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.people for each row execute function app.audit_row();
create trigger audit after insert or update or delete on private.auth_credentials for each row execute function app.audit_row();

-- ---------- security ----------
alter table public.audit_log enable row level security;
alter table private.idempotency_keys enable row level security;
alter table private.jobs enable row level security;
create policy audit_read_owner on public.audit_log for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('settings')));

revoke all on public.audit_log from anon;
revoke insert, update, delete, truncate, references, trigger on public.audit_log from authenticated;
revoke all on private.idempotency_keys, private.jobs from public, anon, authenticated;
revoke all on function app.audit_row(), app.forbid_change() from public, anon, authenticated;
