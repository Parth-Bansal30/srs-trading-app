-- =====================================================================================
-- 5. Payments (advances, pickup payments, khata payments) and the daily cash count.
--
-- Money records are permanent: they can never be edited or deleted. A mistake is fixed
-- with a REVERSAL entry (the same amount, negative, pointing at the original), exactly
-- like crossing out a ledger line and writing the correction below it.
-- A customer's khata balance is always worked out from bills and payments — never stored.
-- =====================================================================================

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references public.companies(id) on delete restrict,
  customer_id         uuid not null,
  order_id            uuid,                       -- set for advances and pickup payments
  amount              numeric(12,2) not null check (amount <> 0),
  mode                text not null check (mode in ('Cash','UPI','Bank','Cheque')),
  -- advance = before finishing; pickup = at finish; khata = later, from the Khata screen; reversal = correction
  kind                text not null check (kind in ('advance','pickup','khata','reversal')),
  side                text check (side in ('pakka','kacha')), -- only for khata payments (order payments follow their order's bill)
  note                text check (note is null or length(note) <= 500),  -- e.g. "Paytm - Dad's number", cheque no.
  reverses_payment_id uuid,
  received_at         timestamptz not null default now(),
  created_by          uuid,
  created_at          timestamptz not null default now(),
  idempotency_key     uuid,
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, customer_id) references public.customers(company_id, id),
  foreign key (company_id, order_id) references public.orders(company_id, id),
  foreign key (company_id, reverses_payment_id) references public.payments(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  constraint payments_reversal_link check ((kind = 'reversal') = (reverses_payment_id is not null)),
  constraint payments_positive check (kind = 'reversal' or amount > 0),
  constraint payments_order_kinds check (kind not in ('advance','pickup') or order_id is not null),
  constraint payments_khata_loose check (kind <> 'khata' or order_id is null),
  constraint payments_side_rule check ((order_id is null) = (side is not null))
);
create unique index payments_reversed_once on public.payments (reverses_payment_id) where reverses_payment_id is not null;
create index payments_customer_idx on public.payments (company_id, customer_id, received_at);
create index payments_order_idx    on public.payments (company_id, order_id) where order_id is not null;
create index payments_day_idx      on public.payments (company_id, received_at desc);

create function app.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
declare st text; orig public.payments;
begin
  if new.kind in ('advance','pickup') then
    select o.status into st from public.orders o where o.id = new.order_id and o.company_id = new.company_id;
    if new.kind = 'advance' and st not in ('accepted','weighed') then
      raise exception 'An advance can only be taken on an accepted order that is not finished yet.' using errcode = 'check_violation';
    end if;
    if new.kind = 'pickup' and st not in ('weighed','done') then
      raise exception 'A pickup payment needs a weighed order.' using errcode = 'check_violation';
    end if;
  end if;
  if new.kind = 'reversal' then
    select * into orig from public.payments p where p.id = new.reverses_payment_id and p.company_id = new.company_id;
    if orig.kind = 'reversal' then
      raise exception 'A reversal cannot itself be reversed.' using errcode = 'check_violation';
    end if;
    if new.amount <> -orig.amount or new.customer_id <> orig.customer_id
       or new.order_id is distinct from orig.order_id or new.side is distinct from orig.side then
      raise exception 'A reversal must be the exact opposite of the original payment.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger guard before insert on public.payments for each row execute function app.guard_payment();
create trigger payments_no_change before update or delete on public.payments for each row execute function app.forbid_change();
create trigger payments_no_truncate before truncate on public.payments for each statement execute function app.forbid_change();
create trigger audit after insert on public.payments for each row execute function app.audit_row();

-- ---------- daily cash count ----------
-- Saving again the same day adds a new row; the latest one for a date is the current count.
create table public.cash_closes (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete restrict,
  business_date date not null,                     -- the shop's date (Indian date for SRS), not UTC
  expected_cash numeric(12,2) not null,            -- what the app says came in as cash
  counted_cash  numeric(12,2) not null check (counted_cash >= 0),
  note          text check (note is null or length(note) <= 500),
  closed_by     uuid,
  closed_at     timestamptz not null default now(),
  foreign key (company_id, closed_by) references public.people(company_id, id)
);
create index cash_closes_day_idx on public.cash_closes (company_id, business_date desc, closed_at desc);

create trigger cash_closes_no_change before update or delete on public.cash_closes for each row execute function app.forbid_change();
create trigger cash_closes_no_truncate before truncate on public.cash_closes for each statement execute function app.forbid_change();
create trigger audit after insert on public.cash_closes for each row execute function app.audit_row();

-- ---------- security ----------
-- Payments need 'money'. Khata payments on the kacha side also need 'kacha';
-- order payments are visible exactly when their order is.
alter table public.payments enable row level security;
alter table public.cash_closes enable row level security;

create policy payments_read on public.payments for select to authenticated
  using (company_id = (select app.current_company_id())
         and (select app.has_perm('money'))
         and ((order_id is null and (side = 'pakka' or (select app.has_perm('kacha'))))
              or (order_id is not null and exists (select 1 from public.orders o where o.id = order_id))));
create policy cash_closes_read on public.cash_closes for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('money')) and (select app.has_perm('today')));

revoke all on public.payments, public.cash_closes from anon;
revoke insert, update, delete, truncate, references, trigger on public.payments, public.cash_closes from authenticated;
revoke all on function app.guard_payment() from public, anon, authenticated;

-- Tables created from now on also start with no access for anon/signed-in users (belt and braces).
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from authenticated;
alter default privileges in schema public revoke all on functions from anon;
