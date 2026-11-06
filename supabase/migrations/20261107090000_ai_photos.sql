-- 7 Nov 2026 (plan v2, F11): photos and scanned statements / bills are read by Claude (Anthropic, outside this app) only
-- with the owner's permission. Off by default; the owner switches it on after a plain explanation (who and when is kept),
-- and every upload asks again on the phone. Text PDFs and Excel files are read on the phone and never leave it.
alter table public.company_settings
  add column ai_photos    boolean not null default false,
  add column ai_photos_by uuid,
  add column ai_photos_at timestamptz,
  add constraint company_settings_ai_photos_by_fk foreign key (company_id, ai_photos_by) references public.people(company_id, id);

/** The owner switches photo reading on / off (kept with who and when; audited). */
create function public.api_ai_photos(p_caller uuid, p_key uuid, p_hash text, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; s public.company_settings;
begin
  perform app.require(c, 'settings');
  prev := app.idem_start(c.company_id, p_key, 'aiPhotos', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  update public.company_settings set ai_photos = coalesce(p_on, false), ai_photos_by = c.id, ai_photos_at = now()
    where company_id = c.company_id returning * into s;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('on', s.ai_photos, 'by', c.display_name, 'at', s.ai_photos_at));
end $$;

/** May this file go to Claude now? 'off' (not allowed by the owner) · 'limit' (today's limit reached) · 'ok' (counted). */
create function public.api_ai_photo_take(p_caller uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller);
begin
  if not coalesce((select ai_photos from public.company_settings where company_id = c.company_id), false) then return 'off'; end if;
  return case when public.api_ai_take(p_caller) then 'ok' else 'limit' end;
end $$;

revoke all on function public.api_ai_photos(uuid, uuid, text, boolean), public.api_ai_photo_take(uuid) from public, anon, authenticated;
grant execute on function public.api_ai_photos(uuid, uuid, text, boolean), public.api_ai_photo_take(uuid) to service_role;
