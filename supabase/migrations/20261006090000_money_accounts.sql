-- =====================================================================================
-- 20. Money accounts (owner decisions 30 Sept 2026, design v2 approved; built 6 Oct 2026).
--   * The shop lists every place money comes in: the cash drawer ("Shop cash", always there)
--     plus any firm bank account, UPI ID, Paytm number or personal / family account it adds
--     itself (nothing else is pre-filled), each marked firm or personal.
--   * When money is taken, the person picks where it went; one payment can be SPLIT across
--     several accounts and the parts must add up exactly (payment_parts, never edited).
--   * A payment's mode follows its parts: "Cash", "UPI", … or several joined ("Cash+Bank").
--     Customers only ever see the mode, never an account name.
--   * The cash drawer only expects the cash parts. Evening: a tally per account with ticks.
--   * Payments made before this (or without choosing) keep working: Cash goes to the drawer,
--     anything else shows as "not placed in an account".
-- =====================================================================================

-- ---------- a) the accounts ----------
create table public.money_accounts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  name       text not null check (length(btrim(name)) between 1 and 40),
  kind       text not null check (kind in ('cash','bank','upi','paytm','wallet','other')),
  owner      text not null default 'firm' check (owner in ('firm','personal')),
  number     text check (number is null or length(number) between 1 and 60),
  staff_can  boolean not null default true,   -- false = only owners (settings permission) may choose it
  position   integer not null default 0,
  hidden     boolean not null default false,
  is_drawer  boolean not null default false,  -- the cash drawer: one per shop, always there
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  constraint money_accounts_cash_is_drawer check ((kind = 'cash') = is_drawer),
  constraint money_accounts_drawer_stays check (not is_drawer or (not hidden and staff_can))
);
create unique index money_accounts_drawer_uq on public.money_accounts (company_id) where is_drawer;
create unique index money_accounts_name_uq on public.money_accounts (company_id, lower(btrim(name)));
create index money_accounts_order_idx on public.money_accounts (company_id, position);

-- every shop has its cash drawer (existing shops now, new shops when they register)
insert into public.money_accounts (company_id, name, kind, owner, is_drawer, position)
  select id, 'Shop cash', 'cash', 'firm', true, 0 from public.companies;
create function app.add_cash_drawer() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.money_accounts (company_id, name, kind, owner, is_drawer, position) values (new.id, 'Shop cash', 'cash', 'firm', true, 0);
  return null;
end $$;
create trigger add_cash_drawer after insert on public.companies for each row execute function app.add_cash_drawer();

-- ---------- b) where each payment went ----------
create table public.payment_parts (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  payment_id uuid not null,
  account_id uuid not null,
  amount     numeric(12,2) not null check (amount <> 0),   -- same sign as the payment (money out < 0)
  mode       text not null check (mode in ('Cash','UPI','Bank','Cheque')),
  method     text check (method is null or method in ('UPI','IMPS','NEFT','RTGS','Cheque')),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, payment_id) references public.payments(company_id, id),
  foreign key (company_id, account_id) references public.money_accounts(company_id, id)
);
create index payment_parts_payment_idx on public.payment_parts (company_id, payment_id);
create index payment_parts_account_idx on public.payment_parts (company_id, account_id, created_at);
create trigger payment_parts_no_change before update or delete on public.payment_parts for each row execute function app.forbid_change();

-- a payment's mode may now be several modes joined ("Cash+Bank") when it was split
alter table public.payments drop constraint payments_mode_check;
alter table public.payments add constraint payments_mode_check
  check (mode = 'Adjust' or mode ~ '^(Cash|UPI|Bank|Cheque)(\+(Cash|UPI|Bank|Cheque))*$');

-- ---------- c) ticks in the evening ("checked in the bank / Paytm app") ----------
create table public.account_checks (
  company_id uuid not null references public.companies(id) on delete restrict,
  account_id uuid not null,
  day        date not null,
  checked_by uuid,
  checked_at timestamptz not null default now(),
  primary key (company_id, account_id, day),
  foreign key (company_id, account_id) references public.money_accounts(company_id, id),
  foreign key (company_id, checked_by) references public.people(company_id, id)
);

create trigger audit after insert or update or delete on public.money_accounts for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.account_checks for each row execute function app.audit_row();

