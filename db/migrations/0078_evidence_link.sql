-- Source: docs/data-model.md, block '-- migration: 0078_evidence_link' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0078_evidence_link
-- SCF Evidence Link (win wave 2026-11-19, agent D; differentiation plan C1, C4, C5): traction snapshot schema v3 =
-- v2 + the usage funnel, the Growth Hack / Public Goods programme block and the project's position in its SCF round and
-- categories (wire-formats §i.3.5). v1 and v2 rows are unchanged and stay verifiable.

-- (1) Schema v3 requests. A preset is required from v2 on (v1 takes none).
ALTER TABLE scf.traction_snapshots
  DROP CONSTRAINT traction_snapshots_schema_version_check,
  ADD CONSTRAINT traction_snapshots_schema_version_check CHECK (schema_version IN (1, 2, 3)),
  DROP CONSTRAINT traction_snapshots_v2_preset,
  ADD CONSTRAINT traction_snapshots_v2_preset CHECK ((schema_version >= 2) = (preset IS NOT NULL));

-- (2) The cohort position: job public_metrics (the signer) reads, with no tenant set (a cross-tenant read of a named
--     job, scf.cross_tenant_read_ok, C-17), which projects share an SCF round or category through a confirmed registry
--     link. Their web and on-chain figures it already reads (0018, 0065). Only the signing project's own percentile
--     (rounded to 5, cohorts of >= cohort_min_tenants projects that reach op_min_count) enters the signed document.
DROP POLICY jobs_select ON scf.registry_projects;
CREATE POLICY jobs_select ON scf.registry_projects FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['registry_sync','trust_scoring','retention','public_metrics']::text[]));
DROP POLICY jobs_select ON scf.tenant_registry_links;
CREATE POLICY jobs_select ON scf.tenant_registry_links FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['registry_sync','tenant_purge','retention','public_metrics']::text[]));
