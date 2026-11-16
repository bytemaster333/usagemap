-- Source: docs/data-model.md, block '-- migration: 0065_snapshot_v2_seal' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0065_snapshot_v2_seal
-- C-136 (plan C1, A2; decisions D4, D10; C-135): traction snapshot schema v2 (wire-formats §i.3.2), the public
-- append-only list of issued snapshots (§i.3.3) and the daily seal (wire-formats §m.2): one MEMO_HASH transaction per
-- day and network whose memo is the root of a Merkle tree over salted snapshot leaves, the audit-anchor document and
-- the previous day's root. Tamper-evidence of published numbers, never proof that the numbers are genuine.

-- (1) Tenant opt-in: only snapshots of tenants with seal_enabled become leaves.
ALTER TABLE scf.tenants ADD COLUMN seal_enabled boolean NOT NULL DEFAULT false;
GRANT INSERT (seal_enabled), UPDATE (seal_enabled) ON scf.tenants TO scf_app;

-- (2) Snapshot v2 request and signing columns. v1 rows keep schema_version 1 and stay verifiable unchanged.
--     preset is required for v2 (and absent for v1); the job stamps methodology_version when it signs, the trigger
--     below stamps signed_at and series_seq. series_seq (C-137) numbers the tenant's signed snapshots 1, 2, 3, … in
--     signing order; the v2 document carries it with the previous snapshot's hash (wire-formats §i.3.2 `series`), so
--     a missing or removed snapshot is evident to anyone holding a later one. Rows signed before this migration keep
--     series_seq NULL and are not in the public list (C-137: they were issued before the list existed).
ALTER TABLE scf.traction_snapshots
  ADD COLUMN schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version IN (1, 2)),
  ADD COLUMN preset text CHECK (preset IN ('build_tranche', 'growth_hack_before', 'growth_hack_during',
                                           'pg_renewal_quarter', 'custom')),
  ADD COLUMN methodology_version text CHECK (methodology_version ~ '^scf-methodology/[0-9]+\.[0-9]+\.[0-9]+$'),
  ADD COLUMN signed_at timestamptz,
  ADD COLUMN series_seq integer CHECK (series_seq >= 1),
  ADD CONSTRAINT traction_snapshots_v2_preset CHECK ((schema_version = 2) = (preset IS NOT NULL)),
  ADD CONSTRAINT traction_snapshots_series_unique UNIQUE (tenant_id, series_seq),
  ADD CONSTRAINT traction_snapshots_series_signed CHECK (series_seq IS NULL OR signature IS NOT NULL),
  ADD CONSTRAINT traction_snapshots_v2_series CHECK (schema_version = 1 OR (signature IS NULL) = (series_seq IS NULL));
-- Backfill (C-137): rows signed before this migration get signed_at = created_at, so daily_seal can select them. The
-- owner bypasses RLS only while FORCE is off, inside this transaction.
ALTER TABLE scf.traction_snapshots NO FORCE ROW LEVEL SECURITY;
UPDATE scf.traction_snapshots SET signed_at = created_at WHERE signature IS NOT NULL AND signed_at IS NULL;
ALTER TABLE scf.traction_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.traction_snapshots
  ADD CONSTRAINT traction_snapshots_signed_at CHECK ((signature IS NULL) = (signed_at IS NULL));
GRANT INSERT (schema_version, preset) ON scf.traction_snapshots TO scf_app;
GRANT UPDATE (methodology_version, signed_at, series_seq) ON scf.traction_snapshots TO scf_jobs;
CREATE INDEX traction_snapshots_signed ON scf.traction_snapshots (signed_at) WHERE signed_at IS NOT NULL;  -- daily_seal

