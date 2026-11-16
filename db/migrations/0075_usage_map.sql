-- Source: docs/data-model.md, block '-- migration: 0075_usage_map' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0075_usage_map
-- Ecosystem Usage Map (2026-11-19, win wave B; NICE-09 extended to the whole registry): daily on-chain usage of EVERY
-- registry project that lists contract ids (scf.registry_projects.contract_ids, public third-party data), computed by
-- job `usage_map` from the public ledger files (`onchain-reader usage`) — not only of tenants' verified contracts.
-- Figures per project and UTC day (invocations, successful, distinct invokers, contract calls), per contract and day,
-- per contract, function and caller kind (account | contract) and day, and per project and ISO week the weekly active
-- accounts of the SCF Growth Hack definition ("initiated at least one operation"; both readings stored, see
-- services/onchain-reader/README.md "Usage map"). Invoker accounts are counted in the reader's memory and discarded;
-- no table here holds an account.
-- (1) scf.usage_map_days: one row per network and complete UTC day whose day anchor matched Horizon (C-144); every
--     figure of a day references it, so rewriting a day is DELETE of this row (cascade) + INSERT, in one transaction.
-- (2) Visibility. Unclaimed projects: SCF operators only, through scf.op_usage_map / scf.op_usage_map_project (audited,
--     scope registry:read), labelled "public chain data — ownership not verified" by the control plane. A tenant
--     reads (scf_app, RLS, tenant context) only the rows of registry projects it has a CONFIRMED registry link to
--     (claimed through /onboard), and the contract/function rows of contracts those projects list; the tenant's view
--     is exact, footprint verification (declared_contracts.status = 'verified', no conflict) is shown per contract.
--     Never on public pages (no grant to anonymous paths, scf_metrics_ro or public functions).
-- (3) Small-count floor in the operator functions: distinct invokers and active accounts below op_min_count are NULL
--     (C-137, D5). Invocation and call counts are public ledger counts and returned exactly (C-95).
-- (4) Retention: job usage_map deletes days older than 25 months (usage_map_days, cascading) and weeks older than
--     25 months itself; rows of a registry project deleted by retention go with it (FK ON DELETE CASCADE).
CREATE TABLE scf.usage_map_days (
  network        text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  day            date NOT NULL,
  ledgers        integer NOT NULL CHECK (ledgers > 0),
  ledger_first   bigint NOT NULL CHECK (ledger_first > 0),
  ledger_last    bigint NOT NULL,
  anchor_ledger  bigint NOT NULL,
  anchor_hash    text NOT NULL CHECK (anchor_hash ~ '^[0-9a-f]{64}$'),
  anchor_checked boolean NOT NULL,                 -- false only with the check off (testnet development lake)
  projects       integer NOT NULL CHECK (projects >= 0),
  contracts      integer NOT NULL CHECK (contracts >= 0),
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, day),
  CHECK (ledger_first <= ledger_last AND anchor_ledger = ledger_last + 1)
);

CREATE TABLE scf.usage_map_project_daily (
  registry_project_id    uuid NOT NULL REFERENCES scf.registry_projects ON DELETE CASCADE,
  network                text NOT NULL,
  day                    date NOT NULL,
  invocations            bigint NOT NULL CHECK (invocations >= 0),
  successful_invocations bigint NOT NULL CHECK (successful_invocations >= 0),
  distinct_invokers      bigint NOT NULL CHECK (distinct_invokers >= 0),
  contract_calls         bigint NOT NULL CHECK (contract_calls >= 0),
  contracts_listed       integer NOT NULL CHECK (contracts_listed > 0),
  contracts_invoked      integer NOT NULL CHECK (contracts_invoked >= 0),
  PRIMARY KEY (registry_project_id, network, day),
  FOREIGN KEY (network, day) REFERENCES scf.usage_map_days ON DELETE CASCADE,
  CHECK (successful_invocations <= invocations AND distinct_invokers <= invocations
         AND contracts_invoked <= contracts_listed)
);
CREATE INDEX usage_map_project_daily_day ON scf.usage_map_project_daily (network, day);

