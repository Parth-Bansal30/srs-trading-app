-- =====================================================================================
-- 10. Owner decisions of 26 Sept 2026:
--   a) Change-rate permission ("price"): only people with it may type a different rate on a slip.
--   b) Cancelling an accepted/weighed order (after its advance is settled).
--   c) Adjusting an advance: return it (money out), move it to another order, or keep it as
--      credit for the customer. Nothing is ever edited — each step is its own permanent entry.
--   d) Old balances from the paper khata: lump sums or old slips, per side.
--   e) Payment reminders: settings + a permanent log of every reminder that was approved.
-- =====================================================================================

-- ---------- a) "price" permission ----------
create or replace function app.valid_perms(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
    where e.key not in ('new','orders','weigh','khata','today','rates','people','settings','money','kacha','price')
       or jsonb_typeof(e.value) <> 'boolean')
$$;
create or replace function app.role_preset(role text) returns jsonb
language sql immutable set search_path = '' as $$
  select case role
    when 'owner'    then '{"new":true,"orders":true,"weigh":true,"khata":true,"today":true,"rates":true,"people":true,"settings":true,"money":true,"kacha":true,"price":true}'::jsonb
    when 'sales'    then '{"new":true,"orders":true,"money":true,"kacha":true}'::jsonb
    when 'weigher'  then '{"weigh":true,"orders":true}'::jsonb
    when 'accounts' then '{"orders":true,"khata":true,"today":true,"money":true}'::jsonb
    else '{}'::jsonb end
$$;
-- existing owners keep being able to change rates on a slip
update public.people set perms = perms || '{"price":true}'::jsonb where role = 'owner' and not (perms ? 'price');

-- ---------- b) cancelled orders ----------
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check check (status in ('estimate','accepted','weighed','done','cancelled'));
alter table public.orders
  add column cancelled_at  timestamptz,
  add column cancelled_by  uuid,
  add column cancel_reason text check (cancel_reason is null or length(cancel_reason) between 1 and 500),
  add constraint orders_cancelled_has_reason check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null)),
  add constraint orders_cancelled_by_fk foreign key (company_id, cancelled_by) references public.people(company_id, id);

create or replace function app.guard_order() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'estimate' then
      raise exception 'New orders start as an estimate.' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'estimate' then
      raise exception 'Only an estimate can be deleted.' using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if old.status = 'done' then
    -- the only change ever allowed on a finished order: it goes into the khata because a payment was reversed
    if (to_jsonb(new) - 'in_khata') = (to_jsonb(old) - 'in_khata') and not old.in_khata and new.in_khata then
      return new;
    end if;
    raise exception 'A finished order cannot be changed. Record a correction instead.' using errcode = 'restrict_violation';
  end if;
  if old.status = 'cancelled' then
    raise exception 'A cancelled order cannot be changed.' using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.internal_no <> old.internal_no
     or new.slip_no <> old.slip_no or new.slip_scheme <> old.slip_scheme or new.slip_period <> old.slip_period
     or new.created_at <> old.created_at then
    raise exception 'An order''s number and date cannot be changed.' using errcode = 'restrict_violation';
  end if;
  if new.customer_id <> old.customer_id and old.status <> 'estimate' then
    raise exception 'The customer can only be changed while it is an estimate.' using errcode = 'restrict_violation';
  end if;
  if new.status <> old.status and (old.status, new.status) not in
     (('estimate','accepted'), ('accepted','weighed'), ('weighed','done'), ('accepted','cancelled'), ('weighed','cancelled')) then
    raise exception 'An order cannot go from % to %.', old.status, new.status using errcode = 'check_violation';
  end if;
  if new.status = 'weighed' and old.status = 'accepted' then
    if not exists (select 1 from public.order_items i where i.order_id = new.id) then
      raise exception 'An order needs at least one item before it can be weighed.' using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.order_items i where i.order_id = new.id and i.actual_weight is null) then
      raise exception 'Every item needs its weight before the order is marked weighed.' using errcode = 'check_violation';
    end if;
  end if;
  if new.status = 'cancelled' and (select coalesce(sum(p.amount), 0) from public.payments p where p.order_id = new.id) <> 0 then
    raise exception 'Return, move or keep the advance as credit before cancelling.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- ---------- c) returning / moving an advance ----------
