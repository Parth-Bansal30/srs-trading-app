-- 6 Nov 2026 (plan v2, F9): the same customer twice, and joining two customers.
-- a) While adding, the phone asks ("Already in khata: … — use this one?"); a "different person" answer is kept here.
--    A customer added WITHOUT internet is checked when it reaches the server: a possible pair goes to "To check" —
--    nothing is changed by itself.
-- b) Joining (owner only) never moves an old slip or payment: it writes matching balance entries. The old customer's due
--    on a side is cleared by a "join" entry (mode Adjust — no money) and the same amount is added to the kept customer as
--    a balance brought over; money the old customer had with us goes the other way. Both are linked to the join record.
--    Remembered bank payers move to the kept customer and its missing special rates are copied. The old customer is
--    marked "joined into …" (pickers hide it; it can still be opened and read).
-- c) Undo while neither customer has anything new: every join entry gets its exact opposite (audited), the marks go back.

-- ---------- a) marks and records ----------
alter table public.customers
  add column joined_into uuid,
  add column joined_at   timestamptz,
  add constraint customers_joined_fk foreign key (company_id, joined_into) references public.customers(company_id, id),
  add constraint customers_joined_self check (joined_into is distinct from id),
  add constraint customers_joined_pair check ((joined_into is null) = (joined_at is null));
create index customers_joined_idx on public.customers (company_id, joined_into) where joined_into is not null;

create table public.customer_joins (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  kept_id     uuid not null,
  old_id      uuid not null,
  moves       jsonb not null,                       -- [{ side, kind: due | credit, amount }]
  moved       jsonb not null default '{}'::jsonb,   -- { payers: [key], rates: [material_id] } — moved / copied with it
  stamp       text not null,                        -- both khatas just before the join (undo only while nothing is new)
  note        text check (note is null or length(note) <= 300),
  status      text not null default 'ok' check (status in ('ok','undone')),
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  undone_by   uuid,
  undone_at   timestamptz,
  unique (company_id, id),
  foreign key (company_id, kept_id) references public.customers(company_id, id),
  foreign key (company_id, old_id) references public.customers(company_id, id),
  foreign key (company_id, created_by) references public.people(company_id, id),
  foreign key (company_id, undone_by) references public.people(company_id, id),
  check (kept_id <> old_id)
);
create unique index customer_joins_one on public.customer_joins (company_id, old_id) where status = 'ok';
create index customer_joins_kept_idx on public.customer_joins (company_id, kept_id);
alter table public.customer_joins enable row level security;
revoke all on public.customer_joins from anon, authenticated;
create trigger guard before update or delete on public.customer_joins for each row execute function app.guard_undo_only();
create trigger audit after insert or update on public.customer_joins for each row execute function app.audit_row();

create table public.customer_not_same (
  company_id  uuid not null references public.companies(id) on delete restrict,
  customer_id uuid not null,
  other_id    uuid not null,
  said_by     uuid,
  said_at     timestamptz not null default now(),
  primary key (company_id, customer_id, other_id),
  foreign key (company_id, customer_id) references public.customers(company_id, id),
  foreign key (company_id, other_id) references public.customers(company_id, id),
  foreign key (company_id, said_by) references public.people(company_id, id),
  check (customer_id <> other_id)
);
alter table public.customer_not_same enable row level security;
revoke all on public.customer_not_same from anon, authenticated;
create trigger audit after insert on public.customer_not_same for each row execute function app.audit_row();

-- the balance entries: a "join" payment (no money: mode Adjust, never at an order) and old balances, both linked
alter table public.payments add column join_id uuid,
  add constraint payments_join_fk foreign key (company_id, join_id) references public.customer_joins(company_id, id),
  drop constraint payments_kind_check,
  add constraint payments_kind_check check (kind in ('advance','pickup','khata','reversal','refund','transfer','join')),
  drop constraint payments_adjust_rule,
  add constraint payments_adjust_rule check ((mode = 'Adjust') = (kind in ('transfer','join') or from_payment_id is not null or (kind = 'reversal' and join_id is not null))),
  add constraint payments_join_rule check ((kind = 'join') <= (join_id is not null and order_id is null));
