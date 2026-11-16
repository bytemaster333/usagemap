-- Source: docs/data-model.md, block '-- migration: 0066_registered_footprint' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0066_registered_footprint
-- C-136 (plan A5, C-135: a required enrolment step): the tenant's Registered Footprint — the PROJECT-OWNED Stellar
-- identifiers it declares, never end-user addresses. Contracts stay in scf.declared_contracts (on-chain correlation,
-- onchain_daily and A3 keep working unchanged; `declared` is the footprint status `claimed`); issuing accounts,
-- app/treasury accounts and WASM hashes of factory products go to scf.footprint_items. The API presents both as one
-- list (FootprintItem). Status claimed → verified | rejected, by one closed verification method.
-- Wave scope (C-137, lead's decision on review finding 18): Wave D1 builds contracts only; issuing accounts, app
-- accounts and WASM hashes stay in this contract but are "Wave D3: not counted until then" — nothing reads them for a
-- count, a cohort, a snapshot or a trust score before Wave D3 builds their counting with plan A4.
-- Conflicts (C-137): when the same subject is verified for two or more tenants on the same network, job
-- contract_verification sets conflict_since on every such item (all tenants are flagged; nobody wins by being first);
-- a flagged item keeps its status but is not counted anywhere (on-chain correlation, cohorts) until an operator_admin
-- rejects the wrong claim(s) with scf.op_footprint_reject() (reason claimed_by_other_tenant); the job clears the flag
-- of an item that no longer has a verified twin.

-- (1) Enrolment step: a tenant declares at least one item or explicitly declares that it has none.
ALTER TABLE scf.tenants ADD COLUMN footprint_none_declared boolean NOT NULL DEFAULT false;
GRANT INSERT (footprint_none_declared), UPDATE (footprint_none_declared) ON scf.tenants TO scf_app;

-- (2) Contracts: a rejected status with a reason, the method, a due time for an on-demand re-check and the conflict
--     flag. op_footprint_reject() (owner scf_op_definer) may update the verification columns.
ALTER TABLE scf.declared_contracts DROP CONSTRAINT declared_contracts_status_check;
ALTER TABLE scf.declared_contracts
  ADD CONSTRAINT declared_contracts_status_check CHECK (status IN ('declared', 'verified', 'rejected')),
  ADD COLUMN verification_method text CHECK (verification_method = 'deployer_admin_match'),
  ADD COLUMN rejected_reason text CHECK (rejected_reason IN ('not_deployer_or_admin', 'not_found_on_ledger',
                                                             'claimed_by_other_tenant')),
  ADD COLUMN next_check_at timestamptz,
  ADD COLUMN conflict_since timestamptz,
  ADD CONSTRAINT declared_contracts_rejected_reason CHECK ((status = 'rejected') = (rejected_reason IS NOT NULL)),
  ADD CONSTRAINT declared_contracts_conflict CHECK (conflict_since IS NULL OR status = 'verified');
CREATE INDEX declared_contracts_due ON scf.declared_contracts (next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX declared_contracts_subject ON scf.declared_contracts (contract_id, network) WHERE status = 'verified';
GRANT UPDATE (status, verified_role, verified_by_evidence, verified_at, verification_method, rejected_reason,
              next_check_at, conflict_since) ON scf.declared_contracts TO scf_op_definer;
CREATE POLICY op_definer_update ON scf.declared_contracts FOR UPDATE TO scf_op_definer USING (true) WITH CHECK (true);

-- (3) Accounts and WASM hashes (Wave D3: not counted until then). subject: G… strkey (accounts; never M… muxed, never
--     an end user's account) or the lower-case hex SHA-256 of a WASM blob. Methods (C-137, stricter than C-136):
--     sep1_accounts — listed in ACCOUNTS of the stellar.toml served on a verified domain of the tenant AND the
--     account's on-ledger home_domain is that same domain (accounts only); signed_challenge — the L2 signer rule of
--     §8.5: a SEP-53 (or SEP-10) signature over a platform challenge by signers meeting the account's medium threshold
--     (accounts only); deployer_admin_match — the WASM was uploaded by a verified account of the tenant (wasm_hash
--     only). A verified hash is a filter, never a count by itself: an instance of it is counted only when it was
--     created by a verified deployer account or factory contract of the tenant (anyone can deploy a public WASM).
--     Retention (§14, C-137): rejected and removed items, and claims never verified, are deleted 30 days later.
CREATE TABLE scf.footprint_items (
  tenant_id             uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  item_id               uuid NOT NULL DEFAULT uuidv7(),
  kind                  text NOT NULL CHECK (kind IN ('issuing_account', 'app_account', 'wasm_hash')),
  subject               text NOT NULL,
  network               text NOT NULL CHECK (network IN ('mainnet', 'testnet')),   -- C-137: one vocabulary
  label                 text CHECK (char_length(label) <= 100),
  status                text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'verified', 'rejected')),
  verification_method   text CHECK (verification_method IN ('sep1_accounts', 'signed_challenge', 'deployer_admin_match')),
  verified_at           timestamptz,
  rejected_reason       text CHECK (rejected_reason IN ('not_listed_in_toml', 'toml_unreachable', 'no_verified_domain',
                          'signature_invalid', 'challenge_expired', 'not_deployer_or_admin', 'not_found_on_ledger',
                          'claimed_by_other_tenant')),
  last_checked_at       timestamptz,
  next_check_at         timestamptz,
  challenge_hash        bytea CHECK (octet_length(challenge_hash) = 32),       -- SHA-256 of the pending challenge
  challenge_expires_at  timestamptz,
  created_by            uuid NOT NULL REFERENCES scf.users,
  created_at            timestamptz NOT NULL DEFAULT now(),
  removed_at            timestamptz,
  conflict_since        timestamptz,
  PRIMARY KEY (tenant_id, item_id),
  UNIQUE (tenant_id, kind, subject, network),
  CHECK (CASE kind WHEN 'wasm_hash' THEN subject ~ '^[0-9a-f]{64}$' ELSE subject ~ '^G[A-Z2-7]{55}$' END),
  CHECK ((status = 'verified') = (verification_method IS NOT NULL AND verified_at IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejected_reason IS NOT NULL)),
  CHECK (verification_method IS NULL
         OR (kind = 'wasm_hash') = (verification_method = 'deployer_admin_match')),
  CHECK ((challenge_hash IS NULL) = (challenge_expires_at IS NULL)),
  CHECK (kind <> 'wasm_hash' OR challenge_hash IS NULL),
  CHECK (conflict_since IS NULL OR status = 'verified')
);
CREATE INDEX footprint_items_due ON scf.footprint_items (next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX footprint_items_subject ON scf.footprint_items (kind, subject, network) WHERE status = 'verified';
CALL scf_admin.apply_tenant_rls('scf.footprint_items', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT,UPDATE}',
  '{"SELECT":["contract_verification","onchain_correlation","registry_sync","trust_scoring","retention","tenant_purge"],
    "UPDATE":["contract_verification"],"DELETE":["retention","tenant_purge"]}');

-- (4) Retention (§14): dev events at most 24 hours (0063; the buffer is also trimmed to dev_event_buffer_size on
--     insert); footprint items rejected, removed or never verified 30 days after they were rejected, removed or
--     claimed (C-137: an address a tenant typed and could not prove is not kept). The rule list of 0050 is replaced as
--     a whole, with these two rows added.
CREATE OR REPLACE FUNCTION scf.retention_rules()
  RETURNS TABLE (relname text, tenant_scoped boolean, keep interval, age_expr text, mechanism text, job text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ VALUES
    ('api_metrics_1m',        true,  interval '35 days',   'bucket_start',                          'partition_drop', 'partitions'),
    ('api_metrics_1h',        true,  interval '25 months', 'bucket_start',                          'partition_drop', 'partitions'),
    ('web_hourly_totals',     true,  interval '25 months', 'hour_start',                            'partition_drop', 'partitions'),
    ('api_ingest_ledger',     true,  interval '7 days',    't.received_at',                         'delete', 'retention'),
    ('api_ingest_counters',   true,  interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('web_edge_counters',     true,  interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('web_dev_events',        true,  interval '24 hours',  't.received_at',                         'delete', 'retention'),   -- C-136
    -- C-137: rejected (since the last check), removed (since removal) or never verified (since the claim); verified kept
    ('footprint_items',       true,  interval '30 days',
       'CASE WHEN t.removed_at IS NOT NULL THEN t.removed_at
             WHEN t.status = ''rejected'' THEN COALESCE(t.last_checked_at, t.created_at)
             WHEN t.status = ''claimed'' THEN t.created_at END',                                     'delete', 'retention'),
    ('tenant_invitations',    true,  interval '30 days',
       'LEAST(COALESCE(t.accepted_at, ''infinity''), COALESCE(t.revoked_at, ''infinity''), t.expires_at)', 'delete', 'retention'),
    -- failed or expired rows 90 days after they closed; the current (newest) row of a domain is kept for its life
    ('domain_verifications',  true,  interval '90 days',
       'CASE WHEN t.status IN (''failed'', ''expired'') AND EXISTS (SELECT 1 FROM scf.domain_verifications n
               WHERE n.tenant_id = t.tenant_id AND n.domain_id = t.domain_id AND n.created_at > t.created_at)
             THEN CASE t.status WHEN ''expired'' THEN t.expires_at ELSE COALESCE(t.last_checked_at, t.expires_at) END END',
       'delete', 'retention'),
    ('api_stream_state',      true,  interval '7 days',    't.updated_at',                          'delete', 'stream_gc'),
    ('api_route_day',         true,  interval '7 days',    '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'stream_gc'),
    ('auth_sessions',         false, interval '7 days',
       'LEAST(COALESCE(t.revoked_at, ''infinity''), t.idle_expires_at, t.absolute_expires_at)', 'delete', 'retention'),
    ('auth_challenges',       false, interval '1 day',     't.expires_at',                          'delete', 'retention'),
    ('edge_report_ledger',    false, interval '7 days',    't.received_at',                         'delete', 'retention'),
    ('edge_spool_accounting', false, interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('durability_reports',    false, interval '25 months', '((t.day + 1)::timestamp AT TIME ZONE ''UTC'')', 'delete', 'retention'),
    ('registry_sync_runs',    false, interval '25 months', 't.started_at',                          'delete', 'retention'),
    -- a project a tenant link still references stays (FK; C-114): links are kept for the tenant's life
    ('registry_projects',     false, interval '365 days',
       'CASE WHEN NOT EXISTS (SELECT 1 FROM scf.tenant_registry_links l
                               WHERE l.registry_project_id = t.registry_project_id) THEN t.missing_since END',
       'delete', 'retention'),
    -- edge snapshots: the last 100 sequences are kept
    ('edge_snapshots',        false, interval '0',
       'CASE WHEN t.sequence <= (SELECT max(s.sequence) - 100 FROM scf.edge_snapshots s) THEN ''-infinity''::timestamptz END',
       'delete', 'retention'),
    -- erasure selectors: literal kept until finished_at + 56 days (C-88, C-112), then type and length only
    ('erasure_requests',      true,  interval '56 days',   't.finished_at',                         'redact', 'retention')
  $$;

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('footprint.conflict_resolved',      'operator_admin rejected a conflicting footprint claim (claimed_by_other_tenant; C-137)', '{scf_op_definer}'),
 ('footprint.item_added',             'tenant declared a footprint item (kind, network; C-136)', '{scf_app}'),
 ('footprint.item_removed',           'tenant removed a footprint item', '{scf_app}'),
 ('footprint.verification_requested', 'tenant requested a footprint check or a signing challenge', '{scf_app}'),
 ('footprint.item_verified',          'footprint item verified (method)', '{scf_app,scf_jobs}'),
 ('footprint.item_rejected',          'footprint item rejected (reason code)', '{scf_app,scf_jobs}'),
 ('operator.read.op_footprint',       'op_* read', '{scf_op_definer}');

-- SCF-operator view of the footprint (contracts and other items, one list; `declared` shown as `claimed`; the stored
-- contract network `public` shown as `mainnet`, the one network vocabulary of every API, C-137).
-- p_tenants NULL = every eligible tenant (op_eligible_tenants at level 0: pending, active, suspended; canary only when
-- named); p_status filters claimed | verified | rejected. Removed items are not listed. C-137: a machine key (actor
-- kind op_key) gets the subject of an account item only when it is verified (NULL otherwise) — a claimed or rejected
-- G… may be an address the tenant could not prove is its own; human operators see it to resolve claims.
CREATE FUNCTION scf.op_footprint(p_tenants uuid[] DEFAULT NULL, p_status text DEFAULT NULL)
  RETURNS TABLE (tenant_id uuid, item_id uuid, kind text, subject text, network text, label text, status text,
                 verification_method text, verified_at timestamptz, rejected_reason text, conflict_since timestamptz,
                 created_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_t uuid[]; v_key boolean;
  BEGIN
    PERFORM scf.op_authorize('registry:read');                 -- C-114: first
    IF p_status IS NOT NULL AND p_status NOT IN ('claimed', 'verified', 'rejected') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    v_t := scf.op_begin('operator.read.op_footprint', 'registry:read', p_tenants,
                        jsonb_build_object('tenants', p_tenants, 'status', p_status));
    v_key := scf.actor_kind() = 'op_key';
    RETURN QUERY
      SELECT x.x_tenant, x.x_item, x.x_kind,
             CASE WHEN v_key AND x.x_kind IN ('issuing_account', 'app_account') AND x.x_status <> 'verified'
                  THEN NULL ELSE x.x_subject END,
             x.x_network, x.x_label, x.x_status, x.x_method, x.x_verified_at, x.x_reason, x.x_conflict, x.x_created_at
        FROM (SELECT c.tenant_id AS x_tenant, c.contract_ref AS x_item, 'contract'::text AS x_kind,
                     c.contract_id AS x_subject,
                     CASE c.network WHEN 'public' THEN 'mainnet' ELSE c.network END AS x_network, c.label AS x_label,
                     CASE c.status WHEN 'declared' THEN 'claimed' ELSE c.status END AS x_status,
                     CASE WHEN c.status = 'verified' THEN 'deployer_admin_match' END AS x_method,
                     c.verified_at AS x_verified_at, c.rejected_reason AS x_reason, c.conflict_since AS x_conflict,
                     c.created_at AS x_created_at
                FROM scf.declared_contracts c WHERE c.removed_at IS NULL
              UNION ALL
              SELECT f.tenant_id, f.item_id, f.kind, f.subject, f.network, f.label, f.status, f.verification_method,
                     f.verified_at, f.rejected_reason, f.conflict_since, f.created_at
                FROM scf.footprint_items f WHERE f.removed_at IS NULL) x
        JOIN scf.op_eligible_tenants(0::smallint, v_t, '{pending,active,suspended}') e ON e.tenant_id = x.x_tenant
       WHERE p_status IS NULL OR x.x_status = p_status
       ORDER BY x.x_tenant, x.x_kind, x.x_created_at;
  END $$;
REVOKE ALL ON FUNCTION scf.op_footprint(uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_footprint(uuid[], text) TO scf_app, scf_metrics_ro;

-- Conflict resolution (C-137): an operator_admin with step-up rejects ONE tenant's flagged item (a contract_ref or an
-- item_id of that tenant) with reason claimed_by_other_tenant; the other tenants' items with the same subject get
-- next_check_at = now(), so job contract_verification clears their flag when no verified twin remains. P0002 when
-- the tenant has no such item, 22023 when it is not flagged. Returns the item's kind.
CREATE FUNCTION scf.op_footprint_reject(p_tenant uuid, p_item uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_kind text; v_subject text; v_network text; v_conflict timestamptz;
  BEGIN
    PERFORM scf.op_authorize(NULL, true, true);               -- C-114: first; operator_admin with step-up
    SELECT 'contract', c.contract_id, c.network, c.conflict_since INTO v_kind, v_subject, v_network, v_conflict
      FROM scf.declared_contracts c
     WHERE c.tenant_id = p_tenant AND c.contract_ref = p_item AND c.removed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      SELECT f.kind, f.subject, f.network, f.conflict_since INTO v_kind, v_subject, v_network, v_conflict
        FROM scf.footprint_items f
       WHERE f.tenant_id = p_tenant AND f.item_id = p_item AND f.removed_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
    END IF;
    IF v_conflict IS NULL THEN RAISE EXCEPTION 'item is not in conflict' USING ERRCODE = '22023'; END IF;
    PERFORM scf.op_begin('footprint.conflict_resolved', NULL, ARRAY[p_tenant],
                         jsonb_build_object('item_id', p_item, 'kind', v_kind, 'network', v_network), true, true);
    IF v_kind = 'contract' THEN
      UPDATE scf.declared_contracts SET status = 'rejected', rejected_reason = 'claimed_by_other_tenant',
             verified_role = NULL, verified_by_evidence = NULL, verified_at = NULL, verification_method = NULL,
             conflict_since = NULL, next_check_at = NULL
       WHERE tenant_id = p_tenant AND contract_ref = p_item;
      UPDATE scf.declared_contracts SET next_check_at = now()
       WHERE contract_id = v_subject AND network = v_network AND tenant_id <> p_tenant AND conflict_since IS NOT NULL;
    ELSE
      UPDATE scf.footprint_items SET status = 'rejected', rejected_reason = 'claimed_by_other_tenant',
             verification_method = NULL, verified_at = NULL, conflict_since = NULL, next_check_at = NULL
       WHERE tenant_id = p_tenant AND item_id = p_item;
      UPDATE scf.footprint_items SET next_check_at = now()
       WHERE kind = v_kind AND subject = v_subject AND network = v_network AND tenant_id <> p_tenant
         AND conflict_since IS NOT NULL;
    END IF;
    RETURN v_kind;
  END $$;
REVOKE ALL ON FUNCTION scf.op_footprint_reject(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_footprint_reject(uuid, uuid) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_footprint(uuid[], text) OWNER TO scf_op_definer;
ALTER FUNCTION scf.op_footprint_reject(uuid, uuid) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
