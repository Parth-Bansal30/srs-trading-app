-- =====================================================================================
-- 6. An order can only be marked "weighed" when every item has an actual weight.
--    (The app already checks this; now the database refuses it too.)
-- =====================================================================================
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
    raise exception 'A finished order cannot be changed. Record a correction instead.' using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id or new.company_id <> old.company_id or new.internal_no <> old.internal_no
     or new.slip_no <> old.slip_no or new.slip_scheme <> old.slip_scheme or new.created_at <> old.created_at then
    raise exception 'An order''s number and date cannot be changed.' using errcode = 'restrict_violation';
  end if;
  if new.customer_id <> old.customer_id and old.status <> 'estimate' then
    raise exception 'The customer can only be changed while it is an estimate.' using errcode = 'restrict_violation';
  end if;
  if new.status <> old.status and (old.status, new.status) not in
     (('estimate','accepted'), ('accepted','weighed'), ('weighed','done')) then
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
  return new;
end $$;
