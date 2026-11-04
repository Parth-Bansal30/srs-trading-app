-- @fixtures fixtures business
-- 4 Nov 2026 (plan v2, F4): a statement's lines keep what the reader could not prove (only the known kinds), and each
-- upload keeps the file's own fingerprint.
do $$
declare
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  bank uuid; r jsonb; d jsonb; h text := repeat('ab', 32);
begin
  update public.companies set created_at = now() - interval '30 days' where id = '11111111-1111-1111-1111-111111111111';
  bank := (public.api_save_account(owner, gen_random_uuid(), 'h', '{"name":"PNB current","kind":"bank"}') ->> 'id')::uuid;
  r := public.api_bank_save(owner, gen_random_uuid(), 'h', jsonb_build_object('account_id', bank, 'file_name', 'pnb.xls', 'file_hash', h, 'lines', jsonb_build_array(
    jsonb_build_object('day', (now() at time zone 'Asia/Kolkata')::date - 2, 'amount', 1200, 'narration', 'A', 'fingerprint', 'doubt-test-line-1', 'doubts', jsonb_build_array('direction', 'nonsense')),
    jsonb_build_object('day', (now() at time zone 'Asia/Kolkata')::date - 1, 'amount', -300, 'narration', 'B', 'balance', 900, 'fingerprint', 'doubt-test-line-2'))));
  assert (select doubts = '{direction}' from public.bank_lines where fingerprint = 'doubt-test-line-1'), 'only known doubts are kept';
  assert (select doubts = '{}' from public.bank_lines where fingerprint = 'doubt-test-line-2'), 'no doubts: empty';
  assert (select file_hash = h from public.bank_imports where id = (r ->> 'import_id')::uuid), 'the file fingerprint is kept';
  d := public.api_bank_data(owner, bank, (r ->> 'import_id')::uuid);
  assert (select x -> 'doubts' = '["direction"]'::jsonb from jsonb_array_elements(d -> 'lines') x where x ->> 'narration' = 'A'), 'the review gets the doubts';
  assert (select x ->> 'file_hash' = h from jsonb_array_elements(d -> 'imports') x limit 1), 'and the file fingerprint of each upload';
  -- the owner says it was money out: the sign changes, the doubt goes, who said it is noted; only for that doubt
  r := public.api_bank_direction(owner, gen_random_uuid(), 'h', (select id from public.bank_lines where fingerprint = 'doubt-test-line-1'), false);
  assert (select amount = -1200 and doubts = '{}' and note like 'Money out — said %' from public.bank_lines where fingerprint = 'doubt-test-line-1'), 'direction settled';
  begin
    r := public.api_bank_direction(owner, gen_random_uuid(), 'h', (select id from public.bank_lines where fingerprint = 'doubt-test-line-2'), true);
    raise exception 'TEST FAILED: a line with a known direction was flipped';
  exception when sqlstate '22023' then null;
  end;
  raise notice '24_bank_doubts: all checks passed';
end $$;
