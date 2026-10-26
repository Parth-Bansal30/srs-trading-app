-- 25 Oct 2026 — bank statement → khata.
-- The owner uploads a bank account's statement (read on the phone by @srs/core). Each line is kept once per account (by its
-- mark), and each is approved by the owner: ADDED as a payment / money given back / an expense / money moved — on the
-- bank's date, into that bank account — or LINKED to an entry already in the app, or SKIPPED (not shop money). Payers are
-- remembered ("SHARMA ENGG" → Sharma Engineering) so next month's statement fills itself in. Owners only (settings + money).

-- ---------- a) tables ----------
create table public.bank_imports (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  account_id  uuid not null,
  file_name   text check (file_name is null or length(file_name) <= 200),
  day_from    date,
  day_to      date,
  opening     numeric(14,2),
  closing     numeric(14,2),
  adds_up     boolean not null default false,
  lines_new   integer not null default 0,
  lines_seen  integer not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, account_id) references public.money_accounts(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id)
);

create table public.bank_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete restrict,
  account_id   uuid not null,
  import_id    uuid not null,
  day          date not null,
  amount       numeric(14,2) not null check (amount <> 0),          -- + money in, − money out
  narration    text not null default '' check (length(narration) <= 500),
  ref          text check (ref is null or length(ref) <= 60),
  balance      numeric(14,2),
  fingerprint  text not null check (length(fingerprint) between 10 and 300),
  status       text not null default 'open' check (status in ('open','added','linked','skipped')),
  payment_id   uuid,
  expense_id   uuid,
  transfer_id  uuid,
  note         text check (note is null or length(note) <= 300),
  done_by      uuid,
  done_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, account_id, fingerprint),                     -- the same statement twice adds nothing twice
  foreign key (company_id, account_id) references public.money_accounts(company_id, id),
  foreign key (company_id, import_id) references public.bank_imports(company_id, id),
  foreign key (company_id, payment_id) references public.payments(company_id, id),
  foreign key (company_id, expense_id) references public.expenses(company_id, id),
  foreign key (company_id, transfer_id) references public.money_transfers(company_id, id),
  foreign key (company_id, done_by) references public.people(company_id, id),
  constraint bank_lines_done_has_link check (
    (status = 'open' and payment_id is null and expense_id is null and transfer_id is null)
    or status = 'skipped'
    or (status in ('added','linked') and num_nonnulls(payment_id, expense_id, transfer_id) = 1))
);
create index bank_lines_account_idx on public.bank_lines (company_id, account_id, status, day);
create index bank_lines_import_idx on public.bank_lines (company_id, import_id);
-- an entry in the app belongs to one bank line only
create unique index bank_lines_payment_once on public.bank_lines (company_id, payment_id) where payment_id is not null;
create unique index bank_lines_expense_once on public.bank_lines (company_id, expense_id) where expense_id is not null;
create unique index bank_lines_transfer_once on public.bank_lines (company_id, transfer_id) where transfer_id is not null;

create table public.bank_payers (
  company_id   uuid not null references public.companies(id) on delete cascade,
  key          text not null check (key ~ '^(upi|ph|name):.' and length(key) <= 120),
  action       text not null check (action in ('payment','refund','expense','supplier','move','skip')),
  customer_id  uuid,
  supplier_id  uuid,
  category     text check (category is null or category ~ '^[a-z][a-z_]{1,19}$'),
  to_account   uuid,
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  primary key (company_id, key),
  foreign key (company_id, customer_id) references public.customers(company_id, id) on delete cascade,
  foreign key (company_id, supplier_id) references public.suppliers(company_id, id) on delete cascade,
  foreign key (company_id, to_account) references public.money_accounts(company_id, id)
);

alter table public.bank_imports enable row level security;   -- backend only (owners, through the api)
alter table public.bank_lines enable row level security;
alter table public.bank_payers enable row level security;
revoke all on public.bank_imports, public.bank_lines, public.bank_payers from anon, authenticated;
create trigger audit after insert or update or delete on public.bank_lines for each row execute function app.audit_row();
create trigger audit after insert or update or delete on public.bank_payers for each row execute function app.audit_row();

