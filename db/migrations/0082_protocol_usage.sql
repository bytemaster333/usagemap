-- Source: docs/data-model.md, block '-- migration: 0082_protocol_usage' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0082_protocol_usage
-- Protocol interactions (integration wave I1, agent Q, 2026-11-19): per UTC day, how many transactions that touch a
-- registry project's listed contracts, or a tenant's verified contracts, also touch the public contracts of a DeFi
-- protocol (Blend, Soroswap, DeFindex, Aquarius, Reflector) — "the protocols your users interact with". Computed by job
-- `protocol_usage` from the public ledger files (`onchain-reader protocols`) against the curated, versioned registry
-- services/jobs/src/onchain/protocols/registry.json; the registry version is stored with every day. A transaction
-- "touches" a contract through its top-level call, its authorization trees or its Soroban footprint (definitions:
-- services/onchain-reader/README.md "Protocol interactions"). Only the protocol label is stored: no contract of the
-- transaction, no account. Counts are public ledger counts (exact, C-95); contracts a protocol creates at run time and
-- the registry does not list are not seen, so every figure is a lower bound.
-- (1) scf.protocol_usage_days: one row per network and complete UTC day whose anchor matched Horizon (C-144); the
--     global figures of a day reference it (rewrite = DELETE cascade + INSERT, one transaction). Tenant rows are
--     rewritten per tenant under its context (no foreign key to the global day: RLS-backstopped tenant rows are never
--     deleted by a cascade from a global table).
-- (2) protocol = 'any' is the row of all transactions touching the subject (the denominator of the share).
-- (3) Visibility: registry projects and network totals to SCF operators only (scf.op_protocol_usage, audited,
--     registry:read); a tenant reads its own rows (scf_app, tenant RLS). Never on public pages.
-- (4) Retention 25 months, by the job itself (global days cascade; tenant rows per tenant); tenant_purge deletes a
--     purged tenant's rows.
CREATE TABLE scf.protocol_usage_days (
  network          text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  day              date NOT NULL,
  ledgers          integer NOT NULL CHECK (ledgers > 0),
  ledger_first     bigint NOT NULL CHECK (ledger_first > 0),
  ledger_last      bigint NOT NULL,
  anchor_ledger    bigint NOT NULL,
  anchor_hash      text NOT NULL CHECK (anchor_hash ~ '^[0-9a-f]{64}$'),
  anchor_checked   boolean NOT NULL,               -- false only with the check off (testnet development lake)
  registry_version text NOT NULL CHECK (registry_version ~ '^\d{4}-\d{2}-\d{2}\.\d{1,3}$'),
  projects         integer NOT NULL CHECK (projects >= 0),
  tenants          integer NOT NULL CHECK (tenants >= 0),
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, day),
  CHECK (ledger_first <= ledger_last AND anchor_ledger = ledger_last + 1)
);

CREATE TABLE scf.protocol_usage_network_daily (
  network                 text NOT NULL,
  day                     date NOT NULL,
  protocol                text NOT NULL CHECK (protocol IN ('blend', 'soroswap', 'defindex', 'aquarius', 'reflector')),
  transactions            bigint NOT NULL CHECK (transactions >= 0),
  successful_transactions bigint NOT NULL CHECK (successful_transactions >= 0),
  PRIMARY KEY (network, day, protocol),
  FOREIGN KEY (network, day) REFERENCES scf.protocol_usage_days ON DELETE CASCADE,
  CHECK (successful_transactions <= transactions)
);

CREATE TABLE scf.protocol_usage_project_daily (
  registry_project_id     uuid NOT NULL REFERENCES scf.registry_projects ON DELETE CASCADE,
  network                 text NOT NULL,
  day                     date NOT NULL,
  protocol                text NOT NULL CHECK (protocol IN ('any', 'blend', 'soroswap', 'defindex', 'aquarius', 'reflector')),
  transactions            bigint NOT NULL CHECK (transactions >= 0),
  successful_transactions bigint NOT NULL CHECK (successful_transactions >= 0),
  PRIMARY KEY (registry_project_id, network, day, protocol),
  FOREIGN KEY (network, day) REFERENCES scf.protocol_usage_days ON DELETE CASCADE,
  CHECK (successful_transactions <= transactions)
);
CREATE INDEX protocol_usage_project_daily_day ON scf.protocol_usage_project_daily (network, day);

CREATE TABLE scf.protocol_usage_tenant_daily (
  tenant_id               uuid NOT NULL REFERENCES scf.tenants,
  network                 text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  day                     date NOT NULL,
  protocol                text NOT NULL CHECK (protocol IN ('any', 'blend', 'soroswap', 'defindex', 'aquarius', 'reflector')),
  transactions            bigint NOT NULL CHECK (transactions >= 0),
  successful_transactions bigint NOT NULL CHECK (successful_transactions >= 0),
  contracts               integer NOT NULL CHECK (contracts > 0),   -- verified contracts counted that day
  registry_version        text NOT NULL CHECK (registry_version ~ '^\d{4}-\d{2}-\d{2}\.\d{1,3}$'),
  computed_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, network, day, protocol),
  CHECK (successful_transactions <= transactions)
);

ALTER TABLE scf.protocol_usage_days ENABLE ROW LEVEL SECURITY;           ALTER TABLE scf.protocol_usage_days FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.protocol_usage_network_daily ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.protocol_usage_network_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.protocol_usage_project_daily ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.protocol_usage_project_daily FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON scf.protocol_usage_days, scf.protocol_usage_network_daily,
  scf.protocol_usage_project_daily TO scf_jobs;