alter table public.money_accounts enable row level security;
alter table public.payment_parts enable row level security;
alter table public.account_checks enable row level security;
create policy money_accounts_read on public.money_accounts for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('money')));
-- a part is visible when its payment is (the payments rule hides no-bill money from people without that permission)
create policy payment_parts_read on public.payment_parts for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('money'))
         and exists (select 1 from public.payments p where p.id = payment_id));
create policy account_checks_read on public.account_checks for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('settings')));
revoke all on public.money_accounts, public.payment_parts, public.account_checks from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.money_accounts, public.payment_parts, public.account_checks from authenticated;

-- ---------- d) placing payments in accounts ----------
-- The mode of one part: drawer = Cash; UPI / Paytm / wallet = UPI; bank / other by how it was paid (default Bank).
create function app.part_mode(p_kind text, p_method text) returns text
language sql immutable set search_path = '' as $$
  select case when p_kind = 'cash' then 'Cash'
              when p_kind in ('upi','paytm','wallet') then 'UPI'
              when p_method = 'UPI' then 'UPI'
              when p_method = 'Cheque' then 'Cheque'
              else 'Bank' end
$$;
create function app.join_modes(p_modes text[]) returns text
language sql immutable set search_path = '' as $$
  select string_agg(m, '+' order by array_position(array['Cash','UPI','Bank','Cheque'], m))
  from (select distinct unnest(p_modes) m) t where m in ('Cash','UPI','Bank','Cheque')
$$;

-- How a payment is placed (set only by public.api_pay for the operation it runs, then cleared):
--   app.pay_parts   = [{account_id, amount, method}] for the NEXT money payment (a split; used once)
--   app.pay_account = {account_id, method} for every money payment in this operation (e.g. refunds of several slips)
-- Neither set: Cash goes to the drawer, anything else is "not placed". A correction mirrors the payment it corrects.
create function app.payment_mode_from_parts() returns trigger
language plpgsql set search_path = '' as $$
declare v text; m text;
begin
  if new.mode = 'Adjust' or new.reverses_payment_id is not null then return new; end if;
  v := nullif(current_setting('app.pay_parts', true), '');
  if v is not null then
    select app.join_modes(array_agg(app.part_mode(a.kind, x ->> 'method'))) into m
      from jsonb_array_elements(v::jsonb) x
      join public.money_accounts a on a.company_id = new.company_id and a.id = (x ->> 'account_id')::uuid;
  else
    v := nullif(current_setting('app.pay_account', true), '');
    if v is not null then
      select app.part_mode(a.kind, v::jsonb ->> 'method') into m
        from public.money_accounts a where a.company_id = new.company_id and a.id = (v::jsonb ->> 'account_id')::uuid;
    end if;
  end if;
  if v is not null then
    if m is null then raise exception 'Choose where the money went.' using errcode = '22023'; end if;
    new.mode := m;
  end if;
  return new;
end $$;

create function app.payment_place() returns trigger
language plpgsql set search_path = '' as $$
declare v text; total numeric; s numeric := sign(new.amount);
begin
  if new.mode = 'Adjust' then return null; end if;
  if new.reverses_payment_id is not null then
    insert into public.payment_parts (company_id, payment_id, account_id, amount, mode, method)
      select pp.company_id, new.id, pp.account_id, -pp.amount, pp.mode, pp.method
      from public.payment_parts pp where pp.company_id = new.company_id and pp.payment_id = new.reverses_payment_id;
    return null;
  end if;
  v := nullif(current_setting('app.pay_parts', true), '');
  if v is not null then
    perform set_config('app.pay_parts', '', true);   -- a split belongs to one payment only
    insert into public.payment_parts (company_id, payment_id, account_id, amount, mode, method)
      select new.company_id, new.id, a.id, s * round((x ->> 'amount')::numeric, 2), app.part_mode(a.kind, x ->> 'method'),
             case when a.kind in ('bank','other') then nullif(x ->> 'method', '') end
      from jsonb_array_elements(v::jsonb) x
      join public.money_accounts a on a.company_id = new.company_id and a.id = (x ->> 'account_id')::uuid;
    select coalesce(sum(amount), 0) into total from public.payment_parts where company_id = new.company_id and payment_id = new.id;
    if total <> new.amount then
      raise exception 'The accounts add up to %, but the payment is %.', abs(total), abs(new.amount) using errcode = '22023';
    end if;
    return null;
  end if;
  v := nullif(current_setting('app.pay_account', true), '');
  if v is not null then
    insert into public.payment_parts (company_id, payment_id, account_id, amount, mode, method)
      select new.company_id, new.id, a.id, new.amount, app.part_mode(a.kind, v::jsonb ->> 'method'),
             case when a.kind in ('bank','other') then nullif(v::jsonb ->> 'method', '') end
      from public.money_accounts a where a.company_id = new.company_id and a.id = (v::jsonb ->> 'account_id')::uuid;
    return null;
  end if;
  if new.mode = 'Cash' then
    insert into public.payment_parts (company_id, payment_id, account_id, amount, mode)
      select new.company_id, new.id, a.id, new.amount, 'Cash' from public.money_accounts a where a.company_id = new.company_id and a.is_drawer;
  end if;
  return null;
