-- Source: docs/data-model.md, block '-- migration: 0067_website_ids_column_guards' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0067_website_ids_column_guards
-- Wave C1 (audit 2026-11-18, database-isolation findings 1–4).
-- (1) Finding 1: an Umami website id is the only link between a site and its events in Umami (rollup through scf_ro,
--     erasure, retention), so it is unique across BOTH id columns of scf.sites and across all tenants. Every main and
--     twin id has one row in scf.umami_websites (primary key website_id), written only by the trigger below (owner
--     scf_definer; no runtime role has any privilege on the table): an id already used by any site, as main or twin,
--     of any tenant, is refused with 23505. The main id never changes (no UPDATE grant); a twin id is set once
--     (NULL → id) and never changes afterwards; a site's tenant_id and site_id never change.
CREATE TABLE scf.umami_websites (
  website_id  uuid PRIMARY KEY,                     -- global: the table exists to make the id unique (§15 G9 allow-list)
  tenant_id   uuid NOT NULL,
  site_id     uuid NOT NULL,
  variant     text NOT NULL CHECK (variant IN ('main', 'twin')),
  UNIQUE (tenant_id, site_id, variant),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE
);
CALL scf_admin.apply_tenant_rls('scf.umami_websites');
GRANT SELECT, INSERT ON scf.umami_websites TO scf_definer;
CREATE POLICY definer_ids ON scf.umami_websites FOR ALL TO scf_definer USING (true) WITH CHECK (true);

CREATE FUNCTION scf.sites_umami_websites() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
         OR NEW.umami_website_id IS DISTINCT FROM OLD.umami_website_id
         OR (OLD.umami_twin_website_id IS NOT NULL
             AND NEW.umami_twin_website_id IS DISTINCT FROM OLD.umami_twin_website_id) THEN
        RAISE EXCEPTION 'a site''s Umami website ids never change' USING ERRCODE = '42501';
      END IF;
      IF OLD.umami_twin_website_id IS NULL AND NEW.umami_twin_website_id IS NOT NULL THEN
        INSERT INTO scf.umami_websites (website_id, tenant_id, site_id, variant)
        VALUES (NEW.umami_twin_website_id, NEW.tenant_id, NEW.site_id, 'twin');
      END IF;
      RETURN NULL;
    END IF;
    INSERT INTO scf.umami_websites (website_id, tenant_id, site_id, variant)
    VALUES (NEW.umami_website_id, NEW.tenant_id, NEW.site_id, 'main');
    IF NEW.umami_twin_website_id IS NOT NULL THEN
      INSERT INTO scf.umami_websites (website_id, tenant_id, site_id, variant)
      VALUES (NEW.umami_twin_website_id, NEW.tenant_id, NEW.site_id, 'twin');
    END IF;
    RETURN NULL;
  END $$;
REVOKE ALL ON FUNCTION scf.sites_umami_websites() FROM PUBLIC;
CREATE TRIGGER sites_umami_websites AFTER INSERT OR UPDATE OF tenant_id, site_id, umami_website_id, umami_twin_website_id
  ON scf.sites FOR EACH ROW EXECUTE FUNCTION scf.sites_umami_websites();

-- Existing sites: one row per id (a collision that already exists makes this migration fail, which is the point).
GRANT SELECT (tenant_id, site_id, umami_website_id, umami_twin_website_id) ON scf.sites TO scf_definer;
CREATE POLICY definer_backfill ON scf.sites FOR SELECT TO scf_definer USING (true);
SET LOCAL ROLE scf_definer;
INSERT INTO scf.umami_websites (website_id, tenant_id, site_id, variant)
  SELECT s.umami_website_id, s.tenant_id, s.site_id, 'main' FROM scf.sites s
  UNION ALL
  SELECT s.umami_twin_website_id, s.tenant_id, s.site_id, 'twin' FROM scf.sites s WHERE s.umami_twin_website_id IS NOT NULL;
RESET ROLE;
DROP POLICY definer_backfill ON scf.sites;
REVOKE SELECT (tenant_id, site_id, umami_website_id, umami_twin_website_id) ON scf.sites FROM scf_definer;

GRANT CREATE ON SCHEMA scf TO scf_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.sites_umami_websites() OWNER TO scf_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_definer;

-- (2) Finding 3: the INSERT twin of 0061's column guard. scf_app inserts only the columns the control plane's
--     createSite writes; multiplicity_mode (operator_admin only, C-124), twin_provisioned_at (umami_reconcile),
--     status, archived_at, debug_until and created_at take their defaults.
REVOKE INSERT ON scf.sites FROM scf_app;
GRANT INSERT (tenant_id, site_id, name, site_key, umami_website_id, umami_twin_website_id, tracker_profile, visitor_id,
              visitor_id_off_countries, visitor_id_explicit, exclude_countries, anonymous_reports, path_folding,
              event_retention_days, opt_out_page_url, created_by, dev_origins) ON scf.sites TO scf_app;

-- (3) Finding 2: the trust signals of the verification ladder (ADR-0015) are written by the verifying job or the
--     audited operator path only, never by the internet-facing control plane under the tenant's own context.
-- (3a) Domains: scf_app declares a host and deletes a declaration; state, verified_at, lapsed_at and grace_until
--      belong to job domain_verification and op_resolve_domain_dispute; host and site_id never change.
REVOKE INSERT, UPDATE ON scf.site_domains FROM scf_app;
GRANT INSERT (tenant_id, domain_id, site_id, host, include_subdomains) ON scf.site_domains TO scf_app;
DROP POLICY app_update ON scf.site_domains;

