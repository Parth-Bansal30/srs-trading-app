-- Bank statements, 3 Nov 2026 (a real 6-month YES Bank PDF tried by the owner):
-- a) The same entry is never saved twice, even when the next statement covers the same days AND is another kind of file
--    (August–September as a PDF, then September–October as Excel: the text of each entry differs, so the old "same text"
--    mark missed them and September was added again). A running balance after every entry makes day + amount + balance
--    one entry; they are counted, so two equal entries on one day both stay.
-- b) Entries from before the shop started the app are kept but skipped ("Before the app was started") — they are already
--    in the opening balances; nothing old is added to a khata by mistake. (Open one again by hand if it is really needed.)
-- c) A customer's UPI payment written in "Shop UPI" (or Paytm / a wallet) is found in the bank statement, because UPI money
--    lands in the bank. Ticking it moves that money from Shop UPI into the bank (one transfer on the bank's date), so both
--    balances stay right. Opening the line again cancels that transfer.

alter table public.bank_imports add column lines_old int not null default 0;
alter table public.bank_lines add column settle_id uuid;
alter table public.bank_lines add constraint bank_lines_settle_fk foreign key (company_id, settle_id) references public.money_transfers(company_id, id);
create unique index bank_lines_settle_once on public.bank_lines (company_id, settle_id) where settle_id is not null;

-- ---------- a) + b) keep a statement's lines ----------
create or replace function public.api_bank_save(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; a public.money_accounts; imp uuid; n_new int := 0; n_old int := 0; n_all int; x jsonb;
  tz text; v_start date; v_day date; v_amt numeric; v_bal numeric; k text; here jsonb := '{}'::jsonb; n_here int; n_have int; v_old boolean;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'bankSave', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into a from public.money_accounts where company_id = c.company_id and id = nullif(p ->> 'account_id', '')::uuid;
  if a.id is null then raise exception 'Choose the bank account.' using errcode = '22023'; end if;
  if a.is_drawer then raise exception 'A bank statement goes into a bank account, not the cash drawer.' using errcode = '22023'; end if;
  select co.timezone, (co.created_at at time zone co.timezone)::date into tz, v_start from public.companies co where co.id = c.company_id;
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
    v_day := (x ->> 'day')::date; v_amt := round((x ->> 'amount')::numeric, 2); v_bal := round(nullif(x ->> 'balance', '')::numeric, 2);
    if v_day > (now() at time zone tz)::date + 1 then raise exception 'A line is dated in the future.' using errcode = '22023'; end if;
    -- a) already saved from an earlier statement of this account (any kind of file)
    if v_bal is not null then
      k := v_day::text || '|' || v_amt::text || '|' || v_bal::text;
      n_here := coalesce((here ->> k)::int, 0) + 1;
      here := here || jsonb_build_object(k, n_here);
      select count(*) into n_have from public.bank_lines b
        where b.company_id = c.company_id and b.account_id = a.id and b.day = v_day and b.amount = v_amt and b.balance = v_bal and b.import_id <> imp;
      continue when n_here <= n_have;
    end if;
    v_old := v_start is not null and v_day < v_start;
    insert into public.bank_lines (company_id, account_id, import_id, day, amount, narration, ref, balance, fingerprint, status, note, done_by, done_at)
      values (c.company_id, a.id, imp, v_day, v_amt, left(coalesce(x ->> 'narration', ''), 500),
              left(nullif(btrim(x ->> 'ref'), ''), 60), v_bal, left(x ->> 'fingerprint', 300),
              case when v_old then 'skipped' else 'open' end, case when v_old then 'Before the app was started' end,
              case when v_old then c.id end, case when v_old then now() end)
      on conflict (company_id, account_id, fingerprint) do nothing;
    if found then n_new := n_new + 1; if v_old then n_old := n_old + 1; end if; end if;
  end loop;
  update public.bank_imports set lines_new = n_new, lines_seen = n_all - n_new, lines_old = n_old where id = imp;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('import_id', imp, 'new', n_new, 'seen', n_all - n_new, 'old', n_old));
end $$;

