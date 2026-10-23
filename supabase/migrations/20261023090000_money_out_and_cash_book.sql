-- =====================================================================================
-- 23. Money out and the cash book (owner decisions 23 Oct 2026).
--   * Shop expenses (kharcha): tea, labour, freight, saw blades, rent, electricity, … paid from
--     any of the shop's money accounts. Also "paid a supplier" (can mark his bills paid) and
--     "owner took for home". An expense is never edited: a wrong one is cancelled (with a reason)
--     or replaced by a corrected one — both stay in the history.
--   * Money moved between the shop's own accounts (cash deposited in the bank, Paytm → bank,
--     cash taken home at closing). Never a sale and never an expense.
--   * Balances: a count of the cash drawer, or the bank passbook figure, is a "balance point".
--     What should be in an account now = its last balance point + everything in and out after it.
--     The cash drawer works like a cash book (rokad): what was left in it last night + cash in
--     − cash out today. At closing the cash is counted and the owner says how much is taken home;
--     the rest stays as tomorrow's opening cash. Before the drawer's first count the old way holds
--     (the drawer starts every day at zero).
--   * New permission "expenses" (owners and the accounts person by default).
--   * New kind of account "safe": cash kept outside the shop (at home, in a locker).
-- =====================================================================================

-- ---------- a) the "expenses" permission ----------
create or replace function app.valid_perms(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
    where e.key not in ('new','orders','weigh','khata','today','rates','people','settings','money','kacha','price','delete','stock','expenses')
       or jsonb_typeof(e.value) <> 'boolean')
$$;
create or replace function app.role_preset(role text) returns jsonb
language sql immutable set search_path = '' as $$
  select case role
    when 'owner'    then '{"new":true,"orders":true,"weigh":true,"khata":true,"today":true,"rates":true,"people":true,"settings":true,"money":true,"kacha":true,"price":true,"delete":true,"stock":true,"expenses":true}'::jsonb
    when 'sales'    then '{"new":true,"orders":true,"money":true,"kacha":true}'::jsonb
    when 'weigher'  then '{"weigh":true,"orders":true}'::jsonb
    when 'accounts' then '{"orders":true,"khata":true,"today":true,"money":true,"expenses":true}'::jsonb
    else '{}'::jsonb end
$$;
update public.people set perms = perms || '{"expenses":true}'::jsonb where role in ('owner','accounts') and not (perms ? 'expenses');

-- ---------- b) cash kept outside the shop ----------
alter table public.money_accounts drop constraint money_accounts_kind_check;
alter table public.money_accounts add constraint money_accounts_kind_check
  check (kind in ('cash','bank','upi','paytm','wallet','safe','other'));
create or replace function app.part_mode(p_kind text, p_method text) returns text
language sql immutable set search_path = '' as $$
  select case when p_kind in ('cash','safe') then 'Cash'
              when p_kind in ('upi','paytm','wallet') then 'UPI'
              when p_method = 'UPI' then 'UPI'
              when p_method = 'Cheque' then 'Cheque'
              else 'Bank' end
$$;

create or replace function public.api_save_account(p_caller uuid, p_key uuid, p_hash text, p_account jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; a public.money_accounts; v_id uuid := nullif(p_account ->> 'id', '')::uuid;
  v_name text := btrim(coalesce(p_account ->> 'name', '')); v_kind text := p_account ->> 'kind'; v_owner text := coalesce(p_account ->> 'owner', 'firm');
  v_number text := nullif(btrim(coalesce(p_account ->> 'number', '')), '');
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'saveAccount', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if length(v_name) not between 1 and 40 then raise exception 'Give the account a name (up to 40 letters).' using errcode = '22023'; end if;
  if v_owner not in ('firm','personal') then raise exception 'Choose firm or personal.' using errcode = '22023'; end if;
  if v_id is not null then
    select * into a from public.money_accounts where company_id = c.company_id and id = v_id for update;
    if a.id is null then raise exception 'Account not found.' using errcode = '22023'; end if;
  end if;
  if a.is_drawer then
    v_kind := 'cash';
  elsif v_kind not in ('bank','upi','paytm','wallet','safe','other') then
    raise exception 'Choose what kind of account it is.' using errcode = '22023';
  end if;
  if exists (select 1 from public.money_accounts x where x.company_id = c.company_id and lower(btrim(x.name)) = lower(v_name) and x.id is distinct from v_id) then
    raise exception 'There is already an account called "%".', v_name using errcode = '23505';
  end if;
  if a.id is null then
    insert into public.money_accounts (company_id, name, kind, owner, number, staff_can, position, hidden, created_by)
      values (c.company_id, v_name, v_kind, v_owner, v_number, coalesce((p_account ->> 'staff_can')::boolean, true),
              coalesce((select max(position) + 1 from public.money_accounts where company_id = c.company_id), 1), false, c.id)
      returning * into a;
  else
    update public.money_accounts set name = v_name, kind = v_kind, owner = case when a.is_drawer then 'firm' else v_owner end,
        number = case when a.is_drawer then null else v_number end,
        staff_can = case when a.is_drawer then true else coalesce((p_account ->> 'staff_can')::boolean, a.staff_can) end,
        hidden = case when a.is_drawer then false else coalesce((p_account ->> 'hidden')::boolean, a.hidden) end
      where id = a.id returning * into a;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('id', a.id, 'name', a.name, 'hidden', a.hidden));
end $$;

