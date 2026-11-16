-- Source: docs/data-model.md, block '-- migration: 0069_operator_admin_domain_claims' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0069_operator_admin_domain_claims
-- Wave C1 (audit 2026-11-18, control-plane-portal findings 4–7): database guarantees behind the control plane's checks.
-- (1) GEN-04, C-20: the platform never has fewer than one ACTIVE operator_admin — a grant with role operator_admin, not
--     revoked, of a user neither deleted nor disabled. Every change that takes such a grant away (revoke, demotion,
--     including the INSERT … ON CONFLICT DO UPDATE of a grant; deletion of the row; deleting or disabling the user)
--     takes the transaction-scoped advisory lock 'scf.platform_operators.admin_set' (the control plane takes the same
--     lock before its own check), then counts the remaining active admins and refuses with 23514 when none is left.
--     Concurrent changes are serialised by the lock; the counted rows are also locked (FOR SHARE), so a REPEATABLE READ
--     transaction that missed a concurrent change fails with a serialisation error instead of passing.
GRANT SELECT, UPDATE (revoked_at) ON scf.platform_operators TO scf_definer;   -- UPDATE: only for FOR SHARE
CREATE POLICY definer_select ON scf.platform_operators FOR SELECT TO scf_definer USING (true);
CREATE POLICY definer_lock ON scf.platform_operators FOR UPDATE TO scf_definer USING (true) WITH CHECK (false);
GRANT SELECT (user_id, deleted_at, disabled_at) ON scf.users TO scf_definer;
CREATE POLICY definer_select ON scf.users FOR SELECT TO scf_definer USING (true);

CREATE FUNCTION scf.operator_admin_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_left integer;
  BEGIN
    IF TG_TABLE_NAME = 'users' THEN
      IF NOT EXISTS (SELECT 1 FROM scf.platform_operators o
                      WHERE o.user_id = NEW.user_id AND o.role = 'operator_admin' AND o.revoked_at IS NULL) THEN
        RETURN NULL;                                   -- not an operator_admin: nothing to keep
      END IF;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('scf.platform_operators.admin_set'));
    SELECT count(*) INTO v_left FROM (
      SELECT 1 FROM scf.platform_operators o JOIN scf.users u ON u.user_id = o.user_id
       WHERE o.role = 'operator_admin' AND o.revoked_at IS NULL AND u.deleted_at IS NULL AND u.disabled_at IS NULL
         FOR SHARE OF o) a;
    IF v_left = 0 THEN
      RAISE EXCEPTION 'the last active operator_admin cannot be revoked, demoted, deleted or disabled'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END $$;
REVOKE ALL ON FUNCTION scf.operator_admin_guard() FROM PUBLIC;
CREATE TRIGGER platform_operators_keep_admin AFTER UPDATE ON scf.platform_operators FOR EACH ROW
  WHEN (OLD.role = 'operator_admin' AND OLD.revoked_at IS NULL
        AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.revoked_at IS NOT NULL OR NEW.user_id IS DISTINCT FROM OLD.user_id))
  EXECUTE FUNCTION scf.operator_admin_guard();
CREATE TRIGGER platform_operators_keep_admin_delete AFTER DELETE ON scf.platform_operators FOR EACH ROW
  WHEN (OLD.role = 'operator_admin' AND OLD.revoked_at IS NULL) EXECUTE FUNCTION scf.operator_admin_guard();
CREATE TRIGGER users_keep_admin AFTER UPDATE OF deleted_at, disabled_at ON scf.users FOR EACH ROW
  WHEN ((OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) OR (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL))
  EXECUTE FUNCTION scf.operator_admin_guard();

-- (2) Domain claims (C-19, C-64, §8.4). host_claims is the single owner of a host; these keep site_domains and the
--     ladder evidence consistent with it whatever path changes them:
--   (a) a domain row that becomes 'lapsed' or 'unverified' releases the host claim it holds — the claim moves to another
--       VERIFIED declaration of the same host by the same tenant, else it is deleted — so a lapsed domain never blocks
--       the host's new owner;
--   (b) a deleted domain row lapses the tenant's valid `domain` evidence for that host unless another declaration of
--       the host by the same tenant is still verified (the control plane lapses and audits first; this is the backstop);
--   (c) at commit, every 'verified' row's tenant holds the host's claim: a host without a claim is claimed for that
--       tenant, a host claimed by another tenant fails with 23514, and a claim never moves away from (or is deleted
--       under) a tenant that still has the host verified. So a host never has two verified owners.
GRANT UPDATE (status, lapsed_at) ON scf.verification_evidence TO scf_definer;
CREATE POLICY definer_lapse ON scf.verification_evidence FOR UPDATE TO scf_definer USING (true) WITH CHECK (true);