-- refund   = money given back to the customer (negative, real mode: Cash/UPI/Bank/Cheque)
-- transfer = advance taken off an order (negative, mode 'Adjust'); the matching positive entry
--            (an advance on another order, or a khata credit) points back to it with from_payment_id.
alter table public.payments drop constraint payments_kind_check;
alter table public.payments add constraint payments_kind_check check (kind in ('advance','pickup','khata','reversal','refund','transfer'));
alter table public.payments drop constraint payments_mode_check;
alter table public.payments add constraint payments_mode_check check (mode in ('Cash','UPI','Bank','Cheque','Adjust'));
alter table public.payments drop constraint payments_positive;
alter table public.payments add constraint payments_sign check ((kind in ('reversal','refund','transfer')) = (amount < 0));
alter table public.payments drop constraint payments_order_kinds;
alter table public.payments add constraint payments_order_kinds check (kind not in ('advance','pickup','transfer') or order_id is not null);
alter table public.payments add column from_payment_id uuid;
alter table public.payments
  add constraint payments_from_fk foreign key (company_id, from_payment_id) references public.payments(company_id, id),
  add constraint payments_adjust_rule check ((mode = 'Adjust') = (kind = 'transfer' or from_payment_id is not null)),
  add constraint payments_from_kinds check (from_payment_id is null or kind in ('advance','khata'));
create unique index payments_from_once on public.payments (from_payment_id) where from_payment_id is not null;

create or replace function app.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
declare st text; orig public.payments;
begin
  if new.order_id is not null then
    select o.status into st from public.orders o where o.id = new.order_id and o.company_id = new.company_id;
  end if;
  if new.kind = 'advance' and st not in ('accepted','weighed') then
    raise exception 'An advance can only be taken on an accepted order that is not finished yet.' using errcode = 'check_violation';
  end if;
  if new.kind = 'pickup' and st not in ('weighed','done') then
    raise exception 'A pickup payment needs a weighed order.' using errcode = 'check_violation';
  end if;
  if new.kind = 'transfer' and st not in ('accepted','weighed') then
    raise exception 'An advance can only be moved from an order that is not finished yet.' using errcode = 'check_violation';
  end if;
  if new.kind = 'refund' and new.order_id is not null and st not in ('accepted','weighed','done') then
    raise exception 'Money can only be returned on an open or finished order.' using errcode = 'check_violation';
  end if;
  if new.from_payment_id is not null then
    select * into orig from public.payments p where p.id = new.from_payment_id and p.company_id = new.company_id;
    if orig.kind is distinct from 'transfer' or new.amount <> -orig.amount or new.customer_id <> orig.customer_id
       or new.order_id is not distinct from orig.order_id then
      raise exception 'A moved advance must match what was taken off the other order.' using errcode = 'check_violation';
    end if;
  end if;
  if new.kind = 'reversal' then
    select * into orig from public.payments p where p.id = new.reverses_payment_id and p.company_id = new.company_id;
    if orig.kind in ('reversal','refund','transfer') or orig.from_payment_id is not null then
      raise exception 'This entry cannot be reversed. Record a new entry instead.' using errcode = 'check_violation';
    end if;
    if new.amount <> -orig.amount or new.customer_id <> orig.customer_id
       or new.order_id is distinct from orig.order_id or new.side is distinct from orig.side then
      raise exception 'A reversal must be the exact opposite of the original payment.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- Advance now counts what was returned or moved away.
