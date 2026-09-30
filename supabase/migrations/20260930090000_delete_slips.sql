-- =====================================================================================
-- 17. Deleting a slip (owner decision 30 Sept 2026).
--   * Only people with the new "delete" permission (owners: Papa and Parth) can delete, and
--     only after typing a one-time SMS code (checked by the api function before it calls here).
--   * Any slip can be deleted, old ones too — also finished GST / no-bill slips.
--   * Nothing disappears: the slip stays with status 'deleted', who, when, why and what stage it
--     was in. It counts nowhere (sales, khata, statements), and its number is never used again.
--   * Money taken on it is settled in the same step: it was never really received (reversed),
--     kept as the customer's credit in the khata, or given back (money out).
--   * Staff without the permission can ASK an owner to delete a slip.
-- =====================================================================================

-- ---------- a) the "delete" permission ----------
create or replace function app.valid_perms(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
    where e.key not in ('new','orders','weigh','khata','today','rates','people','settings','money','kacha','price','delete')
       or jsonb_typeof(e.value) <> 'boolean')
$$;
create or replace function app.role_preset(role text) returns jsonb
language sql immutable set search_path = '' as $$
  select case role
    when 'owner'    then '{"new":true,"orders":true,"weigh":true,"khata":true,"today":true,"rates":true,"people":true,"settings":true,"money":true,"kacha":true,"price":true,"delete":true}'::jsonb
    when 'sales'    then '{"new":true,"orders":true,"money":true,"kacha":true}'::jsonb
    when 'weigher'  then '{"weigh":true,"orders":true}'::jsonb
    when 'accounts' then '{"orders":true,"khata":true,"today":true,"money":true}'::jsonb
    else '{}'::jsonb end
$$;
-- existing owners can delete slips
update public.people set perms = perms || '{"delete":true}'::jsonb where role = 'owner' and not (perms ? 'delete');

-- ---------- b) deleted slips ----------
alter table public.orders drop constraint orders_status_check;
alter table public.orders add constraint orders_status_check
  check (status in ('estimate','accepted','weighed','done','cancelled','deleted'));
alter table public.orders
  add column deleted_at    timestamptz,
  add column deleted_by    uuid,
  add column delete_reason text check (delete_reason is null or length(delete_reason) between 1 and 500),
  add column deleted_from  text check (deleted_from is null or deleted_from in ('estimate','accepted','weighed','done','cancelled')),
  add constraint orders_deleted_has_reason
    check ((status = 'deleted') = (deleted_at is not null and delete_reason is not null and deleted_from is not null)),
  add constraint orders_deleted_by_fk foreign key (company_id, deleted_by) references public.people(company_id, id);
-- a deleted finished (or cancelled) slip keeps its bill (or cancel reason) for the record
alter table public.orders drop constraint orders_finished_has_bill;
alter table public.orders add constraint orders_finished_has_bill check (
  ((status = 'done' or deleted_from is not distinct from 'done') = (bill_type is not null))
  and ((status <> 'done' and deleted_from is distinct from 'done')
       or (gst_pct is not null and kacha_pct is not null and done_at is not null and pay_mode is not null
           and total_amount is not null and base_amount is not null and material_amount is not null
           and cutting_amount is not null and gst_amount is not null and total_weight is not null)));
alter table public.orders drop constraint orders_cancelled_has_reason;
alter table public.orders add constraint orders_cancelled_has_reason check (
  (status = 'cancelled' or deleted_from is not distinct from 'cancelled') = (cancelled_at is not null and cancel_reason is not null));
create index orders_deleted_idx on public.orders (company_id, deleted_at desc) where status = 'deleted';

