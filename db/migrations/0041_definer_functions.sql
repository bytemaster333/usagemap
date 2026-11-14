-- Source: docs/data-model.md, block '-- migration: 0041_definer_functions' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0041_definer_functions
CREATE FUNCTION scf.claim_host(p_host text, p_tenant uuid, p_domain uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_owner uuid;
  BEGIN
    -- current_user is scf_definer here, so scf.current_job() would be NULL: read the GUC (EXECUTE: scf_jobs only).
    IF NULLIF(current_setting('app.job', true), '') IS DISTINCT FROM 'domain_verification'
       OR scf.current_tenant() IS DISTINCT FROM p_tenant THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM scf.enrollment_tombstones z WHERE z.kind = 'host' AND z.subject = p_host
                AND z.lifted_at IS NULL AND z.tenant_id <> p_tenant) THEN
      RETURN 'tombstoned';
    END IF;
    SELECT h.tenant_id INTO v_owner FROM scf.host_claims h WHERE h.host = p_host FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES (p_host, p_tenant, p_domain);
      RETURN 'claimed';
    ELSIF v_owner = p_tenant THEN
      RETURN 'already_yours';
    END IF;
    RETURN 'disputed';
  END $$;

-- C-87: jobs that act for a tenant learn only which tenant and item to work on, then switch to that tenant's
-- context. Called with app.tenant_id unset and app.job = p_job.
CREATE FUNCTION scf.job_queue(p_job text) RETURNS TABLE (tenant_id uuid, item_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF NULLIF(current_setting('app.job', true), '') IS DISTINCT FROM p_job OR scf.current_tenant() IS NOT NULL THEN
      RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
    END IF;
    IF p_job = 'erasure' THEN
      RETURN QUERY SELECT e.tenant_id, e.request_id FROM scf.erasure_requests e
                    WHERE e.status IN ('previewing', 'confirmed') ORDER BY e.created_at LIMIT 100;
    ELSIF p_job = 'tenant_purge' THEN
      RETURN QUERY SELECT t.tenant_id, t.tenant_id FROM scf.tenants t
                    WHERE t.status = 'removed' AND t.purged_at IS NULL AND t.purge_after <= now()
                    ORDER BY t.purge_after LIMIT 100;
    ELSE
      RAISE EXCEPTION 'no queue for job %', p_job USING ERRCODE = '22023';
    END IF;
  END $$;

CREATE FUNCTION scf.release_host(p_host text, p_tenant uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF scf.current_tenant() IS DISTINCT FROM p_tenant THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
    DELETE FROM scf.host_claims WHERE host = p_host AND tenant_id = p_tenant;
  END $$;

-- C-114: called by the control plane BEFORE it deletes a site_domains row. A claim held by that row would otherwise
-- go with it (FK ON DELETE CASCADE) although another site of the same tenant may still declare the host: the claim
-- moves to that remaining declaration (verified first, then the oldest) or, when there is none, is released.
-- Returns 'moved', 'released' or 'none' (the row holds no claim). Caller: scf_app (or scf_jobs) under p_tenant.
GRANT SELECT ON scf.site_domains TO scf_definer;
CREATE POLICY definer_select ON scf.site_domains FOR SELECT TO scf_definer USING (true);
CREATE FUNCTION scf.release_domain_claim(p_tenant uuid, p_domain uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_host text; v_next uuid;
  BEGIN
    IF scf.current_tenant() IS DISTINCT FROM p_tenant THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
    SELECT h.host INTO v_host FROM scf.host_claims h WHERE h.tenant_id = p_tenant AND h.domain_id = p_domain FOR UPDATE;
    IF NOT FOUND THEN RETURN 'none'; END IF;
    SELECT d.domain_id INTO v_next FROM scf.site_domains d
     WHERE d.tenant_id = p_tenant AND d.host = v_host AND d.domain_id <> p_domain
     ORDER BY (d.state = 'verified') DESC, d.created_at, d.domain_id LIMIT 1;
    IF FOUND THEN
      UPDATE scf.host_claims SET domain_id = v_next WHERE host = v_host;
      RETURN 'moved';
    END IF;
    DELETE FROM scf.host_claims WHERE host = v_host;
    RETURN 'released';
  END $$;

CREATE FUNCTION scf.is_tombstoned(p_kind text, p_subject text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM scf.enrollment_tombstones z
                        WHERE z.kind = p_kind AND z.subject = p_subject AND z.lifted_at IS NULL) $$;

CREATE FUNCTION scf.accept_invitation(p_code_hash bytea, p_user uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_inv record;
  BEGIN
    IF scf.current_actor_user() IS DISTINCT FROM p_user THEN RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501'; END IF;
    -- C-114: only a tenant that is active or pending takes new members (not suspended, removed or purged).
    SELECT i.* INTO v_inv FROM scf.tenant_invitations i JOIN scf.tenants t ON t.tenant_id = i.tenant_id
     WHERE i.code_hash = p_code_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
       AND t.status IN ('active', 'pending') AND t.purged_at IS NULL
     FOR UPDATE OF i;
    IF NOT FOUND THEN RETURN NULL; END IF;
    INSERT INTO scf.memberships (tenant_id, user_id, role, added_by) VALUES (v_inv.tenant_id, p_user, v_inv.role, v_inv.created_by)
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
    UPDATE scf.tenant_invitations SET accepted_by = p_user, accepted_at = now()
     WHERE tenant_id = v_inv.tenant_id AND invitation_id = v_inv.invitation_id;
    RETURN v_inv.tenant_id;     -- caller then writes 'invitation.accepted' under that tenant context
  END $$;

CREATE FUNCTION scf.lookup_share_key(p_key_id text)
  RETURNS TABLE (tenant_id uuid, secret_hash bytea, pepper_version smallint, usable boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT k.tenant_id, k.secret_hash, k.pepper_version,
               (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()))
          FROM scf.share_keys k WHERE k.key_id = p_key_id $$;

CREATE FUNCTION scf.public_snapshot(p_snapshot uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT jsonb_build_object('snapshot', s.document,
           'signature', jsonb_build_object('alg', 'Ed25519', 'kid', s.kid,
                                           'sig', rtrim(translate(encode(s.signature, 'base64'), E'+/\n', '-_'), '=')),
           'status', CASE WHEN s.revoked_at IS NULL THEN 'valid' ELSE 'revoked' END,
           'revoked_at', s.revoked_at)
    FROM scf.traction_snapshots s JOIN scf.tenants t ON t.tenant_id = s.tenant_id
   WHERE s.snapshot_id = p_snapshot AND t.status IN ('active', 'suspended')
  $$;

-- p_share_tenant: tenant id resolved from a verified pub key (NULL = anonymous request). Active tenants only, like
-- op_metrics_document: pending, suspended and removed tenants answer 404 (C-94).
CREATE FUNCTION scf.public_metrics_document(p_slug text, p_share_tenant uuid DEFAULT NULL) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT d.document FROM scf.public_metrics_documents d JOIN scf.tenants t ON t.tenant_id = d.tenant_id
   WHERE t.slug = p_slug AND t.status = 'active'
     AND (t.public_stats_enabled OR t.tenant_id = p_share_tenant)
  $$;

GRANT CREATE ON SCHEMA scf TO scf_definer;       -- ALTER … OWNER needs it; revoked below
REVOKE ALL ON FUNCTION scf.claim_host(text, uuid, uuid), scf.job_queue(text), scf.release_host(text, uuid),
  scf.release_domain_claim(uuid, uuid),
  scf.is_tombstoned(text, text), scf.accept_invitation(bytea, uuid), scf.lookup_share_key(text),
  scf.public_snapshot(uuid), scf.public_metrics_document(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.claim_host(text, uuid, uuid), scf.job_queue(text) TO scf_jobs;
GRANT EXECUTE ON FUNCTION scf.release_host(text, uuid), scf.release_domain_claim(uuid, uuid), scf.is_tombstoned(text, text)
  TO scf_app, scf_jobs;
GRANT EXECUTE ON FUNCTION scf.accept_invitation(bytea, uuid), scf.lookup_share_key(text), scf.public_snapshot(uuid),
  scf.public_metrics_document(text, uuid) TO scf_app;
-- C-114: owners last — once a function belongs to scf_definer, the migrator (no INHERIT) can no longer grant on it.
ALTER FUNCTION scf.claim_host(text, uuid, uuid)            OWNER TO scf_definer;
ALTER FUNCTION scf.job_queue(text)                         OWNER TO scf_definer;
ALTER FUNCTION scf.release_host(text, uuid)                OWNER TO scf_definer;
ALTER FUNCTION scf.release_domain_claim(uuid, uuid)        OWNER TO scf_definer;
ALTER FUNCTION scf.is_tombstoned(text, text)               OWNER TO scf_definer;
ALTER FUNCTION scf.accept_invitation(bytea, uuid)          OWNER TO scf_definer;
ALTER FUNCTION scf.lookup_share_key(text)                  OWNER TO scf_definer;
ALTER FUNCTION scf.public_snapshot(uuid)                   OWNER TO scf_definer;
ALTER FUNCTION scf.public_metrics_document(text, uuid)     OWNER TO scf_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;