create index payments_join_idx on public.payments (company_id, join_id) where join_id is not null;
alter table public.old_dues add column join_id uuid,
  add constraint old_dues_join_fk foreign key (company_id, join_id) references public.customer_joins(company_id, id);
create index old_dues_join_idx on public.old_dues (company_id, join_id) where join_id is not null;

-- only the join itself writes (and only its undo reverses) these entries
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
  if (new.kind = 'join' or new.join_id is not null) and coalesce(current_setting('app.joining', true), '') <> 'on' then
    raise exception 'This entry belongs to joining two customers.' using errcode = 'check_violation';
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
    if orig.kind = 'join' and new.join_id is distinct from orig.join_id then
      raise exception 'This entry came from joining two customers — undo the join instead.' using errcode = 'check_violation';
    end if;
    if new.amount <> -orig.amount or new.customer_id <> orig.customer_id
       or new.order_id is distinct from orig.order_id or new.side is distinct from orig.side then
      raise exception 'A reversal must be the exact opposite of the original payment.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create or replace function app.guard_old_due() returns trigger
language plpgsql set search_path = '' as $$
declare orig public.old_dues;
begin
  if new.due_date > (now() at time zone (select timezone from public.companies where id = new.company_id))::date then
    raise exception 'An old balance cannot be dated in the future.' using errcode = 'check_violation';
  end if;
  if new.join_id is not null and coalesce(current_setting('app.joining', true), '') <> 'on' then
    raise exception 'This entry belongs to joining two customers.' using errcode = 'check_violation';
  end if;
  if new.reverses_id is not null then
    select * into orig from public.old_dues d where d.id = new.reverses_id and d.company_id = new.company_id;
    if orig.reverses_id is not null or new.amount <> -orig.amount or new.customer_id <> orig.customer_id
       or new.side <> orig.side or new.ref is distinct from orig.ref or new.due_date <> orig.due_date then
      raise exception 'A correction must be the exact opposite of the original entry.' using errcode = 'check_violation';
    end if;
    if orig.join_id is not null and new.join_id is distinct from orig.join_id then
      raise exception 'This entry came from joining two customers — undo the join instead.' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

-- a join entry is never "the same payment twice?" (the rest of the check is unchanged)
create or replace function app.payment_twin_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare t record; tz text; fact jsonb;
begin
  if current_setting('app.no_twin', true) = 'on' or new.kind = 'join' then return null; end if;
  select timezone into tz from public.companies where id = new.company_id;
  for t in select p.*, pe.display_name as by_name from public.payments p left join public.people pe on pe.company_id = p.company_id and pe.id = p.created_by
            where p.company_id = new.company_id and p.customer_id = new.customer_id and p.id <> new.id and p.kind not in ('reversal', 'join')
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

-- ---------- b) the same customer twice ----------
/** "+91 98110-22334" → "9811022334" ('' when fewer than 10 digits) — the same as core phone10. */
create function app.phone10(p text) returns text language sql immutable set search_path = '' as $$
  select case when length(d) >= 10 then right(d, 10) else '' end from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$$;
/** "M/s. Sharma Engg. & Co." → "sharma eng" — the same as core normName (used for entries that arrive from offline). */
create function app.norm_name(p text) returns text language sql immutable set search_path = '' as $$
  select coalesce(string_agg(w2, ' ' order by i), '') from (
    select i, case
        when w ~ '^(engineering|engineers|engineer|engg|eng)$' then 'eng'
        when w ~ '^(traders|trader|trading|trdg)$' then 'trd'
        when w ~ '^(steels|steel)$' then 'steel'
        when w ~ '^(enterprises|enterprise|ent|entp)$' then 'ent'
        when w ~ '^(industries|industry|inds|ind)$' then 'ind'
        when w ~ '^(brothers|bros|bro)$' then 'bros'
        when w ~ '^(works|work)$' then 'works'
        when w ~ '^(tools|tool)$' then 'tools'
        else w end as w2
    from unnest(regexp_split_to_array(btrim(regexp_replace(replace(lower(coalesce(p, '')), '&', ' '), E'[^a-z0-9ऀ-ॿ]+', ' ', 'g')), '\s+'))
         with ordinality as t(w, i)
  ) x where w2 <> '' and w2 not in ('m','s','ms','and','the','co','company','pvt','private','ltd','limited','llp','firm','shop')
