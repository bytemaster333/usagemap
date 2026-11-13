-- Source: docs/data-model.md, block '-- migration: 0014_verification' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0014_verification
CREATE TABLE scf.verification_evidence (
  tenant_id        uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  evidence_id      uuid NOT NULL DEFAULT uuidv7(),
  kind             scf.evidence_kind NOT NULL,
  subject          text NOT NULL CHECK (char_length(subject) <= 253),
      -- domain: host · stellar_account: G… · registry_match: registry_project_id · operator_approval: 'operator'
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
      -- {"method":"sep53","signer_weight":2,"medium_threshold":2,"home_domain":"example.org","toml_url":"…"}
      -- {"source":"stellarlight","source_as_of":"2026-08-12","basis":["registrable_domain"]}
      -- {"note":"…","operator_user_id":"…"}
  status           scf.evidence_status NOT NULL DEFAULT 'valid',
  verified_at      timestamptz NOT NULL DEFAULT now(),
  last_checked_at  timestamptz,
  lapsed_at        timestamptz,
  revoked_at       timestamptz,
  revoked_by       uuid,
  created_by       uuid,
  PRIMARY KEY (tenant_id, evidence_id),
  UNIQUE (tenant_id, kind, subject),
  CHECK (kind <> 'stellar_account'   OR subject ~ '^G[A-Z2-7]{55}$'),
  CHECK (kind <> 'operator_approval' OR subject = 'operator')
);

CREATE FUNCTION scf.verification_level(p_tenant uuid) RETURNS smallint LANGUAGE sql STABLE
  AS $$
  WITH e AS (SELECT v.kind FROM scf.verification_evidence v WHERE v.tenant_id = p_tenant AND v.status = 'valid')
  SELECT (CASE
    WHEN EXISTS (SELECT 1 FROM e WHERE kind = 'operator_approval') THEN 4
    WHEN EXISTS (SELECT 1 FROM e WHERE kind = 'domain') AND EXISTS (SELECT 1 FROM e WHERE kind = 'registry_match') THEN 3
    WHEN EXISTS (SELECT 1 FROM e WHERE kind = 'domain') AND EXISTS (SELECT 1 FROM e WHERE kind = 'stellar_account') THEN 2
    WHEN EXISTS (SELECT 1 FROM e WHERE kind = 'domain') THEN 1
    ELSE 0 END)::smallint
  $$;
GRANT EXECUTE ON FUNCTION scf.verification_level(uuid) TO scf_app, scf_jobs, scf_definer, scf_op_definer;

CREATE TABLE scf.registry_projects (
  registry_project_id uuid PRIMARY KEY DEFAULT uuidv7(),
  source              text NOT NULL CHECK (source IN ('stellarlight', 'pg_atlas', 'scf_site', 'operator')),
  source_id           text NOT NULL CHECK (char_length(source_id) <= 200),
  canonical_daoip5_id text CHECK (char_length(canonical_daoip5_id) <= 200),
  name                text NOT NULL CHECK (char_length(name) <= 200),
  slug                text CHECK (char_length(slug) <= 200),
  websites            text[] NOT NULL DEFAULT '{}',
  registrable_domains text[] NOT NULL DEFAULT '{}',   -- eTLD+1 per the Public Suffix List
  github_orgs         text[] NOT NULL DEFAULT '{}',   -- informational only (C-20)
  contract_ids        text[] NOT NULL DEFAULT '{}',
  scf_awarded         boolean,
  scf_awards          jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{"round":29,"award_type":"Build","amount_usd":…,"status":"Awarded"}]
  source_url          text,
  source_basis        text,
  source_confidence   numeric(4,3),
  source_as_of        date,
  fetched_at          timestamptz NOT NULL,
  content_sha256      bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
  raw                 jsonb NOT NULL,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  missing_since       timestamptz,
  UNIQUE (source, source_id)
);
CREATE INDEX registry_projects_domains ON scf.registry_projects USING gin (registrable_domains);

CREATE TABLE scf.registry_sync_runs (
  run_id           uuid PRIMARY KEY DEFAULT uuidv7(),
  source           text NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'suspicious')),
  rows_seen        integer, rows_changed integer, rows_missing integer,
  per_round_counts jsonb,
  error_code       text CHECK (char_length(error_code) <= 64)
);

CREATE TABLE scf.tenant_registry_links (
  tenant_id            uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  registry_project_id  uuid NOT NULL REFERENCES scf.registry_projects,
  match_basis          text[] NOT NULL CHECK (match_basis <@ ARRAY['registrable_domain','daoip5','verified_contract','operator']),
  status               text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate', 'confirmed', 'rejected')),
  decided_by           uuid,
  decided_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, registry_project_id)
);

CALL scf_admin.apply_tenant_rls('scf.verification_evidence', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT,INSERT,UPDATE}',
  '{"SELECT":["domain_verification","registry_sync","contract_verification","trust_scoring","edge_snapshot","public_metrics","tenant_purge"],
    "INSERT":["domain_verification","registry_sync"],"UPDATE":["domain_verification","registry_sync"],"DELETE":["tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.tenant_registry_links', '{SELECT}', '{}', '{SELECT,INSERT,UPDATE}',
  '{"SELECT":["registry_sync","tenant_purge","retention"],"INSERT":["registry_sync"],"UPDATE":["registry_sync"],"DELETE":["tenant_purge"]}');

ALTER TABLE scf.registry_projects ENABLE ROW LEVEL SECURITY;   ALTER TABLE scf.registry_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.registry_sync_runs ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.registry_sync_runs FORCE ROW LEVEL SECURITY;
-- Registry rows are public third-party data, not tenant data: readable by the app (candidate display, SCF-operator console)
-- and the machine API (registry:read). Machine reads are still audited by the control plane.
GRANT SELECT ON scf.registry_projects, scf.registry_sync_runs TO scf_app, scf_metrics_ro, scf_op_definer;
GRANT SELECT, INSERT, UPDATE, DELETE ON scf.registry_projects, scf.registry_sync_runs TO scf_jobs;
CREATE POLICY read_all ON scf.registry_projects FOR SELECT TO scf_app, scf_metrics_ro, scf_op_definer USING (true);
CREATE POLICY read_all ON scf.registry_sync_runs FOR SELECT TO scf_app, scf_metrics_ro, scf_op_definer USING (true);
CREATE POLICY jobs_sync ON scf.registry_projects FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) IN ('registry_sync', 'trust_scoring', 'retention'))
  WITH CHECK ((SELECT scf.current_job()) = 'registry_sync');
CREATE POLICY jobs_sync ON scf.registry_sync_runs FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) IN ('registry_sync', 'retention'))
  WITH CHECK ((SELECT scf.current_job()) = 'registry_sync');
