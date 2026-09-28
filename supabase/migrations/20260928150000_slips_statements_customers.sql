-- =====================================================================================
-- 12. Slips and statements for the customer, customer details, UPI for payments.
--
--  • shared_docs: a snapshot of what the CUSTOMER sees (a slip or an account statement),
--    built by the backend from the real figures when staff send, print or save it. Each has a
--    long random token: the WhatsApp message carries a link with it, so the customer opens the
--    slip without logging in. The snapshot never contains rates per kg, cutting rates, internal
--    payment notes or the word "kacha".
--  • shared_doc(token): the ONLY thing a not-logged-in visitor can call — it returns one
--    snapshot for a token, nothing else.
--  • Customers get a GST number and an address; companies get a UPI ID for the pay QR.
-- =====================================================================================

alter table public.customers
  add column gstin   text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  add column address text check (address is null or length(address) <= 300);

alter table public.company_settings
  add column upi_id text check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$');
comment on column public.company_settings.upi_id is 'Shop UPI ID for the "scan to pay" QR on slips and statements (e.g. shopname@okaxis).';

-- ---------- what the customer is sent ----------
create table public.shared_docs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  token       text not null unique check (length(token) >= 20),
  kind        text not null check (kind in ('slip','statement')),
  order_id    uuid,
  customer_id uuid not null,
  lang        text not null default 'en' check (lang in ('en','hi','hn')),
  doc         jsonb not null check (jsonb_typeof(doc) = 'object'),
  has_no_bill boolean not null default false,  -- contains no-bill slips: only people with that permission see it in the app
  sent_at     timestamptz,             -- last time it was sent on WhatsApp
  send_count  integer not null default 0 check (send_count >= 0),
  opened_at   timestamptz,             -- last time the customer opened the link
  open_count  integer not null default 0 check (open_count >= 0),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, order_id) references public.orders(company_id, id),
  foreign key (company_id, customer_id) references public.customers(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  constraint shared_docs_slip_has_order check ((kind = 'slip') = (order_id is not null))
);
create unique index shared_docs_one_per_slip on public.shared_docs (company_id, order_id, lang) where kind = 'slip';
create index shared_docs_customer_idx on public.shared_docs (company_id, customer_id, created_at desc);
comment on table public.shared_docs is 'Slips and statements as the customer sees them (snapshots), opened by a secret link.';
alter table public.shared_docs enable row level security;
create policy shared_docs_read on public.shared_docs for select to authenticated
  using (company_id = (select app.current_company_id())
         and (select app.has_perm('money'))
         and (not has_no_bill or (select app.has_perm('kacha'))));
revoke all on public.shared_docs from anon;
revoke insert, update, delete, truncate, references, trigger on public.shared_docs from authenticated;
create trigger audit after insert or delete on public.shared_docs for each row execute function app.audit_row();

-- ---------- the header every slip / statement carries ----------
create function public.api_doc_header(p_caller uuid, p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); r jsonb;
begin
  perform app.require(c, 'money');
  select jsonb_build_object(
      'shop', jsonb_build_object('name', coalesce(nullif(s.slip_header ->> 'name', ''), co.name), 'address', co.address, 'phone', co.phone,
                                 'gstin', co.gstin, 'city', co.city),
      'upi', case when s.upi_id is not null then jsonb_build_object('id', s.upi_id, 'name', coalesce(nullif(s.slip_header ->> 'name', ''), co.name)) end,
      'show_weight', s.show_weight_on_slip,
      'timezone', co.timezone,
      'customer', (select jsonb_build_object('id', cu.id, 'name', cu.name, 'phone', cu.phone, 'gstin', cu.gstin, 'address', cu.address)
                   from public.customers cu where cu.id = p_customer and cu.company_id = c.company_id))
    into r
    from public.companies co join public.company_settings s on s.company_id = co.id where co.id = c.company_id;
  if r -> 'customer' is null or r -> 'customer' = 'null'::jsonb then raise exception 'Customer not found.' using errcode = '22023'; end if;
  return r;
