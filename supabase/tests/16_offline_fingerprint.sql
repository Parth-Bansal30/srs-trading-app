-- @fixtures fixtures business
-- Offline entries keep the time they really happened and the ids the phone chose (23 Oct 2026);
-- fingerprint unlock: switching on needs a fresh PIN, a challenge is used once on its own session,
-- a copied key is caught, a blocked PIN still needs an SMS code, removing / signing out everywhere.
create function pg_temp.err(q text) returns text language plpgsql as $$
declare st text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics st = returned_sqlstate;
  return st;
end $$;
create function pg_temp.expect(q text, want text, why text) returns void language plpgsql as $$
declare got text := pg_temp.err(q);
begin
  if got <> want then raise exception 'TEST FAILED (%): expected %, got %', why, want, got; end if;
end $$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  weigher uuid := 'aaaaaaa2-0000-0000-0000-000000000000';
  ownerb uuid := 'bbbbbbb1-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  en8 uuid := 'a1000000-0000-0000-0000-000000000001';
  oid uuid := gen_random_uuid(); iid uuid := gen_random_uuid(); cid uuid := gen_random_uuid(); oid2 uuid := gen_random_uuid();
  drawer uuid; r jsonb; o public.orders; pid uuid; args jsonb; items jsonb; t2 timestamptz := now() - interval '2 hours';
