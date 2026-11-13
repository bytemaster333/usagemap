-- Source: docs/data-model.md, block '-- migration: 0005_types' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0005_types
CREATE TYPE scf.tenant_status   AS ENUM ('pending', 'active', 'suspended', 'removed');
CREATE TYPE scf.tenant_role     AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE scf.platform_role   AS ENUM ('operator', 'operator_admin');
CREATE TYPE scf.identity_provider AS ENUM ('github', 'stellar');
CREATE TYPE scf.tracker_profile AS ENUM ('standard', 'strict');
CREATE TYPE scf.domain_method   AS ENUM ('dns_txt', 'well_known', 'meta_tag');
CREATE TYPE scf.domain_verification_status AS ENUM ('pending', 'verified', 'failed', 'expired', 'lapsed');
CREATE TYPE scf.evidence_kind   AS ENUM ('domain', 'stellar_account', 'registry_match', 'operator_approval');
CREATE TYPE scf.evidence_status AS ENUM ('valid', 'lapsed', 'revoked');
CREATE TYPE scf.metric_source   AS ENUM ('sdk_metric', 'span_derived');
CREATE TYPE scf.stream_kind     AS ENUM ('sdk_stable', 'sdk_legacy', 'span_derived');
CREATE TYPE scf.hist_kind       AS ENUM ('explicit15', 'exp3');
CREATE TYPE scf.web_variant     AS ENUM ('verified', 'raw');
CREATE TYPE scf.web_dimension   AS ENUM ('referrer', 'country', 'device', 'browser', 'os', 'path', 'event');
CREATE TYPE scf.erasure_status  AS ENUM ('previewing', 'previewed', 'confirmed', 'running', 'completed', 'failed', 'cancelled');

-- C-86: validate a range over daily data (start inclusive, end exclusive, both midnight UTC) and return the dates.
CREATE FUNCTION scf.utc_day_range(p_start timestamptz, p_end timestamptz, p_max_days integer DEFAULT 3660)
  RETURNS TABLE (first_day date, end_day date) LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF p_start IS NULL OR p_end IS NULL OR p_end <= p_start
       OR date_trunc('day', p_start, 'UTC') <> p_start OR date_trunc('day', p_end, 'UTC') <> p_end
       OR p_end - p_start > make_interval(days => p_max_days) THEN
      RAISE EXCEPTION 'invalid range: start/end must be midnight UTC, end > start, at most % days', p_max_days
        USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT (p_start AT TIME ZONE 'UTC')::date, (p_end AT TIME ZONE 'UTC')::date;
  END $$;
GRANT EXECUTE ON FUNCTION scf.utc_day_range(timestamptz, timestamptz, integer) TO scf_app, scf_jobs, scf_op_definer;
