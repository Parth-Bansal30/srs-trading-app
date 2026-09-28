-- =====================================================================================
-- Evening summary for the owner (approved by Parth 29 Sept 2026)
--   • api_day_data(caller, day): everything that happened on one shop day (only what the person may see)
--   • settings: on/off, time, days, who gets it (people.evening_summary)
--   • phone notifications: private.push_subscriptions, sent every evening by the api function when
--     pg_cron calls it (the secret for that call lives in Vault — set up by scripts/evening-setup.mjs)
-- =====================================================================================

-- ---------- settings ----------
alter table public.company_settings
  add column evening_on   boolean  not null default true,
  add column evening_time time     not null default '20:00',
  add column evening_days smallint[] not null default '{1,2,3,4,5,6}'
    check (evening_days <@ '{1,2,3,4,5,6,7}'::smallint[] and cardinality(evening_days) <= 7);
comment on column public.company_settings.evening_days is 'Days the evening summary is sent: 1 = Monday … 7 = Sunday (shop calendar).';

alter table public.people add column evening_summary boolean not null default false;
comment on column public.people.evening_summary is 'Gets the evening summary (only people who can see money).';
update public.people set evening_summary = true where role = 'owner' and active;

-- ---------- phone notification subscriptions (never readable by the app) ----------
create table private.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  person_id   uuid not null,
  endpoint    text not null unique check (endpoint ~ '^https://' and length(endpoint) <= 1000),
  p256dh      text not null check (length(p256dh) between 80 and 100),
  auth        text not null check (length(auth) between 16 and 30),
  user_agent  text check (user_agent is null or length(user_agent) <= 300),
  created_at  timestamptz not null default now(),
  last_ok_at  timestamptz,
  fails       integer not null default 0,
  foreign key (company_id, person_id) references public.people(company_id, id) on delete cascade
);
create index push_subscriptions_person_idx on private.push_subscriptions (company_id, person_id);
alter table private.push_subscriptions enable row level security;
revoke all on private.push_subscriptions from anon, authenticated;

create table private.evening_log (
  company_id uuid not null references public.companies(id) on delete restrict,
  day        date not null,
  sent_at    timestamptz not null default now(),
  sent       integer not null default 0,
  primary key (company_id, day)
);
alter table private.evening_log enable row level security;
revoke all on private.evening_log from anon, authenticated;

