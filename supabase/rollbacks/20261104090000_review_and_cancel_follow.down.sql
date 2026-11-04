-- Undo 20261104090000_review_and_cancel_follow (tested by `npm run db:try -- --undo`). Review cards are lost on undo —
-- export them first (`npm run db:snapshot -- review_items`).
drop trigger if exists twin_check on public.payments;
drop trigger if exists cancel_follow on public.payments;
drop trigger if exists cancel_follow on public.expenses;
drop trigger if exists cancel_follow on public.money_transfers;
drop function if exists public.api_payment_twin_seen(uuid, uuid, text, uuid);
drop function if exists app.payment_twin_check();
drop function if exists app.transfer_cancel_follow();
drop function if exists app.expense_cancel_follow();
drop function if exists app.payment_cancel_follow();
drop function if exists app.bank_reopen_for(uuid, uuid, uuid, uuid, text, uuid);
drop function if exists public.api_review_answer(uuid, uuid, text, uuid, text, text);
drop function if exists public.api_review_list(uuid, boolean);
drop function if exists app.review_add(uuid, text, uuid, uuid, jsonb, uuid, uuid, text, text, uuid);
drop table if exists public.review_items;