CREATE TABLE scf.usage_map_project_weekly (
  registry_project_id        uuid NOT NULL REFERENCES scf.registry_projects ON DELETE CASCADE,
  network                    text NOT NULL CHECK (network IN ('mainnet', 'testnet')),
  week_start                 date NOT NULL CHECK (extract(isodow FROM week_start) = 1),   -- ISO week, Monday UTC
  active_accounts            bigint NOT NULL CHECK (active_accounts >= 0),
  active_accounts_successful bigint NOT NULL CHECK (active_accounts_successful >= 0),
  invocations                bigint NOT NULL CHECK (invocations >= 0),
  successful_invocations     bigint NOT NULL CHECK (successful_invocations >= 0),
  contract_calls             bigint NOT NULL CHECK (contract_calls >= 0),
  computed_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (registry_project_id, network, week_start),
  CHECK (active_accounts_successful <= active_accounts AND active_accounts <= invocations
         AND successful_invocations <= invocations)
);

CREATE TABLE scf.usage_map_contract_daily (
  network                   text NOT NULL,
  day                       date NOT NULL,
  contract_id               text NOT NULL CHECK (contract_id ~ '^C[A-Z2-7]{55}$'),
  invocations               bigint NOT NULL CHECK (invocations >= 0),
  successful_invocations    bigint NOT NULL CHECK (successful_invocations >= 0),
  distinct_invokers         bigint NOT NULL CHECK (distinct_invokers >= 0),
  contract_calls            bigint NOT NULL CHECK (contract_calls >= 0),
  successful_contract_calls bigint NOT NULL CHECK (successful_contract_calls >= 0),
  PRIMARY KEY (network, contract_id, day),
  FOREIGN KEY (network, day) REFERENCES scf.usage_map_days ON DELETE CASCADE,
  CHECK (successful_invocations <= invocations AND distinct_invokers <= invocations
         AND successful_contract_calls <= contract_calls)
);
CREATE INDEX usage_map_contract_daily_day ON scf.usage_map_contract_daily (network, day);

CREATE TABLE scf.usage_map_function_daily (
  network          text NOT NULL,
  day              date NOT NULL,
  contract_id      text NOT NULL,
  function_name    text NOT NULL CHECK (function_name ~ '^([A-Za-z0-9_]{1,32}|\(other\)|\(invalid\))$'),
  caller_kind      text NOT NULL CHECK (caller_kind IN ('account', 'contract')),
  calls            bigint NOT NULL CHECK (calls > 0),
  successful_calls bigint NOT NULL CHECK (successful_calls >= 0),
  PRIMARY KEY (network, contract_id, day, function_name, caller_kind),
  FOREIGN KEY (network, contract_id, day) REFERENCES scf.usage_map_contract_daily ON DELETE CASCADE,
  CHECK (successful_calls <= calls)
);

ALTER TABLE scf.usage_map_days ENABLE ROW LEVEL SECURITY;           ALTER TABLE scf.usage_map_days FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.usage_map_project_daily ENABLE ROW LEVEL SECURITY;  ALTER TABLE scf.usage_map_project_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.usage_map_project_weekly ENABLE ROW LEVEL SECURITY; ALTER TABLE scf.usage_map_project_weekly FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.usage_map_contract_daily ENABLE ROW LEVEL SECURITY; ALTER TABLE scf.usage_map_contract_daily FORCE ROW LEVEL SECURITY;
ALTER TABLE scf.usage_map_function_daily ENABLE ROW LEVEL SECURITY; ALTER TABLE scf.usage_map_function_daily FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON scf.usage_map_days, scf.usage_map_project_daily, scf.usage_map_project_weekly,
  scf.usage_map_contract_daily, scf.usage_map_function_daily TO scf_jobs;
