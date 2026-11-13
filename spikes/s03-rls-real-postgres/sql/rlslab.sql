-- SPDX-License-Identifier: Apache-2.0
-- Replica of the research spike setup (RLS research test table), so T0–T21 can be
-- compared like for like. Run by the superuser in database rlslab (created by the harness).
DROP SCHEMA IF EXISTS m CASCADE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'owner_role') THEN CREATE ROLE owner_role LOGIN PASSWORD 'spike'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role')   THEN CREATE ROLE app_role LOGIN NOBYPASSRLS PASSWORD 'spike'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_role')   THEN CREATE ROLE ops_role LOGIN BYPASSRLS PASSWORD 'spike'; END IF;
END $$;
CREATE SCHEMA m AUTHORIZATION owner_role;
GRANT USAGE ON SCHEMA m TO app_role, ops_role;
SET ROLE owner_role;
CREATE TABLE m.web_daily (tenant_id uuid NOT NULL, day date NOT NULL, site text NOT NULL, pageviews bigint,
  PRIMARY KEY (tenant_id, day, site)) PARTITION BY RANGE (day);
CREATE TABLE m.web_daily_2026 PARTITION OF m.web_daily FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE m.web_daily_2025 (LIKE m.web_daily INCLUDING ALL);
ALTER TABLE m.web_daily ATTACH PARTITION m.web_daily_2025 FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
ALTER TABLE m.web_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE m.web_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rw ON m.web_daily TO app_role
  USING (tenant_id = (SELECT current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true))::uuid);
CREATE POLICY tenant_backstop ON m.web_daily AS RESTRICTIVE TO app_role
  USING (tenant_id = (SELECT current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true))::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON m.web_daily TO app_role;
GRANT SELECT ON m.web_daily TO ops_role;
-- T8: a global UNIQUE on an RLS table
CREATE TABLE m.sites (tenant_id uuid NOT NULL, hostname text NOT NULL UNIQUE);
ALTER TABLE m.sites ENABLE ROW LEVEL SECURITY; ALTER TABLE m.sites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_rw ON m.sites TO app_role
  USING (tenant_id = (SELECT current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true))::uuid);
GRANT SELECT, INSERT ON m.sites TO app_role;
-- T10: owner-semantics vs invoker views
CREATE VIEW m.v_default AS SELECT * FROM m.web_daily;
CREATE VIEW m.v_invoker WITH (security_invoker = true) AS SELECT * FROM m.web_daily;
GRANT SELECT ON m.v_default, m.v_invoker TO app_role;
-- T11: materialized view
CREATE MATERIALIZED VIEW m.mv AS SELECT tenant_id, count(*) AS n FROM m.web_daily GROUP BY 1;
-- T17: SECURITY DEFINER owned by the (forced) owner
CREATE FUNCTION m.count_all() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT count(*) FROM m.web_daily $$;
GRANT EXECUTE ON FUNCTION m.count_all() TO app_role;
RESET ROLE;
-- seed (superuser bypasses RLS): tenant a 1 row, tenant b 2 rows; the 2026 partition holds 2 rows (a + b)
INSERT INTO m.web_daily VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', '2026-03-01', 'a.example', 10),
  ('bbbbbbbb-0000-0000-0000-000000000002', '2026-03-01', 'b.example', 20),
  ('bbbbbbbb-0000-0000-0000-000000000002', '2025-06-01', 'b.example', 30);
INSERT INTO m.sites VALUES ('bbbbbbbb-0000-0000-0000-000000000002', 'b.example');
REFRESH MATERIALIZED VIEW m.mv;