-- Stage rules, now with deleting: any stage → deleted (only the delete fields change, the money on
-- it must already be settled), and a deleted slip never changes again.
create or replace function app.guard_order() returns trigger
language plpgsql set search_path = '' as $$
declare del_cols text[] := array['status','deleted_at','deleted_by','delete_reason','deleted_from'];
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
  if old.status = 'deleted' then
    raise exception 'A deleted slip cannot be changed.' using errcode = 'restrict_violation';
  end if;
  if new.status = 'deleted' then
    if (to_jsonb(new) - del_cols) <> (to_jsonb(old) - del_cols) or new.deleted_from is distinct from old.status then
      raise exception 'Deleting a slip changes nothing else on it.' using errcode = 'restrict_violation';
    end if;
    if (select coalesce(sum(p.amount), 0) from public.payments p where p.order_id = new.id) <> 0 then
      raise exception 'Settle the money taken on this slip before deleting it.' using errcode = 'check_violation';
    end if;
    return new;
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

-- Payments: nothing new on a deleted slip. While a slip is being deleted (app.deleting_order = its id,
-- set only inside api_delete_orders) its money may be moved to credit or given back whatever its stage.
create or replace function app.guard_payment() returns trigger
language plpgsql set search_path = '' as $$
declare st text; orig public.payments; deleting boolean := false;
begin
  if new.order_id is not null then
    select o.status into st from public.orders o where o.id = new.order_id and o.company_id = new.company_id;
    deleting := coalesce(current_setting('app.deleting_order', true), '') = new.order_id::text;
  end if;
  if st = 'deleted' then
    raise exception 'This slip is deleted.' using errcode = 'check_violation';
  end if;
  if new.kind = 'advance' and st not in ('accepted','weighed') then
    raise exception 'An advance can only be taken on an accepted order that is not finished yet.' using errcode = 'check_violation';
  end if;
  if new.kind = 'pickup' and st not in ('weighed','done') then
    raise exception 'A pickup payment needs a weighed order.' using errcode = 'check_violation';
  end if;
  if new.kind = 'transfer' and st not in ('accepted','weighed') and not deleting then
    raise exception 'An advance can only be moved from an order that is not finished yet.' using errcode = 'check_violation';
  end if;
  if new.kind = 'refund' and new.order_id is not null and st not in ('accepted','weighed','done') and not deleting then
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

-- ---------- c) staff ask an owner to delete ----------
create table private.delete_requests (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  order_id   uuid not null,
  asked_by   uuid not null,
  reason     text not null check (length(reason) between 1 and 500),
  asked_at   timestamptz not null default now(),
  closed_at  timestamptz,
  closed_by  uuid,
  outcome    text check (outcome in ('deleted','declined')),
  unique (company_id, id),
  foreign key (company_id, order_id) references public.orders(company_id, id),
  foreign key (company_id, asked_by) references public.people(company_id, id),
  foreign key (company_id, closed_by) references public.people(company_id, id),
  constraint delete_requests_closed check ((closed_at is null) = (outcome is null))
);
create index delete_requests_company_idx on private.delete_requests (company_id, asked_at desc);
create unique index delete_requests_one_open on private.delete_requests (order_id) where closed_at is null;
alter table private.delete_requests enable row level security;
revoke all on private.delete_requests from anon, authenticated;

-- ---------- d) operations (called only by the api function) ----------
-- The slips about to be deleted, and the owner's own number for the SMS code.
create function public.api_delete_check(p_caller uuid, p_orders uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); n int;
begin
  perform app.require(c, 'delete');
  n := coalesce(cardinality(p_orders), 0);
  if n = 0 or n > 50 then raise exception 'Choose 1 to 50 slips.' using errcode = '22023'; end if;
  if (select count(*) from public.orders o where o.company_id = c.company_id and o.id = any (p_orders)
        and o.status <> 'deleted' and (app.has(c, 'kacha') or o.bill_type is distinct from 'kacha')) <> n then
    raise exception 'A slip is missing or already deleted.' using errcode = '22023';
  end if;
  return jsonb_build_object('phone', c.phone,
    'orders', (select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'status', o.status, 'customer', cu.name,
        'bill', o.bill_type, 'total', o.total_amount, 'in_khata', o.in_khata,
        'paid', (select coalesce(sum(p.amount), 0) from public.payments p where p.order_id = o.id)) order by o.internal_no)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.id = any (p_orders)));
