-- 4 Nov 2026 (plan v2, F4): statements read on the phone keep their DOUBTS — what the reader could not prove
-- (money in or out, a balance that does not follow, which way round the dates are, columns found from their contents,
-- read from a photo). A line with a doubt is never "Ready" and never ticked in bulk: the owner decides. Each upload keeps
-- the file's own fingerprint, so the exact same file uploaded again is recognised before saving.
alter table public.bank_lines add column doubts text[] not null default '{}';
alter table public.bank_imports add column file_hash text check (file_hash is null or file_hash ~ '^[0-9a-f]{64}$');

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
  insert into public.bank_imports (company_id, account_id, file_name, day_from, day_to, opening, closing, adds_up, created_by, file_hash)
    values (c.company_id, a.id, left(nullif(btrim(p ->> 'file_name'), ''), 200), nullif(p ->> 'from', '')::date, nullif(p ->> 'to', '')::date,
            nullif(p ->> 'opening', '')::numeric, nullif(p ->> 'closing', '')::numeric, coalesce((p ->> 'adds_up')::boolean, false), c.id,
            case when (p ->> 'file_hash') ~ '^[0-9a-f]{64}$' then p ->> 'file_hash' end)
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
    insert into public.bank_lines (company_id, account_id, import_id, day, amount, narration, ref, balance, fingerprint, doubts, status, note, done_by, done_at)
      values (c.company_id, a.id, imp, v_day, v_amt, left(coalesce(x ->> 'narration', ''), 500),
              left(nullif(btrim(x ->> 'ref'), ''), 60), v_bal, left(x ->> 'fingerprint', 300),
              coalesce((select array_agg(d) from jsonb_array_elements_text(case when jsonb_typeof(x -> 'doubts') = 'array' then x -> 'doubts' else '[]'::jsonb end) d
                         where d in ('direction','balance','date_style','layout','photo')), '{}'),
              case when v_old then 'skipped' else 'open' end, case when v_old then 'Before the app was started' end,
              case when v_old then c.id end, case when v_old then now() end)
      on conflict (company_id, account_id, fingerprint) do nothing;
    if found then n_new := n_new + 1; if v_old then n_old := n_old + 1; end if; end if;
  end loop;
  update public.bank_imports set lines_new = n_new, lines_seen = n_all - n_new, lines_old = n_old where id = imp;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('import_id', imp, 'new', n_new, 'seen', n_all - n_new, 'old', n_old));
end $$;

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
        'note', l.note, 'import_id', l.import_id, 'doubts', to_jsonb(l.doubts)) order by l.day, l.created_at, l.id)
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
        'new', i.lines_new, 'seen', i.lines_seen, 'old', i.lines_old, 'at', i.created_at, 'file_hash', i.file_hash,
        'open', (select count(*) from public.bank_lines b where b.company_id = c.company_id and b.import_id = i.id and b.status = 'open'))
        order by i.created_at desc) from (select * from public.bank_imports where company_id = c.company_id and account_id = a.id
        order by created_at desc limit 12) i), '[]'::jsonb));
end $$;

-- The owner settles "money in or out?" on a line the reader could not prove (only that doubt, only while it is open).
create function public.api_bank_direction(p_caller uuid, p_key uuid, p_hash text, p_line uuid, p_in boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; l public.bank_lines;
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'bankDirection', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  l := app.bank_line_for(c, p_line);
  if l.status <> 'open' then raise exception 'This bank line is already done.' using errcode = '23001'; end if;
  if not ('direction' = any(l.doubts)) then raise exception 'This line''s money in / out is already known.' using errcode = '22023'; end if;
  update public.bank_lines set amount = case when p_in then abs(amount) else -abs(amount) end, doubts = array_remove(doubts, 'direction'),
      note = 'Money ' || case when p_in then 'in' else 'out' end || ' — said ' || c.display_name
    where id = l.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('line_id', l.id, 'amount', case when p_in then abs(l.amount) else -abs(l.amount) end));
end $$;
revoke all on function public.api_bank_direction(uuid, uuid, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.api_bank_direction(uuid, uuid, text, uuid, boolean) to service_role;
