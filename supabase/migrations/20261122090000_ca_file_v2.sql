-- 22 Nov 2026: the CA's file, matched with Tally. Every GST slip gets its Tally bill no. (and, if typed, the Tally bill's
-- total, so a different amount shows at once); a GST slip deleted after its Tally bill is never lost — it stays on its
-- month, raises an important Review card and goes to the CA as "cancel the Tally bill" (same month) or "make a credit
-- note" (later month) until that is done; the month for the CA also carries GST expense bills, supplier credit notes,
-- the suppliers' GST status, bills unpaid for 180 days and older GST slips still without a Tally bill. Sending the file
-- is noted, so "last sent" can be shown. The app still makes no GST invoices — the CA does, in Tally.

-- ---------- the Tally bill's total, and what happened in Tally after a slip was deleted ----------
alter table public.slip_gst
  add column tally_total numeric(14,2) check (tally_total is null or tally_total >= 0),
  add column cancel_how  text check (cancel_how is null or cancel_how in ('bill_cancelled','credit_note')),
  add column cn_no       text check (cn_no is null or length(btrim(cn_no)) between 1 and 40),
  add column cn_date     date,
  add column cn_by       uuid,
  add column cn_at       timestamptz,
  add constraint slip_gst_cn_by_fk foreign key (company_id, cn_by) references public.people(company_id, id),
  add constraint slip_gst_cn check (cancel_how is distinct from 'bill_cancelled' or cn_no is null);

-- ---------- sending the file to the CA (noted, never required) ----------
create table public.ca_sends (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  month      text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  how        text not null check (how in ('download','share')),
  slips      int check (slips is null or slips >= 0),
  total      numeric(14,2),
  sent_by    uuid,
  sent_at    timestamptz not null default now(),
  foreign key (company_id, sent_by) references public.people(company_id, id)
);
create index ca_sends_month on public.ca_sends (company_id, month, sent_at desc);
alter table public.ca_sends enable row level security;
revoke all on public.ca_sends from anon, authenticated;
create trigger audit after insert on public.ca_sends for each row execute function app.audit_row();

-- ---------- a GST slip deleted after its Tally bill: an important card until the CA's side is done ----------
create function app.tally_cancel_card() returns trigger
language plpgsql security definer set search_path = '' as $$
declare g public.slip_gst;
begin
  if new.status = 'deleted' and old.status = 'done' and new.bill_type = 'pakka' then
    select * into g from public.slip_gst where company_id = new.company_id and order_id = new.id;
    if g.tally_no is not null then
      perform app.review_add(new.company_id, 'tally_cancel', new.id, null,
        jsonb_build_object('slip_no', new.slip_no, 'tally_no', g.tally_no, 'tally_date', g.tally_date, 'total', new.total_amount, 'reason', new.delete_reason),
        new.customer_id, null, 'pakka', 'important', new.deleted_by);
    end if;
  end if;
  return new;
end $$;
create trigger tally_cancel_card after update of status on public.orders for each row execute function app.tally_cancel_card();