create or replace function app.order_paid(p_order uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'advance', coalesce(sum(p.amount) filter (where coalesce(o.kind, p.kind) in ('advance','refund','transfer')), 0),
    'pickup',  coalesce(sum(p.amount) filter (where coalesce(o.kind, p.kind) = 'pickup'), 0),
    'total',   coalesce(sum(p.amount), 0))
  from public.payments p left join public.payments o on o.id = p.reverses_payment_id
  where p.order_id = p_order
$$;

-- ---------- d) old balances from the paper khata ----------
create table public.old_dues (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  side        text not null check (side in ('pakka','kacha')),
  ref         text check (ref is null or length(btrim(ref)) between 1 and 40),   -- old slip number; empty = lump sum
  due_date    date not null,                                                     -- date of the old slip / balance
  amount      numeric(12,2) not null check (amount <> 0),
  note        text check (note is null or length(note) <= 500),
  reverses_id uuid,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, customer_id) references public.customers(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  foreign key (company_id, reverses_id) references public.old_dues(company_id, id),
  constraint old_dues_sign check ((reverses_id is null) = (amount > 0))
);
comment on table public.old_dues is 'What customers owed from before the app (paper khata). Permanent; a mistake is fixed with a linked negative entry.';
create unique index old_dues_reversed_once on public.old_dues (reverses_id) where reverses_id is not null;
create index old_dues_customer_idx on public.old_dues (company_id, customer_id, due_date);

create function app.guard_old_due() returns trigger
language plpgsql set search_path = '' as $$
declare orig public.old_dues;
begin
  if new.due_date > (now() at time zone (select timezone from public.companies where id = new.company_id))::date then
    raise exception 'An old balance cannot be dated in the future.' using errcode = 'check_violation';
  end if;
  if new.reverses_id is not null then
    select * into orig from public.old_dues d where d.id = new.reverses_id and d.company_id = new.company_id;
    if orig.reverses_id is not null or new.amount <> -orig.amount or new.customer_id <> orig.customer_id
       or new.side <> orig.side or new.ref is distinct from orig.ref or new.due_date <> orig.due_date then
      raise exception 'A correction must be the exact opposite of the original entry.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
create trigger guard before insert on public.old_dues for each row execute function app.guard_old_due();
create trigger old_dues_no_change before update or delete on public.old_dues for each row execute function app.forbid_change();
create trigger old_dues_no_truncate before truncate on public.old_dues for each statement execute function app.forbid_change();
create trigger audit after insert on public.old_dues for each row execute function app.audit_row();

alter table public.old_dues enable row level security;
create policy old_dues_read on public.old_dues for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('money'))
         and (side = 'pakka' or (select app.has_perm('kacha'))));
revoke all on public.old_dues from anon;
revoke insert, update, delete, truncate, references, trigger on public.old_dues from authenticated;

-- ---------- e) reminders ----------
alter table public.company_settings
  add column reminder_after_days  integer not null default 25 check (reminder_after_days between 1 and 365),
  add column reminder_repeat_days integer not null default 7  check (reminder_repeat_days between 1 and 90);

create table public.reminders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  side        text not null check (side in ('pakka','kacha')),
  channel     text not null check (channel in ('whatsapp_link','whatsapp_api','sms')),
  phone       text check (phone is null or phone ~ '^\+91[6-9][0-9]{9}$'),
  message     text not null check (length(message) between 1 and 4000),
  total_due   numeric(12,2) not null check (total_due > 0),
  slip_refs   text[] not null default '{}',
  approved_by uuid,
  created_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, customer_id) references public.customers(company_id, id),
  foreign key (company_id, approved_by) references public.people(company_id, id)
);
comment on table public.reminders is 'Every payment reminder someone approved (who, when, to which number, exact text). Permanent.';
create index reminders_customer_idx on public.reminders (company_id, customer_id, side, created_at desc);
create trigger reminders_no_change before update or delete on public.reminders for each row execute function app.forbid_change();
create trigger reminders_no_truncate before truncate on public.reminders for each statement execute function app.forbid_change();
create trigger audit after insert on public.reminders for each row execute function app.audit_row();
alter table public.reminders enable row level security;
create policy reminders_read on public.reminders for select to authenticated
  using (company_id = (select app.current_company_id()) and (select app.has_perm('money')) and (select app.has_perm('khata'))
         and (side = 'pakka' or (select app.has_perm('kacha'))));
