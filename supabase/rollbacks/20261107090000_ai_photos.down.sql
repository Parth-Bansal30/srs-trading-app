-- Undo 20261107090000_ai_photos.sql (the switch goes back to "not set": photos are not read).
drop function public.api_ai_photo_take(uuid);
drop function public.api_ai_photos(uuid, uuid, text, boolean);
alter table public.company_settings drop constraint company_settings_ai_photos_by_fk, drop column ai_photos_at, drop column ai_photos_by, drop column ai_photos;
