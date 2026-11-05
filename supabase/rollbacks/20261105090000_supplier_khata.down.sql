-- Undo 20261105090000_supplier_khata: credit notes, opening balances and the payment ↔ bill splits are lost; every bill's
-- Paid tick is put back exactly as it was before (private.f6_pay_status_before). Goods sent back with a note: their
-- stock moves are removed too (only for this undo).
drop trigger if exists supplier_touch on public.expenses;
drop trigger if exists pay_state on public.purchases;
drop trigger if exists supplier_follow on public.purchases;
drop function if exists app.purchase_cancel_follow();
drop function if exists public.api_supplier_allocate(uuid, uuid, text, uuid, jsonb);
drop function if exists public.api_supplier_opening(uuid, uuid, text, jsonb);
drop function if exists public.api_supplier_settings(uuid, uuid, text, uuid, int);
drop function if exists public.api_supplier_note(uuid, uuid, text, jsonb);
drop function if exists public.api_supplier_note_cancel(uuid, uuid, text, uuid, text);
drop function if exists public.api_supplier_data(uuid, uuid);
drop function if exists app.supplier_allocate(public.people, public.expenses, jsonb, boolean);
drop function if exists app.supplier_auto_parts(public.people, uuid, uuid[], numeric);
alter table public.stock_moves disable trigger stock_moves_no_change;
delete from public.stock_moves where kind in ('return_out', 'return_undo');
alter table public.stock_moves enable trigger stock_moves_no_change;
alter table public.stock_moves drop constraint stock_moves_return_link, drop constraint stock_moves_note_line;
alter table public.stock_moves drop column supplier_note_line_id;
alter table public.stock_moves drop constraint stock_moves_kind_check,
  add constraint stock_moves_kind_check check (kind in ('purchase','purchase_undo','sale','sale_undo','adjust','scrap'));
alter table public.stock_moves drop constraint stock_moves_sign,
  add constraint stock_moves_sign check (kind = 'adjust' or (kind in ('purchase','sale_undo')) = (qty_kg > 0));
drop table public.supplier_allocations;
drop table public.supplier_note_lines;
drop table public.supplier_notes;
drop function if exists app.alloc_touch();
drop function if exists app.note_touch();
drop function if exists app.expense_touch();
drop function if exists app.purchases_touch(uuid, uuid[]);
drop function if exists app.purchase_pay_state();

drop function if exists app.opening_left(uuid);
drop function if exists app.guard_undo_only();
update public.purchases p set pay_status = b.pay_status, paid_at = b.paid_at from private.f6_pay_status_before b
  where b.id = p.id and (p.pay_status, p.paid_at) is distinct from (b.pay_status, b.paid_at);
drop table private.f6_pay_status_before;
alter table public.purchases drop constraint purchases_settled_by, drop column settled, drop column settled_by, drop column settled_at;
alter table public.suppliers drop column credit_days;
-- the old ways
create or replace function public.api_purchases(p_caller uuid, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean;
begin
  perform app.require(c, 'stock');
  k := app.has(c, 'kacha');
  return coalesce((select jsonb_agg(x) from (
      select jsonb_build_object('id', p.id, 'kind', p.kind, 'supplier', sp.name, 'bill_no', p.bill_no, 'bill_date', p.bill_date,
        'bill_type', p.bill_type, 'total', p.total_amount, 'kg', p.total_kg, 'pay_status', p.pay_status, 'status', p.status,
        'lines', (select count(*) from public.purchase_lines pl where pl.purchase_id = p.id), 'created_at', p.created_at) x
      from public.purchases p left join public.suppliers sp on sp.id = p.supplier_id
      where p.company_id = c.company_id and (k or p.bill_type = 'pakka')
      order by p.bill_date desc, p.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) q), '[]'::jsonb);
end $$;
create or replace function public.api_purchase(p_caller uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); p public.purchases;
begin
  perform app.require(c, 'stock');
  select * into p from public.purchases where id = p_id and company_id = c.company_id;
  if p.id is null or (p.bill_type = 'kacha' and not app.has(c, 'kacha')) then raise exception 'Bill not found.' using errcode = '22023'; end if;
  return jsonb_build_object(
    'purchase', to_jsonb(p) - 'idempotency_key',
    'supplier', (select jsonb_build_object('id', id, 'name', name, 'gstin', gstin, 'phone', phone, 'city', city) from public.suppliers where id = p.supplier_id),
    'by', (select display_name from public.people where id = p.created_by),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('id', pl.id, 'description', pl.description, 'hsn', pl.hsn, 'kg', pl.qty_kg, 'rate', pl.rate,
        'amount', pl.amount, 'freight_share', pl.freight_share, 'stock_item_id', pl.stock_item_id, 'code', m.code, 'shape', s.shape, 'label', s.label,
        'on_hand', app.stock_on_hand(s.id)) order by pl.position)
      from public.purchase_lines pl join public.stock_items s on s.id = pl.stock_item_id join public.materials m on m.id = s.material_id
      where pl.purchase_id = p.id), '[]'::jsonb),
    -- a bill can be cancelled only while all of its stock is still there
    'can_cancel', p.status = 'saved' and not exists (
      select 1 from (select pl.stock_item_id, sum(pl.qty_kg) q from public.purchase_lines pl where pl.purchase_id = p.id group by pl.stock_item_id) t
      where app.stock_on_hand(t.stock_item_id) < t.q));
