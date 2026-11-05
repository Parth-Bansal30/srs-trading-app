-- Undo 20261105110000_cash_rules: cash is no longer stopped or flagged (cards already in "To check" stay).
drop trigger if exists cash_rule on public.payment_parts;
drop trigger if exists cash_rule on public.expenses;
drop function if exists public.api_cash_room(uuid, uuid, uuid);
drop function if exists public.api_cash_reason_pay(uuid, text, text, jsonb, jsonb, jsonb);
drop function if exists public.api_cash_reason_expense(uuid, uuid, text, jsonb, text);
drop function if exists app.cash_rule_in();
drop function if exists app.cash_rule_out();
drop function if exists app.cash_in(uuid, uuid, uuid, date, date);
drop function if exists app.cash_out_day(uuid, uuid, text, date);
drop function if exists app.inr(numeric);
drop function if exists app.cash_limit();
