-- Source: docs/data-model.md, block '-- migration: 0077_sealed_audit_anchors' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0077_sealed_audit_anchors
-- "Verify this number" (2026-11-19, plan A2; wire-formats §m.1, §m.2; C-63, C-136): the audit-anchor document that a
-- day's seal committed to (audit leaf = the document's sha256) is published through the public API, so a reader's
-- browser can recompute that hash and see the head of every audit chain — the operator (platform) chain included — that
-- the Stellar transaction fixes. Until now the document lived only in the jobs service's directory.
-- (1) scf.sealed_audit_anchors: one row per UTC day, global (chain ids are tenant UUIDs, seq numbers and row hashes —
--     exactly the public document of §m.1, no names). Written only by job daily_seal, and only with the document whose
--     sha256 equals the day's sealed audit_anchor_sha256 (checked by the job against seal_days before the insert, and
--     by the CHECK below against the document's own sha256 field). Never updated or deleted (no grant; trigger).
-- (2) job audit_verify reads seal_days and these documents: the anchor it checks the live chains against must be the
--     one the ledger fixed, so a rewritten audit row is caught even when the anchor file was rewritten with it.
CREATE TABLE scf.sealed_audit_anchors (
  day        date        PRIMARY KEY,
  sha256     bytea       NOT NULL CHECK (octet_length(sha256) = 32),
  document   jsonb       NOT NULL CHECK (document ->> 'schema' = 'scf-analytics/audit-anchor/1'
                                         AND document ->> 'date' = day::text
                                         AND document ->> 'sha256' = encode(sha256, 'hex')),
  stored_at  timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION scf.sealed_audit_anchors_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    RAISE EXCEPTION 'a sealed audit anchor is never changed' USING ERRCODE = '42501';
  END $$;
CREATE TRIGGER sealed_audit_anchors_guard BEFORE UPDATE OR DELETE ON scf.sealed_audit_anchors
  FOR EACH ROW EXECUTE FUNCTION scf.sealed_audit_anchors_guard();
ALTER TABLE scf.sealed_audit_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE scf.sealed_audit_anchors FORCE ROW LEVEL SECURITY;
GRANT SELECT ON scf.sealed_audit_anchors TO scf_app;                              -- public data (verify page)
GRANT SELECT, INSERT ON scf.sealed_audit_anchors TO scf_jobs;
CREATE POLICY read_all ON scf.sealed_audit_anchors FOR SELECT TO scf_app USING (true);
CREATE POLICY jobs_select ON scf.sealed_audit_anchors FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['daily_seal','audit_verify']::text[]));
CREATE POLICY jobs_insert ON scf.sealed_audit_anchors FOR INSERT TO scf_jobs
  WITH CHECK ((SELECT scf.current_job()) = 'daily_seal');

-- (2) audit_verify reads the seal days (global, public data).
CREATE POLICY jobs_audit_verify_read ON scf.seal_days FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = 'audit_verify');