begin
  select id into drawer from public.money_accounts where company_id = co and is_drawer;
  items := jsonb_build_array(jsonb_build_object('id', iid, 'material_id', en8, 'grade_code', 'EN8', 'shape', 'round', 'unit', 'mm', 'dims', jsonb_build_array('32'),
    'sell_rate', 75, 'cut_rate', 3, 'density', 7850, 'lengths', jsonb_build_array(jsonb_build_object('len', '300', 'pcs', 2))));

  -- ---------- 1. a slip made offline two hours ago ----------
  args := jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust, 'p_rules', '{}'::jsonb,
    'p_items', items, 'p_accept', true, 'p_advance', null, 'p_order_id', oid);
  r := public.api_run(owner, 'api_create_order', args, null, null, t2);
  select * into o from public.orders where id = oid;
  assert o.id = oid and (r ->> 'order_id')::uuid = oid, 'the phone''s id is kept';
  assert o.created_at = t2 and o.accepted_at = t2 and o.entered_offline, format('made and accepted at the real time (%s / %s)', o.created_at, o.accepted_at);
  assert (select id from public.order_items where order_id = oid) = iid, 'the item keeps the phone''s id too';
  assert (r -> 'items' ->> 0)::uuid = iid, 'the answer lists the item ids';
  assert nullif(current_setting('app.at', true), '') is null, 'the time is cleared after the operation';
  -- the same id again (another request) is refused; the same request again gives the first answer
  perform pg_temp.expect(format($q$select public.api_run(%L, 'api_create_order', %L, null, null, now())$q$, owner,
    jsonb_set(args, '{p_key}', to_jsonb(gen_random_uuid()))), '23505', 'one slip per phone id');
  assert (public.api_run(owner, 'api_create_order', args, null, null, t2) ->> 'order_id')::uuid = oid, 'a retry = the first answer';
  -- weighed an hour ago
  r := public.api_run(owner, 'api_record_weights', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_order', oid,
    'p_weights', jsonb_build_array(jsonb_build_object('item_id', iid, 'weight', 3.8)), 'p_batches', '[]'::jsonb, 'p_submit', true), null, null, now() - interval '1 hour');
  assert (select status = 'weighed' and weighed_at = now() - interval '1 hour' from public.orders where id = oid), 'weighed at the real time';
  -- money taken offline, into the drawer
  r := public.api_run(owner, 'api_record_payment', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
    'p_amount', 500, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', null), jsonb_build_array(jsonb_build_object('account_id', drawer, 'amount', 500)), null, now() - interval '30 minutes');
  pid := (r ->> 'payment_id')::uuid;
  assert (select received_at = now() - interval '30 minutes' and entered_offline from public.payments where id = pid), 'paid at the real time, marked offline';
  assert (select account_id = drawer and amount = 500 from public.payment_parts where payment_id = pid), 'and placed in the drawer';
  assert nullif(current_setting('app.at', true), '') is null, 'cleared after a payment too';
  r := public.api_record_payment(owner, gen_random_uuid(), 'h', cust, 200, 'Cash', 'pakka', null);
  assert (select received_at = now() and not entered_offline from public.payments where id = (r ->> 'payment_id')::uuid), 'a normal payment is now';
  -- a customer made offline
  r := public.api_run(owner, 'api_create_customer', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h',
    'p_name', 'Walk-in Ram', 'p_phone', null, 'p_notes', null, 'p_id', cid), null, null, now() - interval '10 minutes');
  assert (r ->> 'id')::uuid = cid and exists (select 1 from public.customers where id = cid and company_id = co), 'customer with the phone''s id';
  -- limits
  perform pg_temp.expect(format($q$select public.api_run(%L, 'api_record_payment', %L, null, null, now() + interval '1 hour')$q$, owner,
    jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust, 'p_amount', 1, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', null)), '22023', 'not in the future');
  perform pg_temp.expect(format($q$select public.api_run(%L, 'api_record_payment', %L, null, null, now() - interval '5 days')$q$, owner,
    jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust, 'p_amount', 1, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', null)), '22023', 'at most 3 days back');
  perform pg_temp.expect(format($q$select public.api_run(%L, 'api_cancel_order', %L, null, null, now())$q$, owner, jsonb_build_object('p_caller', owner)), '22023', 'only the offline operations');
  perform pg_temp.expect(format($q$select public.api_run(%L, 'api_record_weights', %L, '[]'::jsonb, null, now())$q$, owner, jsonb_build_object('p_caller', owner)), '22023', 'no accounts for weighing');
  perform pg_temp.expect(format($q$select public.api_run(%L, 'api_record_payment', %L, null, null, null)$q$, weigher, jsonb_build_object('p_caller', owner)), '22023', 'someone else''s request');
  -- a slip made offline yesterday is numbered for yesterday (when numbers restart daily)
  update public.company_settings set slip_numbering = 'daily' where company_id = co;
  r := public.api_run(owner, 'api_create_order', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
    'p_rules', '{}'::jsonb, 'p_items', jsonb_set(items, '{0,id}', to_jsonb(gen_random_uuid())), 'p_accept', false, 'p_advance', null, 'p_order_id', oid2), null, null, now() - interval '1 day');
  assert (select slip_period = app.slip_counter_key('daily', now() - interval '1 day', 'Asia/Kolkata') from public.orders where id = oid2), 'yesterday''s numbering';
  -- the old door: api_pay still works and clears the time
  r := public.api_pay(owner, 'api_record_payment', jsonb_build_object('p_caller', owner, 'p_key', gen_random_uuid(), 'p_hash', 'h', 'p_customer', cust,
    'p_amount', 50, 'p_mode', 'Cash', 'p_side', 'pakka', 'p_note', null), null, jsonb_build_object('account_id', drawer));
  assert (select received_at = now() from public.payments where id = (r ->> 'payment_id')::uuid), 'api_pay as before';
end $$;

-- ---------- 2. fingerprint ----------
insert into auth.sessions (id, user_id) values
  ('e0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000a'),   -- owner A on a phone not unlocked yet
  ('e0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a');
insert into private.auth_credentials (company_id, person_id, kind, secret_hash) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaa1-0000-0000-0000-000000000000', 'pin', extensions.crypt('385917', extensions.gen_salt('bf', 4))),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaa2-0000-0000-0000-000000000000', 'pin', extensions.crypt('4826', extensions.gen_salt('bf', 4)));
do $$
declare
  ua uuid := 'a0000000-0000-0000-0000-00000000000a'; sa uuid := 'a0000000-0000-0000-0000-00000000000a';   -- owner A's unlocked phone (fixture)
  uw uuid := 'a0000000-0000-0000-0000-00000000000b'; sw uuid := 'a0000000-0000-0000-0000-00000000000b';   -- weigher A's unlocked phone
  ub uuid := 'b0000000-0000-0000-0000-00000000000a';
  snew uuid := 'e0000000-0000-0000-0000-00000000000a'; snew2 uuid := 'e0000000-0000-0000-0000-00000000000b';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000'; weigher uuid := 'aaaaaaa2-0000-0000-0000-000000000000';
  cred text := 'credOwnerA_phone_1234567890'; cred0 text := 'credOwnerA_nocounter_000000'; r jsonb; ch text; k uuid;
begin
  -- switching on: needs a PIN unlock in the last 10 minutes on this very session
  r := public.api_passkey_begin(ua, sa, 'register');
  ch := r ->> 'challenge';
  assert length(ch) >= 40 and jsonb_array_length(r -> 'credentials') = 0, 'a fresh challenge, no keys yet';
  r := public.api_passkey_save(ua, sa, ch, cred, '{"kty":"EC","crv":"P-256","x":"x","y":"y"}', -7, 0, 'Papa''s phone');
  perform pg_temp.expect(format($q$select public.api_passkey_save(%L, %L, %L, 'another_credential_id_xx', '{}', -7, 0, null)$q$, ua, sa, ch), '42501', 'a challenge works once');
  perform pg_temp.expect(format($q$select public.api_passkey_begin(%L, %L, 'register')$q$, ua, snew), '42501', 'not unlocked: no switching on');
  update private.session_unlocks set unlocked_at = now() - interval '20 minutes' where session_id = sw;
  perform pg_temp.expect(format($q$select public.api_passkey_begin(%L, %L, 'register')$q$, uw, sw), '42501', 'PIN too long ago');
  perform pg_temp.expect(format($q$select public.api_passkey_begin(%L, %L, 'register')$q$, ua, '00000000-0000-4000-8000-000000000000'), '42501', 'not a real session');
  perform pg_temp.expect(format($q$select public.api_passkey_begin(%L, %L, 'register')$q$, 'c0000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000000'), '42501', 'a stranger');
  assert (select public_key ->> 'crv' = 'P-256' and alg = -7 and device_label = 'Papa''s phone' from private.passkeys where credential_id = cred), 'key saved';

  -- unlocking a new phone with the finger
  r := public.api_passkey_begin(ua, snew, 'unlock');
  ch := r ->> 'challenge';
  assert (r -> 'credentials' -> 0 ->> 'id') = cred, 'the phone gets its key ids';
  assert (public.api_passkey_key(ua, cred) ->> 'alg')::int = -7 and public.api_passkey_key(uw, cred) is null, 'only its owner''s key';
  perform pg_temp.expect(format($q$select public.api_passkey_unlock(%L, %L, %L, %L, 1)$q$, ua, snew2, ch, cred), '42501', 'a challenge belongs to its session');
  r := public.api_passkey_unlock(ua, snew, ch, cred, 3);
  assert (r ->> 'ok')::boolean, format('unlocked: %s', r);
  assert (select person_id = owner and method = 'passkey' and expires_at > now() + interval '11 hours' from private.session_unlocks where session_id = snew), 'the same unlock as the PIN';
  perform pg_temp.expect(format($q$select public.api_passkey_unlock(%L, %L, %L, %L, 4)$q$, ua, snew, ch, cred), '42501', 'used once');
  -- the counter must go up: an older count = a copied key, switched off
  ch := public.api_passkey_begin(ua, snew, 'unlock') ->> 'challenge';
  r := public.api_passkey_unlock(ua, snew, ch, cred, 3);
  assert not (r ->> 'ok')::boolean and r ->> 'reason' = 'copied_key', 'copied key caught';
  assert (select revoked_at is not null from private.passkeys where credential_id = cred), 'and switched off';
  -- a phone that doesn't count (always 0) is fine
  ch := public.api_passkey_begin(ua, sa, 'register') ->> 'challenge';
  perform public.api_passkey_save(ua, sa, ch, cred0, '{"kty":"EC"}', -7, 0, null);
  ch := public.api_passkey_begin(ua, snew2, 'unlock') ->> 'challenge';
  assert (public.api_passkey_unlock(ua, snew2, ch, cred0, 0) ->> 'ok')::boolean, 'first time 0';
  ch := public.api_passkey_begin(ua, snew2, 'unlock') ->> 'challenge';
  assert (public.api_passkey_unlock(ua, snew2, ch, cred0, 0) ->> 'ok')::boolean, 'again 0';
  -- an old challenge
  ch := public.api_passkey_begin(ua, snew2, 'unlock') ->> 'challenge';
  update private.passkey_challenges set expires_at = now() - interval '1 second' where challenge = ch;
  perform pg_temp.expect(format($q$select public.api_passkey_unlock(%L, %L, %L, %L, 0)$q$, ua, snew2, ch, cred0), '42501', 'too late');
  -- another person can't use it
  ch := public.api_passkey_begin(uw, sw, 'unlock') ->> 'challenge';
  assert (public.api_passkey_unlock(uw, sw, ch, cred0, 0) ->> 'reason') = 'unknown_key', 'the weigher can''t use Papa''s key';
  -- a blocked PIN (10 wrong) still needs a new SMS code
  update private.auth_credentials set failed_attempts = 10 where person_id = owner and kind = 'pin';
  ch := public.api_passkey_begin(ua, snew2, 'unlock') ->> 'challenge';
  assert (public.api_passkey_unlock(ua, snew2, ch, cred0, 0) ->> 'reason') = 'blocked', 'blocked stays blocked';
  update private.auth_credentials set failed_attempts = 0 where person_id = owner and kind = 'pin';
  -- a PIN unlock afterwards is a PIN unlock again
  insert into private.session_unlocks (session_id, company_id, person_id, expires_at) values (snew2, '11111111-1111-1111-1111-111111111111', owner, now() + interval '1 hour')
    on conflict (session_id) do update set unlocked_at = now();
  assert (select method from private.session_unlocks where session_id = snew2) = 'pin', 'method follows the last unlock';

  -- lists and removing
  r := public.api_passkeys(owner, null);
  assert jsonb_array_length(r) = 1 and (r -> 0 ->> 'credential_id') = cred0, 'my phones (the switched-off one is gone)';
  perform pg_temp.expect(format($q$select public.api_passkeys(%L, %L)$q$, weigher, owner), '42501', 'only managers see others''');
  assert jsonb_array_length(public.api_passkeys(owner, weigher)) = 0, 'the owner sees the weigher''s (none)';
  k := (r -> 0 ->> 'id')::uuid;
  perform pg_temp.expect(format($q$select public.api_passkey_remove(%L, gen_random_uuid(), 'h', %L)$q$, weigher, k), '42501', 'the weigher can''t remove Papa''s');
  perform pg_temp.expect(format($q$select public.api_passkey_remove(%L, gen_random_uuid(), 'h', %L)$q$, 'bbbbbbb1-0000-0000-0000-000000000000', k), '22023', 'another shop can''t');
  perform public.api_passkey_remove(owner, gen_random_uuid(), 'h', k);
  assert jsonb_array_length(public.api_passkeys(owner, null)) = 0, 'removed';
  -- signing a person out everywhere switches their fingerprint off
  update private.session_unlocks set unlocked_at = now() where session_id = sw;
  ch := public.api_passkey_begin(uw, sw, 'register') ->> 'challenge';
  perform public.api_passkey_save(uw, sw, ch, 'credWeigher_phone_000000001', '{"kty":"EC"}', -7, 0, null);
  perform public.admin_sign_out_everywhere(owner, weigher);
  assert not exists (select 1 from private.passkeys where person_id = weigher and revoked_at is null), 'signed out = fingerprint off';
  assert not has_table_privilege('authenticated', 'private.passkeys', 'select'), 'keys are backend only';
end $$;