revoke all on public.reminders from anon;
revoke insert, update, delete, truncate, references, trigger on public.reminders from authenticated;

-- =====================================================================================
-- Backend operations
-- =====================================================================================
create function public.api_cancel_order(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders;
begin
  perform app.require(c, 'new');
  if nullif(btrim(p_reason), '') is null then raise exception 'Write why the order is cancelled.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'cancelOrder', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where id = p_order and company_id = c.company_id for update;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if o.status not in ('accepted','weighed') then
    raise exception 'Only an accepted or weighed order can be cancelled (an estimate is simply deleted).' using errcode = '23001';
  end if;
  update public.orders set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = btrim(p_reason) where id = o.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'slip_no', o.slip_no, 'status', 'cancelled'));
end $$;

-- p_action: 'refund' (give money back), 'move' (to p_target order), 'credit' (keep for the customer on p_side).
create function public.api_adjust_advance(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_action text, p_amount numeric,
                                          p_mode text, p_target uuid, p_side text, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; t public.orders; paid jsonb; avail numeric; tid uuid; nid uuid;
begin
  perform app.require(c, 'money');
  prev := app.idem_start(c.company_id, p_key, 'adjustAdvance', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where id = p_order and company_id = c.company_id for update;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if o.bill_type = 'kacha' or p_side = 'kacha' then perform app.require(c, 'kacha'); end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount.' using errcode = '22023'; end if;
  paid := app.order_paid(o.id);
  if o.status in ('accepted','weighed') then
    avail := (paid ->> 'advance')::numeric;
  elsif o.status = 'done' and p_action = 'refund' then
    avail := (paid ->> 'total')::numeric - o.total_amount;   -- extra paid beyond the bill
  else
    raise exception 'This order has no advance that can be changed now.' using errcode = '23001';
  end if;
  if p_amount > avail then
    raise exception 'Only % is available on this order.', avail using errcode = '22023';
  end if;
  if p_action = 'refund' then
    if p_mode not in ('Cash','UPI','Bank','Cheque') then raise exception 'Choose how the money was returned.' using errcode = '22023'; end if;
    if nullif(btrim(p_note), '') is null then raise exception 'Write why the money is returned.' using errcode = '22023'; end if;
    insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, note, created_by)
      values (c.company_id, o.customer_id, o.id, -p_amount, p_mode, 'refund', btrim(p_note), c.id) returning id into tid;
  elsif p_action = 'move' then
    select * into t from public.orders where id = p_target and company_id = c.company_id for update;
    if t.id is null or t.id = o.id or t.customer_id <> o.customer_id then
      raise exception 'Choose another open order of the same customer.' using errcode = '22023';
    end if;
    insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, note, created_by)
      values (c.company_id, o.customer_id, o.id, -p_amount, 'Adjust', 'transfer', coalesce(nullif(btrim(p_note), ''), 'Moved to slip ' || t.slip_no), c.id)
      returning id into tid;
    insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, note, from_payment_id, created_by)
      values (c.company_id, o.customer_id, t.id, p_amount, 'Adjust', 'advance', 'Moved from slip ' || o.slip_no, tid, c.id) returning id into nid;
  elsif p_action = 'credit' then
    if p_side not in ('pakka','kacha') then raise exception 'Choose which account keeps the credit.' using errcode = '22023'; end if;
    insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, note, created_by)
      values (c.company_id, o.customer_id, o.id, -p_amount, 'Adjust', 'transfer', coalesce(nullif(btrim(p_note), ''), 'Kept as credit'), c.id)
      returning id into tid;
    insert into public.payments (company_id, customer_id, amount, mode, kind, side, note, from_payment_id, created_by)
      values (c.company_id, o.customer_id, p_amount, 'Adjust', 'khata', p_side, 'Advance from slip ' || o.slip_no, tid, c.id) returning id into nid;
  else
    raise exception 'Unknown advance change.' using errcode = '22023';
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'action', p_action, 'amount', p_amount,
    'payment_id', tid, 'linked_payment_id', nid, 'paid', app.order_paid(o.id)));
