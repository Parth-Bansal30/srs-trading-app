-- 9 Nov 2026 (Parth, after trying the bank statement): add a new supplier right where it is needed — from a bank
-- statement line ("Paid supplier" → a name the app does not know yet), and anywhere else a supplier is chosen.
-- Until now a supplier could only come in with a purchase bill. Same name (any capitals / spaces) or same GST number
-- as one already there = refused with the one that is there, so no supplier is made twice.

create function public.api_create_supplier(p_caller uuid, p_key uuid, p_hash text, p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.people := app.caller(p_caller); prev jsonb; v_name text; v_gstin text; v_phone text; v_city text; sid uuid; old public.suppliers;
begin
  -- who may: people who enter purchase bills, or who pay suppliers (expenses / the bank statement)
  if not (app.has(c, 'stock') or app.has(c, 'expenses')) then perform app.require(c, 'stock'); end if;
  prev := app.idem_start(c.company_id, p_key, 'createSupplier', p_hash);
  if prev is not null then return prev; end if;
  perform set_config('app.person_id', c.id::text, true);
  v_name := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g');
  if v_name = '' then raise exception 'Write the supplier''s name.' using errcode = '22023'; end if;
  if length(v_name) > 120 then raise exception 'The name is too long.' using errcode = '22023'; end if;
  v_gstin := nullif(upper(regexp_replace(coalesce(p ->> 'gstin', ''), '\s', '', 'g')), '');
  if v_gstin is not null and v_gstin !~ '^[0-9]{2}[0-9A-Z]{13}$' then raise exception 'That GST number has a mistake. Please check it.' using errcode = '22023'; end if;
  v_phone := nullif(btrim(coalesce(p ->> 'phone', '')), '');
  v_city := nullif(btrim(coalesce(p ->> 'city', '')), '');
  if v_phone is not null and length(v_phone) > 30 then raise exception 'Check the phone number.' using errcode = '22023'; end if;
  if v_city is not null and length(v_city) > 80 then raise exception 'The city is too long.' using errcode = '22023'; end if;
  -- already there? (same name, or same GST number)
  select * into old from public.suppliers s where s.company_id = c.company_id
    and (lower(btrim(s.name)) = lower(v_name) or (v_gstin is not null and s.gstin = v_gstin)) limit 1;
  if old.id is not null then
    raise exception '% is already in your suppliers.', old.name using errcode = '23505', detail = old.id::text;
  end if;
  insert into public.suppliers (id, company_id, name, gstin, phone, city)
    values (coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid()), c.company_id, v_name, v_gstin, v_phone, v_city)
    returning id into sid;
  return app.idem_done(c.company_id, p_key, jsonb_build_object('id', sid, 'name', v_name, 'gstin', v_gstin, 'phone', v_phone, 'city', v_city));
end $$;

revoke all on function public.api_create_supplier(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.api_create_supplier(uuid, uuid, text, jsonb) to service_role;