-- ---------- the Tally bill no. (now with the Tally bill's total; the date defaults to the slip's day) ----------
drop function public.api_slip_tally(uuid, uuid, text, uuid, text, date, boolean);
/** The Tally bill no. the CA gave a GST slip, its date and (if typed) its total. The same number on another slip is refused unless confirmed. */
create function public.api_slip_tally(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_no text, p_date date, p_force boolean,
                                      p_total numeric default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; g public.slip_gst; v_no text := nullif(btrim(coalesce(p_no, '')), ''); twin int;
        tz text;
begin
  perform app.require(c, 'money', 'khata');
  prev := app.idem_start(c.company_id, p_key, 'slipTally', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where company_id = c.company_id and id = p_order;
  if o.id is null or o.status <> 'done' or o.bill_type is distinct from 'pakka' then
    raise exception 'Only a finished GST slip gets a Tally bill no.' using errcode = '22023';
  end if;
  if v_no is not null and length(v_no) > 40 then raise exception 'The Tally bill no. is too long.' using errcode = '22023'; end if;
  if p_total is not null and (p_total < 0 or p_total > 1000000000) then raise exception 'Check the Tally bill''s total.' using errcode = '22023'; end if;
  select * into g from public.slip_gst where company_id = c.company_id and order_id = o.id for update;
  if v_no is null and g.tally_no is not null and not app.has(c, 'settings') then
    raise exception 'Only the owner can take a Tally bill no. off.' using errcode = '42501';
  end if;
  if g.tally_no is not null and v_no is distinct from g.tally_no and not app.has(c, 'settings') then
    raise exception 'The Tally bill % is already on this slip — ask the owner to change it.', g.tally_no using errcode = '42501';
  end if;
  if v_no is not null and not coalesce(p_force, false) then
    select x.slip_no into twin from public.slip_gst s join public.orders x on x.company_id = s.company_id and x.id = s.order_id
      where s.company_id = c.company_id and s.order_id <> o.id and lower(btrim(s.tally_no)) = lower(v_no) and x.status in ('done','deleted') limit 1;
    if twin is not null then
      raise exception 'Tally bill % is already on slip #% — the same bill on two slips?', v_no, twin using errcode = '23505';
    end if;
  end if;
  select timezone into tz from public.companies where id = c.company_id;
  insert into public.slip_gst as s (company_id, order_id, tally_no, tally_date, tally_total, tally_by, tally_at, updated_by, updated_at)
    values (c.company_id, o.id, v_no, case when v_no is not null then coalesce(p_date, (o.done_at at time zone tz)::date) end,
            case when v_no is not null then p_total end,
            case when v_no is not null then c.id end, case when v_no is not null then now() end, c.id, now())
    on conflict (company_id, order_id) do update set tally_no = excluded.tally_no, tally_date = excluded.tally_date, tally_total = excluded.tally_total,
      tally_by = case when excluded.tally_no is not distinct from s.tally_no then coalesce(s.tally_by, excluded.tally_by) else excluded.tally_by end,
      tally_at = case when excluded.tally_no is not distinct from s.tally_no then coalesce(s.tally_at, excluded.tally_at) else excluded.tally_at end,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'tally_no', v_no, 'tally_total', case when v_no is not null then p_total end,
    'differs', v_no is not null and p_total is not null and abs(p_total - o.total_amount) > 1));
end $$;

/**
 * A GST slip deleted after its Tally bill: what the CA did in Tally — the bill cancelled (same month) or a credit note
 * (its no. and date). Closes the Review card.
 */
