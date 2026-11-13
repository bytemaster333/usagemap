-- Source: docs/data-model.md, block '-- migration: 0020_api_metrics' (verbatim; the contract is the document).
-- Applied once, in one transaction, as scf_migrator by db/migrate.sh (ledger scf_migrations.applied).
-- migration: 0020_api_metrics
CREATE TABLE scf.api_stream_groups (
  tenant_id     uuid   NOT NULL,
  group_id      bigint GENERATED ALWAYS AS IDENTITY,
  service_id    uuid   NOT NULL,
  kind          scf.stream_kind NOT NULL,
  metric_name   text   NOT NULL CHECK (metric_name IN ('http.server.request.duration', 'http.server.duration', 'scf.span.server.duration')),
  scope_name    text   NOT NULL CHECK (char_length(scope_name) <= 256),
  rank_key      text   NOT NULL,     -- kind rank (1|2|3) ‖ '|' ‖ lpad(scope priority, 3, '0') ‖ '|' ‖ scope_name
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, group_id),
  UNIQUE (tenant_id, service_id, kind, metric_name, scope_name),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE
);

-- Route dictionary. route = pathnorm output (ADR-0012) using the closed placeholder set of the vector corpus
-- (C-16), or exactly '{unknown}' (assigned by the Collector's sanitise step when neither a route nor a path exists)
-- or '{overflow}' (assigned by the writer's cardinality guard) (C-16, C-89). rpc_method only for services with
-- rpc_method_dimension.
CREATE TABLE scf.api_routes (
  tenant_id      uuid   NOT NULL,
  route_id       bigint GENERATED ALWAYS AS IDENTITY,
  service_id     uuid   NOT NULL,
  route          text   NOT NULL CHECK (char_length(route) <= 1024 AND (route ~ '^/' OR route IN ('{unknown}', '{overflow}'))),
  parent_prefix  text   NOT NULL,
  rpc_method     text   CHECK (rpc_method ~ '^[A-Za-z_]{1,64}$'),
  rules_version  text   NOT NULL CHECK (rules_version ~ '^scf-path-rules/[0-9]+\.[0-9]+\.[0-9]+$'),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, route_id),
  UNIQUE NULLS NOT DISTINCT (tenant_id, service_id, route, rpc_method, rules_version),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE
);
CREATE INDEX api_routes_prefix ON scf.api_routes (tenant_id, service_id, parent_prefix);

-- Cardinality guard state (C-24: 1,000/service/day, 5,000/tenant/day, 200 siblings/prefix; L0: 100/tenant/day).
CREATE TABLE scf.api_route_day (
  tenant_id   uuid   NOT NULL,
  day         date   NOT NULL,
  service_id  uuid   NOT NULL,
  route_id    bigint NOT NULL,
  PRIMARY KEY (tenant_id, day, service_id, route_id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, route_id) REFERENCES scf.api_routes (tenant_id, route_id) ON DELETE CASCADE
);

CREATE TABLE scf.api_metrics_1m (
  tenant_id        uuid        NOT NULL,
  service_id       uuid        NOT NULL,
  route_id         bigint      NOT NULL,
  method           smallint    NOT NULL CHECK (method BETWEEN 0 AND 10),
  status_code      smallint    NOT NULL CHECK (status_code = 0 OR status_code BETWEEN 100 AND 599),
  source           scf.metric_source NOT NULL,
  stream_group_id  bigint      NOT NULL,
  bucket_start     timestamptz NOT NULL,
  request_count    bigint      NOT NULL CHECK (request_count >= 0),
  duration_sum     float8      NOT NULL CHECK (duration_sum >= 0),      -- seconds
  duration_min     float8,                                               -- NULL = unknown
  duration_max     float8,
  hist_kind        scf.hist_kind NOT NULL,
  hist             int4[]      NOT NULL,     -- C-103: int4 per bucket (2^31 is ample for a 1d row at 10× load); halves exp3 rows vs bigint[194] (1.7 kB, S-05)
  hist_quality     smallint    NOT NULL DEFAULT 0 CHECK (hist_quality BETWEEN 0 AND 2),   -- 0 exact · 1 approx · 2 coarse
  PRIMARY KEY (tenant_id, service_id, bucket_start, route_id, method, status_code, source, stream_group_id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, route_id) REFERENCES scf.api_routes (tenant_id, route_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, stream_group_id) REFERENCES scf.api_stream_groups (tenant_id, group_id) ON DELETE CASCADE,
  CHECK ((hist_kind = 'explicit15' AND cardinality(hist) = 15) OR (hist_kind = 'exp3' AND cardinality(hist) = 194)),
  CHECK (hist_kind = 'explicit15' OR hist_quality = 0),
  CHECK (bucket_start = date_trunc('minute', bucket_start))
) PARTITION BY RANGE (bucket_start);

-- LIKE does not copy foreign keys: they are repeated (C-87).
CREATE TABLE scf.api_metrics_1h (LIKE scf.api_metrics_1m INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (tenant_id, service_id, bucket_start, route_id, method, status_code, source, stream_group_id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, route_id) REFERENCES scf.api_routes (tenant_id, route_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, stream_group_id) REFERENCES scf.api_stream_groups (tenant_id, group_id) ON DELETE CASCADE,
  CHECK (bucket_start = date_trunc('hour', bucket_start, 'UTC'))
) PARTITION BY RANGE (bucket_start);
CREATE TABLE scf.api_metrics_1d (LIKE scf.api_metrics_1m INCLUDING DEFAULTS INCLUDING CONSTRAINTS,
  PRIMARY KEY (tenant_id, service_id, bucket_start, route_id, method, status_code, source, stream_group_id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, route_id) REFERENCES scf.api_routes (tenant_id, route_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, stream_group_id) REFERENCES scf.api_stream_groups (tenant_id, group_id) ON DELETE CASCADE,
  CHECK (bucket_start = date_trunc('day', bucket_start, 'UTC'))
) PARTITION BY RANGE (bucket_start);
CREATE INDEX api_metrics_1m_tenant_time ON scf.api_metrics_1m (tenant_id, bucket_start);
CREATE INDEX api_metrics_1h_tenant_time ON scf.api_metrics_1h (tenant_id, bucket_start);
CREATE INDEX api_metrics_1d_tenant_time ON scf.api_metrics_1d (tenant_id, bucket_start);

-- Batch ledger (C-23): batch_key = SHA-256 of the decompressed request body (wire-formats §g.3). Not partitioned
-- so the key is globally unique; kept 7 days (C-18).
CREATE TABLE scf.api_ingest_ledger (
  tenant_id    uuid  NOT NULL,
  batch_key    bytea NOT NULL CHECK (octet_length(batch_key) = 32),
  points       integer NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, batch_key)
);
CREATE INDEX api_ingest_ledger_age ON scf.api_ingest_ledger (received_at);