end $$;
create trigger payment_mode_from_parts before insert on public.payments for each row execute function app.payment_mode_from_parts();
create trigger payment_place after insert on public.payments for each row execute function app.payment_place();

-- money taken before today: cash was in the drawer
insert into public.payment_parts (company_id, payment_id, account_id, amount, mode, created_at)
  select p.company_id, p.id, a.id, p.amount, 'Cash', p.created_at
  from public.payments p join public.money_accounts a on a.company_id = p.company_id and a.is_drawer
  where p.mode = 'Cash';

-- ---------- e) running a money operation with its accounts ----------
-- p_op is one of the operations that take or give money, called with its own arguments (p_args, same names);
-- p_parts = a split for the money taken, p_account = one account for all the money in this operation.
-- Everything happens in one go: if the split doesn't add up, nothing is saved.
create function public.api_pay(p_caller uuid, p_op text, p_args jsonb, p_parts jsonb, p_account jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); boss boolean := app.has(c, 'settings');
  v_fn oid; v_args text; n int; v_res jsonb;
  methods text[] := array['UPI','IMPS','NEFT','RTGS','Cheque'];
begin
  if p_op not in ('api_create_order','api_accept_order','api_add_advance','api_finalize_order','api_record_payment',
                  'api_adjust_advance','api_refund_credit','api_delete_orders') then
    raise exception 'Unknown operation.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_args) <> 'object' or (p_args ->> 'p_caller') is distinct from p_caller::text then
    raise exception 'Wrong request.' using errcode = '22023';
  end if;
  if p_parts is not null then
    if jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) not between 1 and 8 then
      raise exception 'Choose where the money went.' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_parts) x
               where jsonb_typeof(x) <> 'object' or (x ->> 'account_id') !~ '^[0-9a-f-]{36}$'
                  or (x ->> 'amount') !~ '^[0-9]+(\.[0-9]+)?$' or (x ->> 'amount')::numeric <= 0
                  or ((x ->> 'method') is not null and (x ->> 'method') <> all (methods))) then
      raise exception 'Choose where the money went.' using errcode = '22023';
    end if;
    if (select count(distinct x ->> 'account_id') from jsonb_array_elements(p_parts) x) <> jsonb_array_length(p_parts) then
      raise exception 'The same account is in the list twice.' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(p_parts) x
               left join public.money_accounts a on a.company_id = c.company_id and a.id = (x ->> 'account_id')::uuid
               where a.id is null or a.hidden or not (a.staff_can or boss)) then
      raise exception 'That account can''t be chosen.' using errcode = '22023';
    end if;
    perform set_config('app.pay_parts', p_parts::text, true);
  end if;
  if p_account is not null then
    if jsonb_typeof(p_account) <> 'object' or (p_account ->> 'account_id') !~ '^[0-9a-f-]{36}$'
       or ((p_account ->> 'method') is not null and (p_account ->> 'method') <> all (methods))
       or not exists (select 1 from public.money_accounts a where a.company_id = c.company_id and a.id = (p_account ->> 'account_id')::uuid
                        and not a.hidden and (a.staff_can or boss)) then
      raise exception 'That account can''t be chosen.' using errcode = '22023';
    end if;
    perform set_config('app.pay_account', p_account::text, true);
  end if;

  -- call the operation with the same named arguments, each cast to its parameter's type
  select p.oid into v_fn from pg_catalog.pg_proc p join pg_catalog.pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = p_op;
  select string_agg(format('%I => %s', a.key,
           case when a.value = 'null'::jsonb then 'NULL::' || pg_catalog.format_type(t.typ, null)
                when pg_catalog.format_type(t.typ, null) = 'jsonb' then pg_catalog.quote_literal(a.value::text) || '::jsonb'
                when pg_catalog.format_type(t.typ, null) = 'uuid[]' then
                  pg_catalog.quote_literal((select coalesce(array_agg(e), '{}') from jsonb_array_elements_text(a.value) e)::text) || '::uuid[]'
                else pg_catalog.quote_literal(a.value #>> '{}') || '::' || pg_catalog.format_type(t.typ, null) end), ', '),
         count(*)
    into v_args, n
    from jsonb_each(p_args) a
    join (select unnest(p.proargnames) nm, unnest(p.proargtypes::oid[]) typ from pg_catalog.pg_proc p where p.oid = v_fn) t on t.nm = a.key;
  if n is distinct from (select count(*) from jsonb_object_keys(p_args)) then
    raise exception 'Wrong request.' using errcode = '22023';
  end if;
  execute format('select public.%I(%s)', p_op, v_args) into v_res;
  perform set_config('app.pay_parts', '', true);
  perform set_config('app.pay_account', '', true);
  return v_res;
end $$;

-- ---------- f) the list, for choosing (anyone who takes money) and for Settings (owners) ----------
create function public.api_accounts(p_caller uuid, p_all boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); boss boolean := app.has(c, 'settings');
begin
  perform app.require(c, 'money');
  if p_all then perform app.require(c, 'settings'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'owner', a.owner,
      'number', case when boss then a.number end, 'staff_can', a.staff_can, 'position', a.position, 'hidden', a.hidden,
      'is_drawer', a.is_drawer, 'usable', not a.hidden and (a.staff_can or boss),
      'used', exists (select 1 from public.payment_parts pp where pp.company_id = a.company_id and pp.account_id = a.id))
      order by a.is_drawer desc, a.position, a.created_at)
    from public.money_accounts a where a.company_id = c.company_id and (p_all or (not a.hidden and (a.staff_can or boss)))), '[]'::jsonb);
