-- Source: docs/data-model.md, block '-- migration: 0022_edge_public' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0022_edge_public
CREATE TABLE scf.edge_snapshots (                   -- wire-formats §e (sequence number, anti-rollback: C-62)
  sequence        bigint PRIMARY KEY,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  envelope        bytea NOT NULL,
  payload_sha256  bytea NOT NULL CHECK (octet_length(payload_sha256) = 32)
);
CREATE TABLE scf.edge_report_ledger (               -- idempotency for spool counter records (wire-formats §l)
  node_id      text NOT NULL CHECK (node_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  record_id    uuid NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (node_id, record_id)
);
-- Spool accounting per edge node and UTC day (C-76), summed from counter records (wire-formats §d.4).
CREATE TABLE scf.edge_spool_accounting (
  node_id               text   NOT NULL CHECK (node_id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  day                   date   NOT NULL,
  queued_start          bigint,                         -- event records queued at 00:00 UTC (first report of the day)
  fsynced               bigint NOT NULL DEFAULT 0,      -- event records made durable (answered 202)
  acked_stored          bigint NOT NULL DEFAULT 0,      -- engine answered 200 with a cache token
  acked_engine_bot      bigint NOT NULL DEFAULT 0,      -- engine answered 200 'beep' (engine_bot_drop, C-69)
  acked_engine_rejected bigint NOT NULL DEFAULT 0,      -- engine answered 400 (engine_rejected)
  expired_72h           bigint NOT NULL DEFAULT 0,      -- discarded under the 72-hour rule (C-18)
  queued_end            bigint,                         -- gauge from the latest report of the day
  last_period_end       timestamptz,
  restarts              integer NOT NULL DEFAULT 0,     -- boot_id changes seen this day (unreported windows)
  PRIMARY KEY (node_id, day),
  CHECK (fsynced >= 0 AND acked_stored >= 0 AND acked_engine_bot >= 0 AND acked_engine_rejected >= 0 AND expired_72h >= 0)
);
-- Daily durability results (C-76): one row per node balance and one per canary probe source.
CREATE TABLE scf.durability_reports (
  day           date   NOT NULL,
  subject       text   NOT NULL CHECK (subject ~ '^(node|canary):[a-z0-9][a-z0-9-]{1,31}$'),
  expected      bigint NOT NULL,     -- node: queued_start + fsynced · canary: events the probes saw accepted
  observed      bigint NOT NULL,     -- node: acked + expired + queued_end · canary: events counted in Umami
  status        text   NOT NULL CHECK (status IN ('balanced', 'loss', 'unaccounted', 'pending')),
  details       jsonb  NOT NULL DEFAULT '{}'::jsonb,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, subject)
);
CREATE TABLE scf.traction_snapshots (               -- wire-formats §i.3, Ed25519 (C-47)
  tenant_id         uuid  NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  snapshot_id       uuid  NOT NULL UNIQUE DEFAULT uuidv7(),
  created_by        uuid  NOT NULL REFERENCES scf.users,
  created_at        timestamptz NOT NULL DEFAULT now(),
  period_start      timestamptz NOT NULL,             -- C-86: inclusive, midnight UTC
  period_end        timestamptz NOT NULL,             -- C-86: exclusive, midnight UTC, ≤ today 00:00 UTC
  document          jsonb NOT NULL,
  canonical_sha256  bytea NOT NULL CHECK (octet_length(canonical_sha256) = 32),
  signature         bytea NOT NULL CHECK (octet_length(signature) = 64),
  kid               text  NOT NULL,
  revoked_at        timestamptz,
  revoked_reason    text CHECK (char_length(revoked_reason) <= 200),
  PRIMARY KEY (tenant_id, snapshot_id),
  CHECK (date_trunc('day', period_start, 'UTC') = period_start AND date_trunc('day', period_end, 'UTC') = period_end),
  CHECK (period_end > period_start AND period_end <= period_start + interval '400 days')
);
CREATE TABLE scf.public_metrics_documents (         -- metrics_endpoint (wire-formats §i.1), rebuilt hourly
  tenant_id     uuid PRIMARY KEY REFERENCES scf.tenants ON DELETE CASCADE,
  document      jsonb NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE scf.edge_snapshots ENABLE ROW LEVEL SECURITY;      ALTER TABLE scf.edge_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.edge_report_ledger ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.edge_report_ledger FORCE ROW LEVEL SECURITY;
GRANT SELECT ON scf.edge_snapshots TO scf_app;
GRANT SELECT, INSERT, DELETE ON scf.edge_snapshots TO scf_jobs;
CREATE POLICY app_read ON scf.edge_snapshots FOR SELECT TO scf_app USING (true);
CREATE POLICY jobs_build ON scf.edge_snapshots FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) IN ('edge_snapshot', 'retention')) WITH CHECK ((SELECT scf.current_job()) = 'edge_snapshot');
GRANT SELECT, INSERT ON scf.edge_report_ledger TO scf_app;
GRANT SELECT, DELETE ON scf.edge_report_ledger TO scf_jobs;
CREATE POLICY app_rw ON scf.edge_report_ledger FOR ALL TO scf_app USING (true) WITH CHECK (true);
CREATE POLICY jobs_retention ON scf.edge_report_ledger FOR ALL TO scf_jobs USING ((SELECT scf.current_job()) = 'retention');

ALTER TABLE scf.edge_spool_accounting ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.edge_spool_accounting FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.durability_reports ENABLE ROW LEVEL SECURITY;     ALTER TABLE scf.durability_reports FORCE ROW LEVEL SECURITY;
-- Written by the internal counter endpoint (scf_app, actor_kind system); no tenant data in either table.
GRANT SELECT, INSERT, UPDATE ON scf.edge_spool_accounting TO scf_app;
CREATE POLICY app_counters ON scf.edge_spool_accounting FOR ALL TO scf_app
  USING ((SELECT scf.actor_kind()) = 'system') WITH CHECK ((SELECT scf.actor_kind()) = 'system');
GRANT SELECT, DELETE ON scf.edge_spool_accounting TO scf_jobs;
CREATE POLICY jobs_read ON scf.edge_spool_accounting FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) IN ('durability_reconcile', 'retention'));
GRANT SELECT, INSERT, UPDATE, DELETE ON scf.durability_reports TO scf_jobs;
CREATE POLICY jobs_write ON scf.durability_reports FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) IN ('durability_reconcile', 'retention'))
  WITH CHECK ((SELECT scf.current_job()) = 'durability_reconcile');
GRANT SELECT ON scf.durability_reports TO scf_app;                 -- SCF-operator console and the SLA report
CREATE POLICY app_read ON scf.durability_reports FOR SELECT TO scf_app USING ((SELECT scf.platform_role()) IS NOT NULL);

CALL scf_admin.apply_tenant_rls('scf.traction_snapshots', '{SELECT,INSERT,UPDATE}', '{}', '{}',
  '{"SELECT":["tenant_purge"],"DELETE":["tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.public_metrics_documents', '{SELECT}', '{}', '{SELECT}',
  '{"SELECT":["public_metrics","tenant_purge"],"INSERT":["public_metrics"],"UPDATE":["public_metrics"],"DELETE":["public_metrics","tenant_purge"]}');
GRANT SELECT ON scf.traction_snapshots, scf.public_metrics_documents TO scf_definer;
CREATE POLICY definer_public ON scf.traction_snapshots FOR SELECT TO scf_definer USING (true);
CREATE POLICY definer_public ON scf.public_metrics_documents FOR SELECT TO scf_definer USING (true);