-- ---------- c) expenses ----------
create table public.expenses (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  kind            text not null default 'expense' check (kind in ('expense','supplier','owner')),
  category        text not null check (category ~ '^[a-z][a-z_]{1,19}$'),   -- the app's list (tea, labour, freight, …); unknown = "other"
  amount          numeric(12,2) not null check (amount > 0),
  account_id      uuid not null,                                            -- where the money came from
  method          text check (method is null or method in ('UPI','IMPS','NEFT','RTGS','Cheque')),
  paid_at         timestamptz not null default now(),                       -- when it was paid (an entry made offline: when it happened)
  business_date   date not null,                                            -- the shop's date of paid_at
  paid_to         text check (paid_to is null or length(btrim(paid_to)) between 1 and 80),
  note            text check (note is null or length(note) <= 300),
  gst_bill        boolean not null default false,                           -- a GST bill was given (the CA may claim the GST)
  gst_amount      numeric(12,2) check (gst_amount is null or gst_amount >= 0),
  bill_no         text check (bill_no is null or length(btrim(bill_no)) between 1 and 40),
  seller_gstin    text check (seller_gstin is null or seller_gstin ~ '^[0-9]{2}[0-9A-Z]{13}$'),
  supplier_id     uuid,                                                     -- "paid a supplier"
  purchase_ids    uuid[] not null default '{}',                             -- his bills this payment settled
  file_key        text check (file_key is null or length(file_key) <= 200), -- photo of the bill / receipt
  status          text not null default 'ok' check (status in ('ok','cancelled')),
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text check (cancel_reason is null or length(btrim(cancel_reason)) between 1 and 300),
  replaces_id     uuid,                                                     -- this entry corrects that one
  entered_offline boolean not null default false,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  idempotency_key uuid,
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, account_id) references public.money_accounts(company_id, id),
  foreign key (company_id, supplier_id) references public.suppliers(company_id, id),
  foreign key (company_id, replaces_id) references public.expenses(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  foreign key (company_id, cancelled_by) references public.people(company_id, id),
  constraint expenses_cancelled check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null)),
  constraint expenses_gst check (gst_bill or (gst_amount is null and seller_gstin is null)),
  constraint expenses_gst_part check (gst_amount is null or gst_amount < amount),
  constraint expenses_supplier check ((kind = 'supplier') = (supplier_id is not null))
);
create index expenses_day_idx on public.expenses (company_id, business_date desc, paid_at desc);
create index expenses_account_idx on public.expenses (company_id, account_id, paid_at);
create unique index expenses_replaced_once on public.expenses (company_id, replaces_id) where replaces_id is not null;

-- Only one change is ever allowed: ok → cancelled (with who, when, why).
create function app.guard_cancel_only() returns trigger
language plpgsql set search_path = '' as $$
declare keep text[] := array['status','cancelled_at','cancelled_by','cancel_reason'];
begin
  if tg_op = 'DELETE' then
    raise exception '% records cannot be deleted. Cancel it instead.', tg_table_name using errcode = 'restrict_violation';
  end if;
  if old.status <> 'ok' or new.status <> 'cancelled' or (to_jsonb(new) - keep) <> (to_jsonb(old) - keep) then
    raise exception '% records can only be cancelled, never changed.', tg_table_name using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger guard before update or delete on public.expenses for each row execute function app.guard_cancel_only();
create trigger no_truncate before truncate on public.expenses for each statement execute function app.forbid_change();
create trigger audit after insert or update on public.expenses for each row execute function app.audit_row();

-- ---------- d) money moved between the shop's accounts ----------
create table public.money_transfers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete restrict,
  from_account    uuid not null,
  to_account      uuid not null,
  amount          numeric(12,2) not null check (amount > 0),
  at              timestamptz not null default now(),
  business_date   date not null,
  reason          text not null default 'move' check (reason in ('move','deposit','withdraw','home','close')),  -- close = taken out of the drawer at closing
  method          text check (method is null or method in ('UPI','IMPS','NEFT','RTGS','Cheque')),
  note            text check (note is null or length(note) <= 300),
  status          text not null default 'ok' check (status in ('ok','cancelled')),
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text check (cancel_reason is null or length(btrim(cancel_reason)) between 1 and 300),
  entered_offline boolean not null default false,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  idempotency_key uuid,
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, from_account) references public.money_accounts(company_id, id),
  foreign key (company_id, to_account) references public.money_accounts(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  foreign key (company_id, cancelled_by) references public.people(company_id, id),
  constraint money_transfers_two_accounts check (from_account <> to_account),
  constraint money_transfers_cancelled check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index money_transfers_day_idx on public.money_transfers (company_id, business_date desc, at desc);
create index money_transfers_from_idx on public.money_transfers (company_id, from_account, at);
create index money_transfers_to_idx on public.money_transfers (company_id, to_account, at);
create trigger guard before update or delete on public.money_transfers for each row execute function app.guard_cancel_only();
create trigger no_truncate before truncate on public.money_transfers for each statement execute function app.forbid_change();
create trigger audit after insert or update on public.money_transfers for each row execute function app.audit_row();

-- ---------- e) balance points: a cash count or the passbook figure ----------
create table public.account_balances (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete restrict,
  account_id    uuid not null,
  at            timestamptz not null default now(),
  balance       numeric(14,2) not null,           -- what was really there (a drawer count: what was LEFT after taking cash out)
  expected      numeric(14,2),                    -- what the app worked out at that moment (null = no figure yet)
  source        text not null check (source in ('count','passbook','start')),
  cash_close_id uuid,
  note          text check (note is null or length(note) <= 300),
  created_by    uuid,
  created_at    timestamptz not null default clock_timestamp(),   -- two points at the same moment: the later one counts
  unique (company_id, id),
  foreign key (company_id, account_id) references public.money_accounts(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id)
);
create index account_balances_idx on public.account_balances (company_id, account_id, at desc);
create trigger account_balances_no_change before update or delete on public.account_balances for each row execute function app.forbid_change();
create trigger account_balances_no_truncate before truncate on public.account_balances for each statement execute function app.forbid_change();
create trigger audit after insert on public.account_balances for each row execute function app.audit_row();

-- the cash count now also remembers the opening cash and what was taken out of the drawer
alter table public.cash_closes add column opening numeric(12,2);
alter table public.cash_closes add column taken_out numeric(12,2) not null default 0 check (taken_out >= 0);
alter table public.cash_closes add column taken_to uuid;
alter table public.cash_closes add constraint cash_closes_taken_to_fk foreign key (company_id, taken_to) references public.money_accounts(company_id, id);
alter table public.cash_closes add constraint cash_closes_taken_le check (taken_out <= counted_cash);

