-- 5 Nov 2026 (plan v2, F6): the supplier khata.
-- What we owe a supplier is worked out from the records (@srs/core supplierLedger): opening balance + bills − payments
-- − credit notes. Payments are set against bills by the person (oldest first is only a suggestion); the rest is money
-- with the supplier (an advance). Returns, rate differences and discounts are their own entries (a return also takes the
-- steel out of stock). The old "Paid" tick becomes "paid outside the app": out of the due, kept as it was; a later
-- payment can be LINKED to such a bill (the mark comes off, the due does not move twice).
-- purchases.pay_status stays, now kept right by the database itself (paid = nothing left / paid outside the app).

-- ---------- a) supplier credit days, "paid outside the app" ----------
alter table public.suppliers add column credit_days smallint check (credit_days is null or credit_days between 0 and 365);
alter table public.purchases
  add column settled    text check (settled is null or settled = 'outside'),
  add column settled_by uuid,
  add column settled_at timestamptz,
  add constraint purchases_settled_by foreign key (company_id, settled_by) references public.people(company_id, id);

-- ---------- b) opening balances and credit notes ----------
create table public.supplier_notes (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete restrict,
  supplier_id    uuid not null,
  kind           text not null check (kind in ('opening','return','rate','discount','other')),
  side           text not null check (side in ('pakka','kacha')),
  direction      text not null default 'credit' check (direction in ('owe','credit')),   -- opening: owe = we owe them, credit = they owe us
  purchase_id    uuid,                                                                     -- a note against one bill
  amount         numeric(14,2) not null check (amount > 0 and amount <= 1000000000),
  note_no        text check (note_no is null or length(btrim(note_no)) between 1 and 40),
  note_date      date not null,
  note           text check (note is null or length(note) <= 300),
  status         text not null default 'ok' check (status in ('ok','cancelled')),
  cancelled_at   timestamptz,
  cancelled_by   uuid,
  cancel_reason  text check (cancel_reason is null or length(btrim(cancel_reason)) between 1 and 300),
  created_by     uuid,
  created_at     timestamptz not null default now(),
  idempotency_key uuid,
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, supplier_id) references public.suppliers(company_id, id),
  foreign key (company_id, purchase_id) references public.purchases(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  foreign key (company_id, cancelled_by) references public.people(company_id, id),
  constraint supplier_notes_dir check ((kind = 'opening') or (direction = 'credit')),
  constraint supplier_notes_opening check (kind <> 'opening' or purchase_id is null)
);
comment on table public.supplier_notes is 'Supplier opening balances and credit notes (returns, rate differences, discounts). Cancel only, never edited.';
create unique index supplier_notes_one_opening on public.supplier_notes (company_id, supplier_id, side) where kind = 'opening' and status = 'ok';
create index supplier_notes_supplier on public.supplier_notes (company_id, supplier_id);
alter table public.supplier_notes enable row level security;
revoke all on public.supplier_notes from anon, authenticated;
create trigger guard before update or delete on public.supplier_notes for each row execute function app.guard_cancel_only();
create trigger audit after insert or update on public.supplier_notes for each row execute function app.audit_row();

create table public.supplier_note_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  note_id       uuid not null,
  stock_item_id uuid not null,
  qty_kg        numeric(14,3) not null check (qty_kg > 0),
  unique (company_id, id),
  foreign key (company_id, note_id) references public.supplier_notes(company_id, id),
  foreign key (company_id, stock_item_id) references public.stock_items(company_id, id)
);
alter table public.supplier_note_lines enable row level security;
revoke all on public.supplier_note_lines from anon, authenticated;
create trigger no_change before update or delete on public.supplier_note_lines for each row execute function app.forbid_change();

-- goods sent back to the supplier leave the stock (and come back if the note is cancelled)
alter table public.stock_moves add column supplier_note_line_id uuid,
  add constraint stock_moves_note_line foreign key (company_id, supplier_note_line_id) references public.supplier_note_lines(company_id, id);
alter table public.stock_moves drop constraint stock_moves_kind_check,
  add constraint stock_moves_kind_check check (kind in ('purchase','purchase_undo','sale','sale_undo','adjust','scrap','return_out','return_undo'));
alter table public.stock_moves drop constraint stock_moves_sign,
  add constraint stock_moves_sign check (kind = 'adjust' or (kind in ('purchase','sale_undo','return_undo')) = (qty_kg > 0));
alter table public.stock_moves add constraint stock_moves_return_link check ((kind in ('return_out','return_undo')) = (supplier_note_line_id is not null));

-- ---------- c) which bills a payment was for ----------
create table public.supplier_allocations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  expense_id  uuid not null,                     -- the supplier payment
  purchase_id uuid,                              -- a bill …
  opening_id  uuid,                              -- … or the opening balance
  amount      numeric(14,2) not null check (amount > 0),
  status      text not null default 'ok' check (status in ('ok','undone')),
  undone_at   timestamptz,
  undone_by   uuid,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, expense_id) references public.expenses(company_id, id),
  foreign key (company_id, purchase_id) references public.purchases(company_id, id),
  foreign key (company_id, opening_id) references public.supplier_notes(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  foreign key (company_id, undone_by) references public.people(company_id, id),
  constraint supplier_allocations_one check (num_nonnulls(purchase_id, opening_id) = 1)
);
create index supplier_allocations_bill on public.supplier_allocations (company_id, purchase_id) where status = 'ok';
create index supplier_allocations_expense on public.supplier_allocations (company_id, expense_id);
alter table public.supplier_allocations enable row level security;
revoke all on public.supplier_allocations from anon, authenticated;
create function app.guard_undo_only() returns trigger
language plpgsql set search_path = '' as $$
declare keep text[] := array['status','undone_at','undone_by'];
begin
  if tg_op = 'DELETE' then raise exception '% records cannot be deleted.', tg_table_name using errcode = 'restrict_violation'; end if;
  if old.status <> 'ok' or new.status <> 'undone' or (to_jsonb(new) - keep) <> (to_jsonb(old) - keep) then
    raise exception '% records can only be undone, never changed.', tg_table_name using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