-- Signing (C-137): when a row becomes signed (INSERT signed, or UPDATE of a pending row), signed_at defaults to now()
-- and series_seq must be the tenant's next number (1 + the highest so far); a NULL series_seq is filled in. The signing
-- job computes the same number (and the previous row's canonical_sha256) before it signs a v2 document; the unique
-- constraint stops two concurrent signers. Runs as the invoker (the signing job sees its tenant's rows).
CREATE FUNCTION scf.traction_snapshots_sign() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_next integer;
  BEGIN
    IF NEW.signature IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.signature IS NULL) THEN
      NEW.signed_at := COALESCE(NEW.signed_at, now());
      SELECT COALESCE(max(x.series_seq), 0) + 1 INTO v_next FROM scf.traction_snapshots x WHERE x.tenant_id = NEW.tenant_id;
      IF NEW.series_seq IS NULL THEN
        NEW.series_seq := v_next;
      ELSIF NEW.series_seq <> v_next THEN
        RAISE EXCEPTION 'series_seq must be %', v_next USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER traction_snapshots_sign BEFORE INSERT OR UPDATE ON scf.traction_snapshots
  FOR EACH ROW EXECUTE FUNCTION scf.traction_snapshots_sign();

-- Append-only after signing (the public list must never lose or change an entry): a signed document, its request
-- columns (period, preset, schema version) and its place in the series are never changed, a revocation is final
-- (revoked_at and revoked_reason are set once), and a signed row is deleted only by job tenant_purge (C-137). The
-- trigger also binds the superuser; anything that bypasses it shows as a gap in the series.
CREATE FUNCTION scf.traction_snapshots_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      IF OLD.signature IS NOT NULL AND scf.current_job() IS DISTINCT FROM 'tenant_purge' THEN
        RAISE EXCEPTION 'a signed snapshot is never deleted' USING ERRCODE = '42501';
      END IF;
      RETURN OLD;
    END IF;
    IF OLD.signature IS NOT NULL AND (NEW.document IS DISTINCT FROM OLD.document
        OR NEW.canonical_sha256 IS DISTINCT FROM OLD.canonical_sha256 OR NEW.signature IS DISTINCT FROM OLD.signature
        OR NEW.kid IS DISTINCT FROM OLD.kid OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
        OR NEW.methodology_version IS DISTINCT FROM OLD.methodology_version
        OR NEW.series_seq IS DISTINCT FROM OLD.series_seq OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
        OR NEW.preset IS DISTINCT FROM OLD.preset OR NEW.period_start IS DISTINCT FROM OLD.period_start
        OR NEW.period_end IS DISTINCT FROM OLD.period_end OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id) THEN
      RAISE EXCEPTION 'a signed snapshot is never changed' USING ERRCODE = '42501';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
        OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason) THEN
      RAISE EXCEPTION 'a revoked snapshot stays revoked' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER traction_snapshots_guard BEFORE UPDATE OR DELETE ON scf.traction_snapshots
  FOR EACH ROW EXECUTE FUNCTION scf.traction_snapshots_guard();

-- The v2 document needs on-chain counts and open anomaly-flag counts: job public_metrics (which signs) reads them.
DROP POLICY jobs_select ON scf.onchain_daily;
CREATE POLICY jobs_select ON scf.onchain_daily FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['onchain_correlation','trust_scoring','tenant_purge','public_metrics']::text[]));
DROP POLICY jobs_select ON scf.declared_contracts;
CREATE POLICY jobs_select ON scf.declared_contracts FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['contract_verification','onchain_correlation','registry_sync',
                                                  'trust_scoring','tenant_purge','public_metrics']::text[]));
DROP POLICY jobs_select ON scf.trust_annotations;
CREATE POLICY jobs_select ON scf.trust_annotations FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['trust_scoring','tenant_purge','public_metrics']::text[]));
-- daily_seal reads signed snapshots (tenant unset: cross-tenant read, never a write).
DROP POLICY jobs_select ON scf.traction_snapshots;
CREATE POLICY jobs_select ON scf.traction_snapshots FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = ANY (ARRAY['tenant_purge','public_metrics','daily_seal']::text[]));