alter table public.expenses enable row level security;           -- read only through the api
alter table public.money_transfers enable row level security;
alter table public.account_balances enable row level security;
revoke all on public.expenses, public.money_transfers, public.account_balances from anon, authenticated;

-- ---------- f) every move of money in and out of one account ----------
-- (after < at <= until). Payment parts (customers), expenses (out), transfers (out / in).
create function app.account_moves(p_company uuid, p_account uuid, p_after timestamptz, p_until timestamptz)
returns table (at timestamptz, amount numeric, src text, ref uuid)
language sql stable security definer set search_path = '' as $$
  select p.received_at, pp.amount, 'payment', p.id
    from public.payment_parts pp join public.payments p on p.company_id = pp.company_id and p.id = pp.payment_id
    where pp.company_id = p_company and pp.account_id = p_account and p.received_at > p_after and p.received_at <= p_until
  union all
  select e.paid_at, -e.amount, 'expense', e.id from public.expenses e
    where e.company_id = p_company and e.account_id = p_account and e.status = 'ok' and e.paid_at > p_after and e.paid_at <= p_until
  union all
  select t.at, -t.amount, 'transfer_out', t.id from public.money_transfers t
    where t.company_id = p_company and t.from_account = p_account and t.status = 'ok' and t.at > p_after and t.at <= p_until
  union all
  select t.at, t.amount, 'transfer_in', t.id from public.money_transfers t
    where t.company_id = p_company and t.to_account = p_account and t.status = 'ok' and t.at > p_after and t.at <= p_until
$$;

-- What should be in an account at a moment: the last balance point + the moves after it.
-- Without a balance point: everything since the start (known = false).
create function app.account_balance(p_company uuid, p_account uuid, p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.account_balances; s numeric;
begin
  select * into b from public.account_balances
    where company_id = p_company and account_id = p_account and at <= p_at order by at desc, created_at desc limit 1;
  select coalesce(sum(m.amount), 0) into s from app.account_moves(p_company, p_account, coalesce(b.at, '-infinity'::timestamptz), p_at) m;
  return jsonb_build_object('known', b.id is not null, 'balance', round(coalesce(b.balance, 0) + s, 2), 'since', b.at, 'base', b.balance, 'source', b.source);
end $$;

-- The drawer's cash at a moment. Like account_balance, but before the drawer was ever counted it
-- starts from zero at the beginning of that shop day (the old way: every day starts empty).
create function app.drawer_cash(p_company uuid, p_drawer uuid, p_at timestamptz, p_day_start timestamptz) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare b public.account_balances; s numeric;
begin
  select * into b from public.account_balances
    where company_id = p_company and account_id = p_drawer and at <= p_at order by at desc, created_at desc limit 1;
  select coalesce(sum(m.amount), 0) into s
    from app.account_moves(p_company, p_drawer, coalesce(b.at, p_day_start - interval '1 microsecond'), p_at) m;
  return round(coalesce(b.balance, 0) + s, 2);
end $$;

-- The drawer's cash book for one shop day: opening, cash in, cash out, what should be there (now /
-- at the end of the day), and the counts made that day.
create function app.cash_book(p_company uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_s timestamptz; v_e timestamptz; v_until timestamptz; v_drawer uuid; v_open numeric; v_in numeric; v_out numeric;
begin
  select timezone into v_tz from public.companies where id = p_company;
  v_s := p_day::timestamp at time zone v_tz;
  v_e := (p_day + 1)::timestamp at time zone v_tz;
  v_until := least(v_e - interval '1 microsecond', now());
  select id into v_drawer from public.money_accounts where company_id = p_company and is_drawer;
  -- opening: what was in the drawer when the day began (zero before the drawer's first count)
  v_open := case when exists (select 1 from public.account_balances where company_id = p_company and account_id = v_drawer and at < v_s)
                 then app.drawer_cash(p_company, v_drawer, v_s - interval '1 microsecond', v_s) else 0 end;
  select coalesce(sum(m.amount) filter (where m.amount > 0), 0), coalesce(-sum(m.amount) filter (where m.amount < 0), 0)
    into v_in, v_out from app.account_moves(p_company, v_drawer, v_s - interval '1 microsecond', v_until) m;
  return jsonb_build_object(
    'day', p_day, 'drawer', v_drawer, 'opening', v_open, 'in', round(v_in, 2), 'out', round(v_out, 2),
    'expected', app.drawer_cash(p_company, v_drawer, v_until, v_s),
    'counted_before', exists (select 1 from public.account_balances where company_id = p_company and account_id = v_drawer and at < v_e),
    'counts', coalesce((select jsonb_agg(jsonb_build_object('at', cc.closed_at, 'expected', cc.expected_cash, 'counted', cc.counted_cash,
        'opening', cc.opening, 'taken_out', cc.taken_out, 'taken_to', cc.taken_to, 'left', cc.counted_cash - cc.taken_out,
        'by', pe.display_name, 'note', cc.note) order by cc.closed_at)
      from public.cash_closes cc left join public.people pe on pe.company_id = cc.company_id and pe.id = cc.closed_by
      where cc.company_id = p_company and cc.business_date = p_day), '[]'::jsonb),
    -- the day's cash moves, for the list (customers' names only for payments)
    'moves', coalesce((select jsonb_agg(jsonb_build_object('at', m.at, 'amount', m.amount, 'src', m.src, 'ref', m.ref) order by m.at)
      from app.account_moves(p_company, v_drawer, v_s - interval '1 microsecond', v_until) m), '[]'::jsonb));
end $$;

-- When an entry may say it happened: not in the future; the past only so far.
create function app.entry_time(p_at timestamptz, p_max_days integer) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p_at is null then return now(); end if;
  if p_at > now() + interval '5 minutes' then raise exception 'That time is in the future.' using errcode = '22023'; end if;
  if p_at < now() - make_interval(days => p_max_days) then
    raise exception 'That is too long ago (up to % days back).', p_max_days using errcode = '22023';
  end if;
  return least(p_at, now());
end $$;

-- Can this person use this account for money going out (same rules as taking money in)?
create function app.usable_account(c public.people, p_account uuid) returns public.money_accounts
language plpgsql stable security definer set search_path = '' as $$
declare a public.money_accounts;
begin
  select * into a from public.money_accounts where company_id = c.company_id and id = p_account;
  if a.id is null or a.hidden or not (a.staff_can or app.has(c, 'settings')) then
    raise exception 'That account can''t be chosen.' using errcode = '22023';
  end if;
  return a;
end $$;

-- ---------- g) saving and cancelling expenses ----------
-- p: { kind, category, amount, account_id, method, at, paid_to, note, gst_bill, gst_amount, bill_no, seller_gstin,
--      supplier_id, purchase_ids, file_key, replaces_id, offline }
create function public.api_save_expense(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.people := app.caller(p_caller); prev jsonb; v_tz text; a public.money_accounts; e public.expenses; old public.expenses;
  v_kind text := coalesce(p ->> 'kind', 'expense'); v_amt numeric := round((p ->> 'amount')::numeric, 2); v_at timestamptz;
  v_gst boolean := coalesce((p ->> 'gst_bill')::boolean, false); v_sup uuid := nullif(p ->> 'supplier_id', '')::uuid;
  v_bills uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'purchase_ids', '[]')) x), '{}');
  v_old uuid := nullif(p ->> 'replaces_id', '')::uuid; n int; boss boolean := app.has(c, 'settings');