end $$;

create function public.api_save_account(p_caller uuid, p_key uuid, p_hash text, p_account jsonb) returns jsonb
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
    v_kind := 'cash';                      -- the drawer stays the drawer
  elsif v_kind not in ('bank','upi','paytm','wallet','other') then
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

-- new order of the list (ids in the order shown; the drawer always stays first)
create function public.api_order_accounts(p_caller uuid, p_key uuid, p_hash text, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb;
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'orderAccounts', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.money_accounts a set position = o.n
    from unnest(p_ids) with ordinality o(id, n)
    where a.company_id = c.company_id and a.id = o.id and not a.is_drawer and a.position <> o.n;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('ok', true));
end $$;

-- tick (or untick) an account as checked for a shop day
create function public.api_check_account(p_caller uuid, p_key uuid, p_hash text, p_account uuid, p_day date, p_checked boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; tz text;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'checkAccount', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select timezone into tz from public.companies where id = c.company_id;
  if p_day is null or p_day > (now() at time zone tz)::date then raise exception 'Choose the day.' using errcode = '22023'; end if;
  if not exists (select 1 from public.money_accounts where company_id = c.company_id and id = p_account) then
    raise exception 'Account not found.' using errcode = '22023';
  end if;
  if p_checked then
    insert into public.account_checks (company_id, account_id, day, checked_by) values (c.company_id, p_account, p_day, c.id)
      on conflict (company_id, account_id, day) do nothing;
  else
    delete from public.account_checks where company_id = c.company_id and account_id = p_account and day = p_day;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('account_id', p_account, 'day', p_day, 'checked', p_checked));
end $$;