CREATE FUNCTION scf.site_domains_claim_sync() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_next uuid;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      UPDATE scf.verification_evidence e SET status = 'lapsed', lapsed_at = now()
       WHERE e.tenant_id = OLD.tenant_id AND e.kind = 'domain' AND e.subject = OLD.host AND e.status = 'valid'
         AND NOT EXISTS (SELECT 1 FROM scf.site_domains d
                          WHERE d.tenant_id = OLD.tenant_id AND d.host = OLD.host AND d.state = 'verified');
      RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM scf.host_claims h WHERE h.tenant_id = NEW.tenant_id AND h.domain_id = NEW.domain_id) THEN
      RETURN NULL;
    END IF;
    SELECT d.domain_id INTO v_next FROM scf.site_domains d
     WHERE d.tenant_id = NEW.tenant_id AND d.host = NEW.host AND d.domain_id <> NEW.domain_id AND d.state = 'verified'
     ORDER BY d.created_at, d.domain_id LIMIT 1;
    IF FOUND THEN
      UPDATE scf.host_claims SET domain_id = v_next WHERE tenant_id = NEW.tenant_id AND domain_id = NEW.domain_id;
    ELSE
      DELETE FROM scf.host_claims WHERE tenant_id = NEW.tenant_id AND domain_id = NEW.domain_id;
    END IF;
    RETURN NULL;
  END $$;
REVOKE ALL ON FUNCTION scf.site_domains_claim_sync() FROM PUBLIC;
CREATE TRIGGER site_domains_release_claim AFTER UPDATE OF state ON scf.site_domains FOR EACH ROW
  WHEN (NEW.state IN ('lapsed', 'unverified') AND OLD.state IS DISTINCT FROM NEW.state)
  EXECUTE FUNCTION scf.site_domains_claim_sync();
CREATE TRIGGER site_domains_lapse_evidence AFTER DELETE ON scf.site_domains FOR EACH ROW
  EXECUTE FUNCTION scf.site_domains_claim_sync();

CREATE FUNCTION scf.host_owner_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_tenant uuid; v_host text; v_domain uuid; v_owner uuid;
  BEGIN
    IF TG_TABLE_NAME = 'site_domains' THEN
      -- the row as it is at commit (it may have changed or gone since the event)
      SELECT d.tenant_id, d.host, d.domain_id INTO v_tenant, v_host, v_domain FROM scf.site_domains d
       WHERE d.tenant_id = NEW.tenant_id AND d.domain_id = NEW.domain_id AND d.state = 'verified';
      IF NOT FOUND THEN RETURN NULL; END IF;
    ELSE
      SELECT d.tenant_id, d.host, d.domain_id INTO v_tenant, v_host, v_domain FROM scf.site_domains d
       WHERE d.tenant_id = OLD.tenant_id AND d.host = OLD.host AND d.state = 'verified'
       ORDER BY d.created_at, d.domain_id LIMIT 1;
      IF NOT FOUND THEN RETURN NULL; END IF;
    END IF;
    SELECT h.tenant_id INTO v_owner FROM scf.host_claims h WHERE h.host = v_host FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES (v_host, v_tenant, v_domain)
      ON CONFLICT (host) DO NOTHING;
      SELECT h.tenant_id INTO v_owner FROM scf.host_claims h WHERE h.host = v_host;
    END IF;
    IF v_owner IS DISTINCT FROM v_tenant THEN
      RAISE EXCEPTION 'a verified domain needs its tenant''s host claim; the host has another verified owner'
        USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  END $$;
REVOKE ALL ON FUNCTION scf.host_owner_check() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER site_domains_one_verified_owner AFTER INSERT OR UPDATE ON scf.site_domains
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scf.host_owner_check();
CREATE CONSTRAINT TRIGGER host_claims_one_verified_owner AFTER UPDATE OR DELETE ON scf.host_claims
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scf.host_owner_check();