begin
  if v_kind = 'expense' then
    if not (app.has(c, 'expenses') or boss) then perform app.require(c, 'expenses'); end if;
  elsif v_kind = 'supplier' then
    if not (app.has(c, 'stock') or boss) then perform app.require(c, 'stock'); end if;
  elsif v_kind = 'owner' then
    perform app.require(c, 'settings');
  else
    raise exception 'Choose what the money was for.' using errcode = '22023';
  end if;
  prev := app.idem_start(c.company_id, p_key, 'saveExpense', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if v_amt is null or v_amt <= 0 or v_amt > 100000000 then raise exception 'Enter the amount.' using errcode = '22023'; end if;
  a := app.usable_account(c, nullif(p ->> 'account_id', '')::uuid);
  v_at := app.entry_time(nullif(p ->> 'at', '')::timestamptz, case when boss then 400 else 3 end);
  select timezone into v_tz from public.companies where id = c.company_id;
  if v_kind = 'supplier' then
    if v_sup is null or not exists (select 1 from public.suppliers where company_id = c.company_id and id = v_sup) then
      raise exception 'Choose the supplier.' using errcode = '22023';
    end if;
  else
    v_sup := null; v_bills := '{}';
  end if;
  if cardinality(v_bills) > 50 then raise exception 'Up to 50 bills at a time.' using errcode = '22023'; end if;
  select count(*) into n from public.purchases pu
    where pu.company_id = c.company_id and pu.id = any(v_bills) and pu.supplier_id = v_sup and pu.status = 'saved'
      and (pu.bill_type = 'pakka' or app.has(c, 'kacha'));
  if n <> cardinality(v_bills) then raise exception 'Those bills are not this supplier''s.' using errcode = '22023'; end if;
  if v_gst and nullif(p ->> 'gst_amount', '') is not null and (p ->> 'gst_amount')::numeric >= v_amt then
    raise exception 'The GST must be less than the amount.' using errcode = '22023';
  end if;

  if v_old is not null then  -- a corrected entry: the old one is cancelled in the same step
    select * into old from public.expenses where company_id = c.company_id and id = v_old for update;
    if old.id is null then raise exception 'Expense not found.' using errcode = '22023'; end if;
    if old.status <> 'ok' then raise exception 'That expense was already cancelled or changed.' using errcode = '23001'; end if;
    if not boss and (old.created_by is distinct from c.id or old.business_date < (now() at time zone v_tz)::date) then
      raise exception 'Only the owner can change an older expense or someone else''s.' using errcode = '42501';
    end if;
    if old.kind <> v_kind then raise exception 'Cancel it and add a new one instead.' using errcode = '22023'; end if;
    update public.expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = 'Changed' where id = old.id;
    if cardinality(old.purchase_ids) > 0 then
      update public.purchases set pay_status = 'to_pay', paid_at = null where company_id = c.company_id and id = any(old.purchase_ids) and pay_status = 'paid';
    end if;
  end if;

  insert into public.expenses (company_id, kind, category, amount, account_id, method, paid_at, business_date, paid_to, note,
      gst_bill, gst_amount, bill_no, seller_gstin, supplier_id, purchase_ids, file_key, replaces_id, entered_offline, created_by, idempotency_key)
    values (c.company_id, v_kind, case when v_kind = 'supplier' then 'supplier' when v_kind = 'owner' then 'home' else coalesce(nullif(p ->> 'category', ''), 'other') end,
      v_amt, a.id, case when a.kind in ('bank','other') then nullif(p ->> 'method', '') end,
      v_at, (v_at at time zone v_tz)::date, nullif(btrim(p ->> 'paid_to'), ''), nullif(btrim(p ->> 'note'), ''),
      v_gst, case when v_gst then round(nullif(p ->> 'gst_amount', '')::numeric, 2) end, nullif(btrim(p ->> 'bill_no'), ''),
      case when v_gst then nullif(upper(btrim(p ->> 'seller_gstin')), '') end, v_sup, v_bills, nullif(p ->> 'file_key', ''), v_old,
      coalesce((p ->> 'offline')::boolean, false), c.id, p_key)
    returning * into e;
  if cardinality(v_bills) > 0 then
    update public.purchases set pay_status = 'paid', paid_at = v_at where company_id = c.company_id and id = any(v_bills);
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('expense_id', e.id, 'amount', e.amount, 'day', e.business_date,
    'mode', app.part_mode(a.kind, e.method), 'replaced', v_old));