create trigger guard before update or delete on public.supplier_allocations for each row execute function app.guard_undo_only();
create trigger audit after insert or update on public.supplier_allocations for each row execute function app.audit_row();

-- ---------- d) a bill's "paid" kept right by the database ----------
/** What is still owed on a bill: total − live allocations of live payments − live notes on it. */
create function app.purchase_left(p_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select p.total_amount
       - coalesce((select sum(a.amount) from public.supplier_allocations a join public.expenses e on e.company_id = a.company_id and e.id = a.expense_id
                   where a.company_id = p.company_id and a.purchase_id = p.id and a.status = 'ok' and e.status = 'ok'), 0)
       - coalesce((select sum(n.amount) from public.supplier_notes n where n.company_id = p.company_id and n.purchase_id = p.id and n.status = 'ok'), 0)
  from public.purchases p where p.id = p_id
$$;
/** How much of an opening balance (we owe) is still owed. */
create function app.opening_left(p_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select n.amount - coalesce((select sum(a.amount) from public.supplier_allocations a join public.expenses e on e.company_id = a.company_id and e.id = a.expense_id
                              where a.company_id = n.company_id and a.opening_id = n.id and a.status = 'ok' and e.status = 'ok'), 0)
  from public.supplier_notes n where n.id = p_id and n.kind = 'opening' and n.direction = 'owe' and n.status = 'ok'
$$;

create function app.purchase_pay_state() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_left numeric;
begin
  if new.kind <> 'bill' then return new; end if;
  -- "Paid" chosen while saving a bill (no money recorded in the app, as before): paid outside the app
  if tg_op = 'INSERT' and new.pay_status = 'paid' and new.settled is null then
    new.settled := 'outside'; new.settled_at := now(); new.settled_by := nullif(current_setting('app.person_id', true), '')::uuid;
  end if;
  if new.settled = 'outside' then
    new.pay_status := 'paid'; new.paid_at := coalesce(new.settled_at, new.paid_at, now());
  elsif tg_op = 'INSERT' then
    new.pay_status := 'to_pay'; new.paid_at := null;
  else
    v_left := app.purchase_left(new.id) - (old.total_amount - new.total_amount);
    if v_left <= 0.5 then
      new.pay_status := 'paid'; new.paid_at := case when old.pay_status = 'paid' and old.settled is null then old.paid_at else now() end;
    else
      new.pay_status := 'to_pay'; new.paid_at := null;
    end if;
  end if;
  return new;
end $$;
create trigger pay_state before insert or update on public.purchases for each row execute function app.purchase_pay_state();

/** Bring these bills' "paid" up to date (only the ones that changed, so the history is not filled with no-ops). */
create function app.purchases_touch(p_company uuid, p_ids uuid[]) returns void
language sql security definer set search_path = '' as $$
  update public.purchases p set pay_status = p.pay_status
    where p.company_id = p_company and p.id = any(p_ids) and p.kind = 'bill'
      and (case when p.settled = 'outside' or app.purchase_left(p.id) <= 0.5 then 'paid' else 'to_pay' end) <> p.pay_status
$$;
create function app.alloc_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.purchase_id is not null then perform app.purchases_touch(new.company_id, array[new.purchase_id]); end if;
  return null;
end $$;
create trigger touch after insert or update on public.supplier_allocations for each row execute function app.alloc_touch();
create function app.note_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.purchase_id is not null then perform app.purchases_touch(new.company_id, array[new.purchase_id]); end if;
  return null;
end $$;
create trigger touch after insert or update on public.supplier_notes for each row execute function app.note_touch();
create function app.expense_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform app.purchases_touch(new.company_id, coalesce((select array_agg(distinct a.purchase_id) from public.supplier_allocations a
    where a.company_id = new.company_id and a.expense_id = new.id and a.purchase_id is not null), '{}'));
  return null;
end $$;
create trigger supplier_touch after update of status on public.expenses for each row
  when (old.status = 'ok' and new.status = 'cancelled' and new.kind = 'supplier') execute function app.expense_touch();


-- a bill cancelled (entered by mistake): payments set against it become money with the supplier again (they are not lost);
-- a bill with a live credit note is cancelled only after the note
create function app.purchase_cancel_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.supplier_notes where company_id = new.company_id and purchase_id = new.id and status = 'ok') then
    raise exception 'This bill has a credit note — cancel the note first.' using errcode = '23001';
  end if;
  update public.supplier_allocations set status = 'undone', undone_at = now(), undone_by = nullif(current_setting('app.person_id', true), '')::uuid
    where company_id = new.company_id and purchase_id = new.id and status = 'ok';
  return null;
end $$;
create trigger supplier_follow after update of status on public.purchases for each row
  when (old.status = 'saved' and new.status = 'cancelled') execute function app.purchase_cancel_follow();

-- ---------- e) setting a payment against bills ----------
/**
 * Set a supplier payment against bills / the opening balance. parts = [{ purchase_id | opening_id, amount, outside }].
 * outside = true: LINK it to a bill marked "paid outside the app" — the mark comes off and this payment is its payment.
 * Each part ≤ what that bill still owes; all parts ≤ the payment (the rest is an advance). p_lenient (an entry made
 * offline): a part that no longer fits is cut down and the owner is told in "To check", instead of refusing.
 */