-- (3b) Evidence: scf_app writes stellar_account evidence (the SEP-53/SEP-10 proof is checked in the control plane,
--      §8.5) and may only lapse or revoke any other kind; job domain_verification writes only `domain`, job
--      registry_sync only `registry_match`; operator_approval only through op_approve_tenant_evidence (scf_op_definer).
CREATE FUNCTION scf.verification_evidence_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_kind text;
  BEGIN
    IF current_user = 'scf_app' THEN
      IF NEW.kind = 'stellar_account' AND (TG_OP = 'INSERT' OR OLD.kind = 'stellar_account') THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'UPDATE' AND NEW.tenant_id = OLD.tenant_id AND NEW.kind = OLD.kind AND NEW.subject = OLD.subject
         AND NEW.details = OLD.details AND NEW.verified_at = OLD.verified_at
         AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
         AND (NEW.status = OLD.status OR NEW.status <> 'valid') THEN
        RETURN NEW;                                   -- lapse / revoke only
      END IF;
      RAISE EXCEPTION 'verification evidence of kind % is not written by the control plane', NEW.kind
        USING ERRCODE = '42501';
    ELSIF current_user = 'scf_jobs' THEN
      v_kind := CASE scf.current_job() WHEN 'domain_verification' THEN 'domain' WHEN 'registry_sync' THEN 'registry_match' END;
      IF v_kind IS NULL OR NEW.kind::text <> v_kind OR (TG_OP = 'UPDATE' AND OLD.kind::text <> v_kind) THEN
        RAISE EXCEPTION 'job % does not write % evidence', scf.current_job(), NEW.kind USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER verification_evidence_guard BEFORE INSERT OR UPDATE ON scf.verification_evidence
  FOR EACH ROW EXECUTE FUNCTION scf.verification_evidence_guard();

-- (3c) Contracts: scf_app declares (request columns only), re-declares, removes and asks for a re-check; it may reset
--      the verification columns (status 'declared', the others NULL) but never set them; contract_id and network never
--      change. Job contract_verification and op_footprint_reject write the verification.
REVOKE INSERT, UPDATE ON scf.declared_contracts FROM scf_app;
GRANT INSERT (tenant_id, contract_ref, contract_id, network, label, service_id, created_by)
  ON scf.declared_contracts TO scf_app;
GRANT UPDATE (label, service_id, status, verified_role, verified_by_evidence, verified_at, last_checked_at, created_by,
              created_at, removed_at, verification_method, rejected_reason, next_check_at, conflict_since)
  ON scf.declared_contracts TO scf_app;
CREATE FUNCTION scf.declared_contracts_app_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF current_user = 'scf_app' AND (
         (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'declared')
      OR (NEW.verified_role IS DISTINCT FROM OLD.verified_role AND NEW.verified_role IS NOT NULL)
      OR (NEW.verified_by_evidence IS DISTINCT FROM OLD.verified_by_evidence AND NEW.verified_by_evidence IS NOT NULL)
      OR (NEW.verified_at IS DISTINCT FROM OLD.verified_at AND NEW.verified_at IS NOT NULL)
      OR (NEW.verification_method IS DISTINCT FROM OLD.verification_method AND NEW.verification_method IS NOT NULL)
      OR (NEW.rejected_reason IS DISTINCT FROM OLD.rejected_reason AND NEW.rejected_reason IS NOT NULL)
      OR (NEW.conflict_since IS DISTINCT FROM OLD.conflict_since AND NEW.conflict_since IS NOT NULL)) THEN
      RAISE EXCEPTION 'contract verification is written by job contract_verification only' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER declared_contracts_app_guard BEFORE UPDATE ON scf.declared_contracts
  FOR EACH ROW EXECUTE FUNCTION scf.declared_contracts_app_guard();

-- (4) Finding 4 (C-87): deleting the owner's membership, or inserting an owner into a tenant that already has
--     members, needs a fresh sign-in like the role change of memberships_owner_reauth; otherwise delete + insert
--     would transfer ownership without one. The owner row of a tenant being created (no member yet) needs none.
--     Job tenant_purge (scf_jobs) is not affected.
CREATE FUNCTION scf.memberships_owner_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF current_user = 'scf_app' AND scf.actor_kind() = 'user' AND NOT scf.reauth_fresh()
       AND (TG_OP = 'DELETE' OR EXISTS (SELECT 1 FROM scf.memberships m WHERE m.tenant_id = NEW.tenant_id)) THEN
      RAISE EXCEPTION 'fresh sign-in required (memberships.%)', TG_OP USING ERRCODE = '42501';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END $$;
CREATE TRIGGER memberships_owner_insert_reauth BEFORE INSERT ON scf.memberships FOR EACH ROW
  WHEN (NEW.role = 'owner') EXECUTE FUNCTION scf.memberships_owner_guard();
CREATE TRIGGER memberships_owner_delete_reauth BEFORE DELETE ON scf.memberships FOR EACH ROW
  WHEN (OLD.role = 'owner') EXECUTE FUNCTION scf.memberships_owner_guard();