end $$;

create function public.api_cancel_expense(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; e public.expenses; v_tz text; why text := btrim(coalesce(p_reason, ''));
begin
  if not (app.has(c, 'expenses') or app.has(c, 'settings') or app.has(c, 'stock')) then perform app.require(c, 'expenses'); end if;
  if why = '' then raise exception 'Write why it is cancelled.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'cancelExpense', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into e from public.expenses where company_id = c.company_id and id = p_id for update;
  if e.id is null then raise exception 'Expense not found.' using errcode = '22023'; end if;
  if e.status <> 'ok' then raise exception 'It is already cancelled.' using errcode = '23001'; end if;
  select timezone into v_tz from public.companies where id = c.company_id;
  if not app.has(c, 'settings') and (e.created_by is distinct from c.id or e.business_date < (now() at time zone v_tz)::date
                                     or e.kind = 'owner' or (e.kind = 'supplier' and not app.has(c, 'stock'))) then
    raise exception 'Only the owner can cancel an older expense or someone else''s.' using errcode = '42501';
  end if;
  update public.expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = left(why, 300) where id = e.id;
  if cardinality(e.purchase_ids) > 0 then
    update public.purchases set pay_status = 'to_pay', paid_at = null where company_id = c.company_id and id = any(e.purchase_ids) and pay_status = 'paid';
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('expense_id', e.id, 'status', 'cancelled'));
end $$;

-- The list for the Expenses screen (and the month's totals). Each person sees the kinds they may:
-- expenses (expenses / owners), supplier payments (stock / owners), owner's own (owners).
create function public.api_expenses(p_caller uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); boss boolean := app.has(c, 'settings'); v_tz text; v_today date;
begin
  if not (app.has(c, 'expenses') or boss or app.has(c, 'stock')) then perform app.require(c, 'expenses'); end if;
  select timezone into v_tz from public.companies where id = c.company_id;
  v_today := (now() at time zone v_tz)::date;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Choose the dates.' using errcode = '22023'; end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'today', v_today,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'category', e.category, 'amount', e.amount,
        'account_id', e.account_id, 'account', a.name, 'account_kind', a.kind, 'is_drawer', a.is_drawer, 'account_owner', a.owner,
        'mode', app.part_mode(a.kind, e.method), 'method', e.method,
        'at', e.paid_at, 'day', e.business_date, 'paid_to', e.paid_to, 'note', e.note, 'gst_bill', e.gst_bill, 'gst_amount', e.gst_amount,
        'bill_no', e.bill_no, 'seller_gstin', e.seller_gstin, 'supplier_id', e.supplier_id, 'supplier', su.name, 'purchase_ids', to_jsonb(e.purchase_ids),
        'has_file', e.file_key is not null, 'status', e.status, 'cancel_reason', e.cancel_reason, 'cancelled_at', e.cancelled_at,
        'cancelled_by', cb.display_name, 'replaces_id', e.replaces_id, 'offline', e.entered_offline,
        'by', pe.display_name, 'by_id', e.created_by, 'created_at', e.created_at,
        'mine_today', e.created_by = c.id and e.business_date = v_today) order by e.paid_at desc, e.created_at desc)
      from public.expenses e
      join public.money_accounts a on a.company_id = e.company_id and a.id = e.account_id
      left join public.suppliers su on su.company_id = e.company_id and su.id = e.supplier_id
      left join public.people pe on pe.company_id = e.company_id and pe.id = e.created_by
      left join public.people cb on cb.company_id = e.company_id and cb.id = e.cancelled_by
      where e.company_id = c.company_id and e.business_date between p_from and p_to
        and ((e.kind = 'expense' and (app.has(c, 'expenses') or boss)) or (e.kind = 'supplier' and (app.has(c, 'stock') or boss)) or (e.kind = 'owner' and boss))), '[]'::jsonb),
    -- money moved between accounts in those days (expenses people and owners)
    'transfers', case when app.has(c, 'expenses') or boss then coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'amount', t.amount,
        'from_account', t.from_account, 'from', fa.name, 'from_drawer', fa.is_drawer, 'to_account', t.to_account, 'to', ta.name, 'to_drawer', ta.is_drawer,
        'reason', t.reason, 'method', t.method, 'note', t.note, 'at', t.at, 'day', t.business_date, 'status', t.status, 'cancel_reason', t.cancel_reason,
        'by', pe.display_name, 'mine_today', t.created_by = c.id and t.business_date = v_today) order by t.at desc)
      from public.money_transfers t
      join public.money_accounts fa on fa.company_id = t.company_id and fa.id = t.from_account
      join public.money_accounts ta on ta.company_id = t.company_id and ta.id = t.to_account
      left join public.people pe on pe.company_id = t.company_id and pe.id = t.created_by
      where t.company_id = c.company_id and t.business_date between p_from and p_to), '[]'::jsonb) else '[]'::jsonb end,
    -- suppliers (and their unpaid bills) for "paid a supplier"
    'suppliers', case when app.has(c, 'stock') or boss then coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name,
        'unpaid', coalesce((select jsonb_agg(jsonb_build_object('id', pu.id, 'bill_no', pu.bill_no, 'date', pu.bill_date, 'total', pu.total_amount) order by pu.bill_date)
          from public.purchases pu where pu.company_id = s.company_id and pu.supplier_id = s.id and pu.status = 'saved' and pu.pay_status = 'to_pay'
            and pu.kind = 'bill' and (pu.bill_type = 'pakka' or app.has(c, 'kacha'))), '[]'::jsonb)) order by s.name)
      from public.suppliers s where s.company_id = c.company_id and s.active), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- ---------- h) moving money between accounts ----------