-- one shop day, account by account (owners): the accounts, every part placed that day, the ticks
create function public.api_day_accounts(p_caller uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; v_tz text; v_s timestamptz; v_e timestamptz; v_day date;
begin
  perform app.require(c, 'money', 'settings');
  k := app.has(c, 'kacha');
  select timezone into v_tz from public.companies where id = c.company_id;
  v_day := coalesce(p_day, (now() at time zone v_tz)::date);
  v_s := v_day::timestamp at time zone v_tz;
  v_e := (v_day + 1)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'day', v_day,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'owner', a.owner,
        'hidden', a.hidden, 'is_drawer', a.is_drawer) order by a.is_drawer desc, a.position, a.created_at)
      from public.money_accounts a where a.company_id = c.company_id), '[]'::jsonb),
    'parts', coalesce((select jsonb_agg(jsonb_build_object('account_id', pp.account_id, 'amount', pp.amount, 'mode', pp.mode,
        'method', pp.method, 'payment_id', p.id, 'kind', coalesce(r.kind, p.kind), 'rev', p.reverses_payment_id is not null,
        'customer', cu.name, 'slip_no', o.slip_no, 'order_id', p.order_id, 'at', p.received_at) order by p.received_at)
      from public.payment_parts pp
      join public.payments p on p.company_id = pp.company_id and p.id = pp.payment_id
      join public.customers cu on cu.company_id = p.company_id and cu.id = p.customer_id
      left join public.payments r on r.id = p.reverses_payment_id
      left join public.orders o on o.company_id = p.company_id and o.id = p.order_id
      where pp.company_id = c.company_id and p.received_at >= v_s and p.received_at < v_e
        and (k or (coalesce(p.side, 'pakka') = 'pakka' and o.bill_type is distinct from 'kacha'))), '[]'::jsonb),
    'checks', coalesce((select jsonb_agg(ac.account_id) from public.account_checks ac
      where ac.company_id = c.company_id and ac.day = v_day), '[]'::jsonb));
end $$;

-- ---------- g) the cash drawer only expects the cash part of each payment ----------
create or replace function public.api_save_cash_count(p_caller uuid, p_key uuid, p_hash text, p_counted numeric, p_note text) returns jsonb
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
  select coalesce(sum(case when exists (select 1 from public.payment_parts pp where pp.company_id = p.company_id and pp.payment_id = p.id)
                           then (select coalesce(sum(pp.amount), 0) from public.payment_parts pp
                                  where pp.company_id = p.company_id and pp.payment_id = p.id and pp.mode = 'Cash')
                           when p.mode = 'Cash' then p.amount else 0 end), 0)
    into expected from public.payments p
    where p.company_id = c.company_id and (p.received_at at time zone tz)::date = d;
  insert into public.cash_closes (company_id, business_date, expected_cash, counted_cash, note, closed_by)
    values (c.company_id, d, expected, p_counted, nullif(btrim(p_note), ''), c.id);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('business_date', d, 'expected', expected, 'counted', p_counted, 'difference', p_counted - expected));
end $$;


