-- Source: docs/data-model.md, block '-- migration: 0002_context_functions' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0002_context_functions
CREATE FUNCTION scf.current_tenant() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION scf.actor_kind() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(NULLIF(pg_catalog.current_setting('app.actor_kind', true), ''), 'anonymous') $$;
CREATE FUNCTION scf.current_actor() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(pg_catalog.current_setting('app.actor_id', true), '') $$;
CREATE FUNCTION scf.current_actor_user() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN scf.actor_kind() IN ('user', 'operator') THEN scf.current_actor()::uuid END $$;
CREATE FUNCTION scf.platform_role() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN scf.actor_kind() = 'operator'
                    THEN NULLIF(pg_catalog.current_setting('app.platform_role', true), '') END $$;
CREATE FUNCTION scf.current_job() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN pg_catalog.current_user() = 'scf_jobs'
                    THEN NULLIF(pg_catalog.current_setting('app.job', true), '') END $$;
-- A tenant context that is not an SCF-operator or machine-key context (C-17: those use op_* functions only).
CREATE FUNCTION scf.tenant_ctx_ok() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT scf.actor_kind() NOT IN ('operator', 'op_key', 'pub_key', 'anonymous') $$;
-- Cross-tenant reads: named jobs only (C-17). Jobs that act FOR a tenant (erasure, tenant_purge) never read across
-- tenants: they find their work through scf.job_queue() (§12) and then run under that tenant's context (C-87).
CREATE FUNCTION scf.cross_tenant_read_ok() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT scf.current_tenant() IS NULL AND scf.current_job() IS NOT NULL
               AND scf.current_job() NOT IN ('erasure', 'tenant_purge') $$;
-- C-87: sensitive tenant actions need a fresh sign-in (≤ 10 minutes) by the member's own method.
CREATE FUNCTION scf.reauth_fresh() RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(NULLIF(pg_catalog.current_setting('app.reauthenticated_at', true), '')::timestamptz
                        >= pg_catalog.now() - interval '10 minutes', false) $$;

GRANT EXECUTE ON FUNCTION scf.current_tenant(), scf.actor_kind(), scf.current_actor(), scf.current_actor_user(),
  scf.platform_role(), scf.current_job(), scf.tenant_ctx_ok(), scf.cross_tenant_read_ok(), scf.reauth_fresh()
  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro, scf_definer, scf_op_definer;

-- C-103: the ONLY way application code sets its context. Always transaction-local (is_local = true); unset
-- arguments are written as '' so nothing from an earlier transaction on the same pooled backend survives (S-03 X1).
-- Invoker function without a SET clause, so the set_config(…, true) effects last until COMMIT/ROLLBACK.
CREATE FUNCTION scf.set_tenant_ctx(
  p_tenant             uuid,
  p_actor_kind         text,
  p_actor_id           text        DEFAULT NULL,
  p_platform_role      text        DEFAULT NULL,
  p_step_up_at         timestamptz DEFAULT NULL,
  p_reauthenticated_at timestamptz DEFAULT NULL,
  p_key_scopes         text        DEFAULT NULL,
  p_key_tenants        uuid[]      DEFAULT NULL,
  p_job                text        DEFAULT NULL,
  p_request_id         text        DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql VOLATILE
  AS $$
  BEGIN
    IF p_actor_kind IS NULL OR p_actor_kind NOT IN ('user','operator','op_key','pub_key','job','writer','system','anonymous')
       OR COALESCE(p_platform_role, '') NOT IN ('', 'operator', 'operator_admin') THEN
      RAISE EXCEPTION 'invalid context' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_catalog.set_config('app.tenant_id',          COALESCE(p_tenant::text, ''), true),
            pg_catalog.set_config('app.actor_kind',         p_actor_kind, true),
            pg_catalog.set_config('app.actor_id',           COALESCE(p_actor_id, ''), true),
            pg_catalog.set_config('app.platform_role',      COALESCE(p_platform_role, ''), true),
            pg_catalog.set_config('app.step_up_at',         COALESCE(p_step_up_at::text, ''), true),
            pg_catalog.set_config('app.reauthenticated_at', COALESCE(p_reauthenticated_at::text, ''), true),
            pg_catalog.set_config('app.key_scopes',         COALESCE(p_key_scopes, ''), true),
            pg_catalog.set_config('app.key_tenants',        COALESCE(p_key_tenants::text, ''), true),
            pg_catalog.set_config('app.job',                COALESCE(p_job, ''), true),
            pg_catalog.set_config('app.request_id',         COALESCE(p_request_id, ''), true);
  END $$;
REVOKE ALL ON FUNCTION scf.set_tenant_ctx(uuid, text, text, text, timestamptz, timestamptz, text, uuid[], text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.set_tenant_ctx(uuid, text, text, text, timestamptz, timestamptz, text, uuid[], text, text)
  TO scf_app, scf_writer, scf_jobs, scf_metrics_ro;