-- p: { from_account, to_account, amount, reason, method, note, at, offline }
create function public.api_save_transfer(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; fa public.money_accounts; ta public.money_accounts; t public.money_transfers;
  v_amt numeric := round((p ->> 'amount')::numeric, 2); v_at timestamptz; v_tz text; v_reason text := coalesce(nullif(p ->> 'reason', ''), 'move');
begin
  if not (app.has(c, 'expenses') or app.has(c, 'settings')) then perform app.require(c, 'expenses'); end if;
  prev := app.idem_start(c.company_id, p_key, 'saveTransfer', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if v_amt is null or v_amt <= 0 or v_amt > 100000000 then raise exception 'Enter the amount.' using errcode = '22023'; end if;
  if v_reason not in ('move','deposit','withdraw','home') then raise exception 'Choose what kind of move it is.' using errcode = '22023'; end if;
  fa := app.usable_account(c, nullif(p ->> 'from_account', '')::uuid);
  ta := app.usable_account(c, nullif(p ->> 'to_account', '')::uuid);
  if fa.id = ta.id then raise exception 'Choose two different accounts.' using errcode = '22023'; end if;
  v_at := app.entry_time(nullif(p ->> 'at', '')::timestamptz, case when app.has(c, 'settings') then 400 else 3 end);
  select timezone into v_tz from public.companies where id = c.company_id;
  insert into public.money_transfers (company_id, from_account, to_account, amount, at, business_date, reason, method, note, entered_offline, created_by, idempotency_key)
    values (c.company_id, fa.id, ta.id, v_amt, v_at, (v_at at time zone v_tz)::date, v_reason,
            case when (fa.kind in ('bank','other') or ta.kind in ('bank','other')) and (p ->> 'method') in ('UPI','IMPS','NEFT','RTGS','Cheque') then p ->> 'method' end,
            nullif(btrim(p ->> 'note'), ''), coalesce((p ->> 'offline')::boolean, false), c.id, p_key)
    returning * into t;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('transfer_id', t.id, 'amount', t.amount, 'day', t.business_date));
end $$;

create function public.api_cancel_transfer(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; t public.money_transfers; v_tz text; why text := btrim(coalesce(p_reason, ''));
begin
  if not (app.has(c, 'expenses') or app.has(c, 'settings')) then perform app.require(c, 'expenses'); end if;
  if why = '' then raise exception 'Write why it is cancelled.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'cancelTransfer', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into t from public.money_transfers where company_id = c.company_id and id = p_id for update;
  if t.id is null then raise exception 'Not found.' using errcode = '22023'; end if;
  if t.status <> 'ok' then raise exception 'It is already cancelled.' using errcode = '23001'; end if;
  select timezone into v_tz from public.companies where id = c.company_id;
  if not app.has(c, 'settings') and (t.created_by is distinct from c.id or t.business_date < (now() at time zone v_tz)::date or t.reason = 'close') then
    raise exception 'Only the owner can cancel this.' using errcode = '42501';
  end if;
  update public.money_transfers set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = left(why, 300) where id = t.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('transfer_id', t.id, 'status', 'cancelled'));
end $$;

-- ---------- i) the cash count at closing, as a cash book ----------
-- Counted cash → a balance point for the drawer. p_take = cash taken out now (home / bank), put into p_take_to
-- (any other account; "Cash at home" is made the first time if none is given). What is left is tomorrow's opening.
create function public.api_close_cash(p_caller uuid, p_key uuid, p_hash text, p_counted numeric, p_note text,
                                      p_take numeric, p_take_to uuid, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; v_tz text; v_at timestamptz; v_day date; v_s timestamptz; drawer uuid;
  v_exp numeric; v_open numeric; v_take numeric := round(coalesce(p_take, 0), 2); v_to public.money_accounts; cc uuid;
begin
  perform app.require(c, 'money', 'today');
  prev := app.idem_start(c.company_id, p_key, 'saveCashCount', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_counted is null or p_counted < 0 then raise exception 'Enter the cash you counted.' using errcode = '22023'; end if;
  if v_take < 0 or v_take > p_counted then raise exception 'You can''t take out more than you counted.' using errcode = '22023'; end if;
  select timezone into v_tz from public.companies where id = c.company_id;
  v_at := app.entry_time(p_at, 3);
  v_day := (v_at at time zone v_tz)::date;
  v_s := v_day::timestamp at time zone v_tz;
  select id into drawer from public.money_accounts where company_id = c.company_id and is_drawer;
  v_exp := app.drawer_cash(c.company_id, drawer, v_at, v_s);
  v_open := (app.cash_book(c.company_id, v_day) ->> 'opening')::numeric;
  if v_take > 0 then
    if p_take_to is null then  -- the first time: an account for the cash kept at home
      select * into v_to from public.money_accounts where company_id = c.company_id and kind = 'safe' and not hidden order by position limit 1;
      if v_to.id is null then
        insert into public.money_accounts (company_id, name, kind, owner, staff_can, position, created_by)
          values (c.company_id, 'Cash at home', 'safe', 'firm', false,
                  coalesce((select max(position) + 1 from public.money_accounts where company_id = c.company_id), 1), c.id)
          returning * into v_to;
      end if;
    else
      select * into v_to from public.money_accounts where company_id = c.company_id and id = p_take_to and not hidden and not is_drawer;
      if v_to.id is null then raise exception 'Choose where the cash went.' using errcode = '22023'; end if;
    end if;
  end if;
  insert into public.cash_closes (company_id, business_date, expected_cash, counted_cash, note, closed_by, closed_at, opening, taken_out, taken_to)
    values (c.company_id, v_day, v_exp, p_counted, nullif(btrim(p_note), ''), c.id, v_at, v_open, v_take, v_to.id)
    returning id into cc;
  -- the balance point is what stays in the drawer; the cash taken out moves at the same moment
  -- (so it is part of this point, not counted again after it)
  insert into public.account_balances (company_id, account_id, at, balance, expected, source, cash_close_id, note, created_by)
    values (c.company_id, drawer, v_at, p_counted - v_take, v_exp, 'count', cc, nullif(btrim(p_note), ''), c.id);
  if v_take > 0 then
    insert into public.money_transfers (company_id, from_account, to_account, amount, at, business_date, reason, note, created_by)
      values (c.company_id, drawer, v_to.id, v_take, v_at, v_day, 'close', null, c.id);
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('business_date', v_day, 'opening', v_open, 'expected', v_exp, 'counted', p_counted,
    'difference', p_counted - v_exp, 'taken_out', v_take, 'taken_to', v_to.id, 'taken_to_name', v_to.name, 'left', p_counted - v_take));
end $$;

-- the old door (same request shape as before) now keeps the cash book too
create or replace function public.api_save_cash_count(p_caller uuid, p_key uuid, p_hash text, p_counted numeric, p_note text) returns jsonb
language sql security definer set search_path = '' as $$
  select public.api_close_cash(p_caller, p_key, p_hash, p_counted, p_note, 0, null, null)
$$;

-- The drawer's cash book for a day (default today) — for the cash count and Today.
create function public.api_cash_book(p_caller uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); v_tz text; v_day date;
begin
  perform app.require(c, 'money', 'today');
  select timezone into v_tz from public.companies where id = c.company_id;
  v_day := coalesce(p_day, (now() at time zone v_tz)::date);
  return app.cash_book(c.company_id, v_day) || jsonb_build_object('today', (now() at time zone v_tz)::date,
    'safes', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind) order by a.kind = 'safe' desc, a.position)
      from public.money_accounts a where a.company_id = c.company_id and not a.hidden and not a.is_drawer and a.kind in ('safe','bank')), '[]'::jsonb));
