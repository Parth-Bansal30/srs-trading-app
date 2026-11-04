-- 4 Nov 2026 (plan v2, steps 0 + 1).
-- a) ONE review list for the owner / accountant: possible double payments, cash-rule cases, maybe-same customers, GST
--    doubts, cheque matches… Each card keeps the facts it was raised with; it is closed by a person, with a note.
-- b) Cancelling follows everywhere (F1): a cancelled payment, expense or money move that a bank line was ticked or
--    added against puts that line back into "Needs you" with the reason, and the UPI → bank move made when ticking is
--    cancelled too. Supplier dues and the cash book are worked out from the entries, so they follow by themselves.
-- c) Possible double payments (F2): a new payment with a twin (same customer, same amount, within 3 days, not cancelled)
--    raises a review card with both entries' facts — never blocks, never deletes. Covers two phones offline (the card is
--    raised when the second one reaches the server) and the bank import adding one that someone also typed.

-- ---------- a) the review list ----------
create table public.review_items (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  kind        text not null check (kind ~ '^[a-z_]{3,40}$'),
  ref_id      uuid,                  -- the entry it is about (a payment, a customer, a slip…)
  ref2_id     uuid,                  -- the other one (the twin payment, the other customer…)
  customer_id uuid,
  supplier_id uuid,
  side        text check (side is null or side in ('pakka','kacha')),   -- kacha cards are shown only to people who may see kacha
  level       text not null default 'check' check (level in ('check','important')),
  data        jsonb not null default '{}'::jsonb,
  status      text not null default 'open' check (status in ('open','done')),
  answer      text check (answer is null or length(answer) <= 300),
  answered_by uuid,
  answered_at timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, answered_by) references public.people(company_id, id),
  constraint review_done_has_answer check ((status = 'done') = (answered_at is not null))
);
create unique index review_items_once on public.review_items (company_id, kind, coalesce(ref_id, '00000000-0000-0000-0000-000000000000'), coalesce(ref2_id, '00000000-0000-0000-0000-000000000000'));
create index review_items_open on public.review_items (company_id, status, created_at desc);
alter table public.review_items enable row level security;
revoke all on public.review_items from anon, authenticated;
create trigger audit after insert or update or delete on public.review_items for each row execute function app.audit_row();

/** Raise a card (once per kind + entries; an answered card is not raised again). */
create function app.review_add(p_company uuid, p_kind text, p_ref uuid, p_ref2 uuid, p_data jsonb,
                               p_customer uuid default null, p_supplier uuid default null, p_side text default null,
                               p_level text default 'check', p_by uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare rid uuid;
begin
  insert into public.review_items (company_id, kind, ref_id, ref2_id, data, customer_id, supplier_id, side, level, created_by)
    values (p_company, p_kind, p_ref, p_ref2, coalesce(p_data, '{}'::jsonb), p_customer, p_supplier, p_side, coalesce(p_level, 'check'), p_by)
    on conflict do nothing returning id into rid;
  return rid;
end $$;

create function public.api_review_list(p_caller uuid, p_all boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'money');
  k := app.has(c, 'kacha');
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'ref_id', r.ref_id, 'ref2_id', r.ref2_id,
        'customer_id', r.customer_id, 'customer', cu.name, 'supplier_id', r.supplier_id, 'supplier', su.name, 'side', r.side, 'level', r.level,
        'data', r.data, 'status', r.status, 'answer', r.answer, 'answered_by', ab.display_name, 'answered_at', r.answered_at, 'created_at', r.created_at)
        order by (r.status = 'open') desc, (r.level = 'important') desc, r.created_at desc)
      from (select * from public.review_items where company_id = c.company_id
              and (status = 'open' or (coalesce(p_all, false) and created_at > now() - interval '60 days'))
              and (k or side is distinct from 'kacha')
            order by created_at desc limit 300) r
      left join public.customers cu on cu.company_id = r.company_id and cu.id = r.customer_id
      left join public.suppliers su on su.company_id = r.company_id and su.id = r.supplier_id
      left join public.people ab on ab.company_id = r.company_id and ab.id = r.answered_by), '[]'::jsonb),
    'open', (select count(*) from public.review_items where company_id = c.company_id and status = 'open' and (k or side is distinct from 'kacha')));
end $$;