$$;

drop function public.api_create_customer(uuid, uuid, text, text, text, text, uuid);
create function public.api_create_customer(p_caller uuid, p_key uuid, p_hash text, p_name text, p_phone text, p_notes text,
                                           p_id uuid default null, p_not_same uuid[] default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; cu public.customers; o record; ph text; nm text;
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
  -- "a different person" (asked on the phone) is kept
  insert into public.customer_not_same (company_id, customer_id, other_id, said_by)
    select c.company_id, cu.id, x.id, c.id from public.customers x
    where x.company_id = c.company_id and x.id = any(coalesce(p_not_same, '{}')) and x.id <> cu.id
    on conflict do nothing;
  -- made without internet: nobody was asked — a possible pair goes to "To check", nothing is changed
  if nullif(current_setting('app.at', true), '') is not null then
    ph := app.phone10(cu.phone); nm := app.norm_name(cu.name);
    for o in select x.id, x.name, x.phone from public.customers x
             where x.company_id = c.company_id and x.id <> cu.id and x.active and x.joined_into is null
               and ((ph <> '' and app.phone10(x.phone) = ph) or (nm <> '' and app.norm_name(x.name) = nm))
               and not exists (select 1 from public.customer_not_same n where n.company_id = c.company_id and n.customer_id = cu.id and n.other_id = x.id)
             order by x.created_at limit 3 loop
      perform app.review_add(c.company_id, 'maybe_same_customer', cu.id, o.id, jsonb_build_object('new', cu.name, 'other', o.name, 'other_id', o.id,
        'why', case when ph <> '' and app.phone10(o.phone) = ph then 'phone' else 'name' end,
        'text', format('Added without internet: %s — the khata already has %s (%s). Same customer? Join them from the customer page, or mark this checked.',
          cu.name, o.name, case when ph <> '' and app.phone10(o.phone) = ph then 'same phone' else 'similar name' end)), cu.id, null, null, 'check', c.id);
    end loop;
  end if;
  return app.idem_done(c.company_id, p_key, to_jsonb(cu));
end $$;

-- ---------- c) joining ----------
/** A fingerprint of everything in both khatas (so a join is refused if something changed after the preview). */
create function app.join_stamp(p_company uuid, p_kept uuid, p_old uuid, p_skip uuid default null) returns text
language sql stable security definer set search_path = '' as $$
  select md5(coalesce(string_agg(x, ',' order by x), '')) from (
    select 'p' || p.id::text as x from public.payments p where p.company_id = p_company and p.customer_id in (p_kept, p_old)
      and (p_skip is null or p.join_id is distinct from p_skip)
    union all select 'd' || d.id::text from public.old_dues d where d.company_id = p_company and d.customer_id in (p_kept, p_old)
      and (p_skip is null or d.join_id is distinct from p_skip)
    union all select 'o' || o.id::text || o.status || coalesce(o.total_amount::text, '') || coalesce(o.in_khata::text, '')
      from public.orders o where o.company_id = p_company and o.customer_id in (p_kept, p_old)
  ) y
$$;

/** What the join screen needs besides the khatas: the two customers, open slips of the old one, joins, the stamp. */
create function public.api_customer_join_check(p_caller uuid, p_kept uuid, p_old uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'settings');
  return jsonb_build_object(
    'kept', (select jsonb_build_object('id', id, 'name', name, 'phone', phone, 'joined_into', joined_into) from public.customers where company_id = c.company_id and id = p_kept),
    'old', (select jsonb_build_object('id', id, 'name', name, 'phone', phone, 'joined_into', joined_into) from public.customers where company_id = c.company_id and id = p_old),
    'open_slips', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'slip_no', o.slip_no, 'status', o.status) order by o.created_at)
      from public.orders o where o.company_id = c.company_id and o.customer_id = p_old and o.status in ('estimate','accepted','weighed')), '[]'::jsonb),
    'stamp', app.join_stamp(c.company_id, p_kept, p_old));
end $$;

