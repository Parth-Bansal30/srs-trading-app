-- 4 Nov 2026 (plan v2, F3): overdraft (OD) and cash credit (CC) bank accounts.
-- The bank's balance on such an account is usually below zero (money used from the limit). The app keeps:
--   sanctioned limit (set by the owner) · outstanding = what is used now = minus the balance, from the last balance point
--   (a statement / passbook figure) + every entry in the app since · available (estimate) = limit − used. The screens
--   say it is an estimate and what it is based on ("statement of 31 Oct + 3 entries since"); the next statement replaces it.
--   (No drawing power: Parth, 4 Nov.) A negative balance point was already allowed for bank accounts (never for cash).
-- Also: ticking a bank line against a payment that was cancelled is refused (a tick racing a cancel).

alter table public.money_accounts add column credit_kind text check (credit_kind is null or credit_kind in ('od','cc'));
alter table public.money_accounts add column credit_limit numeric(14,2) check (credit_limit is null or (credit_limit > 0 and credit_limit <= 100000000000));
alter table public.money_accounts add constraint money_accounts_credit_bank
  check ((credit_kind is null) = (credit_limit is null) and (credit_kind is null or (kind = 'bank' and not is_drawer)));

/** Owner: mark a bank account as OD / CC with its sanctioned limit (or back to a normal account). */
create function public.api_account_credit(p_caller uuid, p_key uuid, p_hash text, p_account uuid, p_kind text, p_limit numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; a public.money_accounts;
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'accountCredit', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into a from public.money_accounts where company_id = c.company_id and id = p_account for update;
  if a.id is null then raise exception 'Account not found.' using errcode = '22023'; end if;
  if p_kind is not null then
    if a.is_drawer or a.kind <> 'bank' then raise exception 'Only a bank account can be an overdraft or CC account.' using errcode = '22023'; end if;
    if p_kind not in ('od', 'cc') then raise exception 'Overdraft or cash credit?' using errcode = '22023'; end if;
    if p_limit is null or p_limit <= 0 then raise exception 'Enter the sanctioned limit.' using errcode = '22023'; end if;
  end if;
  update public.money_accounts set credit_kind = p_kind, credit_limit = case when p_kind is null then null else round(p_limit, 2) end where id = a.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('id', a.id, 'credit_kind', p_kind, 'credit_limit', case when p_kind is null then null else round(p_limit, 2) end));
end $$;

-- the account lists carry the OD / CC facts
create or replace function public.api_accounts(p_caller uuid, p_all boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); boss boolean := app.has(c, 'settings');
begin
  perform app.require(c, 'money');
  if p_all then perform app.require(c, 'settings'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'owner', a.owner,
      'number', case when boss then a.number end, 'staff_can', a.staff_can, 'position', a.position, 'hidden', a.hidden,
      'is_drawer', a.is_drawer, 'usable', not a.hidden and (a.staff_can or boss),
      'credit_kind', a.credit_kind, 'credit_limit', case when boss then a.credit_limit end,
      'used', exists (select 1 from public.payment_parts pp where pp.company_id = a.company_id and pp.account_id = a.id))
      order by a.is_drawer desc, a.position, a.created_at)
    from public.money_accounts a where a.company_id = c.company_id and (p_all or (not a.hidden and (a.staff_can or boss)))), '[]'::jsonb);
end $$;

-- the balance now says how many entries it is made of since its last balance point (for "estimate" wording)
create or replace function app.account_balance(p_company uuid, p_account uuid, p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.account_balances; s numeric; n int;
begin
  select * into b from public.account_balances
    where company_id = p_company and account_id = p_account and at <= p_at order by at desc, created_at desc limit 1;
  select coalesce(sum(m.amount), 0), count(*) into s, n from app.account_moves(p_company, p_account, coalesce(b.at, '-infinity'::timestamptz), p_at) m;
  return jsonb_build_object('known', b.id is not null, 'balance', round(coalesce(b.balance, 0) + s, 2), 'since', b.at, 'base', b.balance, 'source', b.source, 'entries', n);
end $$;

create or replace function public.api_account_balances(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); v_tz text;
begin
  perform app.require(c, 'settings', 'money');
  select timezone into v_tz from public.companies where id = c.company_id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'kind', a.kind, 'owner', a.owner, 'is_drawer', a.is_drawer,
      'hidden', a.hidden, 'credit_kind', a.credit_kind, 'credit_limit', a.credit_limit) || case when a.is_drawer
        then jsonb_build_object('known', true, 'balance', app.drawer_cash(c.company_id, a.id, now(), ((now() at time zone v_tz)::date)::timestamp at time zone v_tz),
                                'since', (select max(at) from public.account_balances b where b.company_id = a.company_id and b.account_id = a.id))
        else app.account_balance(c.company_id, a.id, now()) end
      order by a.is_drawer desc, a.position, a.created_at)
    from public.money_accounts a where a.company_id = c.company_id), '[]'::jsonb);
end $$;

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
  if p_src = 'payment' and exists (select 1 from public.payments r where r.company_id = c.company_id and r.reverses_payment_id = p_ref) then
    raise exception 'That payment was cancelled.' using errcode = '23001';   -- (4 Nov 2026: a tick racing a cancel)
  end if;
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


revoke all on function public.api_account_credit(uuid, uuid, text, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.api_account_credit(uuid, uuid, text, uuid, text, numeric) to service_role;
