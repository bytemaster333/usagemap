-- Source: docs/data-model.md, block '-- migration: 0003_audit' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0003_audit
-- C-89: the ONE enumerated list of audit action names, shared by the database and both OpenAPI documents
-- (x-audit-action values must be members). Extended only by a reviewed migration.
-- C-114: `writers` lists the roles that may insert the action (policy audit_insert); set below, per role.
CREATE TABLE scf.audit_actions (
  action       text PRIMARY KEY CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' AND char_length(action) <= 96),
  description  text NOT NULL CHECK (char_length(description) <= 200),
  writers      text[] NOT NULL DEFAULT '{}'
               CHECK (writers <@ ARRAY['scf_app','scf_writer','scf_jobs','scf_metrics_ro','scf_op_definer'])
);
INSERT INTO scf.audit_actions (action, description) VALUES
 ('account.deleted',                  'member deleted own account (C-57 tombstone)'),
 ('account.updated',                  'member changed own profile'),
 ('api_key.created',                  'operator API key created'),
 ('api_key.revoked',                  'operator API key revoked'),
 ('api_key.expired',                  'operator API key passed expires_at'),
 ('api_key.rate_limited',             'operator API key hit its rate limit (aggregated per minute)'),
 ('api_key.rejected_bad_checksum',    'operator key with a wrong CRC presented'),
 ('audit.anchored',                   'job audit_anchor published chain heads (C-63)'),
 ('audit.verified',                   'job audit_verify re-checked the chains'),
 ('auth.identity_linked',             'GitHub or Stellar identity linked'),
 ('auth.identity_unlinked',           'identity unlinked'),
 ('auth.passkey_added',               'passkey registered'),
 ('auth.passkey_removed',             'passkey deleted'),
 ('auth.reauthenticated',             'fresh sign-in for a sensitive tenant action (C-87)'),
 ('auth.session_revoked',             'session revoked by the member or an operator_admin'),
 ('auth.signed_in',                   'sign-in'),
 ('auth.signed_out',                  'sign-out'),
 ('auth.step_up',                     'SCF-operator passkey step-up (C-09)'),
 ('domain.added',                     'domain declared for a site'),
 ('domain.disputed',                  'host verified by a second tenant'),
 ('domain.dispute_resolved',          'SCF operator resolved a dispute'),
 ('domain.lapsed',                    'verification lapsed after grace'),
 ('domain.removed',                   'domain removed'),
 ('domain.verification_checked',      'manual re-check requested'),
 ('domain.verification_started',      'verification token issued'),
 ('domain.verified',                  'domain verified'),
 ('erasure.cancelled',                'erasure request cancelled'),
 ('erasure.completed',                'erasure job finished (counts only)'),
 ('erasure.confirmed',                'erasure confirmed (fresh sign-in, C-87)'),
 ('erasure.failed',                   'erasure job failed'),
 ('erasure.requested',                'erasure requested (selector type only, C-88)'),
 ('erasure.selector_redacted',        'literal selector replaced by type and length (C-88)'),
 ('ingest_token.created',             'ingest token created'),
 ('ingest_token.revoked',             'ingest token revoked'),
 ('invitation.accepted',              'invitation accepted'),
 ('invitation.created',               'invitation created'),
 ('invitation.revoked',               'invitation revoked'),
 ('member.ownership_transferred',     'ownership transferred (fresh sign-in, C-87)'),
 ('member.removed',                   'member removed'),
 ('member.role_changed',              'member role changed'),
 ('operator.grant.added',             'SCF operator role granted'),
 ('operator.grant.revoked',           'SCF operator role revoked'),
 ('operator.read.op_api_assurance',   'op_* read'),
 ('operator.read.op_api_metrics',     'op_* read'),
 ('operator.read.op_audit_list',      'op_* read'),
 ('operator.read.op_metrics_document','op_* read'),
 ('operator.read.op_onchain',         'op_* read'),
 ('operator.read.op_projects',        'op_* read'),
 ('operator.read.op_tenant_detail',   'op_* read'),
 ('operator.read.op_trust',           'op_* read'),
 ('operator.read.op_web_breakdown',   'op_* read'),
 ('operator.read.op_web_metrics',     'op_* read'),
 ('operator.read.op_web_verdicts',    'op_* read'),
 ('operator.read.registry',           'registry read through the machine API (control plane)'),
 ('operator.read.tombstones',         'tombstone list read (control plane)'),
 ('operator.tombstone_lifted',        'operator_admin lifted a tombstone (C-70)'),
 ('registry.link_confirmed',          'registry link confirmed'),
 ('registry.link_rejected',           'registry link rejected'),
 ('registry.sync_requested',          'on-demand registry sync'),
 ('registry.synced',                  'registry sync run finished'),
 ('retention.umami_pruned',           'Umami event-level retention run (counts only)'),
 ('service.archived',                 'API service archived'),
 ('service.auto_registered',          'writer auto-registered a service (C-21)'),
 ('service.created',                  'API service created'),
 ('service.updated',                  'API service updated'),
 ('settings.updated',                 'platform setting changed (old and new value)'),
 ('share_key.created',                'pub key created'),
 ('share_key.revoked',                'pub key revoked'),
 ('site.archived',                    'site archived'),
 ('site.created',                     'site created'),
 ('site.updated',                     'site settings changed'),
 ('snapshot.created',                 'traction snapshot signed'),
 ('snapshot.revoked',                 'traction snapshot revoked'),
 ('tenant.approved',                  'pending tenant approved'),
 ('tenant.created',                   'tenant created'),
 ('tenant.purge_requested',           'operator_admin requested immediate purge'),
 ('tenant.purged',                    'tenant data purged'),
 ('tenant.reapproval_required',       'operator_admin moved active tenants back to pending in bulk (C-91, C-94)'),
 ('tenant.reinstated',                'suspended tenant reinstated'),
 ('tenant.removed',                   'tenant removed (owner with fresh sign-in, or operator_admin)'),
 ('tenant.restored',                  'removed tenant restored'),
 ('tenant.suspended',                 'tenant suspended'),
 ('tenant.updated',                   'tenant settings changed'),
 ('trust.annotation.created',         'trust annotation by tenant or SCF operator'),
 ('umami.key_rotated',                'per-tenant Umami API key rotated (C-85)'),
 ('verification.contract_declared',   'contract declared'),
 ('verification.contract_removed',    'contract removed'),
 ('verification.contract_verified',   'contract verified on the ledger (C-19)'),
 ('verification.evidence_lapsed',     'ladder evidence lapsed'),
 ('verification.operator_approved',   'operator approval evidence (L4)'),
 ('verification.stellar_account_linked', 'Stellar account evidence (L2)');