create function public.api_customer_join(p_caller uuid, p_key uuid, p_hash text, p_kept uuid, p_old uuid, p_moves jsonb, p_stamp text, p_note text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; k public.customers; o public.customers; tz text; v_day date; j uuid;
  m jsonb; v_side text; v_kind text; v_amt numeric; v_payers text[]; v_rates uuid[]; v_open text;
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'customerJoin', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into k from public.customers where company_id = c.company_id and id = p_kept for update;
  select * into o from public.customers where company_id = c.company_id and id = p_old for update;
  if k.id is null or o.id is null then raise exception 'Choose the two customers.' using errcode = '22023'; end if;
  if k.id = o.id then raise exception 'Choose two different customers.' using errcode = '22023'; end if;
  if o.joined_into is not null then raise exception '% is already joined into another customer.', o.name using errcode = '22023'; end if;
  if k.joined_into is not null then raise exception '% is joined into another customer — keep that one instead.', k.name using errcode = '22023'; end if;
  select string_agg('#' || slip_no::text, ', ' order by created_at) into v_open from public.orders
    where company_id = c.company_id and customer_id = o.id and status in ('estimate','accepted','weighed');
  if v_open is not null then
    raise exception 'Finish or cancel % of % first — open slips stay with their customer.', v_open, o.name using errcode = '22023';
  end if;
  if p_stamp is distinct from app.join_stamp(c.company_id, k.id, o.id) then
    raise exception 'Something changed in these khatas after the preview. Please look again.' using errcode = '40001';
  end if;
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) > 4 then raise exception 'Wrong request.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p_moves) x
             where (x ->> 'side') not in ('pakka','kacha') or (x ->> 'kind') not in ('due','credit')
                or coalesce(x ->> 'amount', '') !~ '^[0-9]+(\.[0-9]{1,2})?$' or (x ->> 'amount')::numeric <= 0 or (x ->> 'amount')::numeric > 1e9)
     or (select count(*) from (select distinct x ->> 'side', x ->> 'kind' from jsonb_array_elements(p_moves) x) d) <> jsonb_array_length(p_moves) then
    raise exception 'Wrong request.' using errcode = '22023';
  end if;
  select timezone into tz from public.companies where id = c.company_id;
  v_day := (now() at time zone tz)::date;

  -- remembered bank payers now mean the kept customer
  with u as (update public.bank_payers set customer_id = k.id, updated_by = c.id, updated_at = now()
             where company_id = c.company_id and customer_id = o.id returning key)
  select coalesce(array_agg(key), '{}') into v_payers from u;
  -- special rates the kept customer doesn't have yet are copied
  with cur as (select distinct on (r.material_id) r.material_id, r.rate from public.customer_rates r
               where r.company_id = c.company_id and r.customer_id = o.id order by r.material_id, r.effective_from desc),
       ins as (insert into public.customer_rates (company_id, customer_id, material_id, rate, created_by)
               select c.company_id, k.id, cur.material_id, cur.rate, c.id from cur
               where cur.rate is not null and not exists (select 1 from public.customer_rates r2 where r2.company_id = c.company_id
                       and r2.customer_id = k.id and r2.material_id = cur.material_id)
               returning material_id)
  select coalesce(array_agg(material_id), '{}') into v_rates from ins;

  insert into public.customer_joins (company_id, kept_id, old_id, moves, moved, stamp, note, created_by)
    values (c.company_id, k.id, o.id, p_moves, jsonb_build_object('payers', to_jsonb(v_payers), 'rates', to_jsonb(v_rates)), p_stamp,
            nullif(left(btrim(coalesce(p_note, '')), 300), ''), c.id) returning id into j;
  perform set_config('app.joining', 'on', true);
  perform set_config('app.no_twin', 'on', true);
  for m in select * from jsonb_array_elements(p_moves) loop
    v_side := m ->> 'side'; v_kind := m ->> 'kind'; v_amt := (m ->> 'amount')::numeric;
    if v_kind = 'due' then
      -- the old customer's due is cleared; the kept customer owes it
      insert into public.payments (company_id, customer_id, amount, mode, kind, side, note, created_by, join_id)
        values (c.company_id, o.id, v_amt, 'Adjust', 'join', v_side,
                format('Joined into %s on %s by %s', k.name, to_char(v_day, 'DD Mon'), c.display_name), c.id, j);
      insert into public.old_dues (company_id, customer_id, side, ref, due_date, amount, note, created_by, join_id)
        values (c.company_id, k.id, v_side, null, v_day, v_amt, format('Brought from %s (joined on %s)', o.name, to_char(v_day, 'DD Mon')), c.id, j);
    else
      -- money the old customer had with us moves to the kept customer
      insert into public.old_dues (company_id, customer_id, side, ref, due_date, amount, note, created_by, join_id)
        values (c.company_id, o.id, v_side, null, v_day, v_amt, format('Joined into %s on %s by %s — money with us moved there', k.name, to_char(v_day, 'DD Mon'), c.display_name), c.id, j);
      insert into public.payments (company_id, customer_id, amount, mode, kind, side, note, created_by, join_id)
        values (c.company_id, k.id, v_amt, 'Adjust', 'join', v_side, format('Money with us brought from %s (joined on %s)', o.name, to_char(v_day, 'DD Mon')), c.id, j);
    end if;
  end loop;
  perform set_config('app.joining', '', true);
  perform set_config('app.no_twin', '', true);

  update public.customers set joined_into = k.id, joined_at = now() where company_id = c.company_id and id = o.id;
  update public.review_items set status = 'done', answer = 'Joined into ' || k.name || ' by ' || c.display_name, answered_by = c.id, answered_at = now()
    where company_id = c.company_id and kind = 'maybe_same_customer' and status = 'open'
      and ((ref_id = o.id and ref2_id = k.id) or (ref_id = k.id and ref2_id = o.id));
  return app.idem_done(c.company_id, p_key, jsonb_build_object('join_id', j, 'kept_id', k.id, 'old_id', o.id, 'moves', p_moves,
    'payers', to_jsonb(v_payers), 'rates', to_jsonb(v_rates)));
