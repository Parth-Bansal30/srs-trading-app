-- Undo 20261104120000_cheques: the cheque register is lost (no khata entry is touched: payments made when a cheque
-- cleared and their cancels stay, as do the bank lines they ticked).
drop trigger if exists cheque_follow on public.bank_lines;
drop trigger if exists cheque_follow on public.payments;
drop trigger if exists cheque_follow on public.expenses;
drop trigger if exists cheque_follow_changed on public.expenses;
drop function if exists app.cheque_line_follow();
drop function if exists app.cheque_payment_cancelled();
drop function if exists app.cheque_expense_follow();
drop function if exists public.api_cheque_add(uuid, uuid, text, jsonb);
drop function if exists public.api_cheque_mark(uuid, uuid, text, uuid, text, uuid, text);
drop function if exists public.api_cheque_clear(uuid, uuid, text, uuid, uuid, text, jsonb);
drop function if exists public.api_cheque_return(uuid, uuid, text, uuid, uuid, uuid, numeric, text);
drop function if exists public.api_cheques(uuid, int, uuid);
drop function if exists app.cheque_may(public.people, text, text);
drop table if exists public.cheques;
-- the "same payment twice?" check as it was (without the cheque exception)
create or replace function app.payment_twin_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare t record; tz text; fact jsonb;
begin
  select timezone into tz from public.companies where id = new.company_id;
  for t in select p.*, pe.display_name as by_name from public.payments p left join public.people pe on pe.company_id = p.company_id and pe.id = p.created_by
            where p.company_id = new.company_id and p.customer_id = new.customer_id and p.id <> new.id and p.kind <> 'reversal'
              and abs(p.amount - new.amount) < 0.005 and abs(extract(epoch from (p.received_at - new.received_at))) <= 3 * 86400
              and not exists (select 1 from public.payments r where r.company_id = p.company_id and r.reverses_payment_id = p.id)
            order by abs(extract(epoch from (p.received_at - new.received_at))) limit 3 loop
    fact := jsonb_build_object('amount', new.amount,
      'new', jsonb_build_object('id', new.id, 'at', new.received_at, 'kind', new.kind, 'mode', new.mode, 'note', new.note, 'offline', new.entered_offline,
              'by', (select display_name from public.people where company_id = new.company_id and id = new.created_by),
              'bank', exists (select 1 from public.bank_lines b where b.company_id = new.company_id and b.payment_id = new.id)),
      'twin', jsonb_build_object('id', t.id, 'at', t.received_at, 'kind', t.kind, 'mode', t.mode, 'note', t.note, 'offline', t.entered_offline, 'by', t.by_name,
              'bank', exists (select 1 from public.bank_lines b where b.company_id = new.company_id and b.payment_id = t.id)));
    perform app.review_add(new.company_id, 'twin_payment', new.id, t.id, fact, new.customer_id, null,
      coalesce(new.side, (select o.bill_type from public.orders o where o.company_id = new.company_id and o.id = new.order_id)),
      case when new.entered_offline or t.entered_offline then 'important' else 'check' end, new.created_by);
  end loop;
  return null;
end $$;
