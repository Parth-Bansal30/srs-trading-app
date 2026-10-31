-- @fixtures fixtures business
-- Weigh again (26 Oct 2026): a weighed slip that is not finished can go back to "to weigh" — by the weigher or by
-- someone who takes money at pickup. Weights stay, the stock comes back and is taken again at the new weight.
-- The weigher's own list shows what was weighed today, with no money.
create function pg_temp.err(q text) returns text language plpgsql as $$
declare st text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics st = returned_sqlstate;
  return st;
end $$;
create function pg_temp.expect(q text, want text, why text) returns void language plpgsql as $$
declare got text := pg_temp.err(q);
begin
  if got <> want then raise exception 'TEST FAILED (%): expected %, got %', why, want, got; end if;
end $$;

do $$
declare
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  weigher uuid := 'aaaaaaa2-0000-0000-0000-000000000000';
  sales uuid := 'aaaaaaa3-0000-0000-0000-000000000000';
  o4 uuid := 'a3000000-0000-0000-0000-000000000004';
  it4 uuid := 'a4000000-0000-0000-0000-000000000004';
  si uuid; r jsonb; k uuid := gen_random_uuid(); onhand numeric;
begin
  -- a stock item for o4's item, so the stock moves can be checked
  insert into public.stock_items (company_id, material_id, shape, rate, cost) values
    ('11111111-1111-1111-1111-111111111111', 'a1000000-0000-0000-0000-000000000002', 'round', 90, 90) returning id into si;
  insert into public.stock_moves (company_id, stock_item_id, kind, qty_kg, note, created_by)
    values ('11111111-1111-1111-1111-111111111111', si, 'adjust', 1000, 'opening', owner);
  update public.order_items set stock_item_id = si where id = it4;

  -- the weigher types 1800 instead of 180 and finishes
  perform public.api_record_weights(weigher, gen_random_uuid(), 'h', o4, jsonb_build_array(jsonb_build_object('item_id', it4, 'weight', 1800)), '[]', true);
  assert (select status from public.orders where id = o4) = 'weighed', 'weighed';
  assert app.stock_on_hand(si) = -800, '1800 kg taken off the stock';

  -- the weigher sees it in his list of today's weighing — sizes and weights, no money
  r := public.api_weighed_list(weigher);
  assert exists (select 1 from jsonb_array_elements(r) e where e ->> 'id' = o4::text and (e ->> 'weight')::numeric = 1800), 'in the weighed list: ' || r::text;
  assert r::text !~ '(sell_rate|cut_rate|amount|paid|total_amount)', 'no money in the weighed list';
  perform pg_temp.expect(format($q$select public.api_weighed_list(%L)$q$, sales), '42501', 'sales opening the weigher''s list');

  -- someone without weigh or money can't send it back
  perform pg_temp.expect(format($q$select public.api_reopen_weighing('aaaaaaa5-0000-0000-0000-000000000000', gen_random_uuid(), 'h', %L)$q$, o4), '42501',
    'a deactivated person weighing again');

  -- the weigher sends it back: to weigh again, weights kept, stock back
  r := public.api_reopen_weighing(weigher, k, 'h', o4);
  assert r ->> 'status' = 'accepted', 'back to "to weigh": ' || r::text;
  assert (select status from public.orders where id = o4) = 'accepted' and (select weighed_at from public.orders where id = o4) is null, 'status and time reset';
  assert (select actual_weight from public.order_items where id = it4) = 1800, 'the typed weight stays to be corrected';
  assert app.stock_on_hand(si) = 1000, 'the stock came back';
  assert exists (select 1 from public.stock_moves where order_id = o4 and kind = 'sale_undo' and note = 'Weighed again'), 'stock move says why';
  r := public.api_reopen_weighing(weigher, k, 'h', o4);
  assert (r ->> 'replayed')::boolean, 'a retry returns the first answer';
  perform pg_temp.expect(format($q$select public.api_reopen_weighing(%L, gen_random_uuid(), 'h', %L)$q$, weigher, o4), '23001', 'weighing again a slip that is waiting already');
  assert exists (select 1 from jsonb_array_elements(public.api_weighing_list(weigher, null)) e where e ->> 'id' = o4::text), 'it is on the weighing list again';

  -- weighed again with the right weight: the stock is taken at the new weight
  perform public.api_record_weights(weigher, gen_random_uuid(), 'h', o4, jsonb_build_array(jsonb_build_object('item_id', it4, 'weight', 180)), '[]', true);
  assert app.stock_on_hand(si) = 820, 'stock taken at 180 kg';

  -- at pickup the owner can also send it back (he takes money); a finished slip can't
  r := public.api_reopen_weighing(owner, gen_random_uuid(), 'h', o4);
  assert r ->> 'status' = 'accepted', 'owner sent it back';
  perform pg_temp.expect(format($q$select public.api_reopen_weighing(%L, gen_random_uuid(), 'h', 'a3000000-0000-0000-0000-000000000001')$q$, owner), '23001',
    'weighing again a finished slip');
  perform pg_temp.expect(format($q$select public.api_reopen_weighing('bbbbbbb1-0000-0000-0000-000000000000', gen_random_uuid(), 'h', %L)$q$, o4), '22023',
    'another company''s slip');
end $$;