-- Per-role action allow-lists (C-114). scf_app: the control plane's own transactions (every x-audit-action of an
-- operation that is not an op_* function); scf_metrics_ro: the operator metrics API pool (registry reads, key
-- events); scf_jobs: the named jobs of §6.3; scf_writer: auto-registration only (CR-20); scf_op_definer: op_begin()
-- inside the op_* functions of §11. scf_definer writes no audit rows.
UPDATE scf.audit_actions SET writers = writers || 'scf_app'::text WHERE action IN (
  'account.deleted', 'account.updated', 'api_key.created', 'api_key.revoked', 'api_key.expired', 'api_key.rate_limited',
  'api_key.rejected_bad_checksum', 'auth.identity_linked', 'auth.identity_unlinked', 'auth.passkey_added',
  'auth.passkey_removed', 'auth.reauthenticated', 'auth.session_revoked', 'auth.signed_in', 'auth.signed_out',
  'auth.step_up', 'domain.added', 'domain.removed', 'domain.verification_checked', 'domain.verification_started',
  'erasure.cancelled', 'erasure.confirmed', 'erasure.requested', 'ingest_token.created', 'ingest_token.revoked',
  'invitation.accepted', 'invitation.created', 'invitation.revoked', 'member.ownership_transferred', 'member.removed',
  'member.role_changed', 'operator.grant.added', 'operator.grant.revoked', 'operator.read.registry',
  'operator.read.tombstones', 'registry.sync_requested', 'service.archived', 'service.created', 'service.updated',
  'settings.updated', 'share_key.created', 'share_key.revoked', 'site.archived', 'site.created', 'site.updated',
  'snapshot.created', 'snapshot.revoked', 'tenant.created', 'tenant.removed', 'tenant.updated',
  'trust.annotation.created', 'verification.contract_declared', 'verification.contract_removed',
  'verification.stellar_account_linked');
UPDATE scf.audit_actions SET writers = writers || 'scf_metrics_ro'::text WHERE action IN (
  'api_key.expired', 'api_key.rate_limited', 'api_key.rejected_bad_checksum', 'operator.read.registry');
UPDATE scf.audit_actions SET writers = writers || 'scf_jobs'::text WHERE action IN (
  'audit.anchored', 'audit.verified', 'domain.disputed', 'domain.lapsed', 'domain.verified', 'erasure.completed',
  'erasure.failed', 'erasure.selector_redacted', 'registry.synced', 'retention.umami_pruned', 'tenant.purged',
  'umami.key_rotated', 'verification.contract_verified', 'verification.evidence_lapsed');