-- ---------- b) keep a statement's lines ----------
-- p: { account_id, file_name, from, to, opening, closing, adds_up, lines: [{ day, amount, narration, ref, balance, fingerprint }] }
create function public.api_bank_save(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; a public.money_accounts; imp uuid; n_new int := 0; n_all int; x jsonb; tz text;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'bankSave', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into a from public.money_accounts where company_id = c.company_id and id = nullif(p ->> 'account_id', '')::uuid;
  if a.id is null then raise exception 'Choose the bank account.' using errcode = '22023'; end if;
  if a.is_drawer then raise exception 'A bank statement goes into a bank account, not the cash drawer.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  if jsonb_typeof(p -> 'lines') <> 'array' then raise exception 'No lines in the statement.' using errcode = '22023'; end if;
  n_all := jsonb_array_length(p -> 'lines');
  if n_all = 0 then raise exception 'No lines in the statement.' using errcode = '22023'; end if;
  if n_all > 3000 then raise exception 'Too many lines at once (up to 3000) — upload one month at a time.' using errcode = '22023'; end if;
  insert into public.bank_imports (company_id, account_id, file_name, day_from, day_to, opening, closing, adds_up, created_by)
    values (c.company_id, a.id, left(nullif(btrim(p ->> 'file_name'), ''), 200), nullif(p ->> 'from', '')::date, nullif(p ->> 'to', '')::date,
            nullif(p ->> 'opening', '')::numeric, nullif(p ->> 'closing', '')::numeric, coalesce((p ->> 'adds_up')::boolean, false), c.id)
    returning id into imp;
  for x in select * from jsonb_array_elements(p -> 'lines') loop
    if nullif(x ->> 'day', '') is null or coalesce((x ->> 'amount')::numeric, 0) = 0 then
      raise exception 'A line without a date or an amount.' using errcode = '22023';
    end if;
    if (x ->> 'day')::date > (now() at time zone tz)::date + 1 then raise exception 'A line is dated in the future.' using errcode = '22023'; end if;
    insert into public.bank_lines (company_id, account_id, import_id, day, amount, narration, ref, balance, fingerprint)
      values (c.company_id, a.id, imp, (x ->> 'day')::date, round((x ->> 'amount')::numeric, 2), left(coalesce(x ->> 'narration', ''), 500),
              left(nullif(btrim(x ->> 'ref'), ''), 60), nullif(x ->> 'balance', '')::numeric, left(x ->> 'fingerprint', 300))
      on conflict (company_id, account_id, fingerprint) do nothing;
    if found then n_new := n_new + 1; end if;
  end loop;
  update public.bank_imports set lines_new = n_new, lines_seen = n_all - n_new where id = imp;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('import_id', imp, 'new', n_new, 'seen', n_all - n_new));
end $$;

