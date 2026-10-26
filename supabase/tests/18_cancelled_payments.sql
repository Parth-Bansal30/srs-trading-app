-- @fixtures fixtures business
-- A cancelled payment in the khata (25 Oct 2026): the khata data says which payment a cancellation belongs to
-- ('reverses') and who cancelled it ('by'), so the screen can show the payment crossed out with the reason and name.
do $$
declare
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  cust uuid := 'a2000000-0000-0000-0000-000000000001';
  pid uuid; r jsonb; pays jsonb; x jsonb; nm text;
begin
  r := public.api_record_payment(owner, gen_random_uuid(), 'h', cust, 1500, 'Cash', 'pakka', 'paid at the counter');
  pid := (r ->> 'payment_id')::uuid;
  assert pid is not null, 'payment saved';
  perform public.api_reverse_payment(owner, gen_random_uuid(), 'h', pid, 'written twice');
  pays := public.api_khata_data(owner, cust) -> 'payments';
  select display_name into nm from public.people where id = owner;
  select e into x from jsonb_array_elements(pays) e where e ->> 'reverses' = pid::text;
  assert x is not null, 'the cancellation says which payment it cancels';
  assert x ->> 'note' = 'written twice', 'with the reason';
  assert x ->> 'by' = nm, 'and who cancelled it';
  assert x ->> 'kind' = 'khata', 'shown as the kind it cancels';
  assert (x ->> 'amount')::numeric = -1500, 'minus the same amount';
  select e into x from jsonb_array_elements(pays) e where e ->> 'id' = pid::text;
  assert x ->> 'reverses' is null and x ->> 'by' is null, 'the payment itself: no reverses, no name';
end $$;