create function public.api_tally_cancel(p_caller uuid, p_key uuid, p_hash text, p_order uuid, p_how text, p_no text, p_date date) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; o public.orders; g public.slip_gst; v_no text := nullif(btrim(coalesce(p_no, '')), '');
begin
  perform app.require(c, 'money', 'khata');
  prev := app.idem_start(c.company_id, p_key, 'tallyCancel', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into o from public.orders where company_id = c.company_id and id = p_order;
  select * into g from public.slip_gst where company_id = c.company_id and order_id = p_order for update;
  if o.id is null or o.status <> 'deleted' or o.deleted_from is distinct from 'done' or o.bill_type is distinct from 'pakka' or g.tally_no is null then
    raise exception 'Only a deleted GST slip that had a Tally bill needs this.' using errcode = '22023';
  end if;
  if p_how not in ('bill_cancelled','credit_note') then raise exception 'Choose: Tally bill cancelled, or credit note made.' using errcode = '22023'; end if;
  if p_how = 'credit_note' and v_no is null then raise exception 'Type the credit note no.' using errcode = '22023'; end if;
  if v_no is not null and length(v_no) > 40 then raise exception 'The credit note no. is too long.' using errcode = '22023'; end if;
  update public.slip_gst set cancel_how = p_how, cn_no = case when p_how = 'credit_note' then v_no end,
      cn_date = case when p_how = 'credit_note' then coalesce(p_date, (now() at time zone (select timezone from public.companies where id = c.company_id))::date) end,
      cn_by = c.id, cn_at = now(), updated_by = c.id, updated_at = now()
    where company_id = c.company_id and order_id = o.id;
  update public.review_items set status = 'done',
      answer = case when p_how = 'bill_cancelled' then 'Tally bill ' || g.tally_no || ' cancelled' else 'Credit note ' || v_no || ' made in Tally' end,
      answered_by = c.id, answered_at = now()
    where company_id = c.company_id and kind = 'tally_cancel' and ref_id = o.id and status = 'open';
  return app.idem_done(c.company_id, p_key, jsonb_build_object('order_id', o.id, 'how', p_how, 'cn_no', case when p_how = 'credit_note' then v_no end));
end $$;

/** "Sent to the CA": noted for the month (download or share). */
create function public.api_ca_sent(p_caller uuid, p_key uuid, p_hash text, p_month text, p_how text, p_slips int, p_total numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; v_id uuid;
begin
  perform app.require(c, 'money', 'khata');
  prev := app.idem_start(c.company_id, p_key, 'caSent', p_hash);
  if prev is not null then return prev; end if;
  if p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'Choose the month.' using errcode = '22023'; end if;
  if p_how not in ('download','share') then raise exception 'How was it sent?' using errcode = '22023'; end if;
  insert into public.ca_sends (company_id, month, how, slips, total, sent_by) values (c.company_id, p_month, p_how, p_slips, p_total, c.id) returning id into v_id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('id', v_id, 'month', p_month, 'how', p_how));
end $$;

/**
 * The GST bills list (for typing Tally bill nos.): the GST slips finished in the days asked — kept when deleted after a
 * Tally bill — and the ones deleted in those days after an earlier month's bill. Also: the last Tally no. typed (to
 * suggest the next one) and how many older GST slips still wait for a Tally bill.
 */
create function public.api_gst_bills(p_caller uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); tz text;
begin
  perform app.require(c, 'money', 'khata');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'Choose the month.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  return jsonb_build_object(
    'last_tally', (select jsonb_build_object('no', g.tally_no, 'date', g.tally_date) from public.slip_gst g
                   where g.company_id = c.company_id and g.tally_no is not null order by g.tally_at desc nulls last, g.tally_no desc limit 1),
    'waiting_before', (select count(*) from public.orders o left join public.slip_gst g on g.company_id = o.company_id and g.order_id = o.id
                       where o.company_id = c.company_id and o.status = 'done' and o.bill_type = 'pakka' and g.tally_no is null
                         and (o.done_at at time zone tz)::date < p_from),
    'bills', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'date', (o.done_at at time zone tz)::date, 'done_at', o.done_at,
        'customer', cu.name, 'customer_id', cu.id, 'gstin', cu.gstin, 'has_address', cu.address is not null,
        'base', o.base_amount, 'gst', o.gst_amount, 'total', o.total_amount, 'status', o.status,
        'deleted_on', case when o.status = 'deleted' then (o.deleted_at at time zone tz)::date end, 'delete_reason', o.delete_reason,
        'pos', g.pos, 'tally_no', g.tally_no, 'tally_date', g.tally_date, 'tally_total', g.tally_total, 'tally_by', pe.display_name,
        'cancel_how', g.cancel_how, 'cn_no', g.cn_no, 'cn_date', g.cn_date) order by o.done_at)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      left join public.slip_gst g on g.company_id = o.company_id and g.order_id = o.id
      left join public.people pe on pe.company_id = g.company_id and pe.id = g.tally_by
      where o.company_id = c.company_id and o.bill_type = 'pakka'
        and (o.status = 'done' or (o.status = 'deleted' and o.deleted_from = 'done' and g.tally_no is not null))
        and ((o.done_at at time zone tz)::date between p_from and p_to
             or (o.status = 'deleted' and (o.deleted_at at time zone tz)::date between p_from and p_to))), '[]'::jsonb));
end $$;

/**
 * A month for the CA (22 Nov 2026): the GST slips (kept when deleted after their Tally bill, marked), slips deleted this
 * month after a Tally bill, GST purchase bills (with the supplier's GST status), shop expenses with a GST bill, supplier
 * credit notes, GST bills unpaid for 180 days, older GST slips still without a Tally bill, and when it was last sent.
 * No-bill slips never appear.
 */