/** Close a card with an answer (some kinds only by the owner). Opening it again is allowed (with a note). */
create function public.api_review_answer(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_status text, p_answer text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; r public.review_items;
begin
  perform app.require(c, 'money');
  prev := app.idem_start(c.company_id, p_key, 'reviewAnswer', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into r from public.review_items where company_id = c.company_id and id = p_id for update;
  if r.id is null then raise exception 'Review card not found.' using errcode = '22023'; end if;
  if r.side = 'kacha' then perform app.require(c, 'kacha'); end if;
  if r.kind in ('cash_exception', 'cash_limit', 'maybe_same_customer', 'paid_twice') then perform app.require(c, 'settings'); end if;
  if p_status not in ('open', 'done') then raise exception 'Unknown answer.' using errcode = '22023'; end if;
  update public.review_items set status = p_status, answer = left(nullif(btrim(p_answer), ''), 300),
      answered_by = case when p_status = 'done' then c.id end, answered_at = case when p_status = 'done' then now() end
    where id = r.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('id', r.id, 'status', p_status));
end $$;

-- ---------- b) cancelling follows everywhere ----------
/** Bank lines ticked / added against an entry that is now cancelled go back to "Needs you" (with why); their UPI → bank move is cancelled. */
create function app.bank_reopen_for(p_company uuid, p_payment uuid, p_expense uuid, p_transfer uuid, p_why text, p_by uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare n int := 0; l record;
begin
  for l in select id, settle_id from public.bank_lines
            where company_id = p_company and status in ('linked', 'added')
              and ((p_payment is not null and payment_id = p_payment) or (p_expense is not null and expense_id = p_expense)
                   or (p_transfer is not null and (transfer_id = p_transfer or settle_id = p_transfer)))
            for update loop
    update public.bank_lines set status = 'open', payment_id = null, expense_id = null, transfer_id = null, settle_id = null,
        note = left(p_why, 300), done_by = p_by, done_at = now() where id = l.id;
    if l.settle_id is not null and l.settle_id is distinct from p_transfer then
      update public.money_transfers set status = 'cancelled', cancelled_at = now(), cancelled_by = p_by, cancel_reason = 'Its payment was cancelled'
        where company_id = p_company and id = l.settle_id and status = 'ok';
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create function app.payment_cancel_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tz text;
begin
  select timezone into tz from public.companies where id = new.company_id;
  perform app.bank_reopen_for(new.company_id, new.reverses_payment_id, null, null,
    'Payment cancelled on ' || to_char(now() at time zone tz, 'DD Mon') || ' — check again', new.created_by);
  -- a possible-double card about it is answered by the cancel itself
  update public.review_items set status = 'done', answer = 'One of them was cancelled', answered_by = new.created_by, answered_at = now()
    where company_id = new.company_id and kind = 'twin_payment' and status = 'open'
      and (ref_id = new.reverses_payment_id or ref2_id = new.reverses_payment_id);
  return null;
end $$;
create trigger cancel_follow after insert on public.payments for each row when (new.reverses_payment_id is not null)
  execute function app.payment_cancel_follow();

create function app.expense_cancel_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tz text;
begin
  select timezone into tz from public.companies where id = new.company_id;
  perform app.bank_reopen_for(new.company_id, null, new.id, null,
    case when new.cancel_reason = 'Changed' then 'Expense changed on ' else 'Expense cancelled on ' end
      || to_char(now() at time zone tz, 'DD Mon') || ' — check again', new.cancelled_by);
  return null;
end $$;
create trigger cancel_follow after update of status on public.expenses for each row
  when (old.status = 'ok' and new.status = 'cancelled') execute function app.expense_cancel_follow();

create function app.transfer_cancel_follow() returns trigger
language plpgsql security definer set search_path = '' as $$
declare tz text;
begin
  select timezone into tz from public.companies where id = new.company_id;
  perform app.bank_reopen_for(new.company_id, null, null, new.id,
    'Money move cancelled on ' || to_char(now() at time zone tz, 'DD Mon') || ' — check again', new.cancelled_by);
  return null;
end $$;
create trigger cancel_follow after update of status on public.money_transfers for each row
  when (old.status = 'ok' and new.status = 'cancelled') execute function app.transfer_cancel_follow();

-- api_bank_mark 'open' must not be undone by its own transfer cancel: it clears the line first (settle_id = null), so the
-- trigger finds no line. (Nothing to change — noted here for the next reader.)

-- ---------- c) possible double payments ----------
create function app.payment_twin_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare t record; tz text; fact jsonb;
begin
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
create trigger twin_check after insert on public.payments for each row when (new.reverses_payment_id is null)
  execute function app.payment_twin_check();

/** The person saving said "a different payment" after seeing the twin: the owner's answer closes the card, staff's is noted. */
create function public.api_payment_twin_seen(p_caller uuid, p_key uuid, p_hash text, p_payment uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; n int;
begin
  perform app.require(c, 'money');
  prev := app.idem_start(c.company_id, p_key, 'paymentTwinSeen', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.review_items
     set status = case when app.has(c, 'settings') then 'done' else status end,
         answer = 'Different payment — said ' || c.display_name || ' while saving',
         answered_by = case when app.has(c, 'settings') then c.id end,
         answered_at = case when app.has(c, 'settings') then now() end
   where company_id = c.company_id and kind = 'twin_payment' and ref_id = p_payment and status = 'open';
  get diagnostics n = row_count;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('payment_id', p_payment, 'cards', n));
end $$;

revoke all on function public.api_review_list(uuid, boolean), public.api_review_answer(uuid, uuid, text, uuid, text, text),
  public.api_payment_twin_seen(uuid, uuid, text, uuid), app.review_add(uuid, text, uuid, uuid, jsonb, uuid, uuid, text, text, uuid),
  app.bank_reopen_for(uuid, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.api_review_list(uuid, boolean), public.api_review_answer(uuid, uuid, text, uuid, text, text),
  public.api_payment_twin_seen(uuid, uuid, text, uuid) to service_role;
