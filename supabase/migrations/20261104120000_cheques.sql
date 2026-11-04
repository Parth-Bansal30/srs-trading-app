-- 4 Nov 2026 (plan v2, F5): cheques and demand drafts (DDs).
-- Parth's rules (D1, D2): staff note a cheque when it comes in (number, bank, amount, customer); it does NOT lower the
-- khata. The payment is made only when the owner matches it to the bank statement's clearing line and confirms it — on
-- the bank's date, into that bank account. A cheque that comes back (returned / bounced) after it was confirmed has that
-- payment cancelled (the due comes back exactly once); one that comes back before it was confirmed never touched the khata.
-- Cheques given to suppliers are noted with the supplier payment; the statement's clearing line is matched by number.
-- Every step is a person's confirmed action (who / when in the audit log); nothing is matched or posted by itself.

create table public.cheques (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete restrict,
  direction      text not null check (direction in ('in','out')),
  instrument     text not null default 'cheque' check (instrument in ('cheque','dd')),
  number         text not null check (number ~ '^[0-9A-Z/-]{1,20}$'),
  bank_name      text check (bank_name is null or length(btrim(bank_name)) between 1 and 40),
  amount         numeric(12,2) not null check (amount > 0 and amount <= 100000000),
  customer_id    uuid,
  supplier_id    uuid,
  side           text check (side is null or side in ('pakka','kacha')),       -- the khata it goes to when it clears
  cheque_date    date,                                                         -- the date written on it (may be later)
  got_on         date not null,                                                -- received (in) / given (out)
  status         text not null check (status in ('received','deposited','given','cleared','returned','cancelled')),
  account_id     uuid,                                                         -- deposited into / drawn on
  payment_id     uuid,                                                         -- in: the khata payment made when it cleared
  expense_id     uuid,                                                         -- out: the supplier payment it was given for
  clear_line_id  uuid,                                                         -- the statement line it cleared (or was deposited) on
  return_line_id uuid,                                                         -- the statement line it came back on
  return_charges numeric(12,2) check (return_charges is null or return_charges > 0),
  note           text check (note is null or length(note) <= 300),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  idempotency_key uuid,
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, customer_id) references public.customers(company_id, id),
  foreign key (company_id, supplier_id) references public.suppliers(company_id, id),
  foreign key (company_id, account_id) references public.money_accounts(company_id, id),
  foreign key (company_id, payment_id) references public.payments(company_id, id),
  foreign key (company_id, expense_id) references public.expenses(company_id, id),
  foreign key (company_id, clear_line_id) references public.bank_lines(company_id, id),
  foreign key (company_id, return_line_id) references public.bank_lines(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  constraint cheques_party check ((direction = 'in' and customer_id is not null and supplier_id is null and side is not null)
                               or (direction = 'out' and supplier_id is not null and customer_id is null)),
  constraint cheques_status_dir check ((direction = 'in' and status <> 'given') or (direction = 'out' and status not in ('received','deposited')))
);
comment on table public.cheques is 'Cheque / DD register (plan v2 F5). A cheque from a customer lowers the khata only when the owner confirms its clearing line.';
create index cheques_open on public.cheques (company_id, direction, status);
create index cheques_number on public.cheques (company_id, ltrim(number, '0'));
create index cheques_customer on public.cheques (company_id, customer_id) where customer_id is not null;
create unique index cheques_payment_once on public.cheques (company_id, payment_id) where payment_id is not null;
alter table public.cheques enable row level security;
revoke all on public.cheques from anon, authenticated;
create trigger audit after insert or update or delete on public.cheques for each row execute function app.audit_row();

