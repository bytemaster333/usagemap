-- Source: docs/data-model.md, block '-- migration: 0017_erasure' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0017_erasure
CREATE TABLE scf.erasure_requests (
  tenant_id      uuid NOT NULL REFERENCES scf.tenants ON DELETE CASCADE,
  request_id     uuid NOT NULL DEFAULT uuidv7(),
  site_id        uuid,
  service_id     uuid,
  scope          text NOT NULL DEFAULT 'filtered' CHECK (scope IN ('filtered', 'site', 'service', 'tenant')),
  criteria       jsonb NOT NULL,
      -- C-86 range: {"start":"2026-01-01T00:00:00Z","end":"2026-02-01T00:00:00Z",   (start inclusive, end exclusive)
      --  "path_pattern":"/users/*"|null,"event_name":"signup"|null,"property_key":"email"|null}
      -- after redaction (C-88): {"start":…,"end":…,"selector":{"type":"path_pattern","length":8}|null}
  status         scf.erasure_status NOT NULL DEFAULT 'previewing',
  preview        jsonb,      -- {"website_events":…,"event_data_rows":…,"sessions_orphaned":…,"breakdown_rows":…,
                             --  "api_routes":…,"api_metric_rows":…,"aggregate_days":["2026-01-03",…]}
  requested_by   uuid NOT NULL REFERENCES scf.users,
  created_at     timestamptz NOT NULL DEFAULT now(),
  previewed_at   timestamptz,
  confirmed_by   uuid REFERENCES scf.users,
  confirmed_at   timestamptz,
  started_at     timestamptz,
  completed_at   timestamptz,
  finished_at    timestamptz,                       -- completed, failed or cancelled (C-88 clock)
  selector_redacted_at timestamptz,                 -- C-88
  result         jsonb,
  failure_code   text CHECK (failure_code IN ('UMAMI_UNAVAILABLE', 'TIMEOUT', 'CRITERIA_INVALID', 'INTERNAL')),
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, site_id) REFERENCES scf.sites (tenant_id, site_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  CHECK (criteria ? 'start' AND criteria ? 'end'),
  CHECK ((scope = 'tenant') OR (site_id IS NULL) <> (service_id IS NULL)),
  CHECK (service_id IS NULL OR NOT (criteria ? 'property_key' AND criteria ->> 'property_key' IS NOT NULL)),
  CHECK (num_nonnulls(criteria ->> 'path_pattern', criteria ->> 'event_name', criteria ->> 'property_key') <= 1),  -- one selector
  CHECK ((status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL)),
  CHECK (selector_redacted_at IS NULL
         OR (finished_at IS NOT NULL AND NOT (criteria ?| ARRAY['path_pattern', 'event_name', 'property_key'])))
);
CREATE INDEX erasure_requests_status ON scf.erasure_requests (status) WHERE status IN ('previewing', 'confirmed', 'running');
CREATE INDEX erasure_requests_redact ON scf.erasure_requests (finished_at) WHERE selector_redacted_at IS NULL;
CREATE TRIGGER erasure_confirm_reauth BEFORE UPDATE ON scf.erasure_requests FOR EACH ROW
  WHEN (NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed') EXECUTE FUNCTION scf.require_reauth();

CALL scf_admin.apply_tenant_rls('scf.erasure_requests', '{SELECT,INSERT,UPDATE}', '{}', '{SELECT}',
  '{"SELECT":["erasure","retention","tenant_purge"],"UPDATE":["erasure","retention"],"DELETE":["tenant_purge"]}');
GRANT SELECT ON scf.erasure_requests TO scf_definer;            -- scf.job_queue('erasure') only (§12)
CREATE POLICY definer_queue ON scf.erasure_requests FOR SELECT TO scf_definer USING (true);