end $$;

-- Give back credit a customer holds in the khata (worked out by the backend with @srs/core: p_available).
create function public.api_refund_credit(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_side text, p_amount numeric,
                                         p_mode text, p_note text, p_available numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; pid uuid;
begin
  perform app.require(c, 'money', 'khata');
  if p_side = 'kacha' then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'refundCredit', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_side not in ('pakka','kacha') then raise exception 'Choose the account.' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > coalesce(p_available, 0) then
    raise exception 'Only % credit is available.', coalesce(p_available, 0) using errcode = '22023';
  end if;
  if p_mode not in ('Cash','UPI','Bank','Cheque') then raise exception 'Choose how the money was returned.' using errcode = '22023'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Write why the money is returned.' using errcode = '22023'; end if;
  insert into public.payments (company_id, customer_id, amount, mode, kind, side, note, created_by)
    values (c.company_id, p_customer, -p_amount, p_mode, 'refund', p_side, btrim(p_note), c.id) returning id into pid;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('payment_id', pid, 'amount', -p_amount));
end $$;

create function public.api_add_old_due(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_side text, p_ref text,
                                       p_date date, p_amount numeric, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; did uuid;
begin
  perform app.require(c, 'money', 'khata');
  if p_side = 'kacha' then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'addOldDue', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_amount is null or p_amount <= 0 then raise exception 'Enter the amount owed.' using errcode = '22023'; end if;
  if p_date is null then raise exception 'Enter the date.' using errcode = '22023'; end if;
  insert into public.old_dues (company_id, customer_id, side, ref, due_date, amount, note, created_by)
    values (c.company_id, p_customer, p_side, nullif(btrim(p_ref), ''), p_date, p_amount, nullif(btrim(p_note), ''), c.id) returning id into did;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('old_due_id', did, 'amount', p_amount));
end $$;

create function public.api_reverse_old_due(p_caller uuid, p_key uuid, p_hash text, p_old_due uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; d public.old_dues; rid uuid;
begin
  perform app.require(c, 'money', 'khata');
  if nullif(btrim(p_note), '') is null then raise exception 'Write why this is being corrected.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'reverseOldDue', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into d from public.old_dues where id = p_old_due and company_id = c.company_id;
  if d.id is null then raise exception 'Entry not found.' using errcode = '22023'; end if;
  if d.side = 'kacha' then perform app.require(c, 'kacha'); end if;
  insert into public.old_dues (company_id, customer_id, side, ref, due_date, amount, note, reverses_id, created_by)
    values (c.company_id, d.customer_id, d.side, d.ref, d.due_date, -d.amount, btrim(p_note), d.id, c.id) returning id into rid;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('reversal_id', rid, 'amount', -d.amount));
end $$;

