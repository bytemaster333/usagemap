-- Source: docs/data-model.md, block '-- migration: 0054_op_tenant_detail_events_today' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0054_op_tenant_detail_events_today
-- C-119: every site in op_tenant_detail carries `verified_events_today`, the per-site quota counter of §8.9
-- (web_edge_counters, counter 'verdict', label 'verified', current UTC day; 0 without a row) — the figure the tenant's
-- own site view shows as limits.verified_events_today. Same signature and audit row; replaced by its owner.
GRANT CREATE ON SCHEMA scf TO scf_op_definer;   -- CREATE OR REPLACE checks it; revoked below
SET LOCAL ROLE scf_op_definer;
CREATE OR REPLACE FUNCTION scf.op_tenant_detail(p_tenant uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
  BEGIN
    IF scf.actor_kind() <> 'operator' THEN RAISE EXCEPTION 'SCF operator required' USING ERRCODE = '42501'; END IF;
    PERFORM scf.op_begin('operator.read.op_tenant_detail', NULL, ARRAY[p_tenant], '{}'::jsonb);
    RETURN (
      SELECT jsonb_build_object(
        'tenant', to_jsonb(t) - 'status_changed_by',
        'verification_level', scf.verification_level(t.tenant_id),
        'members', (SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role,
                      'display_name', u.display_name, 'added_at', m.added_at) ORDER BY m.added_at), '[]')
                      FROM scf.memberships m JOIN scf.users u ON u.user_id = m.user_id WHERE m.tenant_id = t.tenant_id),
        'sites', (SELECT COALESCE(jsonb_agg((to_jsonb(s) - 'umami_website_id' - 'umami_twin_website_id')
                      || jsonb_build_object('effective_event_retention_days',
                           LEAST(COALESCE(s.event_retention_days, 395), scf.setting_int('web_event_retention_days')),
                         -- C-119: the quota counter of §8.9 for the current UTC day (verdict/verified)
                         'verified_events_today',
                           (SELECT COALESCE(sum(c.count), 0) FROM scf.web_edge_counters c
                             WHERE c.tenant_id = s.tenant_id AND c.site_id = s.site_id
                               AND c.day = (now() AT TIME ZONE 'UTC')::date
                               AND c.counter = 'verdict' AND c.label = 'verified'))
                    ORDER BY s.created_at), '[]')
                    FROM scf.sites s WHERE s.tenant_id = t.tenant_id),
        'domains', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.created_at), '[]')
                      FROM scf.site_domains d WHERE d.tenant_id = t.tenant_id),
        'services', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.registered_at), '[]')
                       FROM scf.api_services a WHERE a.tenant_id = t.tenant_id),
        'evidence', (SELECT COALESCE(jsonb_agg(to_jsonb(v) ORDER BY v.verified_at), '[]')
                       FROM scf.verification_evidence v WHERE v.tenant_id = t.tenant_id),
        'registry_links', (SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]')
                             FROM scf.tenant_registry_links r WHERE r.tenant_id = t.tenant_id),
        'ingest_tokens', (SELECT COALESCE(jsonb_agg(to_jsonb(i) - 'secret_hash' ORDER BY i.created_at), '[]')
                            FROM scf.ingest_tokens i WHERE i.tenant_id = t.tenant_id),
        'erasure_requests', (SELECT COALESCE(jsonb_agg(jsonb_build_object('request_id', x.request_id,
                                'scope', x.scope, 'status', x.status, 'created_at', x.created_at) ORDER BY x.created_at), '[]')
                               FROM scf.erasure_requests x
                              WHERE x.tenant_id = t.tenant_id AND x.status IN ('previewing', 'previewed', 'confirmed', 'running')),
        'annotations', (SELECT COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.created_at), '[]')
                          FROM scf.trust_annotations n WHERE n.tenant_id = t.tenant_id))
        FROM scf.tenants t WHERE t.tenant_id = p_tenant);
  END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA scf FROM scf_op_definer;