create function app.supplier_allocate(c public.people, e public.expenses, p_parts jsonb, p_lenient boolean) returns numeric
language plpgsql security definer set search_path = '' as $$
declare x jsonb; v_amt numeric; v_sum numeric := 0; b public.purchases; o public.supplier_notes; v_left numeric; v_cut text := '';
begin
  if p_parts is null or jsonb_typeof(p_parts) = 'null' then return 0; end if;
  if jsonb_typeof(p_parts) <> 'array' or jsonb_array_length(p_parts) > 60 then raise exception 'Choose the bills.' using errcode = '22023'; end if;
  for x in select * from jsonb_array_elements(p_parts) loop
    v_amt := round(nullif(x ->> 'amount', '')::numeric, 2);
    if v_amt is null or v_amt <= 0 then raise exception 'Check the amounts against the bills.' using errcode = '22023'; end if;
    if nullif(x ->> 'opening_id', '') is not null then
      select * into o from public.supplier_notes where company_id = c.company_id and id = (x ->> 'opening_id')::uuid
        and supplier_id = e.supplier_id and kind = 'opening' and direction = 'owe' and status = 'ok';
      if o.id is null or (o.side = 'kacha' and not app.has(c, 'kacha')) then raise exception 'That opening balance is not this supplier''s.' using errcode = '22023'; end if;
      v_left := app.opening_left(o.id);
    else
      select * into b from public.purchases where company_id = c.company_id and id = nullif(x ->> 'purchase_id', '')::uuid for update;
      if b.id is null or b.supplier_id is distinct from e.supplier_id or b.status <> 'saved' or b.kind <> 'bill'
         or (b.bill_type = 'kacha' and not app.has(c, 'kacha')) then
        raise exception 'Those bills are not this supplier''s.' using errcode = '22023';
      end if;
      if b.settled = 'outside' then
        if coalesce((x ->> 'outside')::boolean, false) is not true then
          raise exception 'Bill % is marked paid outside the app — link the payment to it instead.', coalesce(b.bill_no, '') using errcode = '22023';
        end if;
        update public.purchases set settled = null, settled_at = null, settled_by = null where id = b.id;   -- now this payment is its payment
      end if;
      v_left := app.purchase_left(b.id);
    end if;
    if v_amt > v_left + 0.5 then
      if not p_lenient then raise exception 'That is more than the bill still owes (%).', round(v_left, 2) using errcode = '22023'; end if;
      v_cut := v_cut || coalesce(' ' || b.bill_no, '');
      v_amt := round(greatest(v_left, 0), 2);
    end if;
    if v_sum + v_amt > e.amount + 0.005 then
      if not p_lenient then raise exception 'The bills add up to more than the payment.' using errcode = '22023'; end if;
      v_amt := round(greatest(e.amount - v_sum, 0), 2);
    end if;
    if v_amt > 0 then
      insert into public.supplier_allocations (company_id, expense_id, purchase_id, opening_id, amount, created_by)
        values (c.company_id, e.id, case when o.id is null then b.id end, o.id, v_amt, c.id);
      v_sum := v_sum + v_amt;
    end if;
    b := null; o := null;
  end loop;
  if v_cut <> '' then
    perform app.review_add(c.company_id, 'supplier_check', e.id, null,
      jsonb_build_object('text', 'A payment saved offline was more than bill(s)' || v_cut || ' still owed — the extra is kept as money with the supplier.'),
      null, e.supplier_id, null, 'check', c.id);
  end if;
  return v_sum;
end $$;

/** "Paid a supplier" with oldest-first allocation of the bills ticked (the old way: purchase_ids only). */
create function app.supplier_auto_parts(c public.people, p_supplier uuid, p_bills uuid[], p_amount numeric) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r record; v_rest numeric := p_amount; v_use numeric; out jsonb := '[]'::jsonb;
begin
  for r in select p.id, app.purchase_left(p.id) as lft from public.purchases p
            where p.company_id = c.company_id and p.id = any(p_bills) and p.supplier_id = p_supplier and p.settled is null
            order by p.bill_date, p.created_at loop
    exit when v_rest <= 0.005;
    v_use := least(v_rest, greatest(r.lft, 0));
    if v_use > 0 then out := out || jsonb_build_object('purchase_id', r.id, 'amount', round(v_use, 2)); v_rest := v_rest - v_use; end if;
  end loop;
  return out;
end $$;