-- ---------- h) the evening summary gets each payment's parts (a split counts in each of its modes) ----------
create or replace function public.api_day_data(p_caller uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; v_tz text; v_s timestamptz; v_e timestamptz; v_day date;
begin
  perform app.require(c, 'money');
  k := app.has(c, 'kacha');
  select timezone into v_tz from public.companies where id = c.company_id;
  v_day := coalesce(p_day, (now() at time zone v_tz)::date);   -- no day = today in the shop's calendar
  v_s := v_day::timestamp at time zone v_tz;
  v_e := (v_day + 1)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'timezone', v_tz, 'day', v_day,
    'today', (now() at time zone v_tz)::date,
    'shop', (select coalesce(nullif(st.slip_header ->> 'name', ''), co.name) from public.companies co
               join public.company_settings st on st.company_id = co.id where co.id = c.company_id),
    'settings', (select jsonb_build_object('weight_warn_pct', weight_warn_pct, 'min_inch', min_inch)
                 from public.company_settings where company_id = c.company_id),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'slip_no', o.slip_no, 'customer', cu.name, 'bill', o.bill_type, 'total', o.total_amount,
        'weight', o.total_weight, 'in_khata', o.in_khata, 'by', pc.display_name, 'done_at', o.done_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'grade', i.grade_code, 'rate', i.sell_rate, 'special', i.special_rate,
            'std_rate', (select r.sell_rate from public.material_rates r
                          where r.company_id = i.company_id and r.material_id = i.material_id and r.effective_from <= o.created_at
                          order by r.effective_from desc limit 1)) order by i.position)
          from public.order_items i where i.company_id = o.company_id and i.order_id = o.id), '[]'::jsonb),
        'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'kind', coalesce(r.kind, p.kind),
            'rev', p.reverses_payment_id is not null, 'mode', p.mode,
            'parts', (select jsonb_agg(jsonb_build_object('mode', pp.mode, 'amount', pp.amount, 'account_id', pp.account_id)) from public.payment_parts pp where pp.company_id = p.company_id and pp.payment_id = p.id)))
          from public.payments p left join public.payments r on r.id = p.reverses_payment_id
          where p.company_id = o.company_id and p.order_id = o.id), '[]'::jsonb)) order by o.done_at)
      from public.orders o
      join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      left join public.people pc on pc.company_id = o.company_id and pc.id = o.created_by
      where o.company_id = c.company_id and o.status = 'done' and o.done_at >= v_s and o.done_at < v_e
        and (k or o.bill_type is distinct from 'kacha')), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'amount', p.amount, 'kind', coalesce(r.kind, p.kind),
        'rev', p.reverses_payment_id is not null, 'mode', p.mode, 'customer', cu.name, 'order_id', p.order_id, 'at', p.received_at,
        'parts', (select jsonb_agg(jsonb_build_object('mode', pp.mode, 'amount', pp.amount, 'account_id', pp.account_id)) from public.payment_parts pp where pp.company_id = p.company_id and pp.payment_id = p.id))
        order by p.received_at)
      from public.payments p
      join public.customers cu on cu.company_id = p.company_id and cu.id = p.customer_id
      left join public.payments r on r.id = p.reverses_payment_id
      left join public.orders o on o.company_id = p.company_id and o.id = p.order_id
      where p.company_id = c.company_id and p.received_at >= v_s and p.received_at < v_e
        and (k or (coalesce(p.side, 'pakka') = 'pakka' and o.bill_type is distinct from 'kacha'))), '[]'::jsonb),
    'cash_close', case when k then (select jsonb_build_object('expected', cc.expected_cash, 'counted', cc.counted_cash,
        'at', cc.closed_at, 'by', pe.display_name)
      from public.cash_closes cc left join public.people pe on pe.company_id = cc.company_id and pe.id = cc.closed_by
      where cc.company_id = c.company_id and cc.business_date = v_day order by cc.closed_at desc limit 1) end,
    'weighed', coalesce((select jsonb_agg(jsonb_build_object('slip_no', o.slip_no, 'grade', i.grade_code, 'shape', i.shape,
        'unit', i.unit, 'dims', i.dims, 'density', i.density, 'actual', i.actual_weight, 'min_inch', o.pricing_rules -> 'min_inch',
        'lengths', coalesce((select jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs, 'cuts', l.cuts) order by l.position)
          from public.order_item_lengths l where l.company_id = i.company_id and l.order_item_id = i.id), '[]'::jsonb)))
      from public.order_items i join public.orders o on o.company_id = i.company_id and o.id = i.order_id
      where i.company_id = c.company_id and i.actual_weight is not null and o.weighed_at >= v_s and o.weighed_at < v_e
        and (k or o.bill_type is distinct from 'kacha')), '[]'::jsonb),
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('slip_no', o.slip_no, 'customer', cu.name, 'weighed_at', o.weighed_at))
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.status = 'weighed' and o.weighed_at < v_s), '[]'::jsonb),
    'cancelled', coalesce((select jsonb_agg(jsonb_build_object('slip_no', o.slip_no, 'customer', cu.name, 'reason', o.cancel_reason))
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.status = 'cancelled' and o.cancelled_at >= v_s and o.cancelled_at < v_e), '[]'::jsonb),
    'last_week', (select jsonb_build_object('total', coalesce(sum(o.total_amount), 0), 'n', count(*))
      from public.orders o where o.company_id = c.company_id and o.status = 'done'
        and o.done_at >= v_s - interval '7 days' and o.done_at < v_e - interval '7 days'
        and (k or o.bill_type is distinct from 'kacha'))
  );
end $$;

revoke all on function public.api_pay(uuid, text, jsonb, jsonb, jsonb), public.api_accounts(uuid, boolean),
  public.api_save_account(uuid, uuid, text, jsonb), public.api_order_accounts(uuid, uuid, text, uuid[]),
  public.api_check_account(uuid, uuid, text, uuid, date, boolean), public.api_day_accounts(uuid, date),
  public.api_save_cash_count(uuid, uuid, text, numeric, text), public.api_day_data(uuid, date) from public, anon, authenticated;
grant execute on function public.api_pay(uuid, text, jsonb, jsonb, jsonb), public.api_accounts(uuid, boolean),
  public.api_save_account(uuid, uuid, text, jsonb), public.api_order_accounts(uuid, uuid, text, uuid[]),
  public.api_check_account(uuid, uuid, text, uuid, date, boolean), public.api_day_accounts(uuid, date),
  public.api_save_cash_count(uuid, uuid, text, numeric, text), public.api_day_data(uuid, date) to service_role;
revoke all on function app.add_cash_drawer(), app.payment_mode_from_parts(), app.payment_place() from public;
