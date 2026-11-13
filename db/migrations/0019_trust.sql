-- Source: docs/data-model.md, block '-- migration: 0019_trust' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0019_trust
CREATE TABLE scf.web_trust_scores (
  tenant_id          uuid NOT NULL,
  site_id            uuid NOT NULL,
  day                date NOT NULL,
  window_days        smallint NOT NULL CHECK (window_days IN (1, 28)),
  score              smallint CHECK (score BETWEEN 0 AND 100),   -- NULL = not enough data
  components         jsonb NOT NULL,     -- {"proof_coverage":{"p":0.12,"value":0.88,"eco_percentile":41|null}, …}
  reason_codes       text[] NOT NULL DEFAULT '{}',
  decision_rate      numeric(5,4) CHECK (decision_rate BETWEEN 0 AND 1),
  algorithm_version  text NOT NULL,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id, day, window_days),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE
);

CREATE TABLE scf.api_service_assurance (
  tenant_id     uuid NOT NULL,
  service_id    uuid NOT NULL,
  day           date NOT NULL,
  level         smallint NOT NULL CHECK (level BETWEEN 0 AND 2),       -- A0..A2, cumulative
  onchain_badge text NOT NULL CHECK (onchain_badge IN ('consistent', 'inconsistent', 'not_applicable', 'unavailable')),
  checks        jsonb NOT NULL,     -- {"A1":{"pass":true,"codes":[]},"A2":{"pass":false,"codes":["PROBE_FAILED"]},"A3":{…}}
  reason_codes  text[] NOT NULL DEFAULT '{}',
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, service_id, day),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE
);

CREATE TABLE scf.trust_annotations (
  tenant_id             uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  annotation_id         uuid NOT NULL DEFAULT uuidv7(),
  site_id               uuid,
  service_id            uuid,
  range_start           timestamptz NOT NULL,          -- C-86: inclusive, midnight UTC
  range_end             timestamptz NOT NULL,          -- C-86: exclusive, midnight UTC
  author_kind           text NOT NULL CHECK (author_kind IN ('tenant', 'scf_operator')),
  author_user_id        uuid NOT NULL REFERENCES scf.users,
  body                  text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  explains_reason_codes text[] NOT NULL DEFAULT '{}',
  marks_explained       boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, annotation_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  CHECK (date_trunc('day', range_start, 'UTC') = range_start AND date_trunc('day', range_end, 'UTC') = range_end),
  CHECK (range_end > range_start AND range_end <= range_start + interval '367 days'),
  CHECK (author_kind = 'scf_operator' OR NOT marks_explained)
);

CALL scf_admin.apply_tenant_rls('scf.web_trust_scores', '{SELECT}', '{}', '{SELECT}',
  '{"SELECT":["trust_scoring","public_metrics","tenant_purge"],"INSERT":["trust_scoring"],"UPDATE":["trust_scoring"],"DELETE":["trust_scoring","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_service_assurance', '{SELECT}', '{}', '{SELECT}',
  '{"SELECT":["trust_scoring","public_metrics","tenant_purge"],"INSERT":["trust_scoring"],"UPDATE":["trust_scoring"],"DELETE":["trust_scoring","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.trust_annotations', '{SELECT,INSERT}', '{}', '{SELECT,INSERT}',
  '{"SELECT":["trust_scoring","tenant_purge"],"DELETE":["tenant_purge"]}');