GRANT SELECT ON scf.usage_map_days, scf.usage_map_project_daily, scf.usage_map_project_weekly,
  scf.usage_map_contract_daily, scf.usage_map_function_daily TO scf_app, scf_op_definer;

-- Job usage_map: the only writer; it reads the registry's contract lists.
CREATE POLICY jobs_usage_map ON scf.usage_map_days FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'usage_map') WITH CHECK ((SELECT scf.current_job()) = 'usage_map');
CREATE POLICY jobs_usage_map ON scf.usage_map_project_daily FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'usage_map') WITH CHECK ((SELECT scf.current_job()) = 'usage_map');
CREATE POLICY jobs_usage_map ON scf.usage_map_project_weekly FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'usage_map') WITH CHECK ((SELECT scf.current_job()) = 'usage_map');
CREATE POLICY jobs_usage_map ON scf.usage_map_contract_daily FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'usage_map') WITH CHECK ((SELECT scf.current_job()) = 'usage_map');
CREATE POLICY jobs_usage_map ON scf.usage_map_function_daily FOR ALL TO scf_jobs
  USING ((SELECT scf.current_job()) = 'usage_map') WITH CHECK ((SELECT scf.current_job()) = 'usage_map');
CREATE POLICY jobs_usage_map ON scf.registry_projects FOR SELECT TO scf_jobs
  USING ((SELECT scf.current_job()) = 'usage_map');

-- Operator functions (owner scf_op_definer) read everything; they authorise and audit first.
CREATE POLICY op_definer_select ON scf.usage_map_days FOR SELECT TO scf_op_definer USING (true);
CREATE POLICY op_definer_select ON scf.usage_map_project_daily FOR SELECT TO scf_op_definer USING (true);
CREATE POLICY op_definer_select ON scf.usage_map_project_weekly FOR SELECT TO scf_op_definer USING (true);
CREATE POLICY op_definer_select ON scf.usage_map_contract_daily FOR SELECT TO scf_op_definer USING (true);
CREATE POLICY op_definer_select ON scf.usage_map_function_daily FOR SELECT TO scf_op_definer USING (true);

-- Tenants: claimed projects only (a confirmed link of the current tenant; tenant_registry_links is itself tenant-RLS).
CREATE POLICY tenant_days ON scf.usage_map_days FOR SELECT TO scf_app
  USING (scf.tenant_ctx_ok() AND scf.current_tenant() IS NOT NULL);
CREATE POLICY tenant_claimed ON scf.usage_map_project_daily FOR SELECT TO scf_app
  USING (scf.tenant_ctx_ok() AND EXISTS (
    SELECT 1 FROM scf.tenant_registry_links l
     WHERE l.tenant_id = scf.current_tenant() AND l.registry_project_id = usage_map_project_daily.registry_project_id
       AND l.status = 'confirmed'));
CREATE POLICY tenant_claimed ON scf.usage_map_project_weekly FOR SELECT TO scf_app
  USING (scf.tenant_ctx_ok() AND EXISTS (
    SELECT 1 FROM scf.tenant_registry_links l
     WHERE l.tenant_id = scf.current_tenant() AND l.registry_project_id = usage_map_project_weekly.registry_project_id
       AND l.status = 'confirmed'));
CREATE POLICY tenant_claimed ON scf.usage_map_contract_daily FOR SELECT TO scf_app
  USING (scf.tenant_ctx_ok() AND EXISTS (
    SELECT 1 FROM scf.tenant_registry_links l JOIN scf.registry_projects p USING (registry_project_id)
     WHERE l.tenant_id = scf.current_tenant() AND l.status = 'confirmed'
       AND usage_map_contract_daily.contract_id = ANY (p.contract_ids)));