-- ---------- c) everything the review screen needs (+ the shop's name, the start day, UPI payments that land in the bank) ----------
create or replace function public.api_bank_data(p_caller uuid, p_account uuid, p_import uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); a public.money_accounts; im public.bank_imports; tz text; d1 date; d2 date; co public.companies;
begin
  perform app.require(c, 'settings', 'money');
  select * into a from public.money_accounts where company_id = c.company_id and id = p_account;
  if a.id is null then raise exception 'Choose the bank account.' using errcode = '22023'; end if;
  select * into im from public.bank_imports where company_id = c.company_id and id = p_import and account_id = a.id;
  select * into co from public.companies where id = c.company_id;
  tz := co.timezone;
  select min(day), max(day) into d1, d2 from public.bank_lines
    where company_id = c.company_id and account_id = a.id and (im.id is null and status = 'open' or import_id = im.id);
  d1 := coalesce(d1, (now() at time zone tz)::date) - 7; d2 := coalesce(d2, (now() at time zone tz)::date) + 7;
  return jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'number', a.number),
    'shop', co.name,
    'start', (co.created_at at time zone tz)::date,
    'import', case when im.id is null then null else jsonb_build_object('id', im.id, 'file_name', im.file_name, 'from', im.day_from, 'to', im.day_to,
        'opening', im.opening, 'closing', im.closing, 'adds_up', im.adds_up, 'new', im.lines_new, 'seen', im.lines_seen, 'old', im.lines_old, 'at', im.created_at) end,
    -- what the app says is in this account at the end of the statement's last day
    'app_balance', case when im.day_to is null then null else app.account_balance(c.company_id, a.id, ((im.day_to + 1)::timestamp at time zone tz) - interval '1 microsecond') end,
    'drawer', (select id from public.money_accounts where company_id = c.company_id and is_drawer),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'day', l.day, 'amount', l.amount, 'narration', l.narration, 'ref', l.ref,
        'balance', l.balance, 'status', l.status, 'payment_id', l.payment_id, 'expense_id', l.expense_id, 'transfer_id', l.transfer_id,
        'note', l.note, 'import_id', l.import_id) order by l.day, l.created_at, l.id)
      from public.bank_lines l where l.company_id = c.company_id and l.account_id = a.id
        and (im.id is null and l.status = 'open' or l.import_id = im.id)), '[]'::jsonb),
    -- the app's own entries in this account around those days (a cancelled payment and its cancellation are left out);
    -- payments written in Shop UPI / Paytm / a wallet too ('via'): that money lands in the bank
    'moves', coalesce((select jsonb_agg(m) from (
        select jsonb_build_object('src', 'payment', 'ref', p.id, 'amount', pp.amount, 'day', (p.received_at at time zone tz)::date,
                 'label', cu.name, 'customer_id', p.customer_id, 'kind', p.kind, 'via', case when pp.account_id <> a.id then pa.name end,
                 'linked', exists (select 1 from public.bank_lines b where b.company_id = c.company_id and b.payment_id = p.id)) m
          from public.payment_parts pp join public.payments p on p.company_id = pp.company_id and p.id = pp.payment_id
          join public.money_accounts pa on pa.company_id = pp.company_id and pa.id = pp.account_id
          left join public.customers cu on cu.company_id = p.company_id and cu.id = p.customer_id
          where pp.company_id = c.company_id and (pp.account_id = a.id or (pa.kind in ('upi','paytm','wallet') and pp.amount > 0))
            and (p.received_at at time zone tz)::date between d1 and d2
            and p.reverses_payment_id is null
            and not exists (select 1 from public.payments r where r.company_id = p.company_id and r.reverses_payment_id = p.id)
        union all
        select jsonb_build_object('src', 'expense', 'ref', e.id, 'amount', -e.amount, 'day', e.business_date, 'label', coalesce(e.paid_to, e.category),
                 'kind', e.kind, 'linked', exists (select 1 from public.bank_lines b where b.company_id = c.company_id and b.expense_id = e.id))
          from public.expenses e where e.company_id = c.company_id and e.account_id = a.id and e.status = 'ok' and e.business_date between d1 and d2
        union all
        select jsonb_build_object('src', 'transfer_out', 'ref', t.id, 'amount', -t.amount, 'day', t.business_date, 'label', ta.name, 'kind', t.reason,
                 'linked', exists (select 1 from public.bank_lines b where b.company_id = c.company_id and (b.transfer_id = t.id or b.settle_id = t.id)))
          from public.money_transfers t join public.money_accounts ta on ta.company_id = t.company_id and ta.id = t.to_account
          where t.company_id = c.company_id and t.from_account = a.id and t.status = 'ok' and t.business_date between d1 and d2
        union all
        select jsonb_build_object('src', 'transfer_in', 'ref', t.id, 'amount', t.amount, 'day', t.business_date, 'label', fa.name, 'kind', t.reason,
                 'linked', exists (select 1 from public.bank_lines b where b.company_id = c.company_id and (b.transfer_id = t.id or b.settle_id = t.id)))
          from public.money_transfers t join public.money_accounts fa on fa.company_id = t.company_id and fa.id = t.from_account
          where t.company_id = c.company_id and t.to_account = a.id and t.status = 'ok' and t.business_date between d1 and d2) x), '[]'::jsonb),
    'payers', coalesce((select jsonb_object_agg(key, jsonb_build_object('action', action, 'customer_id', customer_id, 'supplier_id', supplier_id,
        'category', category, 'to', to_account)) from public.bank_payers where company_id = c.company_id), '{}'::jsonb),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
      from public.suppliers s where s.company_id = c.company_id), '[]'::jsonb),
    'imports', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'file_name', i.file_name, 'from', i.day_from, 'to', i.day_to,
        'new', i.lines_new, 'seen', i.lines_seen, 'old', i.lines_old, 'at', i.created_at,
        'open', (select count(*) from public.bank_lines b where b.company_id = c.company_id and b.import_id = i.id and b.status = 'open'))
        order by i.created_at desc) from (select * from public.bank_imports where company_id = c.company_id and account_id = a.id
        order by created_at desc limit 12) i), '[]'::jsonb));
