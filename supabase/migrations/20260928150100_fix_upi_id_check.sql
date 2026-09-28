-- 12b. The UPI ID check used a repeat count Postgres doesn't allow ({2,256}); real UPI IDs are short.
alter table public.company_settings drop constraint company_settings_upi_id_check;
alter table public.company_settings
  add constraint company_settings_upi_id_check check (upi_id is null or upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,63}$');