end $$;

-- ---------- j) balances (owners) ----------
-- Every account with what should be in it now.
create function public.api_account_balances(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); v_tz text;
begin
  perform app.require(c, 'settings', 'money');
  select timezone into v_tz from public.companies where id = c.company_id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'owner', a.owner, 'is_drawer', a.is_drawer,
      'hidden', a.hidden) || case when a.is_drawer
        then jsonb_build_object('known', true, 'balance', app.drawer_cash(c.company_id, a.id, now(), ((now() at time zone v_tz)::date)::timestamp at time zone v_tz),
                                'since', (select max(at) from public.account_balances b where b.company_id = a.company_id and b.account_id = a.id))
        else app.account_balance(c.company_id, a.id, now()) end
      order by a.is_drawer desc, a.position, a.created_at)
    from public.money_accounts a where a.company_id = c.company_id), '[]'::jsonb);
end $$;

-- One account's book: balance now, its balance points and every move between two dates with the running balance.
create function public.api_account_book(p_caller uuid, p_account uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); a public.money_accounts; v_tz text; v_s timestamptz; v_e timestamptz; v_open jsonb; k boolean;
begin
  perform app.require(c, 'settings', 'money');
  k := app.has(c, 'kacha');
  select * into a from public.money_accounts where company_id = c.company_id and id = p_account;
  if a.id is null then raise exception 'Account not found.' using errcode = '22023'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Choose the dates.' using errcode = '22023'; end if;
  select timezone into v_tz from public.companies where id = c.company_id;
  v_s := p_from::timestamp at time zone v_tz;
  v_e := least((p_to + 1)::timestamp at time zone v_tz - interval '1 microsecond', now());
  v_open := app.account_balance(c.company_id, a.id, v_s - interval '1 microsecond');
  return jsonb_build_object('account', jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'owner', a.owner, 'is_drawer', a.is_drawer, 'number', a.number),
    'from', p_from, 'to', p_to,
    'now', app.account_balance(c.company_id, a.id, now()),
    'opening', v_open,
    'points', coalesce((select jsonb_agg(jsonb_build_object('at', b.at, 'balance', b.balance, 'expected', b.expected, 'source', b.source, 'note', b.note,
        'by', pe.display_name, 'counted', cc.counted_cash, 'taken_out', cc.taken_out) order by b.at, b.created_at)
      from public.account_balances b left join public.people pe on pe.company_id = b.company_id and pe.id = b.created_by
      left join public.cash_closes cc on cc.company_id = b.company_id and cc.id = b.cash_close_id
      where b.company_id = c.company_id and b.account_id = a.id and b.at >= v_s and b.at <= v_e), '[]'::jsonb),
    'moves', coalesce((select jsonb_agg(jsonb_build_object('at', m.at, 'amount', m.amount, 'src', m.src, 'ref', m.ref,
        'what', case m.src
          when 'payment' then (select case when k or coalesce(p.side, o.bill_type) is distinct from 'kacha'
                                   then jsonb_build_object('customer', cu.name, 'slip_no', o.slip_no, 'kind', p.kind)
                                   else jsonb_build_object('kind', p.kind) end
                                 from public.payments p join public.customers cu on cu.company_id = p.company_id and cu.id = p.customer_id
                                 left join public.orders o on o.company_id = p.company_id and o.id = p.order_id where p.id = m.ref)
          when 'expense' then (select jsonb_build_object('category', e.category, 'kind', e.kind, 'paid_to', e.paid_to, 'note', e.note) from public.expenses e where e.id = m.ref)
          else (select jsonb_build_object('reason', t.reason, 'other', case when m.src = 'transfer_out' then ta.name else fa.name end, 'note', t.note)
                  from public.money_transfers t join public.money_accounts fa on fa.id = t.from_account join public.money_accounts ta on ta.id = t.to_account where t.id = m.ref)
        end) order by m.at)
      from app.account_moves(c.company_id, a.id, v_s - interval '1 microsecond', v_e) m), '[]'::jsonb),
    'kacha', k);
end $$;

