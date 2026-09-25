-- Automatic safety net for the future: these checks look at the WHOLE database, so if a
-- later migration adds a table and forgets any of these rules, this test fails.
do $$
declare bad text;
begin
  -- 1. Every table has Row Level Security switched on.
  select string_agg(format('%I.%I', n.nspname, c.relname), ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p') and n.nspname in ('public','private') and not c.relrowsecurity;
  if bad is not null then raise exception 'Tables without Row Level Security: %', bad; end if;

  -- 2. Every company-owned table has a company_id (only "companies" itself doesn't).
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public','private') and c.relname <> 'companies'
    and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'company_id' and not a.attisdropped and a.attnotnull);
  if bad is not null then raise exception 'Tables without a required company_id: %', bad; end if;

  -- 3. A link from one company-owned table to another must include company_id,
  --    so a row can never point at another company's data.
  select string_agg(format('%s → %s (%s)', src.relname, dst.relname, con.conname), ', ') into bad
  from pg_constraint con
  join pg_class src on src.oid = con.conrelid join pg_namespace sn on sn.oid = src.relnamespace
  join pg_class dst on dst.oid = con.confrelid join pg_namespace dn on dn.oid = dst.relnamespace
  where con.contype = 'f' and sn.nspname in ('public','private') and dn.nspname in ('public','private')
    and dst.relname <> 'companies'
    and exists (select 1 from pg_attribute a where a.attrelid = dst.oid and a.attname = 'company_id')
    and not exists (select 1 from unnest(con.conkey) k join pg_attribute a on a.attrelid = src.oid and a.attnum = k where a.attname = 'company_id');
  if bad is not null then raise exception 'Links that could cross companies: %', bad; end if;

  -- 4. Not-signed-in visitors have no access to anything.
  select string_agg(format('%s on %s', privilege_type, table_name), ', ') into bad
  from information_schema.role_table_grants where grantee = 'anon' and table_schema in ('public','private');
  if bad is not null then raise exception 'Anonymous access found: %', bad; end if;

  -- 5. Signed-in users can only READ; every change goes through the backend.
  select string_agg(format('%s on %s', privilege_type, table_name), ', ') into bad
  from information_schema.role_table_grants
  where grantee = 'authenticated' and table_schema in ('public','private') and privilege_type <> 'SELECT';
  if bad is not null then raise exception 'Direct write access for signed-in users: %', bad; end if;

  -- 6. Internal tables are never readable by app users.
  select string_agg(table_name, ', ') into bad
  from information_schema.role_table_grants where grantee in ('authenticated','anon','PUBLIC') and table_schema = 'private';
  if bad is not null then raise exception 'Internal tables readable by users: %', bad; end if;

  -- 7. Every company-owned table can find its rows by company quickly (an index starting with company_id).
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname in ('public','private') and c.relname <> 'companies'
    and not exists (
      select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = c.oid and a.attname = 'company_id');
  if bad is not null then raise exception 'Tables without an index starting with company_id: %', bad; end if;

  -- 8. Money and history tables are protected against edits and deletes.
  select string_agg(t, ', ') into bad
  from unnest(array['payments','cash_closes','material_rates','customer_rates','audit_log','weigh_batches']) t
  where not exists (
    select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_proc p on p.oid = tg.tgfoid
    where c.relname = t and p.proname = 'forbid_change' and not tg.tgisinternal);
  if bad is not null then raise exception 'Permanent tables missing edit/delete protection: %', bad; end if;

  -- 10. Staff-management functions can only be called by the backend, never by the app.
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'admin\_%'
    and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'));
  if bad is not null then raise exception 'Staff-management functions callable by app users: %', bad; end if;

  -- 11. Login functions are not callable without signing in.
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('login_status','set_pin','unlock','lock_session')
    and has_function_privilege('anon', p.oid, 'execute');
  if bad is not null then raise exception 'Login functions callable without signing in: %', bad; end if;

  -- 9. Security helper functions can't be tricked by a changed search path.
  select string_agg(p.proname, ', ') into bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('app','public') and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%');
  if bad is not null then raise exception 'Security-definer functions without a fixed search_path: %', bad; end if;
end $$;