-- ---------- c) everything the review screen needs (the matching is done by @srs/core in the api) ----------
create function public.api_bank_data(p_caller uuid, p_account uuid, p_import uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); a public.money_accounts; im public.bank_imports; tz text; d1 date; d2 date;
begin
  perform app.require(c, 'settings', 'money');
  select * into a from public.money_accounts where company_id = c.company_id and id = p_account;
  if a.id is null then raise exception 'Choose the bank account.' using errcode = '22023'; end if;
  select * into im from public.bank_imports where company_id = c.company_id and id = p_import and account_id = a.id;
  select timezone into tz from public.companies where id = c.company_id;
  select min(day), max(day) into d1, d2 from public.bank_lines
    where company_id = c.company_id and account_id = a.id and (im.id is null and status = 'open' or import_id = im.id);
  d1 := coalesce(d1, (now() at time zone tz)::date) - 7; d2 := coalesce(d2, (now() at time zone tz)::date) + 7;
  return jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'number', a.number),
    'import', case when im.id is null then null else jsonb_build_object('id', im.id, 'file_name', im.file_name, 'from', im.day_from, 'to', im.day_to,
        'opening', im.opening, 'closing', im.closing, 'adds_up', im.adds_up, 'new', im.lines_new, 'seen', im.lines_seen, 'at', im.created_at) end,
    -- what the app says is in this account at the end of the statement's last day
    'app_balance', case when im.day_to is null then null else app.account_balance(c.company_id, a.id, ((im.day_to + 1)::timestamp at time zone tz) - interval '1 microsecond') end,
    'drawer', (select id from public.money_accounts where company_id = c.company_id and is_drawer),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'day', l.day, 'amount', l.amount, 'narration', l.narration, 'ref', l.ref,
        'balance', l.balance, 'status', l.status, 'payment_id', l.payment_id, 'expense_id', l.expense_id, 'transfer_id', l.transfer_id,
        'note', l.note, 'import_id', l.import_id) order by l.day, l.created_at, l.id)
      from public.bank_lines l where l.company_id = c.company_id and l.account_id = a.id
        and (im.id is null and l.status = 'open' or l.import_id = im.id)), '[]'::jsonb),
    -- the app's own entries in this account around those days (a cancelled payment and its cancellation are left out)
    'moves', coalesce((select jsonb_agg(m) from (
        select jsonb_build_object('src', 'payment', 'ref', p.id, 'amount', pp.amount, 'day', (p.received_at at time zone tz)::date,
                 'label', cu.name, 'kind', p.kind, 'linked', exists (select 1 from public.bank_lines b where b.company_id = c.company_id and b.payment_id = p.id)) m
          from public.payment_parts pp join public.payments p on p.company_id = pp.company_id and p.id = pp.payment_id
          left join public.customers cu on cu.company_id = p.company_id and cu.id = p.customer_id
          where pp.company_id = c.company_id and pp.account_id = a.id
            and (p.received_at at time zone tz)::date between d1 and d2
            and p.reverses_payment_id is null
            and not exists (select 1 from public.payments r where r.company_id = p.company_id and r.reverses_payment_id = p.id)
        union all
        select jsonb_build_object('src', 'expense', 'ref', e.id, 'amount', -e.amount, 'day', e.business_date, 'label', coalesce(e.paid_to, e.category),
                 'kind', e.kind, 'linked', exists (select 1 from public.bank_lines b where b.company_id = c.company_id and b.expense_id = e.id))
          from public.expenses e where e.company_id = c.company_id and e.account_id = a.id and e.status = 'ok' and e.business_date between d1 and d2
        union all
        select jsonb_build_object('src', 'transfer_out', 'ref', t.id, 'amount', -t.amount, 'day', t.business_date, 'label', ta.name, 'kind', t.reason,
                 'linked', exists (select 1 from public.bank_lines b where b.company_id = c.company_id and b.transfer_id = t.id))
          from public.money_transfers t join public.money_accounts ta on ta.company_id = t.company_id and ta.id = t.to_account
          where t.company_id = c.company_id and t.from_account = a.id and t.status = 'ok' and t.business_date between d1 and d2
        union all
        select jsonb_build_object('src', 'transfer_in', 'ref', t.id, 'amount', t.amount, 'day', t.business_date, 'label', fa.name, 'kind', t.reason,
                 'linked', exists (select 1 from public.bank_lines b where b.company_id = c.company_id and b.transfer_id = t.id))
          from public.money_transfers t join public.money_accounts fa on fa.company_id = t.company_id and fa.id = t.from_account
          where t.company_id = c.company_id and t.to_account = a.id and t.status = 'ok' and t.business_date between d1 and d2) x), '[]'::jsonb),
    'payers', coalesce((select jsonb_object_agg(key, jsonb_build_object('action', action, 'customer_id', customer_id, 'supplier_id', supplier_id,
        'category', category, 'to', to_account)) from public.bank_payers where company_id = c.company_id), '{}'::jsonb),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
      from public.suppliers s where s.company_id = c.company_id), '[]'::jsonb),
    'imports', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'file_name', i.file_name, 'from', i.day_from, 'to', i.day_to,
        'new', i.lines_new, 'at', i.created_at,
        'open', (select count(*) from public.bank_lines b where b.company_id = c.company_id and b.import_id = i.id and b.status = 'open'))
        order by i.created_at desc) from (select * from public.bank_imports where company_id = c.company_id and account_id = a.id
        order by created_at desc limit 12) i), '[]'::jsonb));
end $$;

-- ---------- d) one line: added, linked or skipped ----------
create function app.bank_line_for(c public.people, p_line uuid) returns public.bank_lines
language plpgsql security definer set search_path = '' as $$
declare l public.bank_lines;
begin
  select * into l from public.bank_lines where company_id = c.company_id and id = p_line for update;
  if l.id is null then raise exception 'That bank line was not found.' using errcode = '22023'; end if;
  return l;
end $$;