-- api_save_expense, now with { allocations: [{ purchase_id | opening_id, amount, outside }] } for supplier payments.
-- Without allocations, ticked bills (purchase_ids) are paid oldest first up to the payment (the rest = an advance).
-- The bills' "paid" is kept right by the database (it no longer just says "paid").
create or replace function public.api_save_expense(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.people := app.caller(p_caller); prev jsonb; v_tz text; a public.money_accounts; e public.expenses; old public.expenses;
  v_kind text := coalesce(p ->> 'kind', 'expense'); v_amt numeric := round((p ->> 'amount')::numeric, 2); v_at timestamptz;
  v_gst boolean := coalesce((p ->> 'gst_bill')::boolean, false); v_sup uuid := nullif(p ->> 'supplier_id', '')::uuid;
  v_bills uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'purchase_ids', '[]')) x), '{}');
  v_old uuid := nullif(p ->> 'replaces_id', '')::uuid; n int; boss boolean := app.has(c, 'settings'); v_parts jsonb;
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
    -- the bills it is for: as the person split it, else the ticked bills oldest first (purchase_ids keeps the list, as before)
    if jsonb_typeof(p -> 'allocations') = 'array' then
      v_parts := p -> 'allocations';
      v_bills := coalesce((select array_agg(distinct (x ->> 'purchase_id')::uuid) from jsonb_array_elements(v_parts) x where nullif(x ->> 'purchase_id', '') is not null), '{}');
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

  if v_old is not null then  -- a corrected entry: the old one is cancelled in the same step (its bills open again)
    select * into old from public.expenses where company_id = c.company_id and id = v_old for update;
    if old.id is null then raise exception 'Expense not found.' using errcode = '22023'; end if;
    if old.status <> 'ok' then raise exception 'That expense was already cancelled or changed.' using errcode = '23001'; end if;
    if not boss and (old.created_by is distinct from c.id or old.business_date < (now() at time zone v_tz)::date) then
      raise exception 'Only the owner can change an older expense or someone else''s.' using errcode = '42501';
    end if;
    if old.kind <> v_kind then raise exception 'Cancel it and add a new one instead.' using errcode = '22023'; end if;
    update public.expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = 'Changed' where id = old.id;
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
  if v_kind = 'supplier' then
    if v_parts is null and cardinality(v_bills) > 0 then v_parts := app.supplier_auto_parts(c, v_sup, v_bills, v_amt); end if;
    perform app.supplier_allocate(c, e, v_parts, e.entered_offline);
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('expense_id', e.id, 'amount', e.amount, 'day', e.business_date,
    'mode', app.part_mode(a.kind, e.method), 'replaced', v_old));
end $$;

