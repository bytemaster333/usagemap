# S-04 — Minimal Collector build, pipelines, metadata, durable queue, writer failover

**Result:** PARTIAL — items 1–4 work as designed (with the caveat that exporter-side batching must stay off to keep
replays byte-identical), and writer failover with the persistent queue intact works only through one `otlp_http`
exporter whose host name resolves to both writers, not through the `failover` connector, which loses data or stalls.

## Question

Can a minimal, signed-toolchain `ocb` build of the Collector (v0.165.x) implement ADR-0009 / wire-formats §f–§g:
no logs; SERVER spans (local roots only, if the remote-parent flag is reachable from OTTL) → `signal_to_metrics`
delta exponential histograms; SDK server metrics passed through; tenant id taken from gateway metadata over
HTTP and gRPC; a `file_storage` persistent queue with fsync that survives `kill -9` with byte-identical retries; and
failover between `core-a` and `core-b` writers without losing the queue (C-77)?

## Method (versions, commands, how to re-run: one command if possible)

**Re-run everything:** `./run.sh` (≈ 10 min; steps `build item1 item2 item4 item4f item5 item5dial clean`, each also
runnable alone, output tee'd to `evidence/<step>.txt`; the evidence files are from runs on 2026-11-12 16:02–16:14Z). Docker project `scf-s04`, host ports `127.0.0.1:18417/18418/18427/18428`
(OTLP), `18433/18434` (health), `18488/18489` (self-metrics), `18441/18442` (sinks). Images are kept, containers removed.

| Thing | Version / digest |
|---|---|
| `ocb` | **v0.165.0** (`cmd/builder/v0.165.0`, published 2026-11-07, latest). `ocb_0.165.0_linux_amd64` SHA-256 `6fd899cf8794803bb0d9ea0a055fdaabd2e7e8304de3872fd9aaec3f0cd7f18c` = published `.sha256`. Sigstore bundle verified with cosign v3.1.4 (binary SHA-256 `424e2c97…aaf4bbfa`): `cosign verify-blob --bundle ocb_0.165.0_linux_amd64.sigstore.json --certificate-identity https://github.com/open-telemetry/opentelemetry-collector-releases/.github/workflows/base-binary-release.yaml@refs/tags/v0.165.0 --certificate-oidc-issuer https://token.actions.githubusercontent.com` → `Verified OK`. (`ocb version` prints `v0.165.0+dirty` — an upstream stamping quirk; the bytes are the signed artefact.) |
| Collector core | v0.165.0 / stable modules v1.71.0 (2026-11-06) — latest |
| Collector contrib | v0.165.1 (2026-11-09) — latest; sources read at tag `6083b2c53d78` |
| Go | 1.27.4 (mise), `GOWORK=off`, `CGO_ENABLED=0` |
| Test SDK | OpenTelemetry Go v1.47.0 (`sdk`, `sdk/metric`, `sdk/log`, `otlptrace{http,grpc}`, `otlpmetric{http,grpc}` v1.47.0, `otlplog{http,grpc}` v0.23.0) |

Files:
- `builder-config.yaml` — the minimal distribution (exactly the planned component list). `builder-config-s04test.yaml` — the same
  plus `failover` connector and `headers_setter` extension, used **only** for 4e and 5A.
- `scfsanitizeprocessor/` — the stub processor module (module path
  `github.com/bytemaster333/usagemap/collector/processor/scfsanitizeprocessor`, same as the monorepo skeleton).
  Reads `client.FromContext(ctx).Metadata`, stamps `scf.tenant.id`, drops resources whose `service.name` is not in
  `x-scf-allowed-services` (percent-decoded, `*` = all), keeps the §f.5 allow-lists, strips span events/links and
  exemplars, writes `scf.route` from `http.route`→`url.path`→`http.target`→`url.full`→`http.url` or `{unknown}` and
  deletes the path inputs (no normalisation — that is `pathnorm`'s job later).
- `config.yaml` — items 2–4. `config-failover.yaml` — item 5A. `overlay-*.yaml` — merged on top with a second
  `--config` (batching, fsync off, metadata→headers).
- `tools/cmd/sink` — capture endpoint: records every request (headers, SHA-256 of the **decompressed** body = the
  §g.3 batch key, OTLP JSON), can answer 503 N times or hold its 200 for D ms after recording.
  `tools/cmd/sendtest` — plays "gateway in front of a tenant SDK": real Go SDK spans/metrics/logs plus pdata-built
  single-point requests, with the §f.4 `x-scf-*` headers. `tools/cmd/dialtest` — diagnostic for 5B.
  `tools/analyze.py` — counts and hash comparisons quoted below.

Build command (from this directory): `GOWORK=off ocb --config builder-config.yaml` → `work/build/scf-otelcol/scf-otelcol`.
Cold build (contrib modules not yet in the module cache) 1 min 23 s; warm ≈ 3–5 s.

## Observations (raw facts, with excerpts of output)

### 1. Minimal distribution (`evidence/build.txt`, `evidence/item1.txt`)

`scf-otelcol components` (component type — module — stability):

| Kind | Type | Module | Stability |
|---|---|---|---|
| receiver | `otlp` | core `receiver/otlpreceiver v0.165.0` | stable (traces, metrics, logs) |
| processor | `memory_limiter` | core `processor/memorylimiterprocessor v0.165.0` | beta |
| processor | `filter` | contrib `processor/filterprocessor v0.165.1` | alpha |
| processor | `transform` | contrib `processor/transformprocessor v0.165.1` | beta (built in, not needed by `config.yaml`) |
| processor | `scfsanitize` | local module `v0.0.0` (`path: ./scfsanitizeprocessor`) | development (ours) |
| connector | **`signal_to_metrics`** (deprecated alias `signaltometrics`) | contrib `connector/signaltometricsconnector v0.165.1` | **alpha** traces/logs/metrics/profiles → metrics |
| exporter | **`otlp_http`** (deprecated alias `otlphttp`) | core `exporter/otlphttpexporter v0.165.0` | stable |
| extension | `file_storage` | contrib `extension/storage/filestorage v0.165.1` | beta |
| extension | **`health_check`** | contrib `extension/healthcheckextension v0.165.1` | alpha |
| providers | `env`, `file` | core `confmap/provider/{env,file}provider v1.71.0` | — |
| *(test build only)* connector | `failover` | contrib `connector/failoverconnector v0.165.1` | **alpha** (traces/metrics/logs → same); in contrib and k8s distros only |
| *(test build only)* extension | `headers_setter` | contrib `extension/headerssetterextension v0.165.1` | alpha |

Binary `scf-otelcol`: **49 766 560 bytes** (47.5 MiB), static ELF, stripped, `-trimpath`, `CGO_ENABLED=0`;
gzip -9: ≈ 16.3 MB (16 319 382–16 319 392 bytes over two builds — Go stamps `vcs.revision`/`vcs.modified` because
the tree is a dirty git checkout, so the binary is not bit-for-bit reproducible as built here); 229 module requirements
in the generated `go.mod`. `FROM scratch` image as listed by
`docker images`: 66.5 MB. Test build: 49 971 360 bytes.

### 2. Pipelines (`evidence/item2.txt`, `evidence/item2-exported-*.json`)

**(a) Logs** — no logs pipeline:
```
HTTP protobuf /v1/logs -> 404 "404 page not found\n"
HTTP JSON     /v1/logs -> 404 "404 page not found\n"
gRPC LogsService/Export -> code=Unimplemented msg="unknown service opentelemetry.proto.collector.logs.v1.LogsService"
Go SDK otlploghttp Export -> after 11ms: failed to send logs to http://127.0.0.1:18418/v1/logs: 404 Not Found (body: 404 page not found)
Go SDK otlploggrpc Export -> after 5ms: rpc error: code = Unimplemented desc = unknown service opentelemetry.proto.collector.logs.v1.LogsService
```
The real Go SDK exporters give up at once (no retry), as expected for non-retryable codes.

**Remote-parent flag.** What the Go SDK v1.47.0 puts on the wire (spans posted straight to the sink):
```
checkout  GET /internal/nested  kind=2 parent=758d7d3f5b5e986c flags=0x0101   <- SERVER, local parent
checkout  GET horizon           kind=3 parent=758d7d3f5b5e986c flags=0x0101   <- CLIENT
checkout  render                kind=1 parent=758d7d3f5b5e986c flags=0x0101   <- INTERNAL
checkout  GET /users/{id}       kind=2 parent=00f067aa0ba902b7 flags=0x0301   <- SERVER, remote parent
checkout  POST                  kind=2 parent=-                flags=0x0101   <- SERVER, root
checkout  op                    kind=2 parent=-                flags=0x0101   <- SERVER, root, no route/path
checkout  GET /sampled          kind=2 parent=00f067aa0ba902b7 flags=0x0301 tracestate=ot=th:c
forbidden-svc GET /x            kind=2 parent=-                flags=0x0101
```
`0x100` = `SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE_MASK`, `0x200` = `…_IS_REMOTE_MASK`. OTTL exposes them as **`span.flags`
(int64)** (`pkg/ottl/contexts/ottlspan/README.md` L57, `ctxspan/span.go` L115) and has `IsRootSpan()`
(parent id all-zero). OTTL has no bitwise operators, but int64 `/` is integer division, so this parses and works:
```yaml
filter/server_local_roots:
  trace_conditions:   # any true => span dropped
    - span.kind != SPAN_KIND_SERVER
    - not IsRootSpan() and (span.flags / 256) - (span.flags / 512) * 2 == 1 and (span.flags / 512) - (span.flags / 1024) * 2 == 0
```
(second line = "has a parent, the SDK says it knows is_remote, and is_remote is false"). Spans from SDKs that do not
set `0x100` are kept, i.e. fall back to "every SERVER span counts".

**(b) Spans → metrics, spans not exported.** The 8 spans above sent through the Collector over HTTP and again over
gRPC (16 spans): self-metrics `otelcol_receiver_accepted_spans` http 8 / grpc 8; `scfsanitize` out 14 (2 ×
`forbidden-svc` dropped, log `service_not_allowed … "spans": 1` twice); `otelcol_processor_filter_spans_filtered` **6**
(nested SERVER, CLIENT, INTERNAL × 2); filter out 8; the sink received **8 requests, all `/v1/metrics`**, 0
`/v1/traces`; no `otelcol_exporter_sent_spans` series exists. Canary values in spans/logs (`CANARY-LOG-…`,
`CANARY-EVENT`, `host.name`, `user_agent.original`, `url.query`, `enduser.id`, forged `tenant.id`, `client.address`,
raw `url.path` `/users/42`) found **0 times** in the queue directory and in everything the sink received.

**(c) Exported shape** (one request, `evidence/item2-exported-span-derived.json`; OTLP JSON as decoded by the sink):
```json
{"resource":{"attributes":[
   {"key":"deployment.environment.name","value":{"stringValue":"prod"}},
   {"key":"scf.tenant.id","value":{"stringValue":"11111111-2222-4333-8444-555555555555"}},
   {"key":"service.instance.id","value":{"stringValue":"inst-1"}},
   {"key":"service.name","value":{"stringValue":"checkout"}},
   {"key":"signal_to_metrics.service.instance.id","value":{"stringValue":"<Collector instance UUID>"}}]},
 "scopeMetrics":[{"scope":{"name":"github.com/open-telemetry/opentelemetry-collector-contrib/connector/signaltometricsconnector"},
  "metrics":[{"name":"scf.span.server.duration","description":"SERVER span duration (span-derived)","unit":"s",
   "exponentialHistogram":{"aggregationTemporality":1,"dataPoints":[{
     "attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},
                   {"key":"http.response.status_code","value":{"intValue":"200"}},
                   {"key":"scf.route","value":{"stringValue":"/users/{id}"}}],
     "timeUnixNano":"…","count":"1","sum":0.12,"scale":20,
     "positive":{"offset":-3207483,"bucketCounts":["1"]},"negative":{},"min":0.12,"max":0.12}]}}]}]}
```
Other points: `/orders/7` (from `url.path`) POST 500 sum 0.3; `{unknown}` with **no** method/status attributes (those
are `optional: true`, so they are simply absent); `/sampled` **count 4** for `ot=th:c` (`Int(AdjustedCount())`;
spans without a threshold count 1 — `customottl/adjustedcount.go` returns 1 when `th` is absent). Delta
(`aggregationTemporality: 1`), scale 20 (max), `max_size` 160. `signal_to_metrics` is stateless per `Consume` call:
the SDK's `WithSyncer` sent one span per request, so each span became its own point; a batching SDK yields one point
per attribute set per batch. No `startTimeUnixNano` is set on derived points.

**SDK metrics pass-through** (`evidence/item2-exported-sdk-metrics.json`): `http.server.request.duration` (unit `s`,
explicit histogram, cumulative, scope `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp`) arrives with
resource `service.name`, `service.instance.id`, `scf.tenant.id` and point attributes `http.request.method`,
`http.response.status_code`, `http.route` only — `client.address`, `server.address`, `host.name`, forged `tenant.id`
removed; `http.client.request.duration` and `app.orders.created` dropped by `filter/metric_allowlist`. Same result
over HTTP and gRPC.

### 3. Metadata from the front door

- `include_metadata: true` on both `protocols.http` and `protocols.grpc`; the processor calls
  `client.FromContext(ctx).Metadata.Get("x-scf-tenant-id")` (case-insensitive). It works identically for HTTP headers
  and gRPC metadata (2c/2d above: both protocols produce `scf.tenant.id` = the header value; the payload's forged
  `tenant.id`/`scf.tenant.id` = `FORGED-TENANT` never appears downstream).
- The stamped attribute survives `signal_to_metrics` because the connector copies resource attributes listed in
  `include_resource_attributes`.
- A request with no `x-scf-tenant-id`: the stub drops it (`processorhelper.ErrSkipProcessingData`) and logs
  `no tenant metadata on request; dropping payload`; **the client still gets `200`** (empty `partial_success`).
- **All** incoming headers become client metadata — there is no key allow-list on the v0.165 receiver
  (`confighttp`/`configgrpc` have no such option) — and see 4e: the persistent queue writes them to disk.

### 4. Persistent queue durability (`evidence/item4.txt`, `evidence/item4f.txt`)

- Config key: **`extensions.file_storage/<name>.fsync: true`** (`filestorage/config.go` L29–30, default false);
  queue: `exporters.otlp_http/<name>.sending_queue.storage: file_storage/<name>`.
- **4a** sink container stopped, 1000 single-point requests (all `200`), `otelcol_exporter_queue_size 1000`,
  `kill -9` (exit 137), restart (queue still 1000), sink started:
  `distinct_points_delivered=1000 duplicate_deliveries=0`.
- **4b** sink records the request, then holds its `200` 5 s; `kill -9` meanwhile (4 requests in flight, one per
  `num_consumers`): `distinct_points_delivered=50 duplicate_deliveries=4`, and every duplicate has the **same SHA-256**
  of the decompressed body (`points_seen_in_more_than_one_distinct_body=0`).
- **4c** in-process retries (503 × 3): the retried bodies are byte-identical (`3f8c558c…` ×4 and `45107167…` ×4, 503 ×3 then 200).
- **4d** same as 4b with `sending_queue.batch {sizer: items, min_size: 10, max_size: 25, flush_timeout: 2s}` and 95
  points: after restart the 40 points that were in flight were re-sent **in different batches**, e.g.
  `routes=[0, 1, 2, 3, 4, 90, 91, 92, 93, 94]`; result `duplicate_deliveries=40`,
  `points_seen_in_more_than_one_distinct_body=40` → a body-hash ledger would apply them twice.
  Also visible: replayed items go to the **tail** of the queue (order is not preserved across a crash).
- **4e** request metadata through the queue (test build, `headers_setter` copying `x-scf-tenant-id` and `x-scf-node`
  to outgoing headers): 3 requests before the crash and 20 requests queued across `kill -9` all arrived with
  `X-Scf-Tenant-Id=11111111-…` and `X-Scf-Node=edge-s04`. Source: `pdata/xpdata/request/context.go`
  `encodeClientMetadata` (L39) and `encodeClientAddress` (L62) serialise **all** client metadata and the peer address
  with each queued request; exporterhelper README L106: "client metadata … preserved …; context set by Auth
  extensions is **not** propagated". A non-`x-scf` canary header (`x-canary-hdr: CANARY-HDR-0c1d`) was found in the
  bbolt file (`grep -c` 1004 blocks for 1000 requests).
- **4f** fsync is really on: 2000 sequential acknowledged requests with the sink down took **13.07 s with
  `fsync: true` vs 0.38 s with `fsync: false`** (ext4; an earlier run: 15.38 s vs 0.97 s) — ≈ 6.5–7.7 ms vs
  0.2–0.5 ms per acknowledged request.
  (`kill -9` leaves the page cache intact, so 4a–4e do not exercise fsync; power loss was not tested.)
- exporterhelper v0.165 has **no age-based eviction**: `retry_on_failure.max_elapsed_time` is per request and its
  clock restarts with the process (grep of `exporter/exporterhelper/internal/queue*` for max-age/TTL: none).

### 5. Failover between two writers (`evidence/item5.txt`)

**5A — `failover` connector** (contrib, **alpha**, metrics→metrics; queue moved into the connector as its README L39
recommends, exporters without queues). The connector wraps itself with `exporterhelper.WithQueue` only — **no retry
sender** (`factory.go` L105) — and when every level has failed it returns `All provided pipelines return errors`
(`failover.go` L16) until a `retry_interval` tick.
- 5A-1 (finite retries on both exporters): sink-a killed → next 20 points went to sink-b ✔; both killed → **all 20
  points dropped** (`Exporting failed. Dropping data.`, `otelcol_exporter_send_failed_metric_points{exporter="failover/writers"} 20`);
  both back after 25 s → back to sink-a ✔ (20/20; in an earlier run one more point was dropped right after recovery, 19/20).
- 5A-2 (last level `max_elapsed_time: 0`): no loss, survives `kill -9` (30/30 delivered once), but **stalls**: with
  only sink-a (priority 1) back for 30 s nothing was delivered (`queue_size 30`) because all 4 consumers were stuck
  retrying sink-b; delivery resumed only when sink-b came back (26 → sink-a, 4 → sink-b).

**`loadbalancing` exporter** (not built): README L80 — with the `static` resolver "there's a risk of data loss if one
of the defined endpoint targets becomes unavailable"; L83 — persistent queue "is NOT supported" on the per-endpoint
sub-exporters. It routes by key, it does not fail over. Rejected without testing.

**5B — one `otlp_http` exporter, one name, two addresses** (`config.yaml` unchanged, `SINK_ENDPOINT=http://writers:4319`,
container `/etc/hosts` has `writers` → sink-a IP and `writers` → sink-b IP; persistent queue + `max_elapsed_time: 0`).
Go's resolver returns both addresses and its dialer tries them in order (`evidence/item5dial.txt` and a manual run:
`LookupHost: [172.20.3.3 172.20.3.4]`; with sink-a's container gone: `dial 172.20.3.3 after 3.068s: connect: no
route to host` (manual run) or `connection refused` after 0 s (run.sh), then `dial <second address> … err=<nil>`;
an `http.Client` GET with a 5 s timeout succeeded in 3.086 s / 1 ms).
- h1 (both up) 20 → sink-a; sink-a killed, h2 20 → **sink-b**; sink-b killed and sink-a started, h3 20 → **sink-a**;
  each phase `duplicate_deliveries=0`, nothing lost, queue 0.
- Failover took **≈ 15–17 s** when the dead writer's host vanished (last h1 delivery 16:08:01.55Z, first h2 delivery
  at sink-b 16:08:18.96Z): requests on pooled keep-alive connections to the vanished host hang until `timeout: 5s`
  (8 × `context deadline exceeded (Client.Timeout exceeded while awaiting headers)`; an earlier run also showed 4 ×
  plain `context deadline exceeded` while dialling), then a new connection lands on sink-b. In the h3 phase (sink-b
  killed, sink-a back) the switch took < 1 s and logged no retries.
- Limits: it fails over only on connection-level failure, never on an HTTP `503` from a live writer; every new
  connection tries the first address first (≈ 2.5–3 s penalty while that host is down); no rebalancing back.

## Answer to the question

1. **Yes.** `ocb` v0.165.0 (checksum and Sigstore signature verified) builds the exact component set plus our local
   `scfsanitize` module; 47.5 MiB static binary (16.3 MB gzipped). Current names: `signal_to_metrics` (alpha),
   `otlp_http` (stable), `health_check`, `file_storage`, `filter`, `memory_limiter`, `transform`.
2. **Yes.** No logs pipeline → HTTP 404 / gRPC `UNIMPLEMENTED`, SDKs drop at once. **Local-root filtering is
   possible**: `span.flags` + `IsRootSpan()` with integer-division arithmetic; the Go SDK sets both flag bits.
   Spans become delta base-2 exponential histograms (scale 20) with `scf.route`, method, status, `service.name`,
   `scf.tenant.id`; no span leaves the process.
3. **Yes**, for HTTP and gRPC alike, via `include_metadata: true` + `client.FromContext(ctx).Metadata`; the stamped
   `scf.tenant.id` reaches the exporter payload, including span-derived metrics.
4. **Yes, without exporter batching.** N = 1000 delivered after `kill -9`, duplicates only for requests in flight,
   and **retries/replays are byte-identical** (same SHA-256 of the decompressed body) — **but only with
   `sending_queue.batch` off**; with batching, replays are re-batched and the hash changes. Client metadata (all of
   it) survives the queue; auth context would not.
5. **Partly.** The `failover` connector (alpha) cannot be used: it drops data when no writer is up, or, with an
   infinite last-level retry, stalls until the lower-priority writer returns. The `loadbalancing` exporter is not a
   failover. **What works:** a single `otlp_http` exporter with the persistent queue and a host name that resolves
   to both writers; Go's dialer fails over at connection level, the queue stays intact, no loss, no duplicates.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)

- **ADR-0009 / C-77 / wire-formats §g.1 — confirmed with a different mechanism.** Replace "the Collector's own
  failover between `core-a` and `core-b`" by: *one `otlp_http` exporter, endpoint `https://writers.<mesh>:4319`, a
  name that resolves to both writers (two A records in the mesh DNS or `/etc/hosts` from the IaC); failover happens
  at connection level; no `failover` connector, no `loadbalancing` exporter.* Consequences: both writer certificates
  need `writers.<mesh>` in their SAN (C-60); **a writer that cannot reach PostgreSQL must stop accepting connections
  (close its OTLP listener) rather than answer 503**, otherwise the Collector keeps retrying that writer; optionally
  the health controller removes a dead writer from the record (Go re-resolves on every new connection). Set the
  exporter `timeout` low (e.g. 5 s) — failover latency ≈ 2–3 × `timeout`. The loopback relay of C-07 stays the
  fallback only for an mTLS/SAN problem.
- **wire-formats §g.3 — confirmed, with a hard precondition.** The SHA-256-of-decompressed-body batch key is stable
  across in-process retries and across crash replays **only if `sending_queue.batch` is not configured** on the writer
  exporter. Add to §g.1: "no exporter-side batching; one queued request = one incoming request"; add the CI
  config lint. The writer must not assume ordering: replayed requests arrive after newer ones (affects §g.4 cumulative
  reset detection — use `start_time_unix_nano`, not arrival order).
- **ADR-0009 Context / §f.4 — correct the queue/metadata statement.** v0.165 persists **all client metadata and the
  peer address** with each queued request (only auth-extension context is lost). Since the receiver has no metadata
  allow-list, §f.4 must say the gateway forwards **only** `Content-Type`, `Content-Encoding` and the `x-scf-*` headers
  it sets (today it only says it removes `Authorization` and incoming `x-scf-*`); otherwise tenant headers
  (`User-Agent`, vendor keys) land in the on-disk queue. Stamping the tenant into the data before the queue (as
  designed) remains right, but the metadata would also be available to a post-queue component.
- **§f.5 step 5 / C-22 — the remote-parent flag is available.** Use the filter expression above (or the same test in
  Go inside `scfsanitize`: drop when `parent != 0 && flags&0x100 != 0 && flags&0x200 == 0`). If per-reason counters
  `span_not_server` / `span_not_local_root` are needed per tenant, do it in `scfsanitize` — the `filter` processor
  only exposes a global `otelcol_processor_filter_spans_filtered`. SDKs that do not set `0x100` keep "every SERVER
  span counts" (S-06a/b should record which SDKs set it). Remove "when the Collector exposes the remote-parent flag"
  from ADR-0009 Negative consequences.
- **wire-formats §g.2 — span-derived payload differs.** (1) Scope name is
  `github.com/open-telemetry/opentelemetry-collector-contrib/connector/signaltometricsconnector`, not
  `scf/signal_to_metrics` (fixed in the connector, `metadata.ScopeName`). (2) The connector adds resource attribute
  `signal_to_metrics.service.instance.id` = Collector instance UUID (new on every restart). (3) Absent optional
  attributes are omitted, not defaulted (method/status missing on `{unknown}` points). Either change §g.2 to accept
  these (writer ignores the extra attribute, maps the scope name, treats absent status as 0) or put a `transform`
  step in `metrics/span_derived` — that is the only use the `transform` component would have (not tested here).
- **C-18 72-hour cap — not expressible as configured.** No age-based eviction exists; `max_elapsed_time` is per
  request and resets on restart. Use `max_elapsed_time: 72h` as an approximation and state that the cap can be
  exceeded across restarts; age is enforced by the time bounds (`x-scf-received-at`, §f.5 step 7) and the writer.
- **Capacity (ADR-0009 Volume, ADR-0020).** With `fsync: true` one acknowledged request cost ≈ 7.7 ms on this
  disk (≈ 130 sequential requests/s; concurrency not measured). At 11.6 req/s average this is fine; at span-sender
  peaks every incoming trace request also produces one queued request — size edge disks for IOPS, alert on
  `otelcol_exporter_queue_size` and the receiver latency.
- `signal_to_metrics` alpha: confirmed working at v0.165.1 with `exponential_histogram`, `Seconds(span.end_time -
  span.start_time)`, `Int(AdjustedCount())` and `optional` attributes; keep it pinned (the in-house connector
  fallback is not needed today).
- Missing tenant metadata: the stub's silent drop returns `200`; the real `scfsanitize` should count it
  (`scf.ingest.dropped`, reason e.g. `no_tenant`) and the gateway must never forward without it.

## Values the implementation must use (env vars, headers, config keys, flags, limits)

- Builder: `ocb` v0.165.0, SHA-256 `6fd899cf8794803bb0d9ea0a055fdaabd2e7e8304de3872fd9aaec3f0cd7f18c`, cosign
  identity `https://github.com/open-telemetry/opentelemetry-collector-releases/.github/workflows/base-binary-release.yaml@refs/tags/v0.165.0`,
  issuer `https://token.actions.githubusercontent.com`. Build with `GOWORK=off` (the repo's `go.work` otherwise
  interferes; running `go get` in workspace mode rewrites `go.work`).
- Modules: core `v0.165.0` (+ `v1.71.0` stable set), contrib `v0.165.1`; manifest = `builder-config.yaml`.
- Component IDs: `otlp`, `memory_limiter`, `scfsanitize`, `filter`, `signal_to_metrics`, `otlp_http`,
  `file_storage`, `health_check` (`transform` optional). Do **not** use `failover`, `loadbalancing`, `batch`, or
  `sending_queue.batch`.
- Receiver: `protocols.{grpc,http}.include_metadata: true`; listen on `127.0.0.1:4317/4318` in production.
- `file_storage`: `directory`, `create_directory: true`, `fsync: true`.
- Exporter: `otlp_http/writer.endpoint: https://writers.<mesh>:4319`, `encoding: proto`, `compression: gzip`,
  `timeout: 5s`, `retry_on_failure: {enabled: true, initial_interval: 1s, max_interval: 5s, max_elapsed_time: 72h}`,
  `sending_queue: {enabled: true, storage: file_storage/queue, sizer: requests, queue_size: <72 h of requests>, num_consumers: 4}`,
  no `batch`.
- Filter expression for local-root SERVER spans: see §2 above (`span.flags` bits `0x100`/`0x200`).
- `signal_to_metrics.spans[].exponential_histogram: {max_size: 160, value: Seconds(span.end_time - span.start_time), count: Int(AdjustedCount())}`,
  `unit: s`, `include_resource_attributes` = `scf.tenant.id`, `service.name`, `service.instance.id`,
  `deployment.environment.name`; attributes `scf.route` (required) + `http.request.method`, `http.response.status_code` (`optional: true`).
- Metadata keys read by `scfsanitize`: `x-scf-tenant-id`, `x-scf-allowed-services` (comma list, percent-encoded, `*`).
- Self-metrics to alert on: `otelcol_exporter_queue_size`, `otelcol_exporter_send_failed_metric_points`,
  `otelcol_exporter_enqueue_failed_metric_points`, `otelcol_processor_filter_spans_filtered`.

## Open issues

- 5B was run with plain HTTP and `/etc/hosts`; repeat with mTLS (shared SAN) and the real mesh DNS during the
  writer build. The "writer closes its listener when the database is unreachable" behaviour must be built and
  tested; until then a live writer answering 503 is not failed over.
- Which non-Go SDKs set `SPAN_FLAGS_CONTEXT_HAS_IS_REMOTE` — hand over to S-06a/S-06b.
- fsync under real power loss (VM hard reset) not tested; concurrent enqueue throughput with fsync not measured.
- In 1 of ≈ 14 `kill -9` + restart cycles (full run, step 4b) the restarted container did not report healthy within
  30 s; logs were lost, it did not recur in 11 further attempts, and the queue it left behind was later drained
  completely (50/50 points) by a fresh Collector (`evidence/item4-restart-flake.txt`). `run.sh` now dumps logs when
  this happens; watch for it in the Collector chaos tests (C-48).
- Bit-reproducible builds: build from a clean checkout (or with `-buildvcs=false` via the build pipeline) so the
  signed binary's hash is repeatable (ADR-0023).
- The `transform` step to rename the scope / drop `signal_to_metrics.service.instance.id` was not tried.
- The real `scfsanitize` (pathnorm, ms→s conversion, time bounds, drop counters `scf.ingest.dropped`,
  `scf.stream.instance`) is not part of this spike; the stub only proves the plumbing.
- The `failover` connector's data loss when all levels fail could be reported upstream (no retry sender in its
  queue wrapper); re-check at each Collector bump.