-- ---------- one shop day, as the person may see it ----------
create function public.api_day_data(p_caller uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); k boolean; v_tz text; v_s timestamptz; v_e timestamptz; v_day date;
begin
  perform app.require(c, 'money');
  k := app.has(c, 'kacha');
  select timezone into v_tz from public.companies where id = c.company_id;
  v_day := coalesce(p_day, (now() at time zone v_tz)::date);   -- no day = today in the shop's calendar
  v_s := v_day::timestamp at time zone v_tz;
  v_e := (v_day + 1)::timestamp at time zone v_tz;
  return jsonb_build_object(
    'timezone', v_tz, 'day', v_day,
    'today', (now() at time zone v_tz)::date,
    'shop', (select coalesce(nullif(st.slip_header ->> 'name', ''), co.name) from public.companies co
               join public.company_settings st on st.company_id = co.id where co.id = c.company_id),
    'settings', (select jsonb_build_object('weight_warn_pct', weight_warn_pct, 'min_inch', min_inch)
                 from public.company_settings where company_id = c.company_id),
    'orders', coalesce((select jsonb_agg(jsonb_build_object(
        'id', o.id, 'slip_no', o.slip_no, 'customer', cu.name, 'bill', o.bill_type, 'total', o.total_amount,
        'weight', o.total_weight, 'in_khata', o.in_khata, 'by', pc.display_name, 'done_at', o.done_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'grade', i.grade_code, 'rate', i.sell_rate, 'special', i.special_rate,
            'std_rate', (select r.sell_rate from public.material_rates r
                          where r.company_id = i.company_id and r.material_id = i.material_id and r.effective_from <= o.created_at
                          order by r.effective_from desc limit 1)) order by i.position)
          from public.order_items i where i.company_id = o.company_id and i.order_id = o.id), '[]'::jsonb),
        'payments', coalesce((select jsonb_agg(jsonb_build_object('amount', p.amount, 'kind', coalesce(r.kind, p.kind),
            'rev', p.reverses_payment_id is not null, 'mode', p.mode))
          from public.payments p left join public.payments r on r.id = p.reverses_payment_id
          where p.company_id = o.company_id and p.order_id = o.id), '[]'::jsonb)) order by o.done_at)
      from public.orders o
      join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      left join public.people pc on pc.company_id = o.company_id and pc.id = o.created_by
      where o.company_id = c.company_id and o.status = 'done' and o.done_at >= v_s and o.done_at < v_e
        and (k or o.bill_type is distinct from 'kacha')), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('amount', p.amount, 'kind', coalesce(r.kind, p.kind),
        'rev', p.reverses_payment_id is not null, 'mode', p.mode, 'customer', cu.name, 'order_id', p.order_id, 'at', p.received_at)
        order by p.received_at)
      from public.payments p
      join public.customers cu on cu.company_id = p.company_id and cu.id = p.customer_id
      left join public.payments r on r.id = p.reverses_payment_id
      left join public.orders o on o.company_id = p.company_id and o.id = p.order_id
      where p.company_id = c.company_id and p.received_at >= v_s and p.received_at < v_e
        and (k or (coalesce(p.side, 'pakka') = 'pakka' and o.bill_type is distinct from 'kacha'))), '[]'::jsonb),
    'cash_close', case when k then (select jsonb_build_object('expected', cc.expected_cash, 'counted', cc.counted_cash,
        'at', cc.closed_at, 'by', pe.display_name)
      from public.cash_closes cc left join public.people pe on pe.company_id = cc.company_id and pe.id = cc.closed_by
      where cc.company_id = c.company_id and cc.business_date = v_day order by cc.closed_at desc limit 1) end,
    'weighed', coalesce((select jsonb_agg(jsonb_build_object('slip_no', o.slip_no, 'grade', i.grade_code, 'shape', i.shape,
        'unit', i.unit, 'dims', i.dims, 'density', i.density, 'actual', i.actual_weight, 'min_inch', o.pricing_rules -> 'min_inch',
        'lengths', coalesce((select jsonb_agg(jsonb_build_object('len', l.len, 'pcs', l.pcs, 'cuts', l.cuts) order by l.position)
          from public.order_item_lengths l where l.company_id = i.company_id and l.order_item_id = i.id), '[]'::jsonb)))
      from public.order_items i join public.orders o on o.company_id = i.company_id and o.id = i.order_id
      where i.company_id = c.company_id and i.actual_weight is not null and o.weighed_at >= v_s and o.weighed_at < v_e
        and (k or o.bill_type is distinct from 'kacha')), '[]'::jsonb),
    'waiting', coalesce((select jsonb_agg(jsonb_build_object('slip_no', o.slip_no, 'customer', cu.name, 'weighed_at', o.weighed_at))
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.status = 'weighed' and o.weighed_at < v_s), '[]'::jsonb),
    'cancelled', coalesce((select jsonb_agg(jsonb_build_object('slip_no', o.slip_no, 'customer', cu.name, 'reason', o.cancel_reason))
      from public.orders o join public.customers cu on cu.company_id = o.company_id and cu.id = o.customer_id
      where o.company_id = c.company_id and o.status = 'cancelled' and o.cancelled_at >= v_s and o.cancelled_at < v_e), '[]'::jsonb),
    'last_week', (select jsonb_build_object('total', coalesce(sum(o.total_amount), 0), 'n', count(*))
      from public.orders o where o.company_id = c.company_id and o.status = 'done'
        and o.done_at >= v_s - interval '7 days' and o.done_at < v_e - interval '7 days'
        and (k or o.bill_type is distinct from 'kacha'))
  );
end $$;

-- ---------- evening summary settings ----------
create function public.api_evening_get(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  perform app.require(c, 'money');
  return (select jsonb_build_object(
    'on', s.evening_on, 'time', to_char(s.evening_time, 'HH24:MI'), 'days', to_jsonb(s.evening_days),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role, 'lang', p.preferred_lang,
        'on', p.evening_summary, 'kacha', coalesce((p.perms ->> 'kacha')::boolean, false),
        'phones', (select count(*) from private.push_subscriptions ps where ps.company_id = p.company_id and ps.person_id = p.id))
        order by p.role <> 'owner', p.display_name)
      from public.people p where p.company_id = c.company_id and p.active and coalesce((p.perms ->> 'money')::boolean, false)), '[]'::jsonb),
    'my_phones', (select count(*) from private.push_subscriptions ps where ps.company_id = c.company_id and ps.person_id = c.id))
    from public.company_settings s where s.company_id = c.company_id);
end $$;

