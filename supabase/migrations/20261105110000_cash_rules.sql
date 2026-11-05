-- 5 Nov 2026 (plan v2, F8): cash rules (the ₹2 lakh rule, old section 269ST, carried into the new Income-tax Act; the
-- shop's CA confirms the exact section and exceptions). Cash RECEIVED reaching ₹2,00,000 — from one person in one day, or
-- for one slip (advance + pickup + khata payments against it, any day) — is stopped: the rest goes by UPI / bank. Staff
-- can never save it. If the cash really was already handed over, only the OWNER can record what happened, with the reason
-- (Parth's D4) — it goes straight to "To check" for the accountant. An entry made offline that crosses the limit is kept
-- (it already happened) and goes to "To check" as important. Cash from one customer over a week across slips that reaches
-- the limit is never stopped, only flagged ("might be one occasion"). Cash PAID OUT: over ₹10,000 to one person in a day
-- is flagged for the CA; ₹2,00,000 or more to a supplier is stopped like money received.

create function app.cash_limit() returns numeric language sql immutable set search_path = '' as $$ select 200000::numeric $$;
create function app.inr(v numeric) returns text language sql immutable set search_path = '' as $$
  select '₹' || ltrim(to_char(round(v), 'FM99,99,99,99,990'))
$$;

/** Live cash received from a customer: on one shop day / on one slip / over some days (cancelled payments left out). */
create function app.cash_in(p_company uuid, p_customer uuid, p_order uuid, p_from date, p_to date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(pp.amount), 0)
  from public.payments p
  join public.payment_parts pp on pp.company_id = p.company_id and pp.payment_id = p.id and pp.mode = 'Cash' and pp.amount > 0
  join public.companies co on co.id = p.company_id
  where p.company_id = p_company and p.amount > 0 and p.reverses_payment_id is null and p.kind <> 'transfer' and p.from_payment_id is null
    and not exists (select 1 from public.payments r where r.company_id = p.company_id and r.reverses_payment_id = p.id)
    and (p_order is null or p.order_id = p_order)
    and (p_customer is null or p.customer_id = p_customer)
    and (p_from is null or (p.received_at at time zone co.timezone)::date between p_from and p_to)
$$;

/** How much more cash may be taken: { day, slip, week, limit, room } (room = the most cash that still keeps under the limit). */
create function public.api_cash_room(p_caller uuid, p_customer uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); tz text; v_day date; d numeric; s numeric := 0; w numeric;
begin
  perform app.require(c, 'money');
  select timezone into tz from public.companies where id = c.company_id;
  v_day := (coalesce(app.at(), now()) at time zone tz)::date;
  if p_order is not null and p_customer is null then select customer_id into p_customer from public.orders where company_id = c.company_id and id = p_order; end if;
  d := app.cash_in(c.company_id, p_customer, null, v_day, v_day);
  if p_order is not null then s := app.cash_in(c.company_id, null, p_order, null, null); end if;
  w := app.cash_in(c.company_id, p_customer, null, v_day - 6, v_day);
  return jsonb_build_object('day', d, 'slip', s, 'week', w, 'limit', app.cash_limit(), 'room', greatest(0, app.cash_limit() - 1 - greatest(d, s)));
end $$;

-- ---------- money received ----------
create function app.cash_rule_in() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.payments; tz text; v_day date; d numeric; s numeric := 0; w numeric; v_top numeric; v_what text; cu text; boss boolean;
  v_reason text := nullif(current_setting('app.cash_reason', true), ''); v_fact jsonb; v_side text;
begin
  select * into p from public.payments where company_id = new.company_id and id = new.payment_id;
  if p.id is null or p.amount <= 0 or p.reverses_payment_id is not null or p.kind = 'transfer' or p.from_payment_id is not null then return null; end if;
  select timezone into tz from public.companies where id = p.company_id;
  v_day := (p.received_at at time zone tz)::date;
  d := app.cash_in(p.company_id, p.customer_id, null, v_day, v_day);
  if p.order_id is not null then s := app.cash_in(p.company_id, null, p.order_id, null, null); end if;
  select name into cu from public.customers where company_id = p.company_id and id = p.customer_id;
  -- kacha cards are shown only to people who may see kacha
  v_side := coalesce(p.side, (select o.bill_type from public.orders o where o.company_id = p.company_id and o.id = p.order_id));
  if greatest(d, s) >= app.cash_limit() then
    v_what := case when s >= d then 'slip' else 'day' end;
    v_top := greatest(d, s);
    v_fact := jsonb_build_object('amount', new.amount, 'total', v_top, 'what', v_what, 'day', v_day, 'payment_id', p.id, 'order_id', p.order_id, 'kind', p.kind,
      'by', (select display_name from public.people where company_id = p.company_id and id = p.created_by));
    select coalesce((perms ->> 'settings')::boolean, false) into boss from public.people where company_id = p.company_id and id = p.created_by;
    if v_reason is not null and coalesce(boss, false) then
      perform app.review_add(p.company_id, 'cash_exception', p.id, null, v_fact || jsonb_build_object('reason', v_reason,
        'text', format('Cash taken over the limit: %s from %s %s (%s in all). Owner''s reason: %s', app.inr(new.amount), coalesce(cu, ''),
          case v_what when 'slip' then 'for one slip' else 'in one day' end, app.inr(v_top), v_reason)), p.customer_id, null, v_side, 'important', p.created_by);
    elsif p.entered_offline then
      perform app.review_add(p.company_id, 'cash_limit', p.id, null, v_fact || jsonb_build_object(
        'text', format('Saved without internet: cash from %s %s came to %s — over the ₹2,00,000 limit. CA to check.', coalesce(cu, ''),
          case v_what when 'slip' then 'for one slip' else 'in one day' end, app.inr(v_top))), p.customer_id, null, v_side, 'important', p.created_by);
    else
      raise exception 'Cash from % % would be % — the limit is under ₹2,00,000. Take % or more by UPI / bank.', coalesce(cu, 'this customer'),
        case v_what when 'slip' then 'for this slip' else 'today' end, app.inr(v_top), app.inr(v_top - app.cash_limit() + 1) using errcode = '23514';
    end if;
  else
    -- one occasion over several slips? never stopped — the CA checks
    w := app.cash_in(p.company_id, p.customer_id, null, v_day - 6, v_day);
    if w >= app.cash_limit() then
      perform app.review_add(p.company_id, 'cash_occasion', p.id, null, jsonb_build_object('total', w, 'day', v_day,
        'text', format('Cash from %s in 7 days: %s (no one day or slip reached ₹2,00,000). Might be one deal — CA to check.', coalesce(cu, ''), app.inr(w))),
        p.customer_id, null, v_side, 'check', p.created_by);
    end if;
  end if;
  return null;
end $$;
create trigger cash_rule after insert on public.payment_parts for each row when (new.mode = 'Cash' and new.amount > 0)
  execute function app.cash_rule_in();

-- ---------- money paid out ----------
/** Cash paid out to one payee (a supplier, or the same name) on one shop day. */
create function app.cash_out_day(p_company uuid, p_supplier uuid, p_paid_to text, p_day date) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(e.amount), 0) from public.expenses e join public.money_accounts a on a.company_id = e.company_id and a.id = e.account_id
  where e.company_id = p_company and e.status = 'ok' and e.kind <> 'owner' and a.kind in ('cash', 'safe') and e.business_date = p_day
    and ((p_supplier is not null and e.supplier_id = p_supplier) or (p_supplier is null and p_paid_to is not null and lower(btrim(e.paid_to)) = lower(btrim(p_paid_to))))
$$;

create function app.cash_rule_out() returns trigger
language plpgsql security definer set search_path = '' as $$
declare k text; v_tot numeric; who text; boss boolean; v_reason text := nullif(current_setting('app.cash_reason', true), ''); v_fact jsonb;
begin
  select kind into k from public.money_accounts where company_id = new.company_id and id = new.account_id;
  if k is null or k not in ('cash', 'safe') or new.kind = 'owner' or (new.supplier_id is null and nullif(btrim(new.paid_to), '') is null) then return null; end if;
  v_tot := app.cash_out_day(new.company_id, new.supplier_id, new.paid_to, new.business_date);
  who := coalesce((select name from public.suppliers where company_id = new.company_id and id = new.supplier_id), new.paid_to);
  v_fact := jsonb_build_object('amount', new.amount, 'total', v_tot, 'day', new.business_date, 'expense_id', new.id,
    'by', (select display_name from public.people where company_id = new.company_id and id = new.created_by));
  if new.kind = 'supplier' and v_tot >= app.cash_limit() then
    select coalesce((perms ->> 'settings')::boolean, false) into boss from public.people where company_id = new.company_id and id = new.created_by;
    if v_reason is not null and coalesce(boss, false) then
      perform app.review_add(new.company_id, 'cash_exception', new.id, null, v_fact || jsonb_build_object('reason', v_reason,
        'text', format('Cash paid over the limit: %s to %s (%s that day). Owner''s reason: %s', app.inr(new.amount), who, app.inr(v_tot), v_reason)),
        null, new.supplier_id, null, 'important', new.created_by);
    elsif new.entered_offline then
      perform app.review_add(new.company_id, 'cash_limit', new.id, null, v_fact || jsonb_build_object(
        'text', format('Saved without internet: cash paid to %s came to %s in a day — ₹2,00,000 or more. CA to check.', who, app.inr(v_tot))),
        null, new.supplier_id, null, 'important', new.created_by);
    else
      raise exception 'Cash to % today would be % — pay ₹2,00,000 or more by bank / cheque, not cash.', who, app.inr(v_tot) using errcode = '23514';
    end if;
  elsif v_tot > 10000 then
    perform app.review_add(new.company_id, 'cash_out', new.id, null, v_fact || jsonb_build_object(
      'text', format('%s cash paid to %s on %s — over ₹10,000 to one person in a day. The CA checks whether it can be counted as an expense.',
        app.inr(v_tot), who, to_char(new.business_date, 'DD Mon'))), null, new.supplier_id, null, 'check', new.created_by);
  end if;
  return null;
end $$;
create trigger cash_rule after insert on public.expenses for each row execute function app.cash_rule_out();

-- ---------- the owner records cash that was really already taken / paid (with the reason) ----------
create function public.api_cash_reason_pay(p_caller uuid, p_reason text, p_op text, p_args jsonb, p_parts jsonb, p_account jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); r jsonb;
begin
  perform app.require(c, 'settings');
  if nullif(btrim(p_reason), '') is null or length(btrim(p_reason)) < 5 then raise exception 'Write what happened (why the cash was already taken).' using errcode = '22023'; end if;
  perform set_config('app.cash_reason', left(btrim(p_reason), 300), true);
  r := public.api_pay(p_caller, p_op, p_args, p_parts, p_account);
  perform set_config('app.cash_reason', '', true);   -- the reason belongs to this one entry only
  return r;
end $$;
create function public.api_cash_reason_expense(p_caller uuid, p_key uuid, p_hash text, p jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); r jsonb;
begin
  perform app.require(c, 'settings');
  if nullif(btrim(p_reason), '') is null or length(btrim(p_reason)) < 5 then raise exception 'Write what happened (why the cash was already paid).' using errcode = '22023'; end if;
  perform set_config('app.cash_reason', left(btrim(p_reason), 300), true);
  r := public.api_save_expense(p_caller, p_key, p_hash, p);
  perform set_config('app.cash_reason', '', true);
  return r;
end $$;

revoke all on function public.api_cash_room(uuid, uuid, uuid), public.api_cash_reason_pay(uuid, text, text, jsonb, jsonb, jsonb),
  public.api_cash_reason_expense(uuid, uuid, text, jsonb, text), app.cash_in(uuid, uuid, uuid, date, date),
  app.cash_out_day(uuid, uuid, text, date) from public, anon, authenticated;
grant execute on function public.api_cash_room(uuid, uuid, uuid), public.api_cash_reason_pay(uuid, text, text, jsonb, jsonb, jsonb),
  public.api_cash_reason_expense(uuid, uuid, text, jsonb, text) to service_role;