GRANT SELECT ON scf.protocol_usage_days, scf.protocol_usage_network_daily, scf.protocol_usage_project_daily
  TO scf_op_definer;
GRANT SELECT ON scf.protocol_usage_days TO scf_app;

-- Job protocol_usage: the only writer of the global tables.
CREATE POLICY jobs_protocol_usage ON scf.protocol_usage_days FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'protocol_usage') WITH CHECK ((SELECT scf.current_job()) = 'protocol_usage');
CREATE POLICY jobs_protocol_usage ON scf.protocol_usage_network_daily FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'protocol_usage') WITH CHECK ((SELECT scf.current_job()) = 'protocol_usage');
CREATE POLICY jobs_protocol_usage ON scf.protocol_usage_project_daily FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'protocol_usage') WITH CHECK ((SELECT scf.current_job()) = 'protocol_usage');
-- It reads the registry's contract lists and, cross-tenant with the tenant unset, the §p contract list (verified,
-- not removed, no conflict, opted-in tenants that are not removed) — as onchain_correlation.
CREATE POLICY jobs_protocol_usage ON scf.registry_projects FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = 'protocol_usage');
CREATE POLICY jobs_protocol_usage ON scf.declared_contracts FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = 'protocol_usage');
CREATE POLICY jobs_protocol_usage ON scf.tenants FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = 'protocol_usage');

CREATE POLICY op_definer_select ON scf.protocol_usage_days FOR SELECT TO scf_op_definer USING (true);
CREATE POLICY op_definer_select ON scf.protocol_usage_network_daily FOR SELECT TO scf_op_definer USING (true);
CREATE POLICY op_definer_select ON scf.protocol_usage_project_daily FOR SELECT TO scf_op_definer USING (true);
-- A tenant sees which days are covered (no figure in that table belongs to anyone).
CREATE POLICY tenant_days ON scf.protocol_usage_days FOR SELECT TO scf_app
  USING (scf.tenant_ctx_ok() AND scf.current_tenant() IS NOT NULL);

-- Tenant rows: read by the tenant (scf_app), written and pruned by the job under the tenant's context, read by the op
-- functions, deleted by tenant_purge.
CALL scf_admin.apply_tenant_rls('scf.protocol_usage_tenant_daily', '{SELECT}', '{}', '{SELECT}',
  '{"SELECT":["protocol_usage","tenant_purge"],"INSERT":["protocol_usage"],"DELETE":["protocol_usage","tenant_purge"]}');

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('operator.read.op_protocol_usage', 'op_* read', '{scf_op_definer}');

-- Per subject (registry project that lists contracts, or tenant) and protocol: the window's totals (days d0 … d1−1, at
-- most 92) and the days covered; plus one row per protocol with the network totals (subject_kind 'network'). Rows with
-- protocol 'any' are each subject's transactions over all its contracts (the share's denominator).
CREATE FUNCTION scf.op_protocol_usage(p_start timestamptz, p_end timestamptz, p_network text)
  RETURNS TABLE (subject_kind text, subject_id uuid, protocol text, transactions bigint,
                 successful_transactions bigint, days_active integer, days_covered integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE d0 date; d1 date; v_days integer;
  BEGIN
    PERFORM scf.op_authorize('registry:read');                -- C-114: first
    IF p_network IS NULL OR p_network NOT IN ('mainnet', 'testnet') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end, 92) r;
    PERFORM scf.op_begin('operator.read.op_protocol_usage', 'registry:read', NULL,
                         jsonb_build_object('start', p_start, 'end', p_end, 'network', p_network));
    SELECT count(*)::integer INTO v_days FROM scf.protocol_usage_days x
     WHERE x.network = p_network AND x.day >= d0 AND x.day < d1;
    RETURN QUERY
      SELECT 'project'::text, x.registry_project_id, x.protocol, sum(x.transactions)::bigint,
             sum(x.successful_transactions)::bigint, (count(*) FILTER (WHERE x.transactions > 0))::integer, v_days
        FROM scf.protocol_usage_project_daily x
        JOIN scf.registry_projects p ON p.registry_project_id = x.registry_project_id AND p.missing_since IS NULL
       WHERE x.network = p_network AND x.day >= d0 AND x.day < d1
       GROUP BY x.registry_project_id, x.protocol
      UNION ALL
      SELECT 'tenant'::text, x.tenant_id, x.protocol, sum(x.transactions)::bigint,
             sum(x.successful_transactions)::bigint, (count(*) FILTER (WHERE x.transactions > 0))::integer, v_days
        FROM scf.protocol_usage_tenant_daily x
        JOIN scf.tenants t ON t.tenant_id = x.tenant_id AND t.purged_at IS NULL AND NOT t.is_canary
       WHERE x.network = p_network AND x.day >= d0 AND x.day < d1
       GROUP BY x.tenant_id, x.protocol
      UNION ALL
      SELECT 'network'::text, NULL::uuid, x.protocol, sum(x.transactions)::bigint,
             sum(x.successful_transactions)::bigint, (count(*) FILTER (WHERE x.transactions > 0))::integer, v_days
        FROM scf.protocol_usage_network_daily x
       WHERE x.network = p_network AND x.day >= d0 AND x.day < d1
       GROUP BY x.protocol
      ORDER BY 1, 2, 3;
  END $$;
REVOKE ALL ON FUNCTION scf.op_protocol_usage(timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_protocol_usage(timestamptz, timestamptz, text) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_protocol_usage(timestamptz, timestamptz, text) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