-- who may touch which cheque: from customers = khata people (kacha ones only with kacha); to suppliers = stock or owner
create function app.cheque_may(c public.people, p_dir text, p_side text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_dir = 'in' then
    perform app.require(c, 'money', 'khata');
    if p_side = 'kacha' then perform app.require(c, 'kacha'); end if;
  elsif not (app.has(c, 'stock') or app.has(c, 'settings')) then
    perform app.require(c, 'stock');
  end if;
end $$;

/**
 * Note a cheque / DD. p = { direction in|out, instrument cheque|dd, number, bank_name, amount, customer_id + side (in),
 * supplier_id + expense_id (out: the supplier payment it was given for), cheque_date, got_on, note }.
 */
create function public.api_cheque_add(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; v_dir text := p ->> 'direction'; v_id uuid; tz text; v_no text; today date;
  v_side text := coalesce(nullif(p ->> 'side', ''), 'pakka'); v_amt numeric; v_got date; v_exp uuid := nullif(p ->> 'expense_id', '')::uuid;
  v_sup uuid := nullif(p ->> 'supplier_id', '')::uuid; e public.expenses; dup record;
begin
  if v_dir not in ('in', 'out') or v_dir is null then raise exception 'Cheque in or out?' using errcode = '22023'; end if;
  if v_side not in ('pakka', 'kacha') then raise exception 'Choose Pakka or Kacha.' using errcode = '22023'; end if;
  perform app.cheque_may(c, v_dir, case when v_dir = 'in' then v_side end);
  prev := app.idem_start(c.company_id, p_key, 'chequeAdd', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select timezone into tz from public.companies where id = c.company_id;
  today := (now() at time zone tz)::date;
  v_no := upper(regexp_replace(coalesce(p ->> 'number', ''), '\s', '', 'g'));
  if v_no !~ '^[0-9A-Z/-]{1,20}$' then raise exception 'Type the cheque / DD number.' using errcode = '22023'; end if;
  v_amt := round(nullif(p ->> 'amount', '')::numeric, 2);
  if v_amt is null or v_amt <= 0 or v_amt > 100000000 then raise exception 'Enter the amount.' using errcode = '22023'; end if;
  v_got := coalesce(nullif(p ->> 'got_on', '')::date, today);
  if v_got > today or v_got < today - 400 then raise exception 'Check the date.' using errcode = '22023'; end if;
  if v_dir = 'in' and nullif(p ->> 'customer_id', '') is null then raise exception 'Choose the customer.' using errcode = '22023'; end if;
  if v_dir = 'out' then
    if v_exp is not null then
      select * into e from public.expenses where company_id = c.company_id and id = v_exp;
      if e.id is null or e.kind <> 'supplier' or e.status <> 'ok' then raise exception 'That supplier payment was not found.' using errcode = '22023'; end if;
      if abs(e.amount - v_amt) > 0.005 then raise exception 'The cheque and the payment are different amounts.' using errcode = '22023'; end if;
      v_sup := e.supplier_id;
    end if;
    if v_sup is null then raise exception 'Choose the supplier.' using errcode = '22023'; end if;
  end if;
  insert into public.cheques (company_id, direction, instrument, number, bank_name, amount, customer_id, supplier_id, side, cheque_date, got_on, status,
                              account_id, expense_id, note, created_by, idempotency_key)
    values (c.company_id, v_dir, case when p ->> 'instrument' = 'dd' then 'dd' else 'cheque' end, v_no,
            left(nullif(btrim(upper(p ->> 'bank_name')), ''), 40), v_amt,
            case when v_dir = 'in' then (p ->> 'customer_id')::uuid end, case when v_dir = 'out' then v_sup end,
            case when v_dir = 'in' then v_side end, nullif(p ->> 'cheque_date', '')::date, v_got,
            case when v_dir = 'in' then 'received' else 'given' end, case when v_dir = 'out' then e.account_id end, v_exp,
            left(nullif(btrim(p ->> 'note'), ''), 300), c.id, p_key)
    returning id into v_id;
  -- the same cheque noted twice? (same number and amount, still live) — kept, but the owner is asked
  select * into dup from public.cheques where company_id = c.company_id and id <> v_id and ltrim(number, '0') = ltrim(v_no, '0')
    and amount = v_amt and direction = v_dir and status not in ('cancelled') limit 1;
  if dup.id is not null then
    perform app.review_add(c.company_id, 'cheque_twice', v_id, dup.id,
      jsonb_build_object('text', 'Cheque ' || v_no || ' for ₹' || v_amt || ' is noted twice (' || to_char(dup.got_on, 'DD Mon') || ' and ' || to_char(v_got, 'DD Mon') || ')'),
      case when v_dir = 'in' then (p ->> 'customer_id')::uuid end, case when v_dir = 'out' then v_sup end,
      case when v_dir = 'in' then v_side end, 'check', c.id);
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('cheque_id', v_id, 'twice', dup.id is not null));
end $$;

/** deposited (with the bank account) / cancelled (with why) — only while it has not cleared. */
create function public.api_cheque_mark(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_status text, p_account uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; q public.cheques;
begin
  prev := app.idem_start(c.company_id, p_key, 'chequeMark', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into q from public.cheques where company_id = c.company_id and id = p_id for update;
  if q.id is null then raise exception 'Cheque not found.' using errcode = '22023'; end if;
  perform app.cheque_may(c, q.direction, q.side);
  if q.status not in ('received', 'deposited', 'given') then raise exception 'This cheque is already %.', q.status using errcode = '23001'; end if;
  if p_status = 'deposited' and q.direction = 'in' then
    if not exists (select 1 from public.money_accounts where company_id = c.company_id and id = p_account and kind = 'bank' and not hidden) then
      raise exception 'Choose the bank account it went into.' using errcode = '22023';
    end if;
    update public.cheques set status = 'deposited', account_id = p_account where id = q.id;
  elsif p_status = 'cancelled' then
    if nullif(btrim(p_note), '') is null then raise exception 'Write why it is cancelled.' using errcode = '22023'; end if;
    -- a cheque given to a supplier that will never be paid (torn up, or it bounced with nothing in the statement):
    -- its supplier payment is cancelled with it, so the supplier is owed again (F1 follows it everywhere)
    if q.direction = 'out' and q.expense_id is not null
       and exists (select 1 from public.expenses where company_id = c.company_id and id = q.expense_id and status = 'ok') then
      perform public.api_cancel_expense(p_caller, md5(p_key::text || ':cancel')::uuid, p_hash, q.expense_id,
        left('Cheque ' || q.number || ' cancelled — ' || btrim(p_note), 300));
    end if;
    update public.cheques set status = 'cancelled', note = left(btrim(p_note), 300) where id = q.id;
  else
    raise exception 'Deposited or cancelled?' using errcode = '22023';
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('cheque_id', q.id, 'status', p_status));
end $$;

/**
 * Owner: this statement line IS this cheque clearing.
 *  in  → the khata payment is made now, on the bank's date, into that bank account (through api_bank_run, like any bank
 *        line; no "same payment twice?" card for it). p_id null + p_new { customer_id, side, number, bank_name, instrument }:
 *        a cheque that was not in the register — noted and cleared in one step. Different amounts need a note; the
 *        payment is always the bank's amount.
 *  out → the line is ticked against the supplier payment it was given for (or, with none, added as a supplier payment).
 */
create function public.api_cheque_clear(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_line uuid, p_note text, p_new jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; q public.cheques; l public.bank_lines; r jsonb; pid uuid; eid uuid; v_no text;
  sname text; why text := nullif(btrim(p_note), '');
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'chequeClear', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  l := app.bank_line_for(c, p_line);
  if l.status <> 'open' then raise exception 'This bank line is already done.' using errcode = '23001'; end if;
  if p_id is null then
    if jsonb_typeof(p_new) <> 'object' or nullif(p_new ->> 'customer_id', '') is null then raise exception 'Choose the customer.' using errcode = '22023'; end if;
    if l.amount <= 0 then raise exception 'Choose a line of money that came in.' using errcode = '22023'; end if;
    v_no := upper(regexp_replace(coalesce(p_new ->> 'number', ''), '\s', '', 'g'));
    if v_no !~ '^[0-9A-Z/-]{1,20}$' then raise exception 'Type the cheque / DD number.' using errcode = '22023'; end if;
    if coalesce(p_new ->> 'side', 'pakka') not in ('pakka', 'kacha') then raise exception 'Choose Pakka or Kacha.' using errcode = '22023'; end if;
    if p_new ->> 'side' = 'kacha' then perform app.require(c, 'kacha'); end if;
    insert into public.cheques (company_id, direction, instrument, number, bank_name, amount, customer_id, side, got_on, status, account_id, note, created_by)
      values (c.company_id, 'in', case when p_new ->> 'instrument' = 'dd' then 'dd' else 'cheque' end, v_no, left(nullif(btrim(upper(p_new ->> 'bank_name')), ''), 40),
              l.amount, (p_new ->> 'customer_id')::uuid, coalesce(nullif(p_new ->> 'side', ''), 'pakka'), l.day, 'deposited', l.account_id,
              'Not in the register — noted from the statement', c.id)
      returning * into q;
  else
    select * into q from public.cheques where company_id = c.company_id and id = p_id for update;
    if q.id is null then raise exception 'Cheque not found.' using errcode = '22023'; end if;
  end if;
  if q.side = 'kacha' then perform app.require(c, 'kacha'); end if;
  if q.direction = 'in' then
    if q.status not in ('received', 'deposited') then raise exception 'This cheque is already %.', q.status using errcode = '23001'; end if;
    if l.amount <= 0 then raise exception 'Choose a line of money that came in.' using errcode = '22023'; end if;
  else
    if q.status <> 'given' then raise exception 'This cheque is already %.', q.status using errcode = '23001'; end if;
    if l.amount >= 0 then raise exception 'Choose a line of money that went out.' using errcode = '22023'; end if;
  end if;
  if abs(abs(l.amount) - q.amount) > 0.005 and why is null then
    raise exception 'The amounts are different — write why before matching.' using errcode = '22023';
  end if;
  why := left(case when q.instrument = 'dd' then 'DD ' else 'Cheque ' end || q.number || coalesce(' · ' || q.bank_name, '') || coalesce(' · ' || why, ''), 300);
  if q.direction = 'in' then
    perform set_config('app.no_twin', 'on', true);   -- confirming a cheque is never "the same payment twice?"
    r := public.api_bank_run(p_caller, md5(p_key::text || ':cheque')::uuid, p_hash, l.id, 'api_record_payment',
           jsonb_build_object('p_customer', q.customer_id, 'p_amount', l.amount, 'p_mode', 'Cheque', 'p_side', q.side, 'p_note', why), 'Cheque', null);
    perform set_config('app.no_twin', '', true);
    pid := nullif(r ->> 'payment_id', '')::uuid;
    update public.cheques set status = 'cleared', payment_id = pid, clear_line_id = l.id, account_id = l.account_id where id = q.id;
  elsif q.expense_id is not null then
    perform public.api_bank_link(p_caller, md5(p_key::text || ':cheque')::uuid, p_hash, l.id, 'expense', q.expense_id, null);
    update public.cheques set status = 'cleared', clear_line_id = l.id, account_id = l.account_id where id = q.id;
  else
    select name into sname from public.suppliers where company_id = c.company_id and id = q.supplier_id;
    r := public.api_bank_run(p_caller, md5(p_key::text || ':cheque')::uuid, p_hash, l.id, 'api_save_expense',
           jsonb_build_object('kind', 'supplier', 'supplier_id', q.supplier_id, 'paid_to', left(sname, 80), 'note', why), 'Cheque', null);
    eid := nullif(r ->> 'expense_id', '')::uuid;
    update public.cheques set status = 'cleared', expense_id = eid, clear_line_id = l.id, account_id = l.account_id where id = q.id;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('cheque_id', q.id, 'payment_id', pid, 'expense_id', coalesce(eid, q.expense_id), 'status', 'cleared'));
end $$;

/**
 * Owner: this statement line is this cheque COMING BACK (returned / bounced). Nothing is counted twice:
 *  in, already confirmed → its payment is cancelled (the due comes back once; F1); its clearing line and the return line
 *     are both closed ("Cheque … returned"), so the bank adds up.
 *  in, not confirmed yet → the deposit line (p_deposit_line, when it is in a statement) and the return line are closed;
 *     the khata never changed.
 *  out (our cheque to a supplier came back) → its supplier payment is cancelled (the supplier is owed again); both lines closed.
 * p_charge: return charges to add to the customer's khata — 0 / null = none (the default; the owner ticks it).
 * A DD cannot bounce: it is cancelled instead.
 */
create function public.api_cheque_return(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_line uuid, p_deposit_line uuid, p_charge numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; q public.cheques; l public.bank_lines; d public.bank_lines; tz text; why text; v_dep uuid;
  v_charge numeric := nullif(round(coalesce(p_charge, 0), 2), 0);
begin
  perform app.require(c, 'settings', 'money');
  prev := app.idem_start(c.company_id, p_key, 'chequeReturn', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select timezone into tz from public.companies where id = c.company_id;
  select * into q from public.cheques where company_id = c.company_id and id = p_id for update;
  if q.id is null then raise exception 'Cheque not found.' using errcode = '22023'; end if;
  if q.side = 'kacha' then perform app.require(c, 'kacha'); end if;
  if q.status in ('returned', 'cancelled') then raise exception 'This cheque is already %.', q.status using errcode = '23001'; end if;
  if q.direction = 'in' and q.instrument = 'dd' then raise exception 'A DD can''t bounce — cancel it instead.' using errcode = '22023'; end if;
  if v_charge is not null and (v_charge < 0 or v_charge > 100000 or q.direction <> 'in') then raise exception 'Check the return charges.' using errcode = '22023'; end if;
  l := app.bank_line_for(c, p_line);
  if l.status <> 'open' then raise exception 'This bank line is already done.' using errcode = '23001'; end if;
  if (q.direction = 'in' and l.amount >= 0) or (q.direction = 'out' and l.amount <= 0) then
    raise exception 'That line is not this cheque coming back.' using errcode = '22023';
  end if;
  if abs(abs(l.amount) - q.amount) > 0.005 then raise exception 'The amounts are different.' using errcode = '22023'; end if;
  why := left(case when q.instrument = 'dd' then 'DD ' else 'Cheque ' end || q.number || ' returned' || coalesce(' — ' || nullif(btrim(p_note), ''), ''), 300);
  v_dep := q.clear_line_id;
  if q.direction = 'in' and q.payment_id is not null then
    -- F1: cancelling the payment puts the due back and reopens its clearing line, which is then closed with the reason
    perform public.api_reverse_payment(p_caller, md5(p_key::text || ':reverse')::uuid, p_hash, q.payment_id, why);
    update public.bank_lines set status = 'skipped', note = why, done_by = c.id, done_at = now()
      where company_id = c.company_id and id = q.clear_line_id and status = 'open';
  elsif q.direction = 'in' and p_deposit_line is not null then
    d := app.bank_line_for(c, p_deposit_line);
    if d.status <> 'open' or d.account_id <> l.account_id or abs(d.amount - q.amount) > 0.005 then
      raise exception 'That deposit line does not fit this cheque.' using errcode = '22023';
    end if;
    update public.bank_lines set status = 'skipped', note = why, done_by = c.id, done_at = now() where id = d.id;
    v_dep := d.id;
  elsif q.direction = 'out' and q.expense_id is not null then
    perform public.api_cancel_expense(p_caller, md5(p_key::text || ':cancel')::uuid, p_hash, q.expense_id, why);   -- F1 reopens its line
    update public.bank_lines set status = 'skipped', note = why, done_by = c.id, done_at = now()
      where company_id = c.company_id and id = q.clear_line_id and status = 'open';
  end if;
  update public.bank_lines set status = 'skipped', note = why, done_by = c.id, done_at = now() where id = l.id;
  update public.cheques set status = 'returned', payment_id = q.payment_id, expense_id = q.expense_id, clear_line_id = v_dep, return_line_id = l.id,
      return_charges = v_charge, note = coalesce(nullif(btrim(p_note), ''), note) where id = q.id;
  if v_charge is not null then
    insert into public.old_dues (company_id, customer_id, side, ref, due_date, amount, note, created_by)
      values (c.company_id, q.customer_id, q.side, null, (now() at time zone tz)::date, v_charge,
              left(case when q.instrument = 'dd' then 'DD ' else 'Cheque ' end || q.number || ' return charges', 500), c.id);
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('cheque_id', q.id, 'status', 'returned', 'charge', v_charge));
end $$;

-- ---------- following what happens elsewhere ----------
-- a supplier payment made by cheque ticked against a statement line in the normal bank review: that cheque has cleared;
-- the tick taken back (the line reopened): the cheque is waiting again
create function app.cheque_line_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('linked', 'added') and new.expense_id is not null then
    update public.cheques set status = 'cleared', clear_line_id = new.id
      where company_id = new.company_id and direction = 'out' and expense_id = new.expense_id and status = 'given';
  elsif new.status = 'open' and old.status in ('linked', 'added') then
    update public.cheques set status = 'given', clear_line_id = null
      where company_id = new.company_id and direction = 'out' and clear_line_id = new.id and status = 'cleared';
  end if;
  return null;
end $$;
create trigger cheque_follow after update of status on public.bank_lines for each row
  when (new.status is distinct from old.status) execute function app.cheque_line_follow();

-- a cleared cheque's payment cancelled from the khata: the cheque is back to "waiting" (deposited), never left "cleared"
create function app.cheque_payment_cancelled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.cheques set status = 'deposited', payment_id = null, clear_line_id = null,
      note = left('Its payment was cancelled' || coalesce(' — ' || new.note, ''), 300)
    where company_id = new.company_id and payment_id = new.reverses_payment_id and status = 'cleared';
  return null;
end $$;
create trigger cheque_follow after insert on public.payments for each row when (new.reverses_payment_id is not null)
  execute function app.cheque_payment_cancelled();

-- a supplier payment cancelled: its cheque is cancelled with it; changed (corrected): the cheque moves to the new entry
create function app.cheque_expense_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.cancel_reason is distinct from 'Changed' then
      update public.cheques set status = 'cancelled', note = left('Its supplier payment was cancelled' || coalesce(' — ' || new.cancel_reason, ''), 300)
        where company_id = new.company_id and expense_id = new.id and direction = 'out' and status in ('given', 'cleared');
    end if;
  else
    update public.cheques set expense_id = new.id
      where company_id = new.company_id and expense_id = new.replaces_id and direction = 'out' and status in ('given', 'cleared');
  end if;
  return null;
end $$;
create trigger cheque_follow after update of status on public.expenses for each row
  when (old.status = 'ok' and new.status = 'cancelled') execute function app.cheque_expense_follow();
create trigger cheque_follow_changed after insert on public.expenses for each row when (new.replaces_id is not null)
  execute function app.cheque_expense_follow();

-- F2 vs F5: confirming a cheque is never "the same payment twice?" (the rest of the check is unchanged)
create or replace function app.payment_twin_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare t record; tz text; fact jsonb;
begin
  if current_setting('app.no_twin', true) = 'on' then return null; end if;
  select timezone into tz from public.companies where id = new.company_id;
  for t in select p.*, pe.display_name as by_name from public.payments p left join public.people pe on pe.company_id = p.company_id and pe.id = p.created_by
            where p.company_id = new.company_id and p.customer_id = new.customer_id and p.id <> new.id and p.kind <> 'reversal'
              and abs(p.amount - new.amount) < 0.005 and abs(extract(epoch from (p.received_at - new.received_at))) <= 3 * 86400
              and not exists (select 1 from public.payments r where r.company_id = p.company_id and r.reverses_payment_id = p.id)
            order by abs(extract(epoch from (p.received_at - new.received_at))) limit 3 loop
    fact := jsonb_build_object('amount', new.amount,
      'new', jsonb_build_object('id', new.id, 'at', new.received_at, 'kind', new.kind, 'mode', new.mode, 'note', new.note, 'offline', new.entered_offline,
              'by', (select display_name from public.people where company_id = new.company_id and id = new.created_by),
              'bank', exists (select 1 from public.bank_lines b where b.company_id = new.company_id and b.payment_id = new.id)),
      'twin', jsonb_build_object('id', t.id, 'at', t.received_at, 'kind', t.kind, 'mode', t.mode, 'note', t.note, 'offline', t.entered_offline, 'by', t.by_name,
              'bank', exists (select 1 from public.bank_lines b where b.company_id = new.company_id and b.payment_id = t.id)));
    perform app.review_add(new.company_id, 'twin_payment', new.id, t.id, fact, new.customer_id, null,
      coalesce(new.side, (select o.bill_type from public.orders o where o.company_id = new.company_id and o.id = new.order_id)),
      case when new.entered_offline or t.entered_offline then 'important' else 'check' end, new.created_by);
  end loop;
  return null;
end $$;

/**
 * The register: everything still waiting (received / deposited / given) plus the last p_days of the rest; one customer's
 * with p_customer. Kacha cheques only for kacha people; supplier cheques for stock people and the owner.
 */
create function public.api_cheques(p_caller uuid, p_days int, p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; ins boolean; outs boolean; tz text;
begin
  perform app.require(c, 'money');
  k := app.has(c, 'kacha'); ins := app.has(c, 'khata'); outs := app.has(c, 'stock') or app.has(c, 'settings');
  select timezone into tz from public.companies where id = c.company_id;
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'direction', q.direction, 'instrument', q.instrument, 'number', q.number,
      'bank_name', q.bank_name, 'amount', q.amount, 'customer_id', q.customer_id, 'customer', cu.name, 'supplier_id', q.supplier_id, 'supplier', su.name,
      'side', q.side, 'cheque_date', q.cheque_date, 'got_on', q.got_on, 'status', q.status, 'account_id', q.account_id, 'account', ma.name,
      'payment_id', q.payment_id, 'expense_id', q.expense_id, 'clear_line_id', q.clear_line_id, 'return_line_id', q.return_line_id,
      'return_charges', q.return_charges, 'note', q.note, 'by', pe.display_name, 'created_at', q.created_at)
      order by (q.status in ('received','deposited','given')) desc, q.got_on desc, q.created_at desc)
    from public.cheques q
    left join public.customers cu on cu.company_id = q.company_id and cu.id = q.customer_id
    left join public.suppliers su on su.company_id = q.company_id and su.id = q.supplier_id
    left join public.money_accounts ma on ma.company_id = q.company_id and ma.id = q.account_id
    left join public.people pe on pe.company_id = q.company_id and pe.id = q.created_by
    where q.company_id = c.company_id
      and ((q.direction = 'in' and ins and (k or q.side <> 'kacha')) or (q.direction = 'out' and outs))
      and (p_customer is null or q.customer_id = p_customer)
      and (q.status in ('received','deposited','given') or q.got_on >= (now() at time zone tz)::date - least(greatest(coalesce(p_days, 120), 1), 800))), '[]'::jsonb);
end $$;

revoke all on function public.api_cheque_add(uuid, uuid, text, jsonb), public.api_cheque_mark(uuid, uuid, text, uuid, text, uuid, text),
  public.api_cheque_clear(uuid, uuid, text, uuid, uuid, text, jsonb), public.api_cheque_return(uuid, uuid, text, uuid, uuid, uuid, numeric, text),
  public.api_cheques(uuid, int, uuid), app.cheque_may(public.people, text, text) from public, anon, authenticated;
grant execute on function public.api_cheque_add(uuid, uuid, text, jsonb), public.api_cheque_mark(uuid, uuid, text, uuid, text, uuid, text),
  public.api_cheque_clear(uuid, uuid, text, uuid, uuid, text, jsonb), public.api_cheque_return(uuid, uuid, text, uuid, uuid, uuid, numeric, text),
  public.api_cheques(uuid, int, uuid) to service_role;