create function public.api_evening_set(p_caller uuid, p_key uuid, p_hash text, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; v_pid uuid; v_on boolean;
begin
  perform app.require(c, 'settings');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'Nothing to change.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'eveningSet', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.company_settings set
    evening_on   = case when p_changes ? 'on'   then (p_changes ->> 'on')::boolean else evening_on end,
    evening_time = case when p_changes ? 'time' then (p_changes ->> 'time')::time else evening_time end,
    evening_days = case when p_changes ? 'days' then (select coalesce(array_agg(distinct d::smallint order by d::smallint), '{}')
                                                     from jsonb_array_elements_text(p_changes -> 'days') d) else evening_days end,
    updated_at = now(), updated_by = c.id
  where company_id = c.company_id;
  if p_changes ? 'people' then
    for v_pid, v_on in select key::uuid, value::boolean from jsonb_each_text(p_changes -> 'people') loop
      update public.people set evening_summary = v_on
       where id = v_pid and company_id = c.company_id and (not v_on or coalesce((perms ->> 'money')::boolean, false));
    end loop;
  end if;
  return app.idem_done(c.company_id, p_key, public.api_evening_get(p_caller));
end $$;

-- ---------- this phone: notifications on / off ----------
create function public.api_save_push(p_caller uuid, p_key uuid, p_hash text, p_sub jsonb, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; v_ep text := p_sub ->> 'endpoint';
begin
  if v_ep is null then raise exception 'No phone subscription.' using errcode = '22023'; end if;
  prev := app.idem_start(c.company_id, p_key, 'savePush', p_hash);
  if prev is not null then return prev; end if;
  delete from private.push_subscriptions where endpoint = v_ep;
  if p_on then
    perform app.require(c, 'money');
    insert into private.push_subscriptions (company_id, person_id, endpoint, p256dh, auth, user_agent)
      values (c.company_id, c.id, v_ep, p_sub -> 'keys' ->> 'p256dh', p_sub -> 'keys' ->> 'auth', left(p_sub ->> 'ua', 300));
  end if;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('on', p_on,
    'my_phones', (select count(*) from private.push_subscriptions where company_id = c.company_id and person_id = c.id)));
end $$;

/** The caller's own phones (for "send a test now"). */
create function public.api_my_push(p_caller uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'keys', jsonb_build_object('p256dh', p256dh, 'auth', auth)))
    from private.push_subscriptions where company_id = c.company_id and person_id = c.id), '[]'::jsonb);
end $$;

-- ---------- the evening job: which shops are due now (claims them so nothing goes twice) ----------
create function public.api_evening_due(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; out jsonb := '[]'::jsonb; v_local timestamp; v_day date;
begin
  for r in
    select co.id, co.timezone, s.evening_time, s.evening_days
      from public.companies co join public.company_settings s on s.company_id = co.id
     where co.active and s.evening_on
  loop
    v_local := p_now at time zone r.timezone;
    v_day := v_local::date;
    continue when v_local::time < r.evening_time or v_local::time > r.evening_time + interval '3 hours';
    continue when not (extract(isodow from v_day)::smallint = any (r.evening_days));
    insert into private.evening_log (company_id, day) values (r.id, v_day) on conflict do nothing;
    continue when not found;
    out := out || jsonb_build_object('company_id', r.id, 'day', v_day, 'recipients', coalesce((
      select jsonb_agg(jsonb_build_object('person_id', p.id, 'perms', p.perms, 'lang', p.preferred_lang,
          'subs', (select jsonb_agg(jsonb_build_object('endpoint', ps.endpoint, 'keys', jsonb_build_object('p256dh', ps.p256dh, 'auth', ps.auth)))
                     from private.push_subscriptions ps where ps.company_id = p.company_id and ps.person_id = p.id)))
        from public.people p
       where p.company_id = r.id and p.active and p.evening_summary and coalesce((p.perms ->> 'money')::boolean, false)
         and exists (select 1 from private.push_subscriptions ps where ps.company_id = p.company_id and ps.person_id = p.id)), '[]'::jsonb));
  end loop;
  return out;
end $$;

create function public.api_push_result(p_endpoint text, p_ok boolean, p_gone boolean) returns void
language sql security definer set search_path = '' as $$
  delete from private.push_subscriptions where endpoint = p_endpoint and p_gone;
  update private.push_subscriptions set last_ok_at = case when p_ok then now() else last_ok_at end,
         fails = case when p_ok then 0 else fails + 1 end
   where endpoint = p_endpoint;
$$;

create function public.api_evening_sent(p_company uuid, p_day date, p_sent integer) returns void
language sql security definer set search_path = '' as $$
  update private.evening_log set sent = p_sent where company_id = p_company and day = p_day;
$$;

revoke all on function public.api_day_data(uuid, date), public.api_evening_get(uuid), public.api_evening_set(uuid, uuid, text, jsonb),
  public.api_save_push(uuid, uuid, text, jsonb, boolean), public.api_my_push(uuid), public.api_evening_due(timestamptz),
  public.api_push_result(text, boolean, boolean), public.api_evening_sent(uuid, date, integer) from public, anon, authenticated;
grant execute on function public.api_day_data(uuid, date), public.api_evening_get(uuid), public.api_evening_set(uuid, uuid, text, jsonb),
  public.api_save_push(uuid, uuid, text, jsonb, boolean), public.api_my_push(uuid), public.api_evening_due(timestamptz),
  public.api_push_result(text, boolean, boolean), public.api_evening_sent(uuid, date, integer) to service_role;

-- ---------- every 10 minutes: ask the api function to send what is due ----------
-- The address and the shared secret are read from Vault (scripts/evening-setup.mjs puts them there);
-- without them the call simply does nothing.
create extension if not exists pg_net;
create extension if not exists pg_cron;
select cron.schedule('evening-summary', '*/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'evening_url'),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'evening_cron_secret')),
    body := '{"job":"evening"}'::jsonb)
  where exists (select 1 from vault.decrypted_secrets where name = 'evening_url')
$job$);