-- (3) Seal days: one row per network and UTC day, global (no tenant data: hashes, counts and the platform's own
--     sealing account). prev_root is 32 zero bytes for the first day of a network's chain, else the previous day's
--     root (trigger seal_days_chain: the chain grows one day at a time, without gaps). head_path (C-137) = the sibling
--     hashes from the node over leaves 0 and 1 (chain and audit leaf) up to the root, ceil(log2(leaf_count)) - 1 of
--     them, published so anyone can recompute the root from prev_root and the audit-anchor hash alone (wire-formats
--     §m.2). segment (C-137) starts at 1 and increases by one on the first day built after a testnet reset was
--     detected; the chain leaf still holds the previous day's root, so that day's transaction re-anchors every earlier
--     day. The tree is built in memory by job daily_seal; this row is written after the day's leaves and before the
--     transaction is submitted, and makes them final (leaves of a day without a row are provisional).
CREATE TABLE scf.seal_days (
  network              text    NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  day                  date    NOT NULL,
  segment              smallint NOT NULL DEFAULT 1 CHECK (segment >= 1),
  prev_root            bytea   NOT NULL CHECK (octet_length(prev_root) = 32),
  audit_anchor_sha256  bytea   NOT NULL CHECK (octet_length(audit_anchor_sha256) = 32),
  leaf_count           integer NOT NULL CHECK (leaf_count >= 2),
  head_path            bytea[] NOT NULL CHECK (array_position(head_path, NULL) IS NULL),
  root                 bytea   NOT NULL CHECK (octet_length(root) = 32),
  status               text    NOT NULL DEFAULT 'built'
                         CHECK (status IN ('built', 'submitted', 'confirmed', 'failed', 'network_reset')),
  source_account       text    CHECK (source_account ~ '^G[A-Z2-7]{55}$'),     -- the platform sealing account
  tx_hash              bytea   CHECK (octet_length(tx_hash) = 32),
  ledger               bigint  CHECK (ledger > 0),
  built_at             timestamptz NOT NULL DEFAULT now(),
  submitted_at         timestamptz,
  confirmed_at         timestamptz,
  last_checked_at      timestamptz,
  PRIMARY KEY (network, day),
  -- the path of the node over leaves 0 and 1 has ceil(log2(leaf_count)) - 1 = bit length of (leaf_count - 1) - 1 hashes
  CHECK (cardinality(head_path) = 32 - position('1' IN (leaf_count - 1)::bit(32)::text)),
  CHECK (status NOT IN ('confirmed', 'network_reset')
         OR (tx_hash IS NOT NULL AND ledger IS NOT NULL AND source_account IS NOT NULL AND confirmed_at IS NOT NULL))
);
-- The tree of a day never changes once built; only the submission columns move.
CREATE FUNCTION scf.seal_days_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF NEW.network IS DISTINCT FROM OLD.network OR NEW.day IS DISTINCT FROM OLD.day
       OR NEW.segment IS DISTINCT FROM OLD.segment
       OR NEW.prev_root IS DISTINCT FROM OLD.prev_root OR NEW.audit_anchor_sha256 IS DISTINCT FROM OLD.audit_anchor_sha256
       OR NEW.leaf_count IS DISTINCT FROM OLD.leaf_count OR NEW.head_path IS DISTINCT FROM OLD.head_path
       OR NEW.root IS DISTINCT FROM OLD.root OR NEW.built_at IS DISTINCT FROM OLD.built_at THEN
      RAISE EXCEPTION 'a built seal day is never changed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER seal_days_guard BEFORE UPDATE ON scf.seal_days FOR EACH ROW EXECUTE FUNCTION scf.seal_days_guard();