/** Set (again) which bills an existing supplier payment was for: the old split is undone (kept), the new one saved. */
create function public.api_supplier_allocate(p_caller uuid, p_key uuid, p_hash text, p_expense uuid, p_parts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; e public.expenses; v_set numeric; ids uuid[];
begin
  if not (app.has(c, 'stock') or app.has(c, 'settings')) then perform app.require(c, 'stock'); end if;
  prev := app.idem_start(c.company_id, p_key, 'supplierAllocate', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into e from public.expenses where company_id = c.company_id and id = p_expense and kind = 'supplier' for update;
  if e.id is null then raise exception 'Supplier payment not found.' using errcode = '22023'; end if;
  if e.status <> 'ok' then raise exception 'That payment was cancelled.' using errcode = '23001'; end if;
  if not app.has(c, 'kacha') and exists (select 1 from public.supplier_allocations a join public.purchases p on p.company_id = a.company_id and p.id = a.purchase_id
      where a.company_id = c.company_id and a.expense_id = e.id and a.status = 'ok' and p.bill_type = 'kacha') then
    raise exception 'Only the owner can change this payment''s bills.' using errcode = '42501';
  end if;
  select array_agg(purchase_id) into ids from public.supplier_allocations where company_id = c.company_id and expense_id = e.id and status = 'ok' and purchase_id is not null;
  update public.supplier_allocations set status = 'undone', undone_at = now(), undone_by = c.id
    where company_id = c.company_id and expense_id = e.id and status = 'ok';
  v_set := app.supplier_allocate(c, e, coalesce(p_parts, '[]'::jsonb), false);
  perform app.purchases_touch(c.company_id, coalesce(ids, '{}'));
  return app.idem_done(c.company_id, p_key, jsonb_build_object('expense_id', e.id, 'set', v_set, 'advance', e.amount - v_set));
end $$;

-- ---------- f) opening balance, credit days, credit notes ----------
/** Owner: what was owed on the day the shop started with the app — { supplier_id, side, direction owe|credit, amount (0 = none), date, note }. */
create function public.api_supplier_opening(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; v_sup uuid := nullif(p ->> 'supplier_id', '')::uuid; v_side text := coalesce(nullif(p ->> 'side', ''), 'pakka');
  v_dir text := coalesce(nullif(p ->> 'direction', ''), 'owe'); v_amt numeric := round(coalesce(nullif(p ->> 'amount', '')::numeric, 0), 2);
  old public.supplier_notes; nid uuid; tz text; v_day date; r record; v_left numeric;
begin
  perform app.require(c, 'settings');
  if v_side = 'kacha' then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'supplierOpening', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if v_side not in ('pakka','kacha') or v_dir not in ('owe','credit') then raise exception 'Wrong request.' using errcode = '22023'; end if;
  if v_amt < 0 or v_amt > 1000000000 then raise exception 'Enter the amount.' using errcode = '22023'; end if;
  if not exists (select 1 from public.suppliers where company_id = c.company_id and id = v_sup) then raise exception 'Supplier not found.' using errcode = '22023'; end if;
  select co.timezone, (co.created_at at time zone co.timezone)::date into tz, v_day from public.companies co where co.id = c.company_id;
  v_day := coalesce(nullif(p ->> 'date', '')::date, v_day);
  select * into old from public.supplier_notes where company_id = c.company_id and supplier_id = v_sup and side = v_side and kind = 'opening' and status = 'ok' for update;
  if old.id is not null then
    update public.supplier_notes set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = 'Changed' where id = old.id;
  end if;
  if v_amt > 0 then
    insert into public.supplier_notes (company_id, supplier_id, kind, side, direction, amount, note_date, note, created_by, idempotency_key)
      values (c.company_id, v_sup, 'opening', v_side, v_dir, v_amt, v_day, left(nullif(btrim(p ->> 'note'), ''), 300), c.id, p_key) returning id into nid;
  end if;
  -- payments set against the old opening move to the new one (as far as it goes; the rest becomes money with the supplier)
  if old.id is not null then
    for r in select a.* from public.supplier_allocations a join public.expenses e on e.company_id = a.company_id and e.id = a.expense_id
              where a.company_id = c.company_id and a.opening_id = old.id and a.status = 'ok' and e.status = 'ok' order by a.created_at loop
      update public.supplier_allocations set status = 'undone', undone_at = now(), undone_by = c.id where id = r.id;
      if nid is not null and v_dir = 'owe' then
        v_left := app.opening_left(nid);
        if least(v_left, r.amount) > 0 then
          insert into public.supplier_allocations (company_id, expense_id, opening_id, amount, created_by) values (c.company_id, r.expense_id, nid, round(least(v_left, r.amount), 2), c.id);
        end if;
      end if;
    end loop;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('opening_id', nid, 'replaced', old.id));
end $$;

create function public.api_supplier_settings(p_caller uuid, p_key uuid, p_hash text, p_supplier uuid, p_credit_days int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; sid uuid;
begin
  if not (app.has(c, 'stock') or app.has(c, 'settings')) then perform app.require(c, 'stock'); end if;
  prev := app.idem_start(c.company_id, p_key, 'supplierSettings', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_credit_days is not null and (p_credit_days < 0 or p_credit_days > 365) then raise exception 'Credit days: 0 to 365.' using errcode = '22023'; end if;
  update public.suppliers set credit_days = p_credit_days where company_id = c.company_id and id = p_supplier returning id into sid;
  if sid is null then raise exception 'Supplier not found.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('supplier_id', sid, 'credit_days', p_credit_days));
end $$;

/**
 * A credit note from the supplier: { supplier_id, kind return|rate|discount|other, purchase_id (optional: against one
 * bill), side, amount, note_no, date, note, lines: [{ stock_item_id, kg }] (a return: the steel sent back) }.
 */
create function public.api_supplier_note(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; v_sup uuid := nullif(p ->> 'supplier_id', '')::uuid; v_kind text := p ->> 'kind';
  v_amt numeric := round(nullif(p ->> 'amount', '')::numeric, 2); v_side text := coalesce(nullif(p ->> 'side', ''), 'pakka'); b public.purchases;
  nid uuid; x jsonb; v_kg numeric; v_item uuid; lid uuid; tz text; v_day date; n int := 0;
begin
  if not (app.has(c, 'stock') or app.has(c, 'settings')) then perform app.require(c, 'stock'); end if;
  prev := app.idem_start(c.company_id, p_key, 'supplierNote', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if v_kind not in ('return','rate','discount','other') then raise exception 'What is the note for?' using errcode = '22023'; end if;
  if v_amt is null or v_amt <= 0 or v_amt > 1000000000 then raise exception 'Enter the amount.' using errcode = '22023'; end if;
  if not exists (select 1 from public.suppliers where company_id = c.company_id and id = v_sup) then raise exception 'Supplier not found.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  v_day := coalesce(nullif(p ->> 'date', '')::date, (now() at time zone tz)::date);
  if v_day > (now() at time zone tz)::date or v_day < (now() at time zone tz)::date - 400 then raise exception 'Check the date.' using errcode = '22023'; end if;
  if nullif(p ->> 'purchase_id', '') is not null then
    select * into b from public.purchases where company_id = c.company_id and id = (p ->> 'purchase_id')::uuid for update;
    if b.id is null or b.supplier_id <> v_sup or b.status <> 'saved' then raise exception 'That bill is not this supplier''s.' using errcode = '22023'; end if;
    if b.settled = 'outside' then raise exception 'That bill is marked paid outside the app.' using errcode = '22023'; end if;
    v_side := b.bill_type;
    if v_amt > app.purchase_left(b.id) + 0.5 then
      raise exception 'That is more than the bill still owes (%) — save it without the bill.', round(app.purchase_left(b.id), 2) using errcode = '22023';
    end if;
  end if;
  if v_side not in ('pakka','kacha') then raise exception 'Choose Pakka or Kacha.' using errcode = '22023'; end if;
  if v_side = 'kacha' then perform app.require(c, 'kacha'); end if;
  if v_kind = 'return' and (coalesce(jsonb_typeof(p -> 'lines'), '') <> 'array' or jsonb_array_length(p -> 'lines') = 0) then
    raise exception 'Which steel went back, and how many kg?' using errcode = '22023';
  end if;
  insert into public.supplier_notes (company_id, supplier_id, kind, side, purchase_id, amount, note_no, note_date, note, created_by, idempotency_key)
    values (c.company_id, v_sup, v_kind, v_side, b.id, v_amt, nullif(btrim(p ->> 'note_no'), ''), v_day, left(nullif(btrim(p ->> 'note'), ''), 300), c.id, p_key)
    returning id into nid;
  if v_kind = 'return' then
    for x in select * from jsonb_array_elements(p -> 'lines') loop
      v_item := nullif(x ->> 'stock_item_id', '')::uuid; v_kg := round(nullif(x ->> 'kg', '')::numeric, 3);
      if v_kg is null or v_kg <= 0 then raise exception 'Enter the kg sent back.' using errcode = '22023'; end if;
      perform 1 from public.stock_items where company_id = c.company_id and id = v_item for update;
      if not found then raise exception 'Choose the steel from the stock.' using errcode = '22023'; end if;
      if app.stock_on_hand(v_item) < v_kg - 0.0005 then raise exception 'Only % kg of it is in stock.', round(app.stock_on_hand(v_item), 1) using errcode = '23514'; end if;
      insert into public.supplier_note_lines (company_id, note_id, stock_item_id, qty_kg) values (c.company_id, nid, v_item, v_kg) returning id into lid;
      insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, supplier_note_line_id, note, created_by)
        values (c.company_id, v_item, 'return_out', -v_kg, lid, left('Sent back to the supplier' || coalesce(' · note ' || nullif(btrim(p ->> 'note_no'), ''), ''), 300), c.id);
      n := n + 1;
    end loop;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('note_id', nid, 'lines', n));
end $$;

create function public.api_supplier_note_cancel(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; nt public.supplier_notes; why text := btrim(coalesce(p_reason, ''));
begin
  if not (app.has(c, 'stock') or app.has(c, 'settings')) then perform app.require(c, 'stock'); end if;
  if why = '' then raise exception 'Write why it is cancelled.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'supplierNoteCancel', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into nt from public.supplier_notes where company_id = c.company_id and id = p_id for update;
  if nt.id is null or nt.kind = 'opening' or (nt.side = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Note not found.' using errcode = '22023'; end if;
  if nt.status <> 'ok' then raise exception 'It is already cancelled.' using errcode = '23001'; end if;
  update public.supplier_notes set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = left(why, 300) where id = nt.id;
  insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, supplier_note_line_id, note, created_by)
    select l.company_id, l.stock_item_id, 'return_undo', l.qty_kg, l.id, left('Return cancelled: ' || why, 300), c.id
    from public.supplier_note_lines l where l.company_id = c.company_id and l.note_id = nt.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('note_id', nt.id, 'status', 'cancelled'));
end $$;

-- the old tick: now "paid outside the app" (on / off) — never on a bill with payments set against it
create or replace function public.api_purchase_paid(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_paid boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; b public.purchases;
begin
  perform app.require(c, 'stock');
  prev := app.idem_start(c.company_id, p_key, 'purchasePaid', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into b from public.purchases where id = p_id and company_id = c.company_id and (bill_type = 'pakka' or app.has(c, 'kacha')) for update;
  if b.id is null or b.kind <> 'bill' then raise exception 'Bill not found.' using errcode = '22023'; end if;
  if p_paid and b.settled is null and app.purchase_left(b.id) < b.total_amount - 0.5 then
    raise exception 'Payments are already set against this bill — record the rest as a payment.' using errcode = '23001';
  end if;
  update public.purchases set settled = case when p_paid then 'outside' end, settled_at = case when p_paid then now() end,
      settled_by = case when p_paid then c.id end where id = b.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('purchase_id', b.id, 'pay_status', case when p_paid then 'paid' else (select pay_status from public.purchases where id = b.id) end));
end $$;

-- ---------- g) everything the supplier khata needs (worked out by @srs/core supplierLedger) ----------
-- Kacha bills / notes only for kacha people; for others a payment counts only what was not set against kacha bills.
create function public.api_supplier_data(p_caller uuid, p_supplier uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; tz text;
begin
  if not (app.has(c, 'stock') or app.has(c, 'settings')) then perform app.require(c, 'stock'); end if;
  k := app.has(c, 'kacha');
  select timezone into tz from public.companies where id = c.company_id;
  return jsonb_build_object(
    'today', (now() at time zone tz)::date,
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'credit_days', s.credit_days, 'gstin', s.gstin, 'city', s.city, 'phone', s.phone) order by s.name)
      from public.suppliers s where s.company_id = c.company_id and (p_supplier is null or s.id = p_supplier) and (s.active or s.id = p_supplier)), '[]'::jsonb),
    'bills', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'supplier_id', p.supplier_id, 'bill_no', p.bill_no, 'date', p.bill_date, 'side', p.bill_type,
        'total', p.total_amount, 'kg', p.total_kg, 'settled', p.settled, 'settled_at', p.settled_at, 'created_at', p.created_at, 'gst', p.gst_amount) order by p.bill_date, p.created_at)
      from public.purchases p where p.company_id = c.company_id and p.kind = 'bill' and p.status = 'saved' and (p_supplier is null or p.supplier_id = p_supplier)
        and (k or p.bill_type = 'pakka')), '[]'::jsonb),
    'openings', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'supplier_id', n.supplier_id, 'side', n.side, 'direction', n.direction, 'amount', n.amount,
        'date', n.note_date, 'note', n.note, 'by', pe.display_name))
      from public.supplier_notes n left join public.people pe on pe.company_id = n.company_id and pe.id = n.created_by
      where n.company_id = c.company_id and n.kind = 'opening' and n.status = 'ok' and (p_supplier is null or n.supplier_id = p_supplier) and (k or n.side = 'pakka')), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'supplier_id', n.supplier_id, 'kind', n.kind, 'side', n.side, 'purchase_id', n.purchase_id,
        'amount', n.amount, 'note_no', n.note_no, 'date', n.note_date, 'note', n.note, 'by', pe.display_name,
        'kg', (select sum(l.qty_kg) from public.supplier_note_lines l where l.company_id = n.company_id and l.note_id = n.id)) order by n.note_date)
      from public.supplier_notes n left join public.people pe on pe.company_id = n.company_id and pe.id = n.created_by
      where n.company_id = c.company_id and n.kind <> 'opening' and n.status = 'ok' and (p_supplier is null or n.supplier_id = p_supplier) and (k or n.side = 'pakka')), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(x order by x ->> 'at') from (
        select jsonb_build_object('id', e.id, 'supplier_id', e.supplier_id, 'at', e.paid_at, 'day', e.business_date, 'method', e.method, 'account', ma.name, 'note', e.note,
                 'by', pe.display_name, 'offline', e.entered_offline,
                 'amount', e.amount - case when k then 0 else coalesce((select sum(a.amount) from public.supplier_allocations a join public.purchases p
                     on p.company_id = a.company_id and p.id = a.purchase_id where a.company_id = e.company_id and a.expense_id = e.id and a.status = 'ok' and p.bill_type = 'kacha'), 0) end,
                 'cheque', (select q.number from public.cheques q where q.company_id = e.company_id and q.expense_id = e.id and q.status <> 'cancelled' limit 1)) x
          from public.expenses e
          join public.money_accounts ma on ma.company_id = e.company_id and ma.id = e.account_id
          left join public.people pe on pe.company_id = e.company_id and pe.id = e.created_by
          where e.company_id = c.company_id and e.kind = 'supplier' and e.status = 'ok' and (p_supplier is null or e.supplier_id = p_supplier)) t
        where (x ->> 'amount')::numeric > 0), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'expense_id', a.expense_id, 'purchase_id', a.purchase_id, 'opening_id', a.opening_id, 'amount', a.amount))
      from public.supplier_allocations a join public.expenses e on e.company_id = a.company_id and e.id = a.expense_id
      left join public.purchases p on p.company_id = a.company_id and p.id = a.purchase_id
      left join public.supplier_notes o on o.company_id = a.company_id and o.id = a.opening_id
      where a.company_id = c.company_id and a.status = 'ok' and e.status = 'ok' and (p_supplier is null or e.supplier_id = p_supplier)
        and (p.id is null or p.status = 'saved') and (k or coalesce(p.bill_type, o.side) = 'pakka')), '[]'::jsonb));