end $$;

/** Undo a join while neither customer has anything new: every join entry gets its exact opposite; the marks go back. */
create function public.api_customer_join_undo(p_caller uuid, p_key uuid, p_hash text, p_join uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; jn public.customer_joins; k text; o text; v_new text; r record; tz text;
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'customerJoinUndo', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  select * into jn from public.customer_joins where company_id = c.company_id and id = p_join for update;
  if jn.id is null then raise exception 'Which join?' using errcode = '22023'; end if;
  if jn.status <> 'ok' then raise exception 'This join was already undone.' using errcode = '22023'; end if;
  select name into k from public.customers where company_id = c.company_id and id = jn.kept_id;
  select name into o from public.customers where company_id = c.company_id and id = jn.old_id;
  select coalesce(
    (select format('%s: a payment of ₹%s on %s', cu.name, p.amount, to_char(p.received_at at time zone co.timezone, 'DD Mon')) from public.payments p
       join public.customers cu on cu.company_id = p.company_id and cu.id = p.customer_id join public.companies co on co.id = p.company_id
       where p.company_id = c.company_id and p.customer_id in (jn.kept_id, jn.old_id) and p.created_at >= jn.created_at and p.join_id is distinct from jn.id
       order by p.created_at limit 1),
    (select format('%s: slip #%s', cu.name, x.slip_no) from public.orders x join public.customers cu on cu.company_id = x.company_id and cu.id = x.customer_id
       where x.company_id = c.company_id and x.customer_id in (jn.kept_id, jn.old_id)
         and (x.created_at >= jn.created_at or x.done_at >= jn.created_at or x.cancelled_at >= jn.created_at or x.deleted_at >= jn.created_at)
       order by x.created_at limit 1),
    (select format('%s: an old balance', cu.name) from public.old_dues d join public.customers cu on cu.company_id = d.company_id and cu.id = d.customer_id
       where d.company_id = c.company_id and d.customer_id in (jn.kept_id, jn.old_id) and d.created_at >= jn.created_at and d.join_id is distinct from jn.id limit 1))
  into v_new;
  if app.join_stamp(c.company_id, jn.kept_id, jn.old_id, jn.id) <> jn.stamp then
    raise exception 'Can''t undo: there are new entries since the join%. Undo only works before anything new is written.',
      coalesce(' (' || v_new || ')', '') using errcode = '22023';
  end if;
  select timezone into tz from public.companies where id = c.company_id;
  perform set_config('app.joining', 'on', true);
  perform set_config('app.no_twin', 'on', true);
  for r in select * from public.payments where company_id = c.company_id and join_id = jn.id and kind = 'join' loop
    insert into public.payments (company_id, customer_id, amount, mode, kind, side, note, reverses_payment_id, created_by, join_id)
      values (c.company_id, r.customer_id, -r.amount, 'Adjust', 'reversal', r.side, left('Join undone' || coalesce(': ' || nullif(btrim(p_note), ''), ''), 500), r.id, c.id, jn.id);
  end loop;
  for r in select * from public.old_dues d where d.company_id = c.company_id and d.join_id = jn.id and d.reverses_id is null loop
    insert into public.old_dues (company_id, customer_id, side, ref, due_date, amount, note, reverses_id, created_by, join_id)
      values (c.company_id, r.customer_id, r.side, r.ref, r.due_date, -r.amount, 'Join undone', r.id, c.id, jn.id);
  end loop;
  perform set_config('app.joining', '', true);
  perform set_config('app.no_twin', '', true);
  update public.customers set joined_into = null, joined_at = null where company_id = c.company_id and id = jn.old_id and joined_into = jn.kept_id;
  update public.bank_payers set customer_id = jn.old_id, updated_by = c.id, updated_at = now()
    where company_id = c.company_id and customer_id = jn.kept_id and key in (select jsonb_array_elements_text(coalesce(jn.moved -> 'payers', '[]'::jsonb)));
  -- the copied special rates are taken off again (a rate row with no rate = "special rate removed")
  insert into public.customer_rates (company_id, customer_id, material_id, rate, effective_from, created_by)
    select c.company_id, jn.kept_id, x::uuid, null, clock_timestamp(), c.id from jsonb_array_elements_text(coalesce(jn.moved -> 'rates', '[]'::jsonb)) x;
  update public.customer_joins set status = 'undone', undone_by = c.id, undone_at = now() where company_id = c.company_id and id = jn.id;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('join_id', jn.id, 'kept_id', jn.kept_id, 'old_id', jn.old_id, 'undone', true));
