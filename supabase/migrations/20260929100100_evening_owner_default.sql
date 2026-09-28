-- New owners (a newly registered business, or an owner added later) get the evening summary by default.
create function app.evening_owner_default() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.role = 'owner' then new.evening_summary := true; end if;
  return new;
end $$;
create trigger people_evening_owner_default before insert on public.people
  for each row execute function app.evening_owner_default();