create or replace function public.api_gst_month(p_caller uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); tz text; v_exp boolean; v_stock boolean; today date;
begin
  perform app.require(c, 'money', 'khata');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'Choose the month.' using errcode = '22023'; end if;
  select timezone into tz from public.companies where id = c.company_id;
  v_exp := app.has(c, 'expenses'); v_stock := app.has(c, 'stock');
  today := (now() at time zone tz)::date;
  return jsonb_build_object(
    'shop', (select jsonb_build_object('name', name, 'gstin', gstin, 'state', app.shop_state(id)) from public.companies where id = c.company_id),
    'settings', (select jsonb_build_object('gst_pct', gst_pct, 'min_inch', min_inch) from public.company_settings where company_id = c.company_id),
    'slips', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'date', (o.done_at at time zone tz)::date,
        'customer', cu.name, 'gstin', cu.gstin, 'has_address', cu.address is not null, 'gst_pct', o.gst_pct, 'base', o.base_amount, 'gst', o.gst_amount, 'total', o.total_amount,
        'material', o.material_amount, 'cutting', o.cutting_amount, 'min_inch', o.pricing_rules -> 'min_inch',
        'direct', o.direct_purchase_id is not null, 'status', o.status,
        'deleted_on', case when o.status = 'deleted' then (o.deleted_at at time zone tz)::date end,
        'gst_details', case when g.order_id is not null then jsonb_build_object('delivery', g.delivery, 'dest_state', g.dest_state, 'pos', g.pos,
            'items', g.items, 'tally_no', g.tally_no, 'tally_date', g.tally_date, 'tally_total', g.tally_total, 'cancel_how', g.cancel_how) end,
        'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'material_id', i.material_id, 'grade_code', i.grade_code, 'shape', i.shape,
            'unit', i.unit, 'dims', i.dims, 'sell_rate', i.sell_rate, 'cut_rate', i.cut_rate, 'density', i.density, 'actual_weight', i.actual_weight,
            'by_weight', i.by_weight, 'hsn_now', m.hsn, 'gst_rate_now', m.gst_rate, 'hsn_checked_now', m.hsn_checked_at is not null,
            'lengths', (select coalesce(jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs, 'cuts', l.cuts) order by l.position), '[]'::jsonb)
                        from public.order_item_lengths l where l.company_id = i.company_id and l.order_item_id = i.id)) order by i.position), '[]'::jsonb)
          from public.order_items i join public.materials m on m.company_id = i.company_id and m.id = i.material_id
          where i.company_id = o.company_id and i.order_id = o.id)) order by o.done_at)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      left join public.slip_gst g on g.company_id = o.company_id and g.order_id = o.id
      where o.company_id = c.company_id and o.bill_type = 'pakka'
        and (o.status = 'done' or (o.status = 'deleted' and o.deleted_from = 'done' and g.tally_no is not null))
        and (o.done_at at time zone tz)::date between p_from and p_to), '[]'::jsonb),
    -- GST slips deleted in these days after a Tally bill (finished this month or earlier)
    'cancelled', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'customer', cu.name, 'gstin', cu.gstin,
        'date', (o.done_at at time zone tz)::date, 'deleted_on', (o.deleted_at at time zone tz)::date, 'reason', o.delete_reason,
        'tally_no', g.tally_no, 'tally_date', g.tally_date, 'total', o.total_amount, 'gst', o.gst_amount, 'taxable', o.base_amount, 'pos', g.pos,
        'how', g.cancel_how, 'cn_no', g.cn_no, 'cn_date', g.cn_date) order by o.deleted_at)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      join public.slip_gst g on g.company_id = o.company_id and g.order_id = o.id
      where o.company_id = c.company_id and o.bill_type = 'pakka' and o.status = 'deleted' and o.deleted_from = 'done' and g.tally_no is not null
        and (o.deleted_at at time zone tz)::date between p_from and p_to), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'bill_no', p.bill_no, 'date', p.bill_date, 'supplier', s.name, 'gstin', s.gstin,
        'gst_status', s.gst_status, 'gst', p.gst_amount, 'freight', p.freight, 'other', p.other_charges, 'round_off', p.round_off, 'total', p.total_amount,
        'stock_effect', p.stock_effect,
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('hsn', l.hsn, 'description', l.description, 'kg', l.qty_kg, 'amount', l.amount) order by l.position), '[]'::jsonb)
                  from public.purchase_lines l where l.company_id = p.company_id and l.purchase_id = p.id)) order by p.bill_date, p.created_at)
      from public.purchases p left join public.suppliers s on s.company_id = p.company_id and s.id = p.supplier_id
      where p.company_id = c.company_id and p.kind = 'bill' and p.bill_type = 'pakka' and p.status = 'saved' and p.bill_date between p_from and p_to), '[]'::jsonb),
    -- shop expenses with a GST bill (not supplier payments, not money taken home)
    'expenses', case when v_exp then coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'date', e.business_date, 'bill_no', e.bill_no, 'paid_to', e.paid_to,
        'seller_gstin', e.seller_gstin, 'category', e.category, 'amount', e.amount, 'gst_amount', e.gst_amount) order by e.business_date, e.paid_at)
      from public.expenses e where e.company_id = c.company_id and e.kind = 'expense' and e.gst_bill and e.status = 'ok'
        and e.business_date between p_from and p_to), '[]'::jsonb) end,
    -- supplier credit notes on GST bills (returns, rate differences, discounts)
    'supplier_notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'date', n.note_date, 'note_no', n.note_no, 'kind', n.kind, 'amount', n.amount,
        'supplier', s.name, 'gstin', s.gstin,
        'bill', case when p.id is not null then jsonb_build_object('bill_no', p.bill_no, 'gst', p.gst_amount, 'total', p.total_amount) end) order by n.note_date, n.created_at)
      from public.supplier_notes n join public.suppliers s on s.company_id = n.company_id and s.id = n.supplier_id
      left join public.purchases p on p.company_id = n.company_id and p.id = n.purchase_id
      where n.company_id = c.company_id and n.side = 'pakka' and n.kind <> 'opening' and n.status = 'ok' and n.note_date between p_from and p_to), '[]'::jsonb),
    -- GST bills not fully paid 180 days after the bill (any month): their GST credit has to be paid back
    'unpaid180', case when v_stock then coalesce((select jsonb_agg(x order by x ->> 'date') from (
        select jsonb_build_object('id', p.id, 'bill_no', p.bill_no, 'date', p.bill_date, 'supplier', s.name, 'gst', p.gst_amount, 'total', p.total_amount,
          'left', app.purchase_left(p.id), 'days', today - p.bill_date) as x
        from public.purchases p left join public.suppliers s on s.company_id = p.company_id and s.id = p.supplier_id
        where p.company_id = c.company_id and p.kind = 'bill' and p.bill_type = 'pakka' and p.status = 'saved' and p.settled is null
          and p.stock_effect in ('stock','direct') and p.gst_amount > 0 and p.bill_date <= today - 180 and app.purchase_left(p.id) > 0
        order by p.bill_date limit 200) q), '[]'::jsonb) end,
    -- GST slips of earlier months still without a Tally bill
    'pending_before', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'date', (o.done_at at time zone tz)::date, 'customer', cu.name, 'total', o.total_amount) as x
        from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
        left join public.slip_gst g on g.company_id = o.company_id and g.order_id = o.id
        where o.company_id = c.company_id and o.status = 'done' and o.bill_type = 'pakka' and g.tally_no is null and (o.done_at at time zone tz)::date < p_from
        order by o.done_at limit 50) q), '[]'::jsonb),
    'sent', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('at', s.sent_at, 'how', s.how, 'by', pe.display_name, 'slips', s.slips, 'total', s.total) as x
        from public.ca_sends s left join public.people pe on pe.company_id = s.company_id and pe.id = s.sent_by
        where s.company_id = c.company_id and s.month = to_char(p_from, 'YYYY-MM') order by s.sent_at desc limit 5) q), '[]'::jsonb));
