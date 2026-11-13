-- @fixtures fixtures business
-- 13 Nov 2026: the slip data carries what each line's amount is worked out from (the server keeps rates off the customer's slip).
do $$
declare
  owner uuid := 'aaaaaaa1-0000-0000-0000-000000000000';
  o uuid; d jsonb; it jsonb;
begin
  select id into o from public.orders where company_id = '11111111-1111-1111-1111-111111111111' and status = 'done' order by done_at desc limit 1;
  if o is null then raise notice '34_slip_line_amounts: no finished slip in the fixtures — skipped'; return; end if;
  update public.people set perms = perms || '{"money":true,"kacha":true}' where id = owner;
  d := public.api_slip_data(owner, o);
  assert d -> 'order' ? 'min_inch', 'the shop''s smallest inch is there';
  it := d -> 'items' -> 0;
  assert it ? 'rate' and it ? 'cut_rate' and it ? 'density' and it ? 'batch', 'each line carries its rate, cutting rate, density';
  assert (it -> 'lengths' -> 0) ? 'cuts', 'and its cuts';
  assert (it ->> 'rate')::numeric >= 0 and (it ->> 'density')::numeric > 0, 'real numbers';
  raise notice '34_slip_line_amounts: all checks passed';
end $$;