end $$;

-- ---------- c) tick a line as an entry already in the app (a UPI payment: the money moves from Shop UPI into the bank) ----------
create or replace function public.api_bank_link(p_caller uuid, p_key uuid, p_hash text, p_line uuid, p_src text, p_ref uuid, p_remember jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; l public.bank_lines; amt numeric; v_via uuid; v_tid uuid; tz text; v_at timestamptz;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'bankLink', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  l := app.bank_line_for(c, p_line);
  if l.status <> 'open' then raise exception 'This bank line is already done.' using errcode = '23001'; end if;
  if p_src = 'payment' then
    select sum(pp.amount) into amt from public.payment_parts pp where pp.company_id = c.company_id and pp.payment_id = p_ref and pp.account_id = l.account_id;
    if amt is null and l.amount > 0 then   -- written in Shop UPI / Paytm / a wallet: the money is in the bank
      select pp.amount, pp.account_id into amt, v_via from public.payment_parts pp
        join public.money_accounts ma on ma.company_id = pp.company_id and ma.id = pp.account_id
        where pp.company_id = c.company_id and pp.payment_id = p_ref and ma.kind in ('upi','paytm','wallet') and abs(pp.amount - l.amount) <= 0.5
        order by pp.amount desc limit 1;
    end if;
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
  if v_via is not null then
    select timezone into tz from public.companies where id = c.company_id;
    v_at := least((l.day::timestamp + interval '12 hours') at time zone tz, now());
    insert into public.money_transfers (company_id, from_account, to_account, amount, at, business_date, reason, method, note, created_by)
      values (c.company_id, v_via, l.account_id, abs(amt), v_at, l.day, 'move', 'UPI', 'UPI money in the bank (bank statement)', c.id)
      returning id into v_tid;
  end if;
  update public.bank_lines set status = 'linked', done_by = c.id, done_at = now(), settle_id = v_tid,
      payment_id = case when p_src = 'payment' then p_ref end, expense_id = case when p_src = 'expense' then p_ref end,
      transfer_id = case when p_src like 'transfer%' then p_ref end
    where id = l.id;
  perform app.bank_remember(c, l, p_remember);
  return app.idem_done(c.company_id, p_key, jsonb_build_object('line_id', l.id, 'status', 'linked', 'moved_from', v_via));
end $$;

-- ---------- opening a ticked line again also cancels its UPI → bank transfer ----------
create or replace function public.api_bank_mark(p_caller uuid, p_key uuid, p_hash text, p_line uuid, p_status text, p_note text, p_remember jsonb) returns jsonb
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
    update public.bank_lines set status = 'open', note = null, payment_id = null, expense_id = null, transfer_id = null, settle_id = null,
        done_by = c.id, done_at = now() where id = l.id;
    if l.settle_id is not null then
      update public.money_transfers set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = 'Bank line opened again'
        where company_id = c.company_id and id = l.settle_id and status = 'ok';
    end if;
  else
    raise exception 'Unknown status.' using errcode = '22023';
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('line_id', l.id, 'status', p_status));
end $$;