-- Everything the khata / reminders maths needs, limited to what the caller may see.
-- Reversals are given as the kind they reverse (negative amount), which is how @srs/core counts them.
create function public.api_khata_data(p_caller uuid, p_customer uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'money');
  k := app.has(c, 'kacha');
  return jsonb_build_object(
    'timezone', (select timezone from public.companies where id = c.company_id),
    'shop', (select coalesce(nullif(s.slip_header ->> 'name', ''), co.name) from public.companies co
               join public.company_settings s on s.company_id = co.id where co.id = c.company_id),
    'settings', (select jsonb_build_object('reminder_after_days', reminder_after_days, 'reminder_repeat_days', reminder_repeat_days)
                 from public.company_settings where company_id = c.company_id),
    'customers', coalesce((select jsonb_agg(jsonb_build_object('id', cu.id, 'name', cu.name, 'phone', cu.phone, 'active', cu.active) order by cu.name)
      from public.customers cu where cu.company_id = c.company_id and (p_customer is null or cu.id = p_customer)), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'customer_id', o.customer_id, 'status', o.status,
        'bill', o.bill_type, 'in_khata', o.in_khata, 'total', o.total_amount, 'done_at', o.done_at, 'created_at', o.created_at))
      from public.orders o where o.company_id = c.company_id and (p_customer is null or o.customer_id = p_customer)
        and (k or o.bill_type is distinct from 'kacha')
        and ((o.status = 'done' and o.in_khata) or exists (select 1 from public.payments p where p.order_id = o.id))), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'customer_id', p.customer_id, 'order_id', p.order_id,
        'amount', p.amount, 'mode', p.mode, 'kind', coalesce(r.kind, p.kind), 'side', p.side, 'note', p.note, 'at', p.received_at)
        order by p.received_at)
      from public.payments p left join public.payments r on r.id = p.reverses_payment_id
        left join public.orders o on o.id = p.order_id
      where p.company_id = c.company_id and (p_customer is null or p.customer_id = p_customer)
        and (k or (coalesce(p.side, 'pakka') = 'pakka' and o.bill_type is distinct from 'kacha'))), '[]'::jsonb),
    'old_dues', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'customer_id', d.customer_id, 'side', d.side, 'ref', d.ref,
        'date', d.due_date, 'amount', d.amount, 'reverses_id', d.reverses_id, 'note', d.note))
      from public.old_dues d where d.company_id = c.company_id and (p_customer is null or d.customer_id = p_customer)
        and (k or d.side = 'pakka')), '[]'::jsonb),
    'last_reminders', coalesce((select jsonb_agg(jsonb_build_object('customer_id', x.customer_id, 'side', x.side, 'at', x.at))
      from (select customer_id, side, max(created_at) as at from public.reminders
            where company_id = c.company_id and (k or side = 'pakka') group by customer_id, side) x), '[]'::jsonb));
end $$;

create function public.api_record_reminder(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_side text, p_channel text,
                                           p_phone text, p_message text, p_total_due numeric, p_slip_refs text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; rid uuid;
begin
  perform app.require(c, 'money', 'khata');
  if p_side = 'kacha' then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'sendReminder', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  insert into public.reminders (company_id, customer_id, side, channel, phone, message, total_due, slip_refs, approved_by)
    values (c.company_id, p_customer, p_side, p_channel, p_phone, p_message, p_total_due, coalesce(p_slip_refs, '{}'), c.id) returning id into rid;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('reminder_id', rid));
end $$;