create function app.bank_remember(c public.people, p_line public.bank_lines, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p is null or jsonb_typeof(p) <> 'object' or nullif(p ->> 'key', '') is null then return; end if;
  insert into public.bank_payers (company_id, key, action, customer_id, supplier_id, category, to_account, updated_by)
    values (c.company_id, left(p ->> 'key', 120), p ->> 'action', nullif(p ->> 'customer_id', '')::uuid, nullif(p ->> 'supplier_id', '')::uuid,
            nullif(p ->> 'category', ''), nullif(p ->> 'to', '')::uuid, c.id)
    on conflict (company_id, key) do update set action = excluded.action, customer_id = excluded.customer_id, supplier_id = excluded.supplier_id,
      category = excluded.category, to_account = excluded.to_account, updated_by = c.id, updated_at = now();
end $$;

-- Add a line as a new entry, on the bank's date (12 noon in the shop's time), into the statement's account.
-- p_op: api_record_payment | api_refund_credit (p_args = that operation's arguments; the money is placed in the account)
--       api_save_expense | api_save_transfer (p_args = its p; the account, amount and date come from the line)
create function public.api_bank_run(p_caller uuid, p_key uuid, p_hash text, p_line uuid, p_op text, p_args jsonb, p_method text, p_remember jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; l public.bank_lines; tz text; v_at timestamptz; inner_key uuid; v_res jsonb; v_args jsonb;
  pid uuid; eid uuid; tid uuid; drawer uuid;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'bankRun', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  l := app.bank_line_for(c, p_line);
  if l.status <> 'open' then raise exception 'This bank line is already done.' using errcode = '23001'; end if;
  if p_method is not null and p_method not in ('UPI','IMPS','NEFT','RTGS','Cheque') then raise exception 'Choose how the money came.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  v_at := app.entry_time(least((l.day::timestamp + interval '12 hours') at time zone tz, now()), 400);   -- today's line: now
  inner_key := md5(p_key::text || ':bank')::uuid;   -- the operation's own request key, the same on a retry
  if p_op in ('api_record_payment', 'api_refund_credit') then
    if jsonb_typeof(p_args) <> 'object' then raise exception 'Wrong request.' using errcode = '22023'; end if;
    if p_op = 'api_record_payment' and (l.amount <= 0 or round((p_args ->> 'p_amount')::numeric, 2) <> l.amount) then
      raise exception 'The payment must be the bank line''s amount (money in).' using errcode = '22023';
    end if;
    if p_op = 'api_refund_credit' and (l.amount >= 0 or round((p_args ->> 'p_amount')::numeric, 2) <> -l.amount) then
      raise exception 'Money given back must be the bank line''s amount (money out).' using errcode = '22023';
    end if;
    v_args := p_args || jsonb_build_object('p_caller', p_caller, 'p_key', inner_key, 'p_hash', p_hash);
    perform set_config('app.at', v_at::text, true);
    v_res := public.api_pay(p_caller, p_op, v_args, null, jsonb_build_object('account_id', l.account_id, 'method', p_method));
    perform set_config('app.at', '', true);
    pid := nullif(v_res ->> 'payment_id', '')::uuid;
    if pid is null then raise exception 'The payment could not be saved.' using errcode = '22023'; end if;
  elsif p_op = 'api_save_expense' then
    if l.amount >= 0 then raise exception 'An expense is money going out.' using errcode = '22023'; end if;
    v_res := public.api_save_expense(p_caller, inner_key, p_hash, coalesce(p_args, '{}'::jsonb) || jsonb_build_object(
      'amount', -l.amount, 'account_id', l.account_id, 'method', p_method, 'at', v_at, 'offline', false, 'replaces_id', null));
    eid := nullif(v_res ->> 'expense_id', '')::uuid;
  elsif p_op = 'api_save_transfer' then
    select id into drawer from public.money_accounts where company_id = c.company_id and is_drawer;
    v_res := public.api_save_transfer(p_caller, inner_key, p_hash, coalesce(p_args, '{}'::jsonb) || jsonb_build_object(
      'amount', abs(l.amount), 'method', p_method, 'at', v_at, 'offline', false,
      'from_account', case when l.amount < 0 then l.account_id else coalesce(nullif(p_args ->> 'other', '')::uuid, drawer) end,
      'to_account', case when l.amount < 0 then coalesce(nullif(p_args ->> 'other', '')::uuid, drawer) else l.account_id end,
      'reason', case when l.amount < 0 then 'withdraw' else 'deposit' end));
    tid := nullif(v_res ->> 'transfer_id', '')::uuid;
  else
    raise exception 'Unknown operation.' using errcode = '22023';
  end if;
  update public.bank_lines set status = 'added', payment_id = pid, expense_id = eid, transfer_id = tid, done_by = c.id, done_at = now()
    where id = l.id;
  perform app.bank_remember(c, l, p_remember);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('line_id', l.id, 'status', 'added', 'payment_id', pid, 'expense_id', eid, 'transfer_id', tid));
end $$;

-- Link a line to an entry already in the app (same account, same amount; not linked to another line).
create function public.api_bank_link(p_caller uuid, p_key uuid, p_hash text, p_line uuid, p_src text, p_ref uuid, p_remember jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; l public.bank_lines; amt numeric;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'bankLink', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  l := app.bank_line_for(c, p_line);
  if l.status <> 'open' then raise exception 'This bank line is already done.' using errcode = '23001'; end if;
  if p_src = 'payment' then
    select sum(pp.amount) into amt from public.payment_parts pp where pp.company_id = c.company_id and pp.payment_id = p_ref and pp.account_id = l.account_id;
  elsif p_src = 'expense' then
    select -e.amount into amt from public.expenses e where e.company_id = c.company_id and e.id = p_ref and e.account_id = l.account_id and e.status = 'ok';
  elsif p_src in ('transfer_in', 'transfer_out') then
    select case when t.to_account = l.account_id then t.amount when t.from_account = l.account_id then -t.amount end into amt
      from public.money_transfers t where t.company_id = c.company_id and t.id = p_ref and t.status = 'ok';
  else
    raise exception 'Unknown entry.' using errcode = '22023';
  end if;
  if amt is null then raise exception 'That entry is not in this account.' using errcode = '22023'; end if;
  if abs(amt - l.amount) > 0.5 then raise exception 'The amounts are different.' using errcode = '22023'; end if;
  update public.bank_lines set status = 'linked', done_by = c.id, done_at = now(),
      payment_id = case when p_src = 'payment' then p_ref end, expense_id = case when p_src = 'expense' then p_ref end,
      transfer_id = case when p_src like 'transfer%' then p_ref end
    where id = l.id;
  perform app.bank_remember(c, l, p_remember);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('line_id', l.id, 'status', 'linked'));
end $$;

-- Skip a line (not shop money / already handled another way), or open a skipped line again.
create function public.api_bank_mark(p_caller uuid, p_key uuid, p_hash text, p_line uuid, p_status text, p_note text, p_remember jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; l public.bank_lines;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'bankMark', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  l := app.bank_line_for(c, p_line);
  if p_status = 'skipped' then
    if l.status <> 'open' then raise exception 'This bank line is already done.' using errcode = '23001'; end if;
    update public.bank_lines set status = 'skipped', note = left(nullif(btrim(p_note), ''), 300), done_by = c.id, done_at = now() where id = l.id;
    perform app.bank_remember(c, l, p_remember);
  elsif p_status = 'open' then
    if l.status not in ('skipped', 'linked') then raise exception 'Only a skipped or linked line can be opened again (an added entry is cancelled from its own screen).' using errcode = '23001'; end if;
    update public.bank_lines set status = 'open', note = null, payment_id = null, expense_id = null, transfer_id = null, done_by = c.id, done_at = now() where id = l.id;
  else
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('line_id', l.id, 'status', p_status));
end $$;

-- "Balances out": the statement's closing balance becomes the account's balance point at the end of its last day (a passbook
-- point, like typing it in Money accounts — but on the statement's date, so later entries still count after it).
create function public.api_bank_balance(p_caller uuid, p_key uuid, p_hash text, p_import uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; im public.bank_imports; tz text; v_at timestamptz; v_exp jsonb; bid uuid;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'bankBalance', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into im from public.bank_imports where company_id = c.company_id and id = p_import;
  if im.id is null then raise exception 'That statement was not found.' using errcode = '22023'; end if;
  if im.closing is null or im.day_to is null then raise exception 'This statement has no closing balance.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  v_at := least(((im.day_to + 1)::timestamp at time zone tz) - interval '1 second', now());
  v_exp := app.account_balance(c.company_id, im.account_id, v_at);
  insert into public.account_balances (company_id, account_id, at, balance, expected, source, note, created_by)
    values (c.company_id, im.account_id, v_at, im.closing, (v_exp ->> 'balance')::numeric, 'passbook',
            left('Bank statement ' || coalesce(im.file_name, '') || ' — closing balance', 300), c.id)
    returning id into bid;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('balance_id', bid, 'balance', im.closing, 'expected', (v_exp ->> 'balance')::numeric, 'at', v_at));
end $$;

revoke all on function public.api_bank_save(uuid, uuid, text, jsonb), public.api_bank_data(uuid, uuid, uuid),
  public.api_bank_run(uuid, uuid, text, uuid, text, jsonb, text, jsonb), public.api_bank_link(uuid, uuid, text, uuid, text, uuid, jsonb),
  public.api_bank_mark(uuid, uuid, text, uuid, text, text, jsonb), public.api_bank_balance(uuid, uuid, text, uuid), app.bank_line_for(public.people, uuid),
  app.bank_remember(public.people, public.bank_lines, jsonb) from public, anon, authenticated;
grant execute on function public.api_bank_save(uuid, uuid, text, jsonb), public.api_bank_data(uuid, uuid, uuid),
  public.api_bank_run(uuid, uuid, text, uuid, text, jsonb, text, jsonb), public.api_bank_link(uuid, uuid, text, uuid, text, uuid, jsonb),
  public.api_bank_mark(uuid, uuid, text, uuid, text, text, jsonb), public.api_bank_balance(uuid, uuid, text, uuid) to service_role;