GRANT CREATE ON SCHEMA scf TO scf_definer;   -- ALTER … OWNER and CREATE OR REPLACE need it; revoked below
ALTER FUNCTION scf.operator_admin_guard()    OWNER TO scf_definer;
ALTER FUNCTION scf.site_domains_claim_sync() OWNER TO scf_definer;
ALTER FUNCTION scf.host_owner_check()        OWNER TO scf_definer;

--   (d) claim_host (job domain_verification): a tenant context only (finding 5, as 0068); a claim whose holder no
--       longer has the host verified or disputed (a lapsed or unverified declaration, or none) is taken over —
--       'claimed'; a second tenant proving a host its holder still has verified makes BOTH sides 'disputed' (§8.4):
--       the caller marks its own declaration, this function the holder's verified ones. Only an SCF operator ends a
--       dispute (op_resolve_domain_dispute, (3)).
GRANT UPDATE (state) ON scf.site_domains TO scf_definer;
CREATE POLICY definer_dispute ON scf.site_domains FOR UPDATE TO scf_definer USING (true) WITH CHECK (true);
SET LOCAL ROLE scf_definer;
CREATE OR REPLACE FUNCTION scf.claim_host(p_host text, p_tenant uuid, p_domain uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_owner uuid;
  BEGIN
    -- current_user is scf_definer here, so scf.current_job() would be NULL: read the GUC (EXECUTE: scf_jobs only).
    IF NULLIF(current_setting('app.job', true), '') IS DISTINCT FROM 'domain_verification'
       OR scf.current_tenant() IS DISTINCT FROM p_tenant OR NOT scf.tenant_ctx_ok() THEN
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
    ELSIF NOT EXISTS (SELECT 1 FROM scf.site_domains d
                       WHERE d.tenant_id = v_owner AND d.host = p_host AND d.state IN ('verified', 'disputed')) THEN
      UPDATE scf.host_claims SET tenant_id = p_tenant, domain_id = p_domain, claimed_at = now() WHERE host = p_host;
      RETURN 'claimed';
    END IF;
    UPDATE scf.site_domains SET state = 'disputed' WHERE tenant_id = v_owner AND host = p_host AND state = 'verified';
    RETURN 'disputed';
  END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;

-- (3) op_resolve_domain_dispute (C-19, finding 6): 'keep' gives the host to the disputed domain's tenant — the claim
--     moves there; the previous holder's verified or disputed declarations of the host become 'unverified', their
--     open verifications end ('failed', HOST_CLAIMED_ELSEWHERE, no further check) and its `domain` evidence lapses;
--     the kept domain becomes 'verified' (verified_at now) with valid `domain` evidence, and its latest verification
--     is re-checked again (daily). 'release' makes the disputed domain 'unverified' (a claim it holds is released by
--     (2a)) and lapses the tenant's `domain` evidence for the host unless another declaration is still verified; when
--     no other tenant disputes the host any more, the claim holder's disputed declarations are 'verified' again. Same
--     signature, owner and grants; a domain that is not disputed is still 'not found' (P0002).
GRANT INSERT, UPDATE ON scf.host_claims TO scf_op_definer;
CREATE POLICY op_definer_insert ON scf.host_claims FOR INSERT TO scf_op_definer WITH CHECK (true);
CREATE POLICY op_definer_update ON scf.host_claims FOR UPDATE TO scf_op_definer USING (true) WITH CHECK (true);
GRANT UPDATE (status, verified_at, last_checked_at, next_check_at, last_result_code) ON scf.domain_verifications TO scf_op_definer;
CREATE POLICY op_definer_update ON scf.domain_verifications FOR UPDATE TO scf_op_definer USING (true) WITH CHECK (true);
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- CREATE OR REPLACE checks it; revoked below
SET LOCAL ROLE scf_op_definer;
CREATE OR REPLACE FUNCTION scf.op_resolve_domain_dispute(p_tenant uuid, p_domain uuid, p_decision text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_host text; v_holder uuid;
  BEGIN
    PERFORM scf.op_authorize(NULL, true);                   -- C-114
    IF p_decision NOT IN ('keep', 'release') THEN RAISE EXCEPTION 'invalid decision' USING ERRCODE = '22023'; END IF;
    PERFORM scf.op_begin('domain.dispute_resolved', NULL, ARRAY[p_tenant],
                         jsonb_build_object('domain_id', p_domain, 'decision', p_decision), true);
    SELECT d.host INTO v_host FROM scf.site_domains d
     WHERE d.tenant_id = p_tenant AND d.domain_id = p_domain AND d.state = 'disputed' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
    SELECT h.tenant_id INTO v_holder FROM scf.host_claims h WHERE h.host = v_host FOR UPDATE;
    IF p_decision = 'release' THEN
      UPDATE scf.site_domains SET state = 'unverified', verified_at = NULL, grace_until = NULL
       WHERE tenant_id = p_tenant AND domain_id = p_domain;
      UPDATE scf.verification_evidence e SET status = 'lapsed', lapsed_at = now()
       WHERE e.tenant_id = p_tenant AND e.kind = 'domain' AND e.subject = v_host AND e.status = 'valid'
         AND NOT EXISTS (SELECT 1 FROM scf.site_domains d
                          WHERE d.tenant_id = p_tenant AND d.host = v_host AND d.state = 'verified');
      IF v_holder IS DISTINCT FROM p_tenant AND v_holder IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM scf.site_domains d
                          WHERE d.host = v_host AND d.state = 'disputed' AND d.tenant_id <> v_holder) THEN
        UPDATE scf.site_domains SET state = 'verified'
         WHERE tenant_id = v_holder AND host = v_host AND state = 'disputed';
      END IF;
      RETURN;
    END IF;
    IF v_holder IS NULL THEN
      INSERT INTO scf.host_claims (host, tenant_id, domain_id) VALUES (v_host, p_tenant, p_domain);
    ELSE
      UPDATE scf.host_claims SET tenant_id = p_tenant, domain_id = p_domain, claimed_at = now() WHERE host = v_host;
      IF v_holder <> p_tenant THEN
        UPDATE scf.domain_verifications v SET status = 'failed', last_result_code = 'HOST_CLAIMED_ELSEWHERE',
               last_checked_at = now(), next_check_at = NULL
         WHERE v.tenant_id = v_holder AND v.status IN ('pending', 'verified')
           AND v.domain_id IN (SELECT d.domain_id FROM scf.site_domains d WHERE d.tenant_id = v_holder AND d.host = v_host);
        UPDATE scf.site_domains SET state = 'unverified', verified_at = NULL, grace_until = NULL
         WHERE tenant_id = v_holder AND host = v_host AND state IN ('verified', 'disputed');
        UPDATE scf.verification_evidence e SET status = 'lapsed', lapsed_at = now()
         WHERE e.tenant_id = v_holder AND e.kind = 'domain' AND e.subject = v_host AND e.status = 'valid';
      END IF;
    END IF;
    UPDATE scf.site_domains SET state = 'verified', verified_at = now(), lapsed_at = NULL, grace_until = NULL
     WHERE tenant_id = p_tenant AND domain_id = p_domain;
    UPDATE scf.domain_verifications v SET status = 'verified', verified_at = COALESCE(v.verified_at, now()),
           next_check_at = now() + interval '1 day'
     WHERE v.tenant_id = p_tenant AND v.verification_id = (
       SELECT x.verification_id FROM scf.domain_verifications x
        WHERE x.tenant_id = p_tenant AND x.domain_id = p_domain AND x.status IN ('verified', 'failed')
        ORDER BY x.created_at DESC, x.verification_id DESC LIMIT 1);
    INSERT INTO scf.verification_evidence (tenant_id, kind, subject, details, created_by, last_checked_at)
    VALUES (p_tenant, 'domain', v_host,
            jsonb_build_object('method', 'operator_dispute_resolution', 'domain_id', p_domain,
                               'operator_user_id', scf.current_actor_user()),
            scf.current_actor_user(), now())
    ON CONFLICT (tenant_id, kind, subject) DO UPDATE
      SET status = 'valid', lapsed_at = NULL, revoked_at = NULL, revoked_by = NULL, last_checked_at = now(),
          details = EXCLUDED.details,
          verified_at = CASE WHEN verification_evidence.status = 'valid' THEN verification_evidence.verified_at ELSE now() END;
  END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