-- Settings: the two reminder settings join the allowed list.
create or replace function public.api_change_settings(p_caller uuid, p_key uuid, p_hash text, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; s public.company_settings; bad text; co jsonb := p_changes -> 'company';
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'changeSettings', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select string_agg(k, ', ') into bad from jsonb_object_keys(p_changes) k
    where k not in ('gst_pct','kacha_pct','min_inch','default_unit','show_weight_on_slip','weight_warn_pct','slip_numbering',
                    'family_density','slip_header','unlock_hours','first_slip_no','ai_daily_limit','company',
                    'reminder_after_days','reminder_repeat_days');
  if bad is not null then raise exception 'Unknown setting: %', bad using errcode = '22023'; end if;
  if p_changes ? 'first_slip_no' and exists (select 1 from public.orders where company_id = c.company_id) then
    raise exception 'The first slip number can only be set before the first order.' using errcode = '23514';
  end if;
  update public.company_settings set
      gst_pct = coalesce((p_changes ->> 'gst_pct')::numeric, gst_pct),
      kacha_pct = coalesce((p_changes ->> 'kacha_pct')::numeric, kacha_pct),
      min_inch = coalesce((p_changes ->> 'min_inch')::int, min_inch),
      default_unit = coalesce(p_changes ->> 'default_unit', default_unit),
      show_weight_on_slip = coalesce((p_changes ->> 'show_weight_on_slip')::boolean, show_weight_on_slip),
      weight_warn_pct = coalesce((p_changes ->> 'weight_warn_pct')::numeric, weight_warn_pct),
      slip_numbering = coalesce(p_changes ->> 'slip_numbering', slip_numbering),
      family_density = coalesce(p_changes -> 'family_density', family_density),
      slip_header = coalesce(p_changes -> 'slip_header', slip_header),
      unlock_hours = coalesce((p_changes ->> 'unlock_hours')::int, unlock_hours),
      first_slip_no = coalesce((p_changes ->> 'first_slip_no')::bigint, first_slip_no),
      ai_daily_limit = coalesce((p_changes ->> 'ai_daily_limit')::int, ai_daily_limit),
      reminder_after_days = coalesce((p_changes ->> 'reminder_after_days')::int, reminder_after_days),
      reminder_repeat_days = coalesce((p_changes ->> 'reminder_repeat_days')::int, reminder_repeat_days),
      updated_at = now(), updated_by = c.id
    where company_id = c.company_id returning * into s;
  if co is not null then
    update public.companies set
        name = coalesce(nullif(btrim(co ->> 'name'), ''), name),
        legal_name = case when co ? 'legal_name' then nullif(btrim(co ->> 'legal_name'), '') else legal_name end,
        gstin = case when co ? 'gstin' then nullif(upper(btrim(co ->> 'gstin')), '') else gstin end,
        phone = case when co ? 'phone' then nullif(btrim(co ->> 'phone'), '') else phone end,
        address = case when co ? 'address' then nullif(btrim(co ->> 'address'), '') else address end
      where id = c.company_id;
  end if;
  return app.idem_done(c.company_id, p_key, to_jsonb(s));
end $$;

-- Reversing a payment: an advance can't be reversed below what is still on the order
-- (e.g. after part of it was returned or moved), so balances can never go negative.
create or replace function public.api_reverse_payment(p_caller uuid, p_key uuid, p_hash text, p_payment uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; orig public.payments; ord public.orders; rid uuid;
begin
  perform app.require(c, 'money', 'khata');
  if nullif(btrim(p_note), '') is null then raise exception 'Write why this payment is being cancelled.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'reversePayment', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into orig from public.payments where id = p_payment and company_id = c.company_id;
  if orig.id is null then raise exception 'Payment not found.' using errcode = '22023'; end if;
  select * into ord from public.orders where id = orig.order_id for update;
  if orig.side = 'kacha' or ord.bill_type = 'kacha' then perform app.require(c, 'kacha'); end if;
  if orig.kind = 'advance' and ord.status in ('accepted','weighed')
     and (app.order_paid(ord.id) ->> 'advance')::numeric < orig.amount then
    raise exception 'Part of this advance was already returned or moved; cancel only what is left.' using errcode = '23514';
  end if;
  if ord.status = 'cancelled' then raise exception 'This order is cancelled.' using errcode = '23001'; end if;
  insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, side, note, reverses_payment_id, created_by)
    values (c.company_id, orig.customer_id, orig.order_id, -orig.amount, orig.mode, 'reversal', orig.side, btrim(p_note), orig.id, c.id)
    returning id into rid;
  if ord.status = 'done' and not ord.in_khata then update public.orders set in_khata = true where id = ord.id; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('reversal_id', rid, 'reverses', orig.id, 'amount', -orig.amount));
end $$;

-- ---------- only the backend may call these ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'api\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  revoke all on function app.guard_old_due() from public, anon, authenticated;
end $$;