end $$;

-- p_money: what happened to money taken on the slips —
--   'never'  it was not really received (test / typed twice): every payment is reversed
--   'credit' the customer keeps it as credit in the khata (on the slip's bill side; GST side if not finished)
--   'refund' it was given back (p_mode: Cash / UPI / Bank / Cheque) — money out
--   'none'   no money was taken (refused if there was)
create function public.api_delete_orders(p_caller uuid, p_key uuid, p_hash text, p_orders uuid[], p_reason text,
                                         p_money text, p_mode text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; oid uuid; net numeric; pay record;
        tid uuid; side text; why text := btrim(coalesce(p_reason, '')); done jsonb := '[]'::jsonb;
begin
  perform app.require(c, 'delete');
  if why = '' then raise exception 'Write why the slip is deleted.' using errcode = '22023'; end if;
  if length(why) > 500 then raise exception 'The reason is too long.' using errcode = '22023'; end if;
  if coalesce(cardinality(p_orders), 0) = 0 or cardinality(p_orders) > 50 then
    raise exception 'Choose 1 to 50 slips.' using errcode = '22023';
  end if;
  if p_money not in ('none','never','credit','refund') then raise exception 'Choose what happened to the money.' using errcode = '22023'; end if;
  if p_money = 'refund' and coalesce(p_mode, '') not in ('Cash','UPI','Bank','Cheque') then
    raise exception 'Choose how the money was given back.' using errcode = '22023';
  end if;
  prev := app.idem_start(c.company_id, p_key, 'deleteSlips', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  foreach oid in array p_orders loop
    select * into o from public.orders where id = oid and company_id = c.company_id for update;
    if o.id is null then raise exception 'Slip not found.' using errcode = '22023'; end if;
    if o.status = 'deleted' then raise exception 'Slip % is already deleted.', o.slip_no using errcode = '23001'; end if;
    if o.bill_type = 'kacha' then perform app.require(c, 'kacha'); end if;
    select coalesce(sum(amount), 0) into net from public.payments where order_id = o.id;
    if net < 0 then raise exception 'The money on slip % does not add up. Please check its payments first.', o.slip_no using errcode = '23001'; end if;
    if net > 0 then
      perform set_config('app.deleting_order', o.id::text, true);
      if p_money = 'never' then
        for pay in select p.* from public.payments p
                   where p.order_id = o.id and p.kind in ('advance','pickup') and p.from_payment_id is null
                     and not exists (select 1 from public.payments r where r.reverses_payment_id = p.id) loop
          insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, side, note, reverses_payment_id, created_by)
            values (c.company_id, pay.customer_id, o.id, -pay.amount, pay.mode, 'reversal', pay.side, 'Slip deleted: ' || why, pay.id, c.id);
        end loop;
        if (select coalesce(sum(amount), 0) from public.payments where order_id = o.id) <> 0 then
          raise exception 'Part of the money on slip % was already returned or moved. Choose "kept as credit" or "gave it back".', o.slip_no
            using errcode = '23001';
        end if;
      elsif p_money = 'credit' then
        side := coalesce(o.bill_type, 'pakka');
        if side = 'kacha' then perform app.require(c, 'kacha'); end if;
        insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, note, created_by)
          values (c.company_id, o.customer_id, o.id, -net, 'Adjust', 'transfer', 'Slip deleted: kept as credit', c.id) returning id into tid;
        insert into public.payments (company_id, customer_id, amount, mode, kind, side, note, from_payment_id, created_by)
          values (c.company_id, o.customer_id, net, 'Adjust', 'khata', side, 'Credit from deleted slip ' || o.slip_no, tid, c.id);
      elsif p_money = 'refund' then
        insert into public.payments (company_id, customer_id, order_id, amount, mode, kind, note, created_by)
          values (c.company_id, o.customer_id, o.id, -net, p_mode, 'refund', 'Slip deleted: money given back', c.id);
      else
        raise exception 'Slip % has % taken on it. Choose what happened to that money.', o.slip_no, net using errcode = '22023';
      end if;
      perform set_config('app.deleting_order', '', true);
    end if;
    update public.orders set status = 'deleted', deleted_at = now(), deleted_by = c.id, delete_reason = why, deleted_from = o.status
      where id = o.id;
    update private.delete_requests set closed_at = now(), closed_by = c.id, outcome = 'deleted'
      where order_id = o.id and closed_at is null;
    done := done || jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'was', o.status, 'money', net);
  end loop;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('deleted', done, 'money', p_money));