end $$;


-- the purchases list and one bill: what is still owed (part payments), "paid outside the app", what paid it
create or replace function public.api_purchases(p_caller uuid, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'stock');
  k := app.has(c, 'kacha');
  return coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', p.id, 'kind', p.kind, 'supplier', sp.name, 'supplier_id', p.supplier_id, 'bill_no', p.bill_no, 'bill_date', p.bill_date,
        'bill_type', p.bill_type, 'total', p.total_amount, 'kg', p.total_kg, 'pay_status', p.pay_status, 'status', p.status, 'settled', p.settled,
        'left', case when p.kind = 'bill' and p.status = 'saved' and p.settled is null then app.purchase_left(p.id) else 0 end,
        'due_date', case when sp.credit_days is not null then p.bill_date + sp.credit_days end,
        'lines', (select count(*) from public.purchase_lines pl where pl.purchase_id = p.id), 'created_at', p.created_at) x
      from public.purchases p left join public.suppliers sp on sp.id = p.supplier_id
      where p.company_id = c.company_id and (k or p.bill_type = 'pakka')
      order by p.bill_date desc, p.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) q), '[]'::jsonb);
end $$;

create or replace function public.api_purchase(p_caller uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); p public.purchases; cd int;
begin
  perform app.require(c, 'stock');
  select * into p from public.purchases where id = p_id and company_id = c.company_id;
  if p.id is null or (p.bill_type = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Bill not found.' using errcode = '22023'; end if;
  select credit_days into cd from public.suppliers where id = p.supplier_id;
  return jsonb_build_object(
    'purchase', to_jsonb(p) - 'idempotency_key',
    'supplier', (select jsonb_build_object('id', id, 'name', name, 'gstin', gstin, 'phone', phone, 'city', city, 'credit_days', credit_days) from public.suppliers where id = p.supplier_id),
    'by', (select display_name from public.people where id = p.created_by),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', pl.id, 'description', pl.description, 'hsn', pl.hsn, 'kg', pl.qty_kg, 'rate', pl.rate,
        'amount', pl.amount, 'freight_share', pl.freight_share, 'stock_item_id', pl.stock_item_id, 'code', m.code, 'shape', s.shape, 'label', s.label,
        'on_hand', app.stock_on_hand(s.id)) order by pl.position)
      from public.purchase_lines pl join public.stock_items s on s.id = pl.stock_item_id join public.materials m on m.id = s.material_id
      where pl.purchase_id = p.id), '[]'::jsonb),
    'left', case when p.kind = 'bill' and p.status = 'saved' and p.settled is null then app.purchase_left(p.id) else 0 end,
    'due_date', case when p.kind = 'bill' and cd is not null then p.bill_date + cd end,
    'paid_by', coalesce((select jsonb_agg(jsonb_build_object('expense_id', e.id, 'amount', a.amount, 'day', e.business_date, 'method', e.method, 'account', ma.name) order by e.paid_at)
      from public.supplier_allocations a join public.expenses e on e.company_id = a.company_id and e.id = a.expense_id
      join public.money_accounts ma on ma.company_id = e.company_id and ma.id = e.account_id
      where a.company_id = p.company_id and a.purchase_id = p.id and a.status = 'ok' and e.status = 'ok'), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'amount', n.amount, 'note_no', n.note_no, 'date', n.note_date) order by n.note_date)
      from public.supplier_notes n where n.company_id = p.company_id and n.purchase_id = p.id and n.status = 'ok'), '[]'::jsonb),
    -- a bill can be cancelled only while all of its stock is still there
    'can_cancel', p.status = 'saved' and not exists (
      select 1 from (select pl.stock_item_id, sum(pl.qty_kg) q from public.purchase_lines pl where pl.purchase_id = p.id group by pl.stock_item_id) t
      where app.stock_on_hand(t.stock_item_id) < t.q));
