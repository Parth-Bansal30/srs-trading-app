-- @fixtures fixtures business
-- Smart checks on purchase bills (8 Oct 2026): the bill screen gets recent rates per grade and recent bills.
do $$
declare
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  en24 uuid := 'a1000000-0000-0000-0000-000000000002';
  r jsonb; h jsonb;
begin
  update public.people set perms = perms || '{"stock":true}'::jsonb where id = owner;
  perform public.api_save_purchase(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'bill', 'bill_no', 'C-1', 'bill_date', current_date - 3, 'bill_type', 'pakka',
    'supplier', jsonb_build_object('name', 'Check Steels'), 'freight', 0, 'gst', 0, 'total', 15600,
    'lines', jsonb_build_array(jsonb_build_object('description', 'EN24 Round', 'hsn', '722830', 'qty_kg', 200, 'rate', 78, 'amount', 15600, 'material_id', en24, 'shape', 'round'))));
  perform public.api_save_purchase(owner, gen_random_uuid(), 'h', jsonb_build_object('kind', 'bill', 'bill_no', 'C-2', 'bill_date', current_date - 1, 'bill_type', 'pakka',
    'supplier', jsonb_build_object('name', 'Check Steels'), 'freight', 0, 'gst', 0, 'total', 7600,
    'lines', jsonb_build_array(jsonb_build_object('description', 'EN24 Round', 'hsn', '722830', 'qty_kg', 100, 'rate', 76, 'amount', 7600, 'material_id', en24, 'shape', 'round'))));
  r := public.api_purchase_context(owner);
  h := r -> 'history';
  assert jsonb_array_length(h -> 'rates') = 2, 'two EN24 rates';
  assert (h -> 'rates' -> 0 ->> 'material_id')::uuid = en24 and (h -> 'rates' -> 0 ->> 'supplier') = 'Check Steels', 'rate with grade and supplier';
  assert jsonb_array_length(h -> 'bills') = 2 and (h -> 'bills' -> 0 ->> 'bill_no') = 'C-2', 'recent bills, newest first';
  assert (h -> 'bills' -> 0 ->> 'kg')::numeric = 100 and (h -> 'bills' -> 0 ->> 'total')::numeric = 7600, 'weight and total for the typed-twice check';
end $$;