end $$;

-- A request key that was already used: its answer (so a retry after the code was used up still works).
create function public.api_idem_answer(p_caller uuid, p_key uuid, p_op text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select k.response || '{"replayed":true}'::jsonb from private.idempotency_keys k
  where k.company_id = (select company_id from public.people where id = p_caller) and k.key = p_key and k.operation = p_op and k.response is not null
$$;

-- Deleted slips (newest first) and open requests — for owners.
create function public.api_deleted_slips(p_caller uuid, p_order uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'delete');
  k := app.has(c, 'kacha');
  return jsonb_build_object(
    'deleted', case when p_order is null then coalesce((select jsonb_agg(x order by x ->> 'at' desc) from (
        select jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'customer', cu.name, 'bill', o.bill_type, 'total', o.total_amount,
          'was', o.deleted_from, 'at', o.deleted_at, 'by', pe.display_name, 'reason', o.delete_reason, 'created_at', o.created_at) x
        from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
        left join public.people pe on pe.company_id = o.company_id and pe.id = o.deleted_by
        where o.company_id = c.company_id and o.status = 'deleted' and (k or o.bill_type is distinct from 'kacha')
        order by o.deleted_at desc limit 300) s), '[]'::jsonb) end,
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'order_id', o.id, 'slip_no', o.slip_no, 'customer', cu.name,
        'total', o.total_amount, 'status', o.status, 'by', pe.display_name, 'reason', r.reason, 'at', r.asked_at) order by r.asked_at desc)
      from private.delete_requests r
      join public.orders o on o.company_id = r.company_id and o.id = r.order_id
      join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      left join public.people pe on pe.company_id = r.company_id and pe.id = r.asked_by
      where r.company_id = c.company_id and r.closed_at is null and (p_order is null or r.order_id = p_order)
        and (k or o.bill_type is distinct from 'kacha')), '[]'::jsonb));
end $$;

-- Staff: ask an owner to delete a slip. Returns the owners' phones to notify.
create function public.api_request_delete(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; rid uuid; why text := btrim(coalesce(p_reason, ''));
begin
  if not (app.has(c, 'orders') or app.has(c, 'new')) then raise exception 'Not allowed.' using errcode = '42501'; end if;
  if why = '' then raise exception 'Write why the slip should be deleted.' using errcode = '22023'; end if;
  if length(why) > 500 then raise exception 'The reason is too long.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'requestDelete', p_hash);
  if prev is not null then return prev; end if;
  select * into o from public.orders where id = p_order and company_id = c.company_id;
  if o.id is null or (o.bill_type = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Slip not found.' using errcode = '22023'; end if;
  if o.status = 'deleted' then raise exception 'This slip is already deleted.' using errcode = '23001'; end if;
  select id into rid from private.delete_requests where order_id = o.id and closed_at is null;
  if rid is null then
    insert into private.delete_requests (company_id, order_id, asked_by, reason) values (c.company_id, o.id, c.id, why) returning id into rid;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('request_id', rid, 'order_id', o.id, 'slip_no', o.slip_no,
    'asked_by', c.display_name, 'reason', why,
    'owners', coalesce((select jsonb_agg(jsonb_build_object('lang', pe.preferred_lang,
        'subs', (select coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth))), '[]'::jsonb)
                 from private.push_subscriptions s where s.company_id = pe.company_id and s.person_id = pe.id)))
      from public.people pe where pe.company_id = c.company_id and pe.active and pe.id <> c.id
        and coalesce((pe.perms ->> 'delete')::boolean, false)
        and (o.bill_type is distinct from 'kacha' or coalesce((pe.perms ->> 'kacha')::boolean, false))), '[]'::jsonb)));