CREATE TABLE scf.api_stream_state (
  tenant_id          uuid   NOT NULL,
  stream_key         bytea  NOT NULL CHECK (octet_length(stream_key) = 32),
  start_time_unix_ns bigint NOT NULL,
  last_time_unix_ns  bigint NOT NULL,
  last_count         bigint NOT NULL,
  last_sum           float8 NOT NULL,
  last_layout        jsonb  NOT NULL,     -- {"kind":"explicit","bounds":[…]} | {"kind":"exponential","scale":s} | {"kind":"source"} (C-122)
  last_buckets       bigint[] NOT NULL,   -- source layout (explicit: N+1 counts; exponential: positive counts)
  last_zero_count    bigint NOT NULL DEFAULT 0,
  last_exp_offset    integer,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, stream_key)
);

-- Which stream groups delivered data per service and UTC day (drives the preferred group, C-22).
CREATE TABLE scf.api_service_day_groups (
  tenant_id        uuid   NOT NULL,
  service_id       uuid   NOT NULL,
  day              date   NOT NULL,
  stream_group_id  bigint NOT NULL,
  PRIMARY KEY (tenant_id, service_id, day, stream_group_id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES scf.api_services (tenant_id, service_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, stream_group_id) REFERENCES scf.api_stream_groups (tenant_id, group_id) ON DELETE CASCADE
);

-- reasons: wire-formats §h.3; service_id all-zero = not attributable, hence no foreign key (the one exception, §1)
CREATE TABLE scf.api_ingest_counters (
  tenant_id   uuid   NOT NULL,
  day         date   NOT NULL,
  service_id  uuid   NOT NULL,
  reason      text   NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{1,47}$'),
  count       bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (tenant_id, day, service_id, reason)
);

CALL scf_admin.apply_tenant_rls('scf.api_stream_groups', '{SELECT}', '{SELECT,INSERT}', '{SELECT}',
  '{"SELECT":["trust_scoring","tenant_purge"],"DELETE":["tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_routes', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{SELECT}',
  '{"SELECT":["trust_scoring","erasure","tenant_purge"],"DELETE":["erasure","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_route_day', '{}', '{SELECT,INSERT}', '{}',
  '{"SELECT":["stream_gc","tenant_purge"],"DELETE":["stream_gc","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_metrics_1m', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{SELECT}',
  '{"SELECT":["erasure","tenant_purge"],"DELETE":["erasure","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_metrics_1h', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{SELECT}',
  '{"SELECT":["trust_scoring","erasure","tenant_purge"],"DELETE":["erasure","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_metrics_1d', '{SELECT}', '{SELECT,INSERT,UPDATE}', '{SELECT}',
  '{"SELECT":["trust_scoring","public_metrics","erasure","tenant_purge"],"DELETE":["erasure","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_ingest_ledger', '{}', '{SELECT,INSERT}', '{}',
  '{"SELECT":["retention"],"DELETE":["retention"]}');
CALL scf_admin.apply_tenant_rls('scf.api_stream_state', '{}', '{SELECT,INSERT,UPDATE}', '{}',
  '{"SELECT":["stream_gc","tenant_purge"],"DELETE":["stream_gc","tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_service_day_groups', '{SELECT}', '{SELECT,INSERT}', '{SELECT}',
  '{"SELECT":["trust_scoring","tenant_purge"],"DELETE":["tenant_purge"]}');
CALL scf_admin.apply_tenant_rls('scf.api_ingest_counters', '{SELECT,INSERT,UPDATE}', '{SELECT,INSERT,UPDATE}', '{SELECT}',
  '{"SELECT":["trust_scoring","retention","tenant_purge"],"DELETE":["retention","tenant_purge"]}');

-- Preferred-group views (tenant-facing, security_invoker). A row counts only if its stream group is the best-ranked
-- group present for its service on that UTC day.
CREATE FUNCTION scf.is_preferred_group(p_tenant uuid, p_service uuid, p_day date, p_group bigint) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  SELECT p_group = (SELECT d.stream_group_id
                      FROM scf.api_service_day_groups d
                      JOIN scf.api_stream_groups g ON g.tenant_id = d.tenant_id AND g.group_id = d.stream_group_id
                     WHERE d.tenant_id = p_tenant AND d.service_id = p_service AND d.day = p_day
                     ORDER BY g.rank_key, g.group_id LIMIT 1)
  $$;
GRANT EXECUTE ON FUNCTION scf.is_preferred_group(uuid, uuid, date, bigint) TO scf_app, scf_jobs, scf_op_definer;

CREATE VIEW scf.api_metrics_1m_pref WITH (security_invoker = true) AS
  SELECT m.* FROM scf.api_metrics_1m m
   WHERE scf.is_preferred_group(m.tenant_id, m.service_id, (m.bucket_start AT TIME ZONE 'UTC')::date, m.stream_group_id);
CREATE VIEW scf.api_metrics_1h_pref WITH (security_invoker = true) AS
  SELECT m.* FROM scf.api_metrics_1h m
   WHERE scf.is_preferred_group(m.tenant_id, m.service_id, (m.bucket_start AT TIME ZONE 'UTC')::date, m.stream_group_id);
CREATE VIEW scf.api_metrics_1d_pref WITH (security_invoker = true) AS
  SELECT m.* FROM scf.api_metrics_1d m
   WHERE scf.is_preferred_group(m.tenant_id, m.service_id, (m.bucket_start AT TIME ZONE 'UTC')::date, m.stream_group_id);
GRANT SELECT ON scf.api_metrics_1m_pref, scf.api_metrics_1h_pref, scf.api_metrics_1d_pref TO scf_app, scf_op_definer;
