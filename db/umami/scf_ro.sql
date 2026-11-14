-- SPDX-License-Identifier: Apache-2.0
-- What the platform touches in the `umami` database — docs/data-model.md §16.1 (roles, statement timeout) and §16.3
-- (the read-only rollup views, C-109). Not a migration of `scf`. Ownership (C-112(12)): run
-- as the one-shot Compose step `umami-views` AFTER `umami-migrate` has completed and BEFORE `web_rollup` starts:
--   db/migrate.sh umami-views     (superuser of the umami database)
--
-- Idempotent and re-runnable after every Umami migration: the views are dropped and recreated each time, roles are
-- created if missing and their attributes and settings re-asserted, grants re-applied (a migration that recreates a
-- table drops its grants). Upgrade procedure (§16.3): `db/migrate.sh umami-views-drop` → umami-migrate → this file →
-- view contract test → web_rollup resumes.
--
-- Passwords (SCF_UMAMI_RO_PASSWORD, SCF_UMAMI_MAINT_PASSWORD; unset = keep) are set by db/migrate.sh after this file with
-- psql's \password: the SCRAM verifier is computed client-side, clear text never reaches the server (C-114).
-- We never change Umami's own schema (ADR-0003): no index, no column, nothing in schema public is created.
\set ON_ERROR_STOP on

BEGIN;

-- Umami's own role must exist (umami-migrate runs as it, C-104).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'umami_app') THEN
    RAISE EXCEPTION 'role umami_app does not exist: run umami-migrate first' USING ERRCODE = '42704';
  END IF;
  IF to_regclass('public.website_event') IS NULL OR to_regclass('public.session') IS NULL
     OR to_regclass('public.revenue') IS NULL THEN
    RAISE EXCEPTION 'Umami tables missing in database %: run umami-migrate first', current_database()
      USING ERRCODE = '42P01';
  END IF;
END $$;

-- §16.1, C-112(6): no Umami query (live window, internal UI) runs longer than 30 s.
ALTER ROLE umami_app SET statement_timeout = '30s';

-- Roles (attributes re-asserted on every run).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('scf_umami_ro',    'LOGIN NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE'),
      ('scf_umami_maint', 'LOGIN NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE'),
      ('scf_umami_view_owner', 'NOLOGIN NOBYPASSRLS NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE')) AS t(name, attrs)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I %s', r.name, r.attrs);
    ELSE
      EXECUTE format('ALTER ROLE %I %s', r.name, r.attrs);
    END IF;
  END LOOP;
END $$;
ALTER ROLE scf_umami_ro SET statement_timeout = '300s';
ALTER ROLE scf_umami_ro SET default_transaction_read_only = on;

-- §16.3: the two views, exactly the columns the rollups need (no url_query, page_title, hostname, distinct_id, region
-- or city). Owner-semantics views on purpose: scf_umami_ro has no right on schema public. Reads through them run with
-- their OWNER's rights, so the owner is scf_umami_view_owner (NOLOGIN, no superuser, no BYPASSRLS;
-- gate G12), which may read exactly the viewed columns and nothing else — never the superuser that runs
-- this file.
GRANT USAGE ON SCHEMA public TO scf_umami_view_owner;
GRANT SELECT (website_id, session_id, visit_id, created_at, event_type, event_name, tag, url_path, referrer_domain)
  ON public.website_event TO scf_umami_view_owner;
GRANT SELECT (session_id, website_id, browser, os, device, country) ON public.session TO scf_umami_view_owner;
DROP SCHEMA IF EXISTS scf_ro CASCADE;
CREATE SCHEMA scf_ro;
REVOKE ALL ON SCHEMA scf_ro FROM PUBLIC;
CREATE VIEW scf_ro.website_event AS
  SELECT e.website_id, e.session_id, e.visit_id, e.created_at, e.event_type, e.event_name, e.tag,
         e.url_path, e.referrer_domain
    FROM public.website_event e;
CREATE VIEW scf_ro.session AS
  SELECT s.session_id, s.website_id, s.browser, s.os, s.device, s.country
    FROM public.session s;
ALTER VIEW scf_ro.website_event OWNER TO scf_umami_view_owner;
ALTER VIEW scf_ro.session OWNER TO scf_umami_view_owner;
SELECT format('GRANT CONNECT ON DATABASE %I TO scf_umami_ro, scf_umami_maint', current_database()) \gexec
GRANT USAGE ON SCHEMA scf_ro TO scf_umami_ro;
GRANT SELECT ON scf_ro.website_event, scf_ro.session TO scf_umami_ro;
-- No grant of ours on schema public or any table in it for scf_umami_ro (only PUBLIC's default USAGE on the schema
-- remains, which reaches no table): it can read the two views and nothing else.
REVOKE ALL ON SCHEMA public FROM scf_umami_ro;

-- §16.1: jobs retention and erasure (C-12), DELETE only; SELECT per column because DELETE … WHERE reads them.
GRANT USAGE ON SCHEMA public TO scf_umami_maint;
GRANT DELETE ON public.website_event, public.event_data, public.session, public.session_data, public.session_link,
  public.revenue TO scf_umami_maint;
GRANT SELECT (event_id, website_id, session_id, created_at, url_path, event_name) ON public.website_event TO scf_umami_maint;
-- revenue (Umami ≥ 2.18): saveEvent writes a row for event data with a numeric `revenue` and a `currency`; retention
-- and erasure delete those rows with their events. Never the amount.
GRANT SELECT (revenue_id, website_id, session_id, event_id, event_name, created_at) ON public.revenue TO scf_umami_maint;
GRANT SELECT (website_event_id, website_id, data_key, created_at) ON public.event_data TO scf_umami_maint;
GRANT SELECT (session_id, website_id, created_at) ON public.session TO scf_umami_maint;
GRANT SELECT (session_id, website_id, created_at) ON public.session_data TO scf_umami_maint;
GRANT SELECT (session_id, website_id, created_at) ON public.session_link TO scf_umami_maint;
-- no INSERT/UPDATE/TRUNCATE; no access to user, team, team_user, api_key, share, report, website tables.

COMMIT;