UPDATE scf.audit_actions SET writers = writers || 'scf_writer'::text WHERE action = 'service.auto_registered';
UPDATE scf.audit_actions SET writers = writers || 'scf_op_definer'::text WHERE action LIKE 'operator.read.op\_%' OR action IN (
  'domain.dispute_resolved', 'operator.tombstone_lifted', 'registry.link_confirmed', 'registry.link_rejected',
  'tenant.approved', 'tenant.purge_requested', 'tenant.reapproval_required', 'tenant.reinstated', 'tenant.removed',
  'tenant.restored', 'tenant.suspended', 'trust.annotation.created', 'verification.operator_approved');
ALTER TABLE scf.audit_actions ADD CHECK (cardinality(writers) > 0);    -- a new action must name its writers

CREATE TABLE scf.audit_chain_heads (
  chain_id   uuid   PRIMARY KEY,
  last_seq   bigint NOT NULL,
  last_hash  bytea  NOT NULL CHECK (octet_length(last_hash) = 32)
);

CREATE TABLE scf.audit_log (
  chain_id            uuid        NOT NULL,
  seq                 bigint      NOT NULL,
  occurred_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  tx_id               xid8        NOT NULL DEFAULT pg_current_xact_id(),
  tenant_id           uuid,
  actor_kind          text        NOT NULL CHECK (actor_kind IN ('user','operator','op_key','pub_key','job','writer','system','anonymous')),
  actor_id            text        CHECK (char_length(actor_id) <= 64),
  action              text        NOT NULL REFERENCES scf.audit_actions,
  target_type         text        CHECK (char_length(target_type) <= 48),
  target_id           text        CHECK (char_length(target_id) <= 128),
  subject_tenant_ids  uuid[],
  outcome             text        NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied','failure')),
  details             jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(details) <= 8192),
  request_id          text        CHECK (char_length(request_id) <= 64),
  prev_hash           bytea       NOT NULL,
  row_hash            bytea       NOT NULL,
  PRIMARY KEY (chain_id, seq),
  CHECK ((tenant_id IS NULL AND chain_id = '00000000-0000-0000-0000-000000000000'::uuid) OR tenant_id = chain_id)
);
CREATE INDEX audit_log_tenant_time ON scf.audit_log (tenant_id, occurred_at);
CREATE INDEX audit_log_tx          ON scf.audit_log (tx_id);
CREATE INDEX audit_log_time        ON scf.audit_log (occurred_at);

-- Canonical text v2 (C-114): 'v2:' followed by a JSON array of the fields in a fixed order — injective, because JSON
-- quotes and escapes every string and keeps NULL distinct from ''. details is embedded as its jsonb text form.
-- row_hash = sha256(prev_hash || utf8(audit_canonical(row))).
CREATE FUNCTION scf.audit_canonical(r scf.audit_log) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
  SELECT 'v2:' || json_build_array(r.chain_id::text, r.seq::text,
           to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           r.actor_kind, r.actor_id, r.action, r.tenant_id::text, r.target_type, r.target_id,
           r.subject_tenant_ids::text[], r.outcome, r.details, r.request_id)::text
  $$;

-- C-103 (S-03 §5): SECURITY DEFINER under its own owner, so runtime roles need no write access to audit_chain_heads
-- and cannot rewrite a chain head outside this trigger. A trigger function cannot be called directly.
CREATE FUNCTION scf.audit_chain_append() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_seq bigint; v_hash bytea;
  BEGIN
    NEW.chain_id    := COALESCE(NEW.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid);
    NEW.occurred_at := clock_timestamp();
    NEW.tx_id       := pg_current_xact_id();
    INSERT INTO scf.audit_chain_heads (chain_id, last_seq, last_hash)
         VALUES (NEW.chain_id, 0, decode(repeat('00', 32), 'hex'))
    ON CONFLICT (chain_id) DO NOTHING;
    SELECT h.last_seq, h.last_hash INTO v_seq, v_hash
      FROM scf.audit_chain_heads h WHERE h.chain_id = NEW.chain_id FOR UPDATE;   -- serialises the chain
    NEW.seq       := v_seq + 1;
    NEW.prev_hash := v_hash;
    NEW.row_hash  := sha256(v_hash || convert_to(scf.audit_canonical(NEW), 'UTF8'));
    UPDATE scf.audit_chain_heads SET last_seq = NEW.seq, last_hash = NEW.row_hash WHERE chain_id = NEW.chain_id;
    RETURN NEW;
  END $$;

CREATE FUNCTION scf.audit_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$ BEGIN RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = '42501'; END $$;

CREATE TRIGGER audit_chain_append BEFORE INSERT ON scf.audit_log FOR EACH ROW EXECUTE FUNCTION scf.audit_chain_append();
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON scf.audit_log FOR EACH ROW EXECUTE FUNCTION scf.audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON scf.audit_log FOR EACH STATEMENT EXECUTE FUNCTION scf.audit_immutable();