-- "My passbook / Paytm app says ₹…" (or the starting cash): a balance point for that account.
create function public.api_set_balance(p_caller uuid, p_key uuid, p_hash text, p_account uuid, p_balance numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; a public.money_accounts; v_exp jsonb;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'setBalance', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into a from public.money_accounts where company_id = c.company_id and id = p_account;
  if a.id is null then raise exception 'Account not found.' using errcode = '22023'; end if;
  if p_balance is null or abs(p_balance) > 10000000000 then raise exception 'Enter the balance.' using errcode = '22023'; end if;
  if a.is_drawer and p_balance < 0 then raise exception 'Cash can''t be below zero.' using errcode = '22023'; end if;
  v_exp := app.account_balance(c.company_id, a.id, now());
  insert into public.account_balances (company_id, account_id, at, balance, expected, source, note, created_by)
    values (c.company_id, a.id, now(), round(p_balance, 2), case when (v_exp ->> 'known')::boolean or a.is_drawer then (v_exp ->> 'balance')::numeric end,
            case when (v_exp ->> 'known')::boolean then 'passbook' else 'start' end, nullif(btrim(p_note), ''), c.id);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('account_id', a.id, 'balance', round(p_balance, 2),
    'expected', case when (v_exp ->> 'known')::boolean then (v_exp ->> 'balance')::numeric end));
end $$;

-- ---------- k) one shop day's money out, for the evening summary ----------
create function public.api_day_money(p_caller uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); boss boolean := app.has(c, 'settings'); v_tz text; v_day date;
begin
  perform app.require(c, 'money');
  select timezone into v_tz from public.companies where id = c.company_id;
  v_day := coalesce(p_day, (now() at time zone v_tz)::date);
  return jsonb_build_object('day', v_day,
    'expenses', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'category', e.category, 'amount', e.amount,
        'account_id', e.account_id, 'is_drawer', a.is_drawer, 'mode', app.part_mode(a.kind, e.method), 'paid_to', e.paid_to, 'note', e.note,
        'gst_amount', e.gst_amount, 'supplier', su.name, 'at', e.paid_at, 'by', pe.display_name) order by e.paid_at)
      from public.expenses e join public.money_accounts a on a.company_id = e.company_id and a.id = e.account_id
      left join public.suppliers su on su.company_id = e.company_id and su.id = e.supplier_id
      left join public.people pe on pe.company_id = e.company_id and pe.id = e.created_by
      where e.company_id = c.company_id and e.business_date = v_day and e.status = 'ok'
        and ((e.kind = 'expense' and (app.has(c, 'expenses') or boss)) or (e.kind = 'supplier' and (app.has(c, 'stock') or boss)) or (e.kind = 'owner' and boss))), '[]'::jsonb),
    'transfers', case when app.has(c, 'expenses') or boss then coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'amount', t.amount,
        'from_account', t.from_account, 'from', fa.name, 'from_drawer', fa.is_drawer, 'to_account', t.to_account, 'to', ta.name, 'to_drawer', ta.is_drawer,
        'reason', t.reason, 'at', t.at, 'by', pe.display_name) order by t.at)
      from public.money_transfers t
      join public.money_accounts fa on fa.company_id = t.company_id and fa.id = t.from_account
      join public.money_accounts ta on ta.company_id = t.company_id and ta.id = t.to_account
      left join public.people pe on pe.company_id = t.company_id and pe.id = t.created_by
      where t.company_id = c.company_id and t.business_date = v_day and t.status = 'ok'), '[]'::jsonb) else '[]'::jsonb end,
    'cash_book', case when app.has(c, 'today') then app.cash_book(c.company_id, v_day) end);
end $$;

-- ---------- l) access ----------
revoke all on function app.guard_cancel_only(), app.account_moves(uuid, uuid, timestamptz, timestamptz), app.account_balance(uuid, uuid, timestamptz),
  app.drawer_cash(uuid, uuid, timestamptz, timestamptz), app.cash_book(uuid, date), app.entry_time(timestamptz, integer),
  app.usable_account(public.people, uuid) from public, anon, authenticated;
revoke all on function public.api_save_expense(uuid, uuid, text, jsonb), public.api_cancel_expense(uuid, uuid, text, uuid, text),
  public.api_expenses(uuid, date, date), public.api_save_transfer(uuid, uuid, text, jsonb), public.api_cancel_transfer(uuid, uuid, text, uuid, text),
  public.api_close_cash(uuid, uuid, text, numeric, text, numeric, uuid, timestamptz), public.api_save_cash_count(uuid, uuid, text, numeric, text),
  public.api_cash_book(uuid, date), public.api_account_balances(uuid), public.api_account_book(uuid, uuid, date, date),
  public.api_set_balance(uuid, uuid, text, uuid, numeric, text), public.api_day_money(uuid, date), public.api_save_account(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.api_save_expense(uuid, uuid, text, jsonb), public.api_cancel_expense(uuid, uuid, text, uuid, text),
  public.api_expenses(uuid, date, date), public.api_save_transfer(uuid, uuid, text, jsonb), public.api_cancel_transfer(uuid, uuid, text, uuid, text),
  public.api_close_cash(uuid, uuid, text, numeric, text, numeric, uuid, timestamptz), public.api_save_cash_count(uuid, uuid, text, numeric, text),
  public.api_cash_book(uuid, date), public.api_account_balances(uuid), public.api_account_book(uuid, uuid, date, date),
  public.api_set_balance(uuid, uuid, text, uuid, numeric, text), public.api_day_money(uuid, date), public.api_save_account(uuid, uuid, text, jsonb)
  to service_role;

-- the photo of an expense's bill / receipt (only for people who may see that expense)
create function public.api_expense_file(p_caller uuid, p_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); boss boolean := app.has(c, 'settings'); k text;
begin
  select e.file_key into k from public.expenses e where e.company_id = c.company_id and e.id = p_id
    and ((e.kind = 'expense' and (app.has(c, 'expenses') or boss)) or (e.kind = 'supplier' and (app.has(c, 'stock') or boss)) or (e.kind = 'owner' and boss));
  return k;
end $$;
revoke all on function public.api_expense_file(uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_expense_file(uuid, uuid) to service_role;