-- Chain continuity (C-137): a new day's prev_root is the previous day's root on that network and its segment is the
-- same or the next; the first row of a network has 32 zero bytes and segment 1; no day may be skipped or inserted
-- before an existing one. Rows are never deleted (no DELETE grant).
CREATE FUNCTION scf.seal_days_chain() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_root bytea; v_segment smallint;
  BEGIN
    SELECT d.root, d.segment INTO v_root, v_segment FROM scf.seal_days d
     WHERE d.network = NEW.network AND d.day = NEW.day - 1;
    IF FOUND THEN
      IF NEW.prev_root IS DISTINCT FROM v_root OR NEW.segment NOT IN (v_segment, v_segment + 1) THEN
        RAISE EXCEPTION 'prev_root or segment does not continue the chain' USING ERRCODE = '23514';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM scf.seal_days d WHERE d.network = NEW.network) THEN
      RAISE EXCEPTION 'seal days are built one day at a time, without gaps' USING ERRCODE = '23514';
    ELSIF NEW.prev_root <> decode(repeat('00', 32), 'hex') OR NEW.segment <> 1 THEN
      RAISE EXCEPTION 'the first day of a chain has a zero prev_root and segment 1' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER seal_days_chain BEFORE INSERT ON scf.seal_days FOR EACH ROW EXECUTE FUNCTION scf.seal_days_chain();
ALTER TABLE scf.seal_days ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.seal_days FORCE ROW LEVEL SECURITY;
GRANT SELECT ON scf.seal_days TO scf_app, scf_metrics_ro, scf_definer;           -- public data (verify page)
GRANT SELECT, INSERT, UPDATE ON scf.seal_days TO scf_jobs;
CREATE POLICY read_all ON scf.seal_days FOR SELECT TO scf_app, scf_metrics_ro, scf_definer USING (true);
CREATE POLICY jobs_seal ON scf.seal_days FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'daily_seal') WITH CHECK ((SELECT scf.current_job()) = 'daily_seal');

-- (4) Seal leaves: one row per sealed snapshot and network, under the snapshot's tenant. leaf_index >= 2 (0 is the
--     chain leaf, 1 the audit leaf, wire-formats §m.2) and unique per day; audit_path = the sibling hashes from the leaf
--     to the root (RFC 9162 §2.1.3), stored so a proof needs no other tenant's row. A leaf is PROVISIONAL until its
--     (network, day) has a seal_days row (C-137): job daily_seal deletes the provisional leaves of a day before it
--     rebuilds that day (an interrupted build), and may never delete a final leaf (trigger seal_leaves_guard). The
--     salt is released only through scf.public_seal_proof(snapshot_id), which serves final leaves only.
CREATE TABLE scf.seal_leaves (
  tenant_id    uuid    NOT NULL,
  snapshot_id  uuid    NOT NULL,
  network      text    NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  day          date    NOT NULL,
  leaf_index   integer NOT NULL CHECK (leaf_index >= 2),
  salt         bytea   NOT NULL CHECK (octet_length(salt) = 32),
  leaf_hash    bytea   NOT NULL CHECK (octet_length(leaf_hash) = 32),
  audit_path   bytea[] NOT NULL CHECK (cardinality(audit_path) BETWEEN 1 AND 64 AND array_position(audit_path, NULL) IS NULL),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, snapshot_id, network),
  UNIQUE (network, day, leaf_index),
  FOREIGN KEY (tenant_id, snapshot_id) REFERENCES scf.traction_snapshots (tenant_id, snapshot_id) ON DELETE CASCADE
);
CREATE FUNCTION scf.seal_leaves_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF scf.current_job() = 'daily_seal'
       AND EXISTS (SELECT 1 FROM scf.seal_days d WHERE d.network = OLD.network AND d.day = OLD.day) THEN
      RAISE EXCEPTION 'a leaf of a built seal day is final' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END $$;
CREATE TRIGGER seal_leaves_guard BEFORE DELETE ON scf.seal_leaves FOR EACH ROW EXECUTE FUNCTION scf.seal_leaves_guard();
CALL scf_admin.apply_tenant_rls('scf.seal_leaves', '{SELECT}', '{}', '{}',
  '{"SELECT":["daily_seal","tenant_purge"],"INSERT":["daily_seal"],"DELETE":["daily_seal","tenant_purge"]}');