CREATE POLICY tenant_claimed ON scf.usage_map_function_daily FOR SELECT TO scf_app
  USING (scf.tenant_ctx_ok() AND EXISTS (
    SELECT 1 FROM scf.tenant_registry_links l JOIN scf.registry_projects p USING (registry_project_id)
     WHERE l.tenant_id = scf.current_tenant() AND l.status = 'confirmed'
       AND usage_map_function_daily.contract_id = ANY (p.contract_ids)));

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('operator.read.op_usage_map', 'op_* read', '{scf_op_definer}'),
 ('operator.read.op_usage_map_project', 'op_* read', '{scf_op_definer}');

-- Per registry project that lists contracts (and is still listed): the window's totals (days d0 … d1−1, at most 92),
-- the daily invocation series for the sparkline (NULL where the day is not covered), the latest two complete ISO
-- weeks' active accounts, and the claim state: claimed = a confirmed link of a tenant that is not removed, purged or
-- a canary; contracts_verified = listed contracts a claimant holds as a verified footprint item without conflict.
CREATE FUNCTION scf.op_usage_map(p_start timestamptz, p_end timestamptz, p_network text)
  RETURNS TABLE (registry_project_id uuid, contracts_listed integer, days_covered integer, invocations bigint,
                 successful_invocations bigint, contract_calls bigint, peak_daily_invokers bigint,
                 daily_invocations bigint[], week_start date, active_accounts bigint,
                 active_accounts_successful bigint, prev_active_accounts bigint, claimed boolean,
                 contracts_verified integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  #variable_conflict use_column
  DECLARE d0 date; d1 date; v_k integer; v_w date;
  BEGIN
    PERFORM scf.op_authorize('registry:read');                -- C-114: first
    IF p_network IS NULL OR p_network NOT IN ('mainnet', 'testnet') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end, 92) r;
    PERFORM scf.op_begin('operator.read.op_usage_map', 'registry:read', NULL,
                         jsonb_build_object('start', p_start, 'end', p_end, 'network', p_network));
    v_k := GREATEST(COALESCE(scf.setting_int('op_min_count'), 10), 1);
    SELECT max(w.week_start) INTO v_w FROM scf.usage_map_project_weekly w
     WHERE w.network = p_network AND w.week_start + 7 <= d1;
    RETURN QUERY
      WITH p AS (
        SELECT x.registry_project_id AS rp, x.contract_ids
          FROM scf.registry_projects x
         WHERE x.missing_since IS NULL AND cardinality(x.contract_ids) > 0),
      claim AS (
        SELECT l.registry_project_id AS rp, l.tenant_id
          FROM scf.tenant_registry_links l JOIN scf.tenants t ON t.tenant_id = l.tenant_id
         WHERE l.status = 'confirmed' AND t.status IN ('pending', 'active', 'suspended')
           AND t.purged_at IS NULL AND NOT t.is_canary),
      ver AS (
        SELECT c.rp, count(DISTINCT dc.contract_id)::integer AS n
          FROM claim c JOIN p ON p.rp = c.rp
          JOIN scf.declared_contracts dc ON dc.tenant_id = c.tenant_id AND dc.contract_id = ANY (p.contract_ids)
                                        AND dc.status = 'verified' AND dc.removed_at IS NULL
                                        AND dc.conflict_since IS NULL
         GROUP BY c.rp),
      d AS (
        SELECT x.registry_project_id AS rp, count(*)::integer AS n, sum(x.invocations)::bigint AS inv,
               sum(x.successful_invocations)::bigint AS ok, sum(x.contract_calls)::bigint AS calls,
               max(x.distinct_invokers)::bigint AS peak, max(x.contracts_listed) AS listed
          FROM scf.usage_map_project_daily x
         WHERE x.network = p_network AND x.day >= d0 AND x.day < d1
         GROUP BY x.registry_project_id),
      s AS (
        SELECT p.rp, array_agg(x.invocations ORDER BY g.day) AS series
          FROM p CROSS JOIN generate_series(d0, d1 - 1, interval '1 day') g(day)
          LEFT JOIN scf.usage_map_project_daily x
                 ON x.registry_project_id = p.rp AND x.network = p_network AND x.day = g.day::date
         GROUP BY p.rp),
      w AS (
        SELECT x.registry_project_id AS rp,
               max(x.active_accounts) FILTER (WHERE x.week_start = v_w) AS aa,
               max(x.active_accounts_successful) FILTER (WHERE x.week_start = v_w) AS aas,
               max(x.active_accounts) FILTER (WHERE x.week_start = v_w - 7) AS prev
          FROM scf.usage_map_project_weekly x
         WHERE x.network = p_network AND x.week_start IN (v_w, v_w - 7)
         GROUP BY x.registry_project_id)
      SELECT p.rp, COALESCE(d.listed, cardinality(p.contract_ids))::integer, COALESCE(d.n, 0),
             COALESCE(d.inv, 0), COALESCE(d.ok, 0), COALESCE(d.calls, 0),
             CASE WHEN d.peak >= v_k THEN d.peak END,
             s.series,
             CASE WHEN w.rp IS NOT NULL THEN v_w END,
             CASE WHEN w.aa >= v_k THEN w.aa END,
             CASE WHEN w.aas >= v_k THEN w.aas END,
             CASE WHEN w.prev >= v_k THEN w.prev END,
             EXISTS (SELECT 1 FROM claim c WHERE c.rp = p.rp),
             COALESCE(ver.n, 0)
        FROM p
        LEFT JOIN d ON d.rp = p.rp
        LEFT JOIN s ON s.rp = p.rp
        LEFT JOIN w ON w.rp = p.rp
        LEFT JOIN ver ON ver.rp = p.rp
       ORDER BY p.rp;
  END $$;
