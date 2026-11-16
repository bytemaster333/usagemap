-- Source: docs/data-model.md, block '-- migration: 0061_multiplicity_mode' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0061_multiplicity_mode
-- C-124 (F19): multiplicity mode `enforce` | `shadow` (wire-formats §b.4, §e.3) and the `unknown` thresholds.
-- (1) Platform setting `multiplicity_mode` (default `enforce`), changed by an operator_admin with step-up
--     (operatorUpdateSetting); only the two values are accepted.
INSERT INTO scf.settings (key, value, public, description) VALUES
 ('multiplicity_mode', '"enforce"', true,
  'enforce | shadow: in shadow the gateway counts multiplicity/high_shadow instead of adding multiplicity_high, verdicts unchanged; per-site override sites.multiplicity_mode (C-124)');
ALTER TABLE scf.settings ADD CONSTRAINT settings_multiplicity_mode
  CHECK (key <> 'multiplicity_mode' OR value IN ('"enforce"'::jsonb, '"shadow"'::jsonb));

-- (2) The `unknown` network class is "in no range list" — without eyeball lists nearly every visitor, including
--     carrier-grade NAT and campus gateways — so its defaults equal `eyeball_mobile` (the gateway also floors
--     `unknown` at max(T[unknown], T[eyeball_mobile])): 40 / 160 distinct visitors (identified) and 400 / 1,600
--     page loads (unidentified) per 10 minutes. Only the shipped default is replaced; an operator's own value stays.
UPDATE scf.settings SET value = jsonb_set(jsonb_set(value, '{exact_ip,unknown}', '40'), '{subnet,unknown}', '160')
 WHERE key = 'multiplicity_thresholds' AND value #> '{exact_ip,unknown}' = '6' AND value #> '{subnet,unknown}' = '24';
UPDATE scf.settings SET value = jsonb_set(jsonb_set(value, '{exact_ip,unknown}', '400'), '{subnet,unknown}', '1600')
 WHERE key = 'multiplicity_event_thresholds' AND value #> '{exact_ip,unknown}' = '60' AND value #> '{subnet,unknown}' = '240';

-- (3) Per-site override, NULL = inherit the platform setting. It weakens a bot signal for the site's own figures,
--     so the tenant cannot set it: scf_app keeps UPDATE on every other column (column grants, as for tenants,
--     C-114) and only scf.op_set_site_multiplicity_mode (operator_admin, step-up, audited) writes it.
ALTER TABLE scf.sites ADD COLUMN multiplicity_mode text CHECK (multiplicity_mode IN ('enforce', 'shadow'));
REVOKE UPDATE ON scf.sites FROM scf_app;
GRANT UPDATE (name, tracker_profile, visitor_id, visitor_id_off_countries, visitor_id_explicit, exclude_countries,
              anonymous_reports, path_folding, event_retention_days, opt_out_page_url, umami_twin_website_id,
              status, archived_at) ON scf.sites TO scf_app;

INSERT INTO scf.audit_actions (action, description, writers) VALUES
 ('site.multiplicity_mode_set', 'SCF operator set or cleared a site''s multiplicity mode (C-124)', '{scf_op_definer}');

CREATE FUNCTION scf.op_set_site_multiplicity_mode(p_tenant uuid, p_site uuid, p_mode text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  DECLARE v_old text;
  BEGIN
    PERFORM scf.op_authorize(NULL, true, true);             -- C-114: first; operator_admin with step-up
    IF p_mode IS NOT NULL AND p_mode NOT IN ('enforce', 'shadow') THEN
      RAISE EXCEPTION 'invalid mode' USING ERRCODE = '22023';
    END IF;
    SELECT s.multiplicity_mode INTO v_old FROM scf.sites s
     WHERE s.tenant_id = p_tenant AND s.site_id = p_site AND s.status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002'; END IF;
    PERFORM scf.op_begin('site.multiplicity_mode_set', NULL, ARRAY[p_tenant],
                         jsonb_build_object('site_id', p_site, 'from', v_old, 'to', p_mode), true, true);
    UPDATE scf.sites SET multiplicity_mode = p_mode WHERE tenant_id = p_tenant AND site_id = p_site;
    PERFORM pg_notify('scf_edge', p_tenant::text);          -- edge snapshot rebuild
    -- the effective mode: the override, else the platform setting, else enforce (wire-formats §b.4)
    RETURN COALESCE(p_mode, (SELECT value #>> '{}' FROM scf.settings WHERE key = 'multiplicity_mode'), 'enforce');
  END $$;
REVOKE ALL ON FUNCTION scf.op_set_site_multiplicity_mode(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scf.op_set_site_multiplicity_mode(uuid, uuid, text) TO scf_app;
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- ALTER … OWNER needs it; revoked below
ALTER FUNCTION scf.op_set_site_multiplicity_mode(uuid, uuid, text) OWNER TO scf_op_definer;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