end $$;
create or replace function public.api_save_expense(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.people := app.caller(p_caller); prev jsonb; v_tz text; a public.money_accounts; e public.expenses; old public.expenses;
  v_kind text := coalesce(p ->> 'kind', 'expense'); v_amt numeric := round((p ->> 'amount')::numeric, 2); v_at timestamptz;
  v_gst boolean := coalesce((p ->> 'gst_bill')::boolean, false); v_sup uuid := nullif(p ->> 'supplier_id', '')::uuid;
  v_bills uuid[] := coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p -> 'purchase_ids', '[]')) x), '{}');
  v_old uuid := nullif(p ->> 'replaces_id', '')::uuid; n int; boss boolean := app.has(c, 'settings');
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

  if v_old is not null then  -- a corrected entry: the old one is cancelled in the same step
    select * into old from public.expenses where company_id = c.company_id and id = v_old for update;
    if old.id is null then raise exception 'Expense not found.' using errcode = '22023'; end if;
    if old.status <> 'ok' then raise exception 'That expense was already cancelled or changed.' using errcode = '23001'; end if;
    if not boss and (old.created_by is distinct from c.id or old.business_date < (now() at time zone v_tz)::date) then
      raise exception 'Only the owner can change an older expense or someone else''s.' using errcode = '42501';
    end if;
    if old.kind <> v_kind then raise exception 'Cancel it and add a new one instead.' using errcode = '22023'; end if;
    update public.expenses set status = 'cancelled', cancelled_at = now(), cancelled_by = c.id, cancel_reason = 'Changed' where id = old.id;
    if cardinality(old.purchase_ids) > 0 then
      update public.purchases set pay_status = 'to_pay', paid_at = null where company_id = c.company_id and id = any(old.purchase_ids) and pay_status = 'paid';
    end if;
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
  if cardinality(v_bills) > 0 then
    update public.purchases set pay_status = 'paid', paid_at = v_at where company_id = c.company_id and id = any(v_bills);
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('expense_id', e.id, 'amount', e.amount, 'day', e.business_date,
    'mode', app.part_mode(a.kind, e.method), 'replaced', v_old));
end $$;
create or replace function public.api_purchase_paid(p_caller uuid, p_key uuid, p_hash text, p_id uuid, p_paid boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; rid uuid;
begin
  perform app.require(c, 'stock');
  prev := app.idem_start(c.company_id, p_key, 'purchasePaid', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.purchases set pay_status = case when p_paid then 'paid' else 'to_pay' end, paid_at = case when p_paid then now() end
    where id = p_id and company_id = c.company_id and (bill_type = 'pakka' or app.has(c, 'kacha')) returning id into rid;
  if rid is null then raise exception 'Bill not found.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('purchase_id', rid, 'pay_status', case when p_paid then 'paid' else 'to_pay' end));
end $$;
drop function if exists app.purchase_left(uuid);