end $$;

-- the delete sheet: a GST slip's Tally bill, so deleting it warns first
create or replace function public.api_delete_check(p_caller uuid, p_orders uuid[]) returns jsonb
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
        'paid', (select coalesce(sum(p.amount), 0) from public.payments p where p.order_id = o.id),
        'can_undo', not exists (select 1 from public.payments p where p.order_id = o.id
                                  and (p.kind in ('refund','transfer') or p.from_payment_id is not null)),
        'stock_back_kg', (select coalesce(-sum(m.qty_kg), 0) from public.stock_moves m where m.order_id = o.id and m.kind in ('sale','sale_undo')),
        'done_at', o.done_at,
        'tally_no', (select g.tally_no from public.slip_gst g where g.company_id = o.company_id and g.order_id = o.id and o.status = 'done'),
        'tally_date', (select g.tally_date from public.slip_gst g where g.company_id = o.company_id and g.order_id = o.id and o.status = 'done')
      ) order by o.internal_no)
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.id = any (p_orders)));
end $$;


-- one slip's GST details (the slip page) now also carry the Tally bill's total
create or replace function public.api_slip_gst_get(p_caller uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'money');
  return (select jsonb_build_object('delivery', g.delivery, 'dest_state', g.dest_state, 'pos', g.pos, 'items', g.items, 'tally_no', g.tally_no,
      'tally_date', g.tally_date, 'tally_total', g.tally_total, 'tally_by', pe.display_name, 'shop_state', app.shop_state(c.company_id),
      'cancel_how', g.cancel_how, 'cn_no', g.cn_no, 'cn_date', g.cn_date)
    from public.slip_gst g left join public.people pe on pe.company_id = g.company_id and pe.id = g.tally_by
    where g.company_id = c.company_id and g.order_id = p_order);
end $$;

revoke all on function app.tally_cancel_card(), public.api_slip_tally(uuid, uuid, text, uuid, text, date, boolean, numeric),
  public.api_tally_cancel(uuid, uuid, text, uuid, text, text, date), public.api_ca_sent(uuid, uuid, text, text, text, int, numeric),
  public.api_gst_bills(uuid, date, date) from public, anon, authenticated;
grant execute on function public.api_slip_tally(uuid, uuid, text, uuid, text, date, boolean, numeric),
  public.api_tally_cancel(uuid, uuid, text, uuid, text, text, date), public.api_ca_sent(uuid, uuid, text, text, text, int, numeric),
  public.api_gst_bills(uuid, date, date) to service_role;