end $$;

-- ---------- everything needed to write one finished slip ----------
create function public.api_slip_data(p_caller uuid, p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); o public.orders;
begin
  perform app.require(c, 'money');
  select * into o from public.orders where id = p_order and company_id = c.company_id;
  if o.id is null then raise exception 'Slip not found.' using errcode = '22023'; end if;
  if o.status <> 'done' then raise exception 'The slip is ready to send after pickup.' using errcode = '23514'; end if;
  if o.bill_type = 'kacha' then perform app.require(c, 'kacha'); end if;
  return public.api_doc_header(p_caller, o.customer_id) || jsonb_build_object(
    'order', jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'done_at', o.done_at, 'bill', o.bill_type, 'gst_pct', o.gst_pct,
      'total_weight', o.total_weight, 'material', o.material_amount, 'cutting', o.cutting_amount, 'gst', o.gst_amount, 'total', o.total_amount),
    'items', coalesce((select jsonb_agg(jsonb_build_object('grade', i.grade_code, 'shape', i.shape, 'unit', i.unit, 'dims', i.dims,
        'weight', i.actual_weight,
        'lengths', (select coalesce(jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs) order by l.position), '[]'::jsonb)
                    from public.order_item_lengths l where l.order_item_id = i.id))
        order by i.position) from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('at', p.received_at, 'amount', p.amount, 'mode', p.mode,
        'kind', coalesce(r.kind, p.kind)) order by p.received_at)
      from public.payments p left join public.payments r on r.id = p.reverses_payment_id
      where p.order_id = o.id), '[]'::jsonb));
end $$;

