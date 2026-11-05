-- Undo 20261106090000_customer_join.sql. Refused once any customers were joined (their entries must stay — undo the joins
-- in the app instead, and keep this migration).
do $$ begin
  if exists (select 1 from public.customer_joins) then
    raise exception 'Customers were joined — this cannot be rolled back (undo the joins in the app instead).';
  end if;
end $$;

drop function public.api_customer_joins(uuid, uuid);
drop function public.api_customer_join_undo(uuid, uuid, text, uuid, text);
drop function public.api_customer_join(uuid, uuid, text, uuid, uuid, jsonb, text, text);
drop function public.api_customer_join_check(uuid, uuid, uuid);
drop function app.join_stamp(uuid, uuid, uuid, uuid);
drop function public.api_create_customer(uuid, uuid, text, text, text, text, uuid, uuid[]);
create function public.api_create_customer(p_caller uuid, p_key uuid, p_hash text, p_name text, p_phone text, p_notes text,
                                           p_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; cu public.customers;
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'createCustomer', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_id is not null and exists (select 1 from public.customers where id = p_id) then
    raise exception 'That customer is already saved.' using errcode = '23505';
  end if;
  insert into public.customers (id, company_id, name, phone, notes)
    values (coalesce(p_id, gen_random_uuid()), c.company_id, btrim(p_name), nullif(btrim(p_phone), ''), nullif(btrim(p_notes), '')) returning * into cu;
  return app.idem_done(c.company_id, p_key, to_jsonb(cu));
end $$;
revoke all on function public.api_create_customer(uuid, uuid, text, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.api_create_customer(uuid, uuid, text, text, text, text, uuid) to service_role;
drop function app.norm_name(text);
drop function app.phone10(text);

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

create or replace function app.guard_old_due() returns trigger
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

drop index public.old_dues_join_idx;
alter table public.old_dues drop constraint old_dues_join_fk, drop column join_id;
drop index public.payments_join_idx;
alter table public.payments drop constraint payments_join_rule, drop constraint payments_adjust_rule,
  add constraint payments_adjust_rule check ((mode = 'Adjust') = (kind = 'transfer' or from_payment_id is not null)),
  drop constraint payments_kind_check,
  add constraint payments_kind_check check (kind in ('advance','pickup','khata','reversal','refund','transfer')),
  drop constraint payments_join_fk, drop column join_id;
drop table public.customer_not_same;
drop table public.customer_joins;
drop index public.customers_joined_idx;
alter table public.customers drop constraint customers_joined_pair, drop constraint customers_joined_self, drop constraint customers_joined_fk,
  drop column joined_at, drop column joined_into;
