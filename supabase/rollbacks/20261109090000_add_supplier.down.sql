-- Undo 20261109090000_add_supplier: only the function goes (suppliers added with it stay — they are ordinary suppliers).
drop function if exists public.api_create_supplier(uuid, uuid, text, jsonb);
