-- =====================================================================================
-- 26 Oct 2026 — found by walking through a whole shop day as real people.
--
-- a) Weigh again. The weigher typed 180 for 18.0 kg; the slip went to "ready to finish" and the bill
--    came out ten times too big, with no way back except cancelling. Now a weighed slip that is not
--    finished yet can go back to "to weigh" (the weigher, or anyone who takes money at pickup).
--    The weights stay filled in to be corrected; the stock taken for it comes back and is taken again
--    when it is weighed again. Who did it is in the audit history like every change.
-- b) The weigher's own list of what was weighed today and yesterday (sizes and weights, no money),
--    so the Weighing screen can answer "did I weigh #3 already?". The weigher can't read slips with
--    money, so the Slips list was always empty for him.
-- =====================================================================================

-- ---------- a) stage rules: weighed → accepted is allowed (weigh again) ----------
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
     (('estimate','accepted'), ('accepted','weighed'), ('weighed','accepted'), ('weighed','done'), ('accepted','cancelled'), ('weighed','cancelled')) then
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

-- ---------- stock follows: weighed again → what was taken comes back (and is taken again at the new weight) ----------
create or replace function app.stock_follow_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare by_id uuid := nullif(current_setting('app.person_id', true), '')::uuid;
begin
  if new.status = old.status then return new; end if;
  if old.status = 'accepted' and new.status = 'weighed' then
    insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, order_id, order_item_id, created_by)
      select i.company_id, i.stock_item_id, 'sale', -i.actual_weight, i.order_id, i.id, by_id
      from public.order_items i
      where i.company_id = new.company_id and i.order_id = new.id and i.stock_item_id is not null and i.actual_weight > 0;
  elsif (new.status = 'cancelled' and old.status = 'weighed') or (new.status = 'deleted' and old.status in ('weighed','done'))
        or (new.status = 'accepted' and old.status = 'weighed') then
    insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, order_id, order_item_id, note, created_by)
      select m.company_id, m.stock_item_id, 'sale_undo', -sum(m.qty_kg), m.order_id, m.order_item_id,
             case when new.status = 'deleted' then 'Slip deleted' when new.status = 'accepted' then 'Weighed again' else 'Order cancelled' end, by_id
      from public.stock_moves m
      where m.company_id = new.company_id and m.order_id = new.id and m.kind in ('sale','sale_undo')
      group by m.company_id, m.stock_item_id, m.order_id, m.order_item_id
      having sum(m.qty_kg) < 0;
  end if;
  return new;
end $$;

-- ---------- the operation ----------
create function public.api_reopen_weighing(p_caller uuid, p_key uuid, p_hash text, p_order uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders;
begin
  if not (app.has(c, 'weigh') or app.has(c, 'money')) then
    raise exception 'You don''t have permission for this (weigh).' using errcode = '42501';
  end if;
  prev := app.idem_start(c.company_id, p_key, 'reopenWeighing', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where id = p_order and company_id = c.company_id for update;
  if o.id is null then raise exception 'Order not found.' using errcode = '22023'; end if;
  if o.status <> 'weighed' then
    raise exception 'Only a weighed slip that is not finished yet can be weighed again.' using errcode = '23001';
  end if;
  update public.orders set status = 'accepted', weighed_at = null where id = o.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'status', 'accepted', 'slip_no', o.slip_no));
end $$;

-- ---------- b) what was weighed today and yesterday (for the weigher: sizes and weights, never money) ----------
create function public.api_weighed_list(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; tz text; v_s timestamptz;
begin
  perform app.require(c, 'weigh');
  k := app.has(c, 'kacha');
  select timezone into tz from public.companies where id = c.company_id;
  v_s := (((now() at time zone tz)::date) - 1)::timestamp at time zone tz;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.id, 'slip_no', o.slip_no, 'status', o.status, 'weighed_at', o.weighed_at,
      'customer', (select name from public.customers where id = o.customer_id),
      'weight', (select sum(i.actual_weight) from public.order_items i where i.order_id = o.id),
      'items', (select jsonb_agg(jsonb_build_object(
          'grade_code', i.grade_code, 'shape', i.shape, 'unit', i.unit, 'dims', to_jsonb(i.dims), 'actual_weight', i.actual_weight,
          'lengths', (select coalesce(jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs) order by l.position), '[]'::jsonb)
                      from public.order_item_lengths l where l.order_item_id = i.id)) order by i.position)
        from public.order_items i where i.order_id = o.id)) order by o.weighed_at desc)
    from public.orders o
    where o.company_id = c.company_id and o.status in ('weighed', 'done') and o.weighed_at >= v_s
      and (k or o.bill_type is distinct from 'kacha')), '[]'::jsonb);
end $$;

revoke all on function public.api_reopen_weighing(uuid, uuid, text, uuid), public.api_weighed_list(uuid) from public, anon, authenticated;
grant execute on function public.api_reopen_weighing(uuid, uuid, text, uuid), public.api_weighed_list(uuid) to service_role;