GRANT SELECT ON scf.seal_leaves TO scf_definer;
CREATE POLICY definer_public ON scf.seal_leaves FOR SELECT TO scf_definer USING (true);

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('seal.published', 'job daily_seal built, submitted or confirmed a day''s seal (network, day, root; C-136)', '{scf_jobs}');

-- (5) Public read functions (§12): the append-only list of a tenant's signed snapshots (wire-formats §i.3.3) and
--     the inclusion proofs of one snapshot (§m.2). Active and suspended tenants only, like public_snapshot. The list
--     holds every snapshot with a series number (signed from 0065 on), in series order, with the previous entry's hash,
--     so a reader checks that seq runs 1, 2, 3, … and that each previous_sha256 matches (C-137).
CREATE FUNCTION scf.public_snapshot_list(p_slug text)
  RETURNS TABLE (snapshot_id uuid, series_seq integer, previous_sha256 text, schema_version smallint, preset text,
                 period_start timestamptz, period_end timestamptz, signed_at timestamptz, canonical_sha256 text,
                 status text, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT s.snapshot_id, s.series_seq, encode(lag(s.canonical_sha256) OVER (ORDER BY s.series_seq), 'hex'),
         s.schema_version, s.preset, s.period_start, s.period_end, s.signed_at,
         encode(s.canonical_sha256, 'hex'), CASE WHEN s.revoked_at IS NULL THEN 'valid' ELSE 'revoked' END, s.revoked_at
    FROM scf.traction_snapshots s JOIN scf.tenants t ON t.tenant_id = s.tenant_id
   WHERE t.slug = p_slug AND t.status IN ('active', 'suspended') AND s.signature IS NOT NULL
     AND s.series_seq IS NOT NULL
   ORDER BY s.series_seq
  $$;

CREATE FUNCTION scf.public_seal_proof(p_snapshot uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT jsonb_agg(jsonb_build_object(
           'snapshot_id', l.snapshot_id, 'snapshot_sha256', encode(s.canonical_sha256, 'hex'),
           'network', l.network, 'day', l.day, 'segment', d.segment, 'leaf_index', l.leaf_index,
           'leaf_count', d.leaf_count, 'salt', encode(l.salt, 'hex'), 'leaf_hash', encode(l.leaf_hash, 'hex'),
           'audit_path', (SELECT jsonb_agg(encode(x.h, 'hex') ORDER BY x.o)
                            FROM unnest(l.audit_path) WITH ORDINALITY AS x(h, o)),
           'head_path', COALESCE((SELECT jsonb_agg(encode(x.h, 'hex') ORDER BY x.o)
                                    FROM unnest(d.head_path) WITH ORDINALITY AS x(h, o)), '[]'::jsonb),
           'root', encode(d.root, 'hex'), 'prev_root', encode(d.prev_root, 'hex'),
           'audit_anchor_sha256', encode(d.audit_anchor_sha256, 'hex'), 'status', d.status,
           'source_account', d.source_account, 'tx_hash', encode(d.tx_hash, 'hex'), 'ledger', d.ledger,
           'confirmed_at', d.confirmed_at)
         ORDER BY l.network)
    FROM scf.seal_leaves l
    JOIN scf.seal_days d ON d.network = l.network AND d.day = l.day          -- final leaves only (C-137)
    JOIN scf.traction_snapshots s ON s.tenant_id = l.tenant_id AND s.snapshot_id = l.snapshot_id
    JOIN scf.tenants t ON t.tenant_id = l.tenant_id
   WHERE l.snapshot_id = p_snapshot AND t.status IN ('active', 'suspended')
  $$;

REVOKE ALL ON FUNCTION scf.public_snapshot_list(text), scf.public_seal_proof(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.public_snapshot_list(text), scf.public_seal_proof(uuid) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_definer;       -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.public_snapshot_list(text) OWNER TO scf_definer;
ALTER FUNCTION scf.public_seal_proof(uuid)    OWNER TO scf_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;
