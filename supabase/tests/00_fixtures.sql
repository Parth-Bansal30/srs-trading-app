-- Shared test data, loaded at the start of test files that need it (everything is rolled back).
-- Two companies: A (like SRS) and B (another steel shop). Fixed ids keep tests readable.
--   A: owner (all), weigher (no money), sales_nokacha (no kacha), accounts
--   B: owner
-- Plus a signed-in user with no staff record, and a deactivated person.
insert into auth.users (id, email, aud, role) values
  ('a0000000-0000-0000-0000-00000000000a', 'owner.a@test.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000b', 'weigher.a@test.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000c', 'sales.a@test.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000d', 'accounts.a@test.local', 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-00000000000e', 'former.a@test.local', 'authenticated', 'authenticated'),
  ('b0000000-0000-0000-0000-00000000000a', 'owner.b@test.local', 'authenticated', 'authenticated'),
  ('c0000000-0000-0000-0000-000000000000', 'stranger@test.local', 'authenticated', 'authenticated');

insert into public.companies (id, name, gstin) values
  ('11111111-1111-1111-1111-111111111111', 'Test Company A', '07AAAAA1111A1Z1'),
  ('22222222-2222-2222-2222-222222222222', 'Test Company B', null);
insert into public.company_settings (company_id) values
  ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');

insert into public.people (id, company_id, auth_user_id, display_name, role, perms, active) values
  ('aaaaaaa1-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-00000000000a', 'Owner A', 'owner',
     '{"new":true,"orders":true,"weigh":true,"khata":true,"today":true,"rates":true,"people":true,"settings":true,"money":true,"kacha":true}', true),
  ('aaaaaaa2-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-00000000000b', 'Weigher A', 'weigher',
     '{"weigh":true,"orders":true}', true),
  ('aaaaaaa3-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-00000000000c', 'Sales A (no kacha)', 'custom',
     '{"new":true,"orders":true,"money":true}', true),
  ('aaaaaaa4-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-00000000000d', 'Accounts A', 'accounts',
     '{"orders":true,"khata":true,"today":true,"money":true}', true),
  ('aaaaaaa5-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'a0000000-0000-0000-0000-00000000000e', 'Former A', 'sales',
     '{"new":true,"orders":true,"money":true,"kacha":true}', false),
  ('bbbbbbb1-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'b0000000-0000-0000-0000-00000000000a', 'Owner B', 'owner',
     '{"new":true,"orders":true,"weigh":true,"khata":true,"today":true,"rates":true,"people":true,"settings":true,"money":true,"kacha":true}', true);