-- ---------- keep the snapshot and hand out its link ----------
-- A slip keeps ONE link per language (re-sending refreshes the snapshot, the link stays the same);
-- every statement gets its own link.
create function public.api_save_doc(p_caller uuid, p_key uuid, p_hash text, p_kind text, p_order uuid, p_customer uuid,
                                    p_lang text, p_doc jsonb, p_send boolean, p_no_bill boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; d public.shared_docs; o public.orders; nb boolean := coalesce(p_no_bill, false);
  tok text := translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/=', '-_');
begin
  perform app.require(c, 'money');
  if p_kind not in ('slip','statement') then raise exception 'Unknown document.' using errcode = '22023'; end if;
  if p_kind = 'statement' then perform app.require(c, 'khata'); end if;
  if p_kind = 'slip' then
    select * into o from public.orders where id = p_order and company_id = c.company_id;
    if o.id is null or o.status <> 'done' then raise exception 'The slip is ready to send after pickup.' using errcode = '23514'; end if;
    nb := o.bill_type = 'kacha';
    if o.customer_id <> p_customer then raise exception 'Wrong customer for this slip.' using errcode = '22023'; end if;
  elsif not exists (select 1 from public.customers where id = p_customer and company_id = c.company_id) then
    raise exception 'Customer not found.' using errcode = '22023';
  end if;
  if nb then perform app.require(c, 'kacha'); end if;
  prev := app.idem_start(c.company_id, p_key, 'saveDoc', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  if p_kind = 'slip' then
    insert into public.shared_docs (company_id, token, kind, order_id, customer_id, lang, doc, has_no_bill, created_by,
                                    sent_at, send_count)
      values (c.company_id, tok, 'slip', p_order, p_customer, coalesce(p_lang, 'en'), p_doc, nb, c.id,
              case when p_send then now() end, case when p_send then 1 else 0 end)
      on conflict (company_id, order_id, lang) where kind = 'slip' do update
        set doc = excluded.doc, has_no_bill = excluded.has_no_bill, updated_at = now(),
            sent_at = case when p_send then now() else shared_docs.sent_at end,
            send_count = shared_docs.send_count + case when p_send then 1 else 0 end
      returning * into d;
  else
    insert into public.shared_docs (company_id, token, kind, customer_id, lang, doc, has_no_bill, created_by, sent_at, send_count)
      values (c.company_id, tok, 'statement', p_customer, coalesce(p_lang, 'en'), p_doc, nb, c.id,
              case when p_send then now() end, case when p_send then 1 else 0 end)
      returning * into d;
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('id', d.id, 'token', d.token, 'sent_at', d.sent_at, 'send_count', d.send_count));
end $$;

-- ---------- the customer opens the link (no login) ----------
create function public.shared_doc(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.shared_docs;
begin
  if p_token is null or length(p_token) < 20 or length(p_token) > 64 then return null; end if;
  update public.shared_docs sd set open_count = sd.open_count + 1, opened_at = now()
    where sd.token = p_token and exists (select 1 from public.companies co where co.id = sd.company_id and co.active)
    returning * into d;
  if d.id is null then return null; end if;
  return jsonb_build_object('kind', d.kind, 'lang', d.lang, 'doc', d.doc, 'made_at', d.updated_at);
end $$;

-- ---------- customers: GST number and address can be edited ----------
create or replace function public.api_update_customer(p_caller uuid, p_key uuid, p_hash text, p_customer uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; cu public.customers;
begin
  perform app.require(c, 'new');
  prev := app.idem_start(c.company_id, p_key, 'updateCustomer', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.customers set
      name = coalesce(nullif(btrim(p_changes ->> 'name'), ''), name),
      phone = case when p_changes ? 'phone' then nullif(btrim(p_changes ->> 'phone'), '') else phone end,
      notes = case when p_changes ? 'notes' then nullif(btrim(p_changes ->> 'notes'), '') else notes end,
      gstin = case when p_changes ? 'gstin' then nullif(upper(regexp_replace(p_changes ->> 'gstin', '\s', '', 'g')), '') else gstin end,
      address = case when p_changes ? 'address' then nullif(btrim(p_changes ->> 'address'), '') else address end,
      active = coalesce((p_changes ->> 'active')::boolean, active)
    where id = p_customer and company_id = c.company_id returning * into cu;
  if cu.id is null then raise exception 'Customer not found.' using errcode = '22023'; end if;
  return app.idem_done(c.company_id, p_key, to_jsonb(cu));
end $$;

-- ---------- settings: the UPI ID joins the allowed list ----------
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
                    'reminder_after_days','reminder_repeat_days','upi_id');
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
      upi_id = case when p_changes ? 'upi_id' then nullif(btrim(p_changes ->> 'upi_id'), '') else upi_id end,
      updated_at = now(), updated_by = c.id
    where company_id = c.company_id returning * into s;
  if co is not null then
    update public.companies set
        name = coalesce(nullif(btrim(co ->> 'name'), ''), name),
        legal_name = case when co ? 'legal_name' then nullif(btrim(co ->> 'legal_name'), '') else legal_name end,
        gstin = case when co ? 'gstin' then nullif(upper(btrim(co ->> 'gstin')), '') else gstin end,
        phone = case when co ? 'phone' then nullif(btrim(co ->> 'phone'), '') else phone end,
        address = case when co ? 'address' then nullif(btrim(co ->> 'address'), '') else address end,
        city = case when co ? 'city' then nullif(btrim(co ->> 'city'), '') else city end
      where id = c.company_id;
  end if;
  return app.idem_done(c.company_id, p_key, to_jsonb(s));
end $$;

revoke all on function public.api_doc_header(uuid, uuid), public.api_slip_data(uuid, uuid),
  public.api_save_doc(uuid, uuid, text, text, uuid, uuid, text, jsonb, boolean, boolean) from public, anon, authenticated;
grant execute on function public.api_doc_header(uuid, uuid), public.api_slip_data(uuid, uuid),
  public.api_save_doc(uuid, uuid, text, text, uuid, uuid, text, jsonb, boolean, boolean) to service_role;
revoke all on function public.shared_doc(text) from public;
grant execute on function public.shared_doc(text) to anon, authenticated, service_role;
