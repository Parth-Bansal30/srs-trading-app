-- @fixtures fixtures business
-- 9 Nov 2026: add a new supplier where it is needed (a bank statement line, an expense) — never twice.
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
  weigher uuid := 'aaaaaaa2-0000-0000-0000-000000000000';
  k uuid := gen_random_uuid();
  r jsonb; r2 jsonb; n int;
begin
  update public.people set perms = perms || '{"stock":true,"expenses":true}' where id = owner;
  r := public.api_create_supplier(owner, k, 'h', '{"name":"  Ridhi   Sidhi Enterprises ","gstin":"07aabcr1234q1z5","city":"Delhi"}');
  assert r ->> 'name' = 'Ridhi Sidhi Enterprises' and r ->> 'gstin' = '07AABCR1234Q1Z5', 'tidy name and GST number';
  assert exists (select 1 from public.suppliers where company_id = co and id = (r ->> 'id')::uuid and city = 'Delhi'), 'saved in this company';
  r2 := public.api_create_supplier(owner, k, 'h', '{"name":"Ridhi Sidhi Enterprises"}');
  assert r2 ->> 'id' = r ->> 'id', 'the same request twice = one supplier';
  assert pg_temp.err(format($q$select public.api_create_supplier(%L, gen_random_uuid(), 'h', '{"name":"RIDHI SIDHI ENTERPRISES"}')$q$, owner)) = '23505', 'same name: refused';
  assert pg_temp.err(format($q$select public.api_create_supplier(%L, gen_random_uuid(), 'h', '{"name":"R S Ent","gstin":"07AABCR1234Q1Z5"}')$q$, owner)) = '23505', 'same GST number: refused';
  assert pg_temp.err(format($q$select public.api_create_supplier(%L, gen_random_uuid(), 'h', '{"name":"  "}')$q$, owner)) = '22023', 'a name is needed';
  assert pg_temp.err(format($q$select public.api_create_supplier(%L, gen_random_uuid(), 'h', '{"name":"X","gstin":"12345"}')$q$, owner)) = '22023', 'a wrong GST number is refused';
  assert pg_temp.err(format($q$select public.api_create_supplier(%L, gen_random_uuid(), 'h', '{"name":"Weigher Steel"}')$q$, weigher)) = '42501', 'not for people who do not buy or pay';
  select count(*) into n from public.suppliers where company_id = co and lower(name) like 'ridhi%';
  assert n = 1, 'exactly one';
  assert exists (select 1 from public.audit_log where entity_type = 'suppliers' and entity_id = r ->> 'id'), 'audited';
  raise notice '33_add_supplier: all checks passed';
end $$;