-- True when the current transaction already wrote an audit row for the current actor (privileged global writes).
CREATE FUNCTION scf.audited_in_tx() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT EXISTS (SELECT 1 FROM scf.audit_log a WHERE a.tx_id = pg_current_xact_id()
                        AND a.actor_kind = scf.actor_kind() AND a.actor_id = scf.current_actor()) $$;
GRANT EXECUTE ON FUNCTION scf.audited_in_tx(), scf.audit_canonical(scf.audit_log)
  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer, scf_audit_definer;

REVOKE ALL ON FUNCTION scf.audit_chain_append() FROM PUBLIC;   -- before the owner change (C-114: no INHERIT)
GRANT CREATE ON SCHEMA scf TO scf_audit_definer;          -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.audit_chain_append() OWNER TO scf_audit_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_audit_definer;

ALTER TABLE scf.audit_actions ENABLE ROW LEVEL SECURITY;      ALTER TABLE scf.audit_actions FORCE ROW LEVEL SECURITY;
GRANT SELECT ON scf.audit_actions TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer;
CREATE POLICY read_all ON scf.audit_actions FOR SELECT
  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer USING (true);
-- C-114: FORCE applies to the owner too; later migrations seed and correct actions as scf_migrator.
CREATE POLICY migrator_seed ON scf.audit_actions FOR ALL TO scf_migrator USING (true) WITH CHECK (true);

ALTER TABLE scf.audit_log ENABLE ROW LEVEL SECURITY;          ALTER TABLE scf.audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.audit_chain_heads ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.audit_chain_heads FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON scf.audit_log TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_op_definer;
GRANT SELECT ON scf.audit_log TO scf_definer;
-- C-103: only the trigger's owner writes chain heads; job audit_anchor reads them. No runtime role has INSERT/UPDATE.
GRANT SELECT, INSERT, UPDATE ON scf.audit_chain_heads TO scf_audit_definer;
GRANT SELECT ON scf.audit_chain_heads TO scf_jobs;

-- Runtime roles write their own tenant chain or the platform chain. (No audit_log policy may call a function
-- that reads audit_log through RLS-dependent logic of this table other than tx-local rows.)
-- scf_writer writes only service.auto_registered under its tenant context (CR-20).
CREATE POLICY tenant_backstop ON scf.audit_log AS RESTRICTIVE FOR ALL TO scf_app, scf_writer, scf_jobs, scf_metrics_ro
  USING (tenant_id = (SELECT scf.current_tenant()) OR tx_id = pg_current_xact_id()
         OR (SELECT scf.current_job()) = ANY (ARRAY['audit_verify','audit_anchor']))
  WITH CHECK (tenant_id IS NULL OR tenant_id = (SELECT scf.current_tenant()));
-- C-114: each role appends only the actions whose `writers` name it (inside op_* functions current_user is
-- scf_op_definer).
CREATE POLICY audit_insert ON scf.audit_log FOR INSERT TO scf_app, scf_jobs, scf_metrics_ro, scf_op_definer
  WITH CHECK (actor_kind = (SELECT scf.actor_kind())
              AND action IN (SELECT x.action FROM scf.audit_actions x WHERE current_user::text = ANY (x.writers)));
CREATE POLICY writer_insert ON scf.audit_log FOR INSERT TO scf_writer
  WITH CHECK (actor_kind = 'writer' AND action = 'service.auto_registered' AND tenant_id = (SELECT scf.current_tenant())
              AND action IN (SELECT x.action FROM scf.audit_actions x WHERE 'scf_writer' = ANY (x.writers)));
CREATE POLICY audit_read_own_tx ON scf.audit_log FOR SELECT TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer
  USING (tx_id = pg_current_xact_id());
CREATE POLICY audit_read_tenant ON scf.audit_log FOR SELECT TO scf_app
  USING (tenant_id = (SELECT scf.current_tenant()) AND (SELECT scf.tenant_ctx_ok()));
CREATE POLICY audit_read_jobs ON scf.audit_log FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['audit_verify','audit_anchor']));
CREATE POLICY op_definer_all ON scf.audit_log FOR SELECT TO scf_op_definer USING (true);

-- C-103: the former FOR ALL policy for runtime roles (chain_heads_rw) is gone — S-03 showed scf_app could
-- UPDATE the platform chain head directly. The trigger runs as scf_audit_definer; RLS on audit_log still decides
-- which chain a role may append to (its WITH CHECK runs after the BEFORE trigger and rolls the head update back).
CREATE POLICY audit_definer_all ON scf.audit_chain_heads FOR ALL TO scf_audit_definer USING (true) WITH CHECK (true);
CREATE POLICY jobs_anchor_read ON scf.audit_chain_heads FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = 'audit_anchor');