end $$;

/** A customer's joins: who was joined into it (its "history from" links) and what it was joined into. */
create function public.api_customer_joins(p_caller uuid, p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'money');
  return coalesce((select jsonb_agg(jsonb_build_object('id', j.id, 'kept_id', j.kept_id, 'kept', k.name, 'old_id', j.old_id, 'old', o.name,
      'moves', case when app.has(c, 'kacha') then j.moves else (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(j.moves) x where x ->> 'side' = 'pakka') end,
      'note', j.note, 'status', j.status, 'at', j.created_at, 'by', pe.display_name, 'undone_at', j.undone_at, 'undone_by', pu.display_name) order by j.created_at desc)
    from public.customer_joins j
    join public.customers k on k.company_id = j.company_id and k.id = j.kept_id
    join public.customers o on o.company_id = j.company_id and o.id = j.old_id
    left join public.people pe on pe.company_id = j.company_id and pe.id = j.created_by
    left join public.people pu on pu.company_id = j.company_id and pu.id = j.undone_by
    where j.company_id = c.company_id and (j.kept_id = p_customer or j.old_id = p_customer)), '[]'::jsonb);
end $$;

revoke all on function public.api_create_customer(uuid, uuid, text, text, text, text, uuid, uuid[]),
  public.api_customer_join_check(uuid, uuid, uuid), public.api_customer_join(uuid, uuid, text, uuid, uuid, jsonb, text, text),
  public.api_customer_join_undo(uuid, uuid, text, uuid, text), public.api_customer_joins(uuid, uuid),
  app.join_stamp(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.api_create_customer(uuid, uuid, text, text, text, text, uuid, uuid[]),
  public.api_customer_join_check(uuid, uuid, uuid), public.api_customer_join(uuid, uuid, text, uuid, uuid, jsonb, text, text),
  public.api_customer_join_undo(uuid, uuid, text, uuid, text), public.api_customer_joins(uuid, uuid) to service_role;
