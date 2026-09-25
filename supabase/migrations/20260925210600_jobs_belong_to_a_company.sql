-- =====================================================================================
-- 7. Found by the structure test: every background job belongs to one company, like all
--    other data. Plus indexes so each company's rows are found quickly.
-- =====================================================================================
alter table private.jobs alter column company_id set not null;
create index jobs_company_idx on private.jobs (company_id, created_at desc);
create index auth_credentials_person_idx on private.auth_credentials (company_id, person_id);
