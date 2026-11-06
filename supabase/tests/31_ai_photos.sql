-- @fixtures fixtures business
-- 7 Nov 2026 (plan v2, F11): photos go to Claude only with the owner's permission — off by default, who and when kept,
-- the daily limit still applies.
create function pg_temp.err(q text) returns text language plpgsql as $$
declare st text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics st = returned_sqlstate;
  return st;
end $$;

do $$
declare
  co uuid := '11111111-1111-1111-1111-111111111111';
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  acct uuid := 'aaaaaaa4-0000-0000-0000-000000000000';
  r jsonb;
begin
  assert not (select ai_photos from public.company_settings where company_id = co), 'off by default';
  assert public.api_ai_photo_take(owner) = 'off', 'off: nothing is sent';
  assert pg_temp.err(format($q$select public.api_ai_photos(%L, gen_random_uuid(), 'h', true)$q$, acct)) = '42501', 'owner only';
  r := public.api_ai_photos(owner, gen_random_uuid(), 'h', true);
  assert (r ->> 'on')::boolean and (select ai_photos_by = owner and ai_photos_at is not null from public.company_settings where company_id = co), 'on, with who and when';
  assert exists (select 1 from public.audit_log where entity_type = 'company_settings' and (after ->> 'ai_photos')::boolean and after ->> 'ai_photos_by' = owner::text), 'audited';
  update public.company_settings set ai_daily_limit = 1 where company_id = co;
  delete from private.ai_usage where company_id = co;
  assert public.api_ai_photo_take(owner) = 'ok', 'allowed and counted';
  assert public.api_ai_photo_take(owner) = 'limit', 'the daily limit applies';
  r := public.api_ai_photos(owner, gen_random_uuid(), 'h', false);
  assert public.api_ai_photo_take(owner) = 'off', 'switched off again';
  raise notice '31_ai_photos: all checks passed';
end $$;
