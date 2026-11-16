-- Source: docs/data-model.md, block '-- migration: 0060_signing_in_jobs_rate_limits' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0060_signing_in_jobs_rate_limits
-- (1) F16: traction snapshots are signed by job `public_metrics` in the jobs service, never in the internet-facing
--     control plane. The control plane inserts a pending request (document and signature NULL); the job computes the
--     figures itself from the request's tenant, period and include_api, signs JCS(document) and fills the four columns
--     once. scf_app may insert only the request columns and update only the revocation columns, so the control plane
--     can neither write a document nor a signature.
ALTER TABLE scf.traction_snapshots
  ALTER COLUMN document DROP NOT NULL,
  ALTER COLUMN canonical_sha256 DROP NOT NULL,
  ALTER COLUMN signature DROP NOT NULL,
  ALTER COLUMN kid DROP NOT NULL,
  ADD COLUMN include_api boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT traction_snapshots_signed_together CHECK (
    (document IS NULL AND canonical_sha256 IS NULL AND signature IS NULL AND kid IS NULL)
    OR (document IS NOT NULL AND canonical_sha256 IS NOT NULL AND signature IS NOT NULL AND kid IS NOT NULL));
REVOKE INSERT, UPDATE ON scf.traction_snapshots FROM scf_app;
GRANT INSERT (tenant_id, snapshot_id, created_by, period_start, period_end, include_api) ON scf.traction_snapshots TO scf_app;
GRANT UPDATE (revoked_at, revoked_reason) ON scf.traction_snapshots TO scf_app;
GRANT UPDATE (document, canonical_sha256, signature, kid) ON scf.traction_snapshots TO scf_jobs;
DROP POLICY jobs_select ON scf.traction_snapshots;
CREATE POLICY jobs_select ON scf.traction_snapshots FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['tenant_purge','public_metrics']::text[]));
-- Only a pending row is signed, and only once.
CREATE POLICY jobs_update ON scf.traction_snapshots FOR UPDATE TO scf_jobs
  USING ((SELECT scf.current_job()) = 'public_metrics' AND signature IS NULL)
  WITH CHECK ((SELECT scf.current_job()) = 'public_metrics');

-- (2) F21: control-plane rate limits shared by every instance (fixed windows, OpenAPI "Rate limits", C-64). A bucket is
--     HMAC-SHA-256 of the limit key (user id or truncated client subnet) under a deployment secret, so neither an address
--     nor a user id is stored; rows expire with their window and are swept by the control plane.
CREATE TABLE scf.rate_limit_buckets (
  bucket      bytea PRIMARY KEY CHECK (octet_length(bucket) = 32),
  window_end  timestamptz NOT NULL,
  hits        integer NOT NULL CHECK (hits >= 0)
);
ALTER TABLE scf.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE scf.rate_limit_buckets FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON scf.rate_limit_buckets TO scf_app;
CREATE POLICY app_rw ON scf.rate_limit_buckets FOR ALL TO scf_app USING (true) WITH CHECK (true);
CREATE INDEX rate_limit_buckets_window_end ON scf.rate_limit_buckets (window_end);