REVOKE ALL ON FUNCTION scf.op_usage_map(timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_usage_map(timestamptz, timestamptz, text) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_usage_map(timestamptz, timestamptz, text) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;

-- One project's detail over at most 400 days: daily and weekly series, per-contract totals with the claimant's
-- footprint state, and calls per contract, function and caller kind. NULL (not found) for a project that is not
-- listed or lists no contracts. Floors as op_usage_map.
CREATE FUNCTION scf.op_usage_map_project(p_registry_project uuid, p_start timestamptz, p_end timestamptz,
                                         p_network text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE d0 date; d1 date; v_k integer; v_ids text[]; v_doc jsonb;
  BEGIN
    PERFORM scf.op_authorize('registry:read');                -- C-114: first
    IF p_registry_project IS NULL OR p_network IS NULL OR p_network NOT IN ('mainnet', 'testnet') THEN
      RAISE EXCEPTION 'invalid arguments' USING ERRCODE = '22023';
    END IF;
    SELECT r.first_day, r.end_day INTO d0, d1 FROM scf.utc_day_range(p_start, p_end, 400) r;
    PERFORM scf.op_begin('operator.read.op_usage_map_project', 'registry:read', NULL,
                         jsonb_build_object('registry_project_id', p_registry_project, 'start', p_start,
                                            'end', p_end, 'network', p_network));
    SELECT x.contract_ids INTO v_ids FROM scf.registry_projects x
     WHERE x.registry_project_id = p_registry_project AND x.missing_since IS NULL AND cardinality(x.contract_ids) > 0;
    IF v_ids IS NULL THEN
      RETURN NULL;
    END IF;
    v_k := GREATEST(COALESCE(scf.setting_int('op_min_count'), 10), 1);
    SELECT jsonb_build_object(
      'daily', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'day', x.day, 'invocations', x.invocations, 'successful_invocations', x.successful_invocations,
                  'distinct_invokers', CASE WHEN x.distinct_invokers >= v_k THEN x.distinct_invokers END,
                  'contract_calls', x.contract_calls, 'contracts_invoked', x.contracts_invoked,
                  'contracts_listed', x.contracts_listed) ORDER BY x.day)
                FROM scf.usage_map_project_daily x
               WHERE x.registry_project_id = p_registry_project AND x.network = p_network
                 AND x.day >= d0 AND x.day < d1), '[]'::jsonb),
      'weekly', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'week_start', x.week_start,
                  'active_accounts', CASE WHEN x.active_accounts >= v_k THEN x.active_accounts END,
                  'active_accounts_successful',
                    CASE WHEN x.active_accounts_successful >= v_k THEN x.active_accounts_successful END,
                  'invocations', x.invocations, 'successful_invocations', x.successful_invocations,
                  'contract_calls', x.contract_calls) ORDER BY x.week_start)
                FROM scf.usage_map_project_weekly x
               WHERE x.registry_project_id = p_registry_project AND x.network = p_network
                 AND x.week_start >= d0 AND x.week_start + 7 <= d1), '[]'::jsonb),
      'contracts', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'contract_id', c.cid, 'invocations', COALESCE(a.inv, 0),
                  'successful_invocations', COALESCE(a.ok, 0), 'contract_calls', COALESCE(a.calls, 0),
                  'days_active', COALESCE(a.active, 0),
                  'footprint_verified', EXISTS (
                     SELECT 1 FROM scf.tenant_registry_links l
                       JOIN scf.tenants t ON t.tenant_id = l.tenant_id
                       JOIN scf.declared_contracts dc ON dc.tenant_id = l.tenant_id AND dc.contract_id = c.cid
                      WHERE l.registry_project_id = p_registry_project AND l.status = 'confirmed'
                        AND t.status IN ('pending', 'active', 'suspended') AND t.purged_at IS NULL
                        AND NOT t.is_canary AND dc.status = 'verified' AND dc.removed_at IS NULL
                        AND dc.conflict_since IS NULL)) ORDER BY c.cid)
                FROM unnest(v_ids) c(cid)
                LEFT JOIN LATERAL (
                  SELECT sum(x.invocations)::bigint AS inv, sum(x.successful_invocations)::bigint AS ok,
                         sum(x.contract_calls)::bigint AS calls,
                         (count(*) FILTER (WHERE x.invocations + x.contract_calls > 0))::integer AS active
                    FROM scf.usage_map_contract_daily x
                   WHERE x.network = p_network AND x.contract_id = c.cid AND x.day >= d0 AND x.day < d1) a ON true),
               '[]'::jsonb),
      'functions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'contract_id', f.contract_id, 'function', f.function_name, 'caller_kind', f.caller_kind,
                  'calls', f.calls, 'successful_calls', f.ok) ORDER BY f.calls DESC, f.contract_id, f.function_name,
                  f.caller_kind)
                FROM (SELECT x.contract_id, x.function_name, x.caller_kind, sum(x.calls)::bigint AS calls,
                             sum(x.successful_calls)::bigint AS ok
                        FROM scf.usage_map_function_daily x
                       WHERE x.network = p_network AND x.contract_id = ANY (v_ids) AND x.day >= d0 AND x.day < d1
                       GROUP BY x.contract_id, x.function_name, x.caller_kind) f), '[]'::jsonb),
      'days_covered', (SELECT count(*) FROM scf.usage_map_days x
                        WHERE x.network = p_network AND x.day >= d0 AND x.day < d1),
      'claimed', EXISTS (SELECT 1 FROM scf.tenant_registry_links l JOIN scf.tenants t ON t.tenant_id = l.tenant_id
                          WHERE l.registry_project_id = p_registry_project AND l.status = 'confirmed'
                            AND t.status IN ('pending', 'active', 'suspended') AND t.purged_at IS NULL
                            AND NOT t.is_canary))
      INTO v_doc;
    RETURN v_doc;
  END $$;
REVOKE ALL ON FUNCTION scf.op_usage_map_project(uuid, timestamptz, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_usage_map_project(uuid, timestamptz, timestamptz, text) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_usage_map_project(uuid, timestamptz, timestamptz, text) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