end $$;

-- ---------- h) one time: the bills already in the app ----------
-- (kept so the undo script can put every bill's tick back exactly as it was)
create table private.f6_pay_status_before as select id, company_id, pay_status, paid_at from public.purchases;
alter table private.f6_pay_status_before alter column company_id set not null, enable row level security;
revoke all on private.f6_pay_status_before from public, anon, authenticated;
create index f6_pay_status_before_idx on private.f6_pay_status_before (company_id, id);
do $$
declare e record; v_parts jsonb; c public.people; n_alloc int := 0; n_out int := 0; n_short int := 0; b record;
begin
  perform set_config('app.person_id', '', true);
  -- payments that ticked bills: set against them, oldest first, up to the payment
  for e in select x.* from public.expenses x where x.kind = 'supplier' and x.status = 'ok' and cardinality(x.purchase_ids) > 0 order by x.paid_at loop
    select * into c from public.people where company_id = e.company_id and id = e.created_by;
    if c.id is null then select * into c from public.people where company_id = e.company_id and role = 'owner' order by created_at limit 1; end if;
    c.perms := c.perms || '{"kacha": true}'::jsonb;   -- the conversion sees every bill
    v_parts := app.supplier_auto_parts(c, e.supplier_id, e.purchase_ids, e.amount);
    perform app.supplier_allocate(c, (select x from public.expenses x where x.id = e.id), v_parts, true);
    n_alloc := n_alloc + 1;
  end loop;
  -- ticked "Paid" with no payment in the app: paid outside the app
  update public.purchases p set settled = 'outside', settled_at = coalesce(p.paid_at, p.created_at)
    where p.kind = 'bill' and p.pay_status = 'paid' and p.settled is null
      and not exists (select 1 from public.supplier_allocations a where a.company_id = p.company_id and a.purchase_id = p.id and a.status = 'ok');
  get diagnostics n_out = row_count;
  -- ticked "Paid" by a payment that did not cover all of it: now shows what is still owed — the owner is told
  for b in select p.* from public.purchases p join private.f6_pay_status_before o on o.id = p.id
            where p.kind = 'bill' and p.status = 'saved' and o.pay_status = 'paid' and p.settled is null and app.purchase_left(p.id) > 0.5 loop
    perform app.review_add(b.company_id, 'supplier_check', b.id, null,
      jsonb_build_object('text', 'Bill ' || coalesce(b.bill_no, '') || ' was ticked paid by a payment that did not cover all of it — ₹'
        || round(app.purchase_left(b.id), 2) || ' now shows as still to pay.'), null, b.supplier_id, b.bill_type, 'check', null);
    n_short := n_short + 1;
  end loop;
  perform app.purchases_touch(p.company_id, array_agg(p.id)) from public.purchases p group by p.company_id;
  raise notice 'supplier khata: % payments set against their bills, % bills paid outside the app, % short (in To check)', n_alloc, n_out, n_short;
end $$;

revoke all on function public.api_supplier_allocate(uuid, uuid, text, uuid, jsonb), public.api_supplier_opening(uuid, uuid, text, jsonb),
  public.api_supplier_settings(uuid, uuid, text, uuid, int), public.api_supplier_note(uuid, uuid, text, jsonb),
  public.api_supplier_note_cancel(uuid, uuid, text, uuid, text), public.api_supplier_data(uuid, uuid),
  app.supplier_allocate(public.people, public.expenses, jsonb, boolean), app.supplier_auto_parts(public.people, uuid, uuid[], numeric),
  app.purchase_left(uuid), app.opening_left(uuid), app.purchases_touch(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.api_supplier_allocate(uuid, uuid, text, uuid, jsonb), public.api_supplier_opening(uuid, uuid, text, jsonb),
  public.api_supplier_settings(uuid, uuid, text, uuid, int), public.api_supplier_note(uuid, uuid, text, jsonb),
  public.api_supplier_note_cancel(uuid, uuid, text, uuid, text), public.api_supplier_data(uuid, uuid) to service_role;
