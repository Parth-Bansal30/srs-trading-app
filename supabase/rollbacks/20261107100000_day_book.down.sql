-- Undo 20261107100000_day_book.sql (read-only functions; nothing is stored).
drop function public.api_stock_on(uuid, date, date);
drop function public.api_sales_days(uuid, date, date);
drop function public.api_day_book(uuid, date, date, date, date);
drop function app.day_start(uuid, date);