end $$;

-- Owner: "not needed" — close a request without deleting.
create function public.api_decline_delete(p_caller uuid, p_key uuid, p_hash text, p_request uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; rid uuid;
begin
  perform app.require(c, 'delete');
  prev := app.idem_start(c.company_id, p_key, 'declineDelete', p_hash);
  if prev is not null then return prev; end if;
  update private.delete_requests set closed_at = now(), closed_by = c.id, outcome = 'declined'
    where id = p_request and company_id = c.company_id and closed_at is null returning id into rid;
  if rid is null then raise exception 'This request is already closed.' using errcode = '23001'; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('request_id', rid, 'outcome', 'declined'));
end $$;

-- Slips deleted on one shop day (for the evening summary's "needs a look").
create function public.api_day_deleted(p_caller uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; v_tz text; v_s timestamptz; v_e timestamptz;
begin
  perform app.require(c, 'money');
  k := app.has(c, 'kacha');
  select timezone into v_tz from public.companies where id = c.company_id;
  v_s := (coalesce(p_day, (now() at time zone v_tz)::date))::timestamp at time zone v_tz;
  v_e := v_s + interval '1 day';
  return coalesce((select jsonb_agg(jsonb_build_object('slip_no', o.slip_no, 'customer', cu.name, 'reason', o.delete_reason,
      'by', pe.display_name, 'total', o.total_amount) order by o.deleted_at)
    from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
    left join public.people pe on pe.company_id = o.company_id and pe.id = o.deleted_by
    where o.company_id = c.company_id and o.status = 'deleted' and o.deleted_at >= v_s and o.deleted_at < v_e
      and (k or o.bill_type is distinct from 'kacha')), '[]'::jsonb);
end $$;

-- ---------- e) the customer's link of a deleted slip says so ----------
create or replace function public.shared_doc(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.shared_docs;
begin
  if p_token is null or length(p_token) < 20 or length(p_token) > 64 then return null; end if;
  update public.shared_docs sd set open_count = sd.open_count + 1, opened_at = now()
    where sd.token = p_token and exists (select 1 from public.companies co where co.id = sd.company_id and co.active)
    returning * into d;
  if d.id is null then return null; end if;
  if d.kind = 'slip' and exists (select 1 from public.orders o where o.id = d.order_id and o.status = 'deleted') then
    return jsonb_build_object('kind', d.kind, 'lang', d.lang, 'cancelled', true,
      'shop', jsonb_build_object('name', d.doc -> 'shop' ->> 'name', 'phone', d.doc -> 'shop' ->> 'phone'),
      'slip_no', d.doc -> 'slip' ->> 'no');
  end if;
  return jsonb_build_object('kind', d.kind, 'lang', d.lang, 'doc', d.doc, 'made_at', d.updated_at);
end $$;
revoke all on function public.shared_doc(text) from public;
grant execute on function public.shared_doc(text) to anon, authenticated, service_role;

revoke all on function public.api_delete_check(uuid, uuid[]), public.api_delete_orders(uuid, uuid, text, uuid[], text, text, text),
  public.api_idem_answer(uuid, uuid, text), public.api_deleted_slips(uuid, uuid), public.api_request_delete(uuid, uuid, text, uuid, text),
  public.api_decline_delete(uuid, uuid, text, uuid), public.api_day_deleted(uuid, date) from public, anon, authenticated;
grant execute on function public.api_delete_check(uuid, uuid[]), public.api_delete_orders(uuid, uuid, text, uuid[], text, text, text),
  public.api_idem_answer(uuid, uuid, text), public.api_deleted_slips(uuid, uuid), public.api_request_delete(uuid, uuid, text, uuid, text),
  public.api_decline_delete(uuid, uuid, text, uuid), public.api_day_deleted(uuid, date) to service_role;
