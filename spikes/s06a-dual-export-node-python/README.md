# S-06a — Dual export from Node.js/Express, Next.js and Python/FastAPI (+ tenant Collector fan-out)

**Result:** PARTIAL — all four patterns dual-export end to end, and every request arrived at the UsageMap stand-in
(53 of 53 per scenario). But **none of the three in-SDK recipes worked as written**: each needed a fix before it
delivered a usable signal. The env-header leak is confirmed for Node and Python; it does not happen with `@vercel/otel`
or with the tenant Collector.

## Question

Do the researched dual-export recipes (§A, §B.1, §B.2; never run before)
work with current packages? What actually reaches the UsageMap endpoint from each stack: signals, metric names, units,
histogram type, `http.route` on metrics and spans, semconv version, temporality, attributes that may carry personal
data? Are the research claims right: Node stable-only since `instrumentation-http` 0.221.0, Python 0.66b2 old by
default, Next.js spans only with old names and the query string in `http.target`? Does `OTEL_EXPORTER_OTLP_HEADERS`
leak into the UsageMap exporter? (ADR-0009, C-22, C-77; S-06 in ADR-0009 "Unproven".)

## Method (versions, commands, how to re-run: one command if possible)

**Re-run everything:** `./run.sh` (about 3 minutes). It installs or builds the apps, starts the three Collectors as
compose project `scf-s06a`, runs 17 scenarios, writes `out/summary.md` (per destination × service) and runs
`docker compose -p scf-s06a down -v`. Images are kept.

| Component | Version |
|---|---|
| Collector (all three roles) | `otel/opentelemetry-collector-contrib:0.165.0@sha256:e40d61f10c9a617cca1ffd1be4d7e2b3a4b0f0001798ff07e58cabe82e618cea`. **There is no `0.165.1` image on Docker Hub** (tag → 404). |
| Node / pnpm | Node 24.19.0, pnpm 12.19.0 (mise) |
| Express stack | express 5.3.0, `@opentelemetry/sdk-node` 0.301.1, `sdk-metrics` 3.1.1, `sdk-trace` 3.1.1, `exporter-{metrics,trace}-otlp-proto` 0.301.1, `instrumentation` 0.301.1, `auto-instrumentations-node` 0.83.0 (brings `instrumentation-http` 0.301.1, `-express` 0.73.0, `-router` 0.69.0, `-runtime-node` 0.38.0), `api` 1.10.0 |
| Semconv boundary | `sdk-node` / `instrumentation-http` / `instrumentation` **0.220.0** + `instrumentation-express` 0.68.0, and **0.221.0** + 0.69.0 (`api` 1.9.0) |
| Next.js stack | next 16.4.6 (Turbopack build, `next start`), react 19.3.1, `@vercel/otel` 2.3.0, OTel JS 2.x line: `sdk-trace-base`/`sdk-metrics`/`resources` 2.12.1, `api-logs`/`sdk-logs`/`instrumentation` 0.223.1, `api` 1.10.0 |
| Python stack | CPython 3.13.5, fastapi 0.162.5 (starlette 1.10.0), uvicorn 0.54.0, `opentelemetry-api`/`-sdk`/`-exporter-otlp-proto-http` 1.45.2, `opentelemetry-instrumentation-fastapi`/`-asgi`/`-distro` 0.66b2 |

Layout (everything inside this directory; the apps are meant to be reused as e2e fixtures):

- `collectors/scf.yaml`: the **UsageMap stand-in**. OTLP on host port 18510 (HTTP) / 18511 (gRPC). It requires
  `bearertokenauth` (requests without the token get 401, checked by `run.sh`). It writes verbatim OTLP JSON to
  `out/scf/{metrics,traces,logs}.jsonl`. With `include_metadata: true` plus a `resource` processor using
  `from_context: metadata.<header>`, selected request headers (`x-vendor-key`, `api-key`, `authorization`,
  `user-agent`, `content-*`) are copied into `spike.seen.*` resource attributes. That is how the header-leak test
  "sees" the headers.
- `collectors/apm.yaml`: the **vendor APM stand-in** (18520/18521). No auth; `debug` exporter plus files in `out/apm/`.
- `collectors/tenant.yaml`: **recipe A**, the tenant Collector (18530/18531), corrected version (see below).
- `apps/express` (port 18540), `apps/nextjs` (18541), `apps/fastapi` (18542), `apps/node-semconv-0.22{0,1}.0` (18543).
  Each has `GET /health`, `GET /accounts/:id` (404 when the id is `GMISSING`), `GET /assets/:code/:issuer`, and
  `GET /boom` (500).
- `tools/load.py`: 53 requests per scenario. 10×`/health`; 20×`/accounts/G…?cursor=canary-cursor-91&email=canary%40example.com`;
  5×`/accounts/GMISSING` (404); 10×`/assets/USDC/GA5Z…?limit=5`; 5×`/boom` (500); 3×`/nope/unmatched-canary-path`
  (404, no route). User-Agent `s06a-load/1.0 (canary-ua-7f3a)`. `run.sh` adds 1 readiness `/health`, so every
  histogram should count **54**.
- `tools/analyze.py out`: groups the files by destination × `service.name` and prints `out/summary.md`.
- The Node app dirs have their own `pnpm-workspace.yaml` with `minimumReleaseAge: 0`. The repo's 3-day rule would
  have blocked the versions under test: `0.301.1` and `3.1.1` were published 2026-11-09 17:00Z. **Re-pin through the
  normal policy before these become fixtures.**
- In every in-SDK scenario `OTEL_EXPORTER_OTLP_HEADERS=x-vendor-key=SECRET` is set (a fake value), standing in for
  a vendor setup left in the environment.

Scenarios, by service name: `s06a-express-sdk`, `-express-sdk-nohook`, `-express-sdk-envauth`, `-node-0.220.0`,
`-node-0.221.0`, `-next-sdk`, `-next-sdk-allspans`, `-fastapi-default`, `-fastapi-stable`, `-fastapi-envauth`,
`-fastapi-default-recipefilter`, `-express-tenant`, `-fastapi-tenant`, `-next-tenant`.

## Observations (raw facts, with excerpts of output)

### 1. Node.js + Express (in-SDK, recipe B.1)

- **Recipe bug 1: APM traces silently lost.** `new BatchSpanProcessor(exporter)` (positional, as in the recipe) does
  not throw with SDK 3.x. Every flush then fails with `TypeError: Cannot read properties of undefined (reading
  'export')` at `sdk-trace@3.1.1/dist/export/BatchSpanProcessorBase.mjs:105`. The error is visible only with
  `OTEL_LOG_LEVEL=debug`. In 3.x the constructor is `constructor(options: T)` (`BatchSpanProcessorBase.d.mts:23`),
  i.e. `new BatchSpanProcessor({ exporter })`.
- **Recipe bug 2: no `http.route` in an ESM app.** With `node --import ./otel.mjs app.mjs` and `import express`, only
  `instrumentation-router` patches. Express itself is never patched. Result (scenario `-nohook`, UsageMap):
  `datapoint keys: ['error.type','http.request.method','http.response.status_code','network.protocol.version','url.scheme']`,
  `per route: {'GET <none> 200': 41, 'GET <none> 404': 8, 'GET <none> 500': 5}`. The fix is to register the ESM
  hook in `otel.mjs`: `register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)`. This needs
  `@opentelemetry/instrumentation` as a **direct** dependency under pnpm.
- With both fixes, UsageMap receives (`s06a-express-sdk -> UsageMap`):
  - **metrics only**, exactly one name: `http.server.request.duration`, unit `s`, explicit-bucket `histogram`,
    **CUMULATIVE**, scope `@opentelemetry/instrumentation-http@0.301.1`, no schemaUrl. Bounds
    `[0.005 … 10]` (14 semconv bounds). Total count 54. No exemplars.
  - Data-point keys: `error.type, http.request.method, http.response.status_code, http.route,
    network.protocol.version, url.scheme`. Routes: `/accounts/:id` (200×20, 404×5), `/assets/:code/:issuer`,
    `/boom` (500, `error.type="500"`), `/health`. The unmatched 404 has no `http.route`.
  - Canary values in the UsageMap payload: none.
  - **Resource**: `host.name, host.id, host.arch, os.*, process.owner` (the OS user name), `process.command_args`,
    `process.executable.path`, `process.command`, `process.pid`, `process.runtime.*`, `service.instance.id`,
    `telemetry.sdk.*`. These are the NodeSDK default detectors.
- APM got everything: 16 metric names (`nodejs.eventloop.*`, `v8js.*`), 54 SERVER + 158 INTERNAL spans. SERVER spans
  carry `client.address, network.peer.address/port, server.address/port, url.path, url.query, user_agent.original`,
  with the canary query, UA and Stellar address present.
- `OTEL_SEMCONV_STABILITY_OPT_IN=http/dup` was set in this scenario: still **stable only** (ignored, as claimed).
- **Boundary**: `0.220.0` emits `http.server.duration` **ms**, bounds `[0,5,…,10000]`, keys `http.flavor,
  http.method, http.route, http.scheme, http.status_code, net.host.name, net.host.port`. Its old-style spans carry
  `http.target` with the query, `http.url`, `http.user_agent` and `net.peer.ip`. `0.221.0` emits
  `http.server.request.duration` **s** with the stable keys. Both had no opt-in set.
- NodeSDK logs `OTEL_LOGS_EXPORTER is empty. Using default otlp exporter.`: a logs exporter to the env/default
  endpoint is created unless `OTEL_LOGS_EXPORTER=none` is set (run.sh sets it).

### 2. Next.js 16.4.6 + `@vercel/otel` 2.3.0 (in-SDK)

- The recipe compiles and runs as written. The UsageMap stand-in received **spans only, no metrics** (not at the APM
  either: `metrics=0 names`). There are no logs. Scope `next.js@16.4.6`, no schemaUrl. One SERVER span per request
  (54); there is no second SERVER span, because `@vercel/otel` does not add `instrumentation-http`.
- SERVER span keys: `error.type, http.method, http.route, http.status_code, http.target, next.route, next.rsc,
  next.span_category, next.span_name, next.span_type, operation.name, resource.name`. These are **old names**, as
  claimed. `http.target` holds the **raw URL including the query string**:
  `http.target=/accounts/GBRP…OX2H?cursor=canary-cursor-91&email=canary%40example.com`.
- `http.route` uses **Next's bracket syntax**: `/accounts/[id]`, `/assets/[code]/[issuer]`. The unmatched 404 has
  no route (span name `GET`). For the 500, `error.type="500"`, `http.status_code=500`, status `ERROR`. The span is
  the root span.
- Resource: `service.name, cloud.provider, node.env, process.runtime.name, vercel.runtime`. **No
  `service.instance.id`.**
- **Recipe as written sends all spans** (`-next-sdk-allspans -> UsageMap`: `INTERNAL: 271, SERVER: 54`, about 6 spans per
  request). With the `ServerSpansOnly` exporter wrapper it sends `SERVER: 54` only.
- **Spans lost on shutdown.** `next start` exits on SIGTERM (exit 143) without flushing. With two requests and then
  SIGTERM, **0 spans** arrived at either Collector, with or without a plain `process.once('SIGTERM')` flush. With
  `NEXT_MANUAL_SIG_HANDLE=true` and an awaited `forceFlush()` in `instrumentation.js` (exit 0), all spans arrived.
  (Also: `node_modules/.bin/next` is a pnpm shell shim that does not forward SIGTERM to the server process.)
- `@vercel/otel`'s bundled exporter identifies itself as `OTel-OTLP-Exporter-JavaScript/0.46.0`.

### 3. Python + FastAPI (in-SDK, recipe B.2)

- **Recipe bug 3: the UsageMap reader exports nothing.** The recipe filters by mutating `sm.metrics = …`. In SDK 1.45.2
  the point types are `@dataclass(frozen=True)` (`sdk/metrics/_internal/point.py` l.165–226), so each export logs
  `Exception while exporting metrics … dataclasses.FrozenInstanceError: cannot assign to field 'metrics'`. The fix
  is to build filtered copies with `dataclasses.replace`. The private `_preferred_temporality` and
  `_preferred_aggregation` attributes do exist in 1.45.2.
- **Recipe bug 4: the last interval is lost on every restart.** uvicorn 0.54.0 re-raises the captured
  SIGTERM/SIGINT after its graceful shutdown (`uvicorn/server.py` l.348–349, `signal.raise_signal`). The SDK's
  `atexit` shutdown therefore never runs, and nothing after the last periodic export is flushed. In the spike, runs
  shorter than the export interval delivered **nothing**. The fix is to call `provider.shutdown()` in the FastAPI
  `lifespan`. This also applies to `opentelemetry-instrument uvicorn …`.
- **Default mode (no opt-in), `-fastapi-default -> UsageMap`.**
  - `http.server.duration`, unit **ms**, explicit histogram, bounds `[0,5,…,10000]`, CUMULATIVE.
  - Schema `https://opentelemetry.io/schemas/1.11.0`, scope `opentelemetry.instrumentation.fastapi@0.66b2`.
  - Keys: `http.flavor, http.host, http.method, http.scheme, http.server_name, http.status_code, http.target,
    net.host.port`. `http.target` = the **route template** (`/accounts/{account_id}`), and it is absent for the
    unmatched 404.
  - **There is no `http.route` on the metric.** `http.host` (`host:port` from the Host header) is a cardinality and
    host leak.
  - Spans (APM only) carry `http.url` with the full query, `http.user_agent` and `net.peer.ip`.
- **Recipe filter as written** (stable name only) with default mode (`-fastapi-default-recipefilter`): **nothing at
  UsageMap** (no section in the summary).
- **`OTEL_SEMCONV_STABILITY_OPT_IN=http`, `-fastapi-stable -> UsageMap`.** `http.server.request.duration`, unit **s**,
  bounds `[0.005…10]`, CUMULATIVE, schema `1.21.0`. Keys `error.type, http.request.method, http.response.status_code,
  http.route, network.protocol.version, url.scheme`. Routes `/accounts/{account_id}`, `/assets/{code}/{issuer}`,
  `/boom`, `/health`. Personal-data keys: none.
- **Python attaches exemplars** (`traceId`, `spanId`, value; no `filteredAttributes`) to the UsageMap histogram points in
  both modes and in the tenant path. Node attached none.
- Resource: `service.name, service.instance.id, telemetry.sdk.*` only (zero-code adds `telemetry.auto.version`).
- APM also got `http.server.active_requests` and `http.server.response.size` / `.body.size`, so the filter leaves
  the APM reader intact.

### 4. Tenant-side Collector fan-out (recipe A), zero-code SDKs → tenant Collector → APM + UsageMap

- The recipe's config **loads and works on 0.165.0 as written**: the `metric_conditions`/`trace_conditions` keys
  are accepted, `keep_keys` on `datapoint.attributes` and `resource.attributes` in one statement list works, and
  `replace_pattern(span.attributes["http.target"], "\\?.*$", "")` works. The only warning is
  `"otlphttp" alias is deprecated; use "otlp_http" instead`.
- **Express zero-code** (`node --import @opentelemetry/auto-instrumentations-node/register app.mjs`) has the same
  ESM problem: in the first full run no `http.route` arrived (`GET <none> 200: 41 …`). `register.mjs` in 0.83.0
  does not register the loader hook. With `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` added
  (Node prints an ExperimentalWarning), UsageMap got `http.server.request.duration` with `http.route`, count 54.
- **FastAPI zero-code** (`opentelemetry-instrument uvicorn app:app`, default mode): UsageMap got `http.server.duration` ms
  with keys reduced to `http.method, http.status_code, http.target` (the route template). This is the old-mode
  fallback the recipe intended; it works.
- **Next.js** (only `'auto'`, env → tenant): UsageMap got SERVER spans only (54), keys `error.type, http.method,
  http.route, http.status_code, http.target, next.route`, and `http.target` **without the query**
  (`/accounts/GBRP…OX2H`).
- **The UsageMap branch shrank the resource to `service.name` (+ `service.instance.id`).** `host.name`, `process.owner`
  and `process.command_args` are gone. Requests to UsageMap carried `content-encoding: gzip` and `Authorization: Bearer
  <UsageMap token>` only.
- **Double source.** With `traces/scf` enabled as in the recipe, Express and FastAPI reached UsageMap as **both** metrics
  and SERVER spans. Adding `not IsMatch(resource.attributes["service.name"], "^s06a-next-")` to the span filter
  removed that (final run: Express/FastAPI → UsageMap `spans={}`; Next → `SERVER: 54`).

### 5. Header-leak test

| Scenario | `x-vendor-key: SECRET` seen at UsageMap? | Notes |
|---|---|---|
| Node sdk-node 0.301.1, exporters configured in code | **yes** | merged from `OTEL_EXPORTER_OTLP_HEADERS` |
| Python SDK 1.45.2, exporters configured in code | **yes** | same |
| `@vercel/otel` 2.3.0 `OTLPHttpProtoTraceExporter` in code | **no** | the `'auto'` (env) export to the APM had it |
| Tenant Collector (SDK env → tenant) | **no** | the header ends at the tenant Collector; UsageMap sees only the Collector's own headers |
| Env `authorization=Basic …` + code `Authorization: Bearer …` (Node and Python, `-envauth`) | UsageMap got **Bearer** | code wins over env, case-insensitively, in both SDKs; the env Basic credential went to the APM exporter, which has no code `Authorization` |

## Answer to the question

- **Node.js + Express: works, after two fixes.** UsageMap gets metrics only: `http.server.request.duration` (s, explicit
  histogram, cumulative), with `http.route` on metrics and spans **only if the ESM loader hook is registered**. The
  claim "stable only since instrumentation-http 0.221.0, opt-in ignored" is **confirmed** (0.220.0 → `http.server.duration`
  ms; 0.221.0 and 0.301.1 → stable; `http/dup` ignored on 0.301.1).
- **Next.js: works, after two fixes.** Spans only, old attribute names, `http.target` with the raw query: **confirmed**.
  New: the route is in bracket syntax (`/accounts/[id]`), there is no `service.instance.id`, there is no env-header
  leak, the recipe without a filter ships about 5 INTERNAL spans per request, and `next start` drops buffered spans
  on SIGTERM unless `NEXT_MANUAL_SIG_HANDLE=true` plus a flush is used.
- **Python + FastAPI: works, after two fixes.** The default is old conventions: `http.server.duration` ms, route
  template in `http.target`, no `http.route`, `http.host` on the metric. **Confirmed.** With
  `OTEL_SEMCONV_STABILITY_OPT_IN=http` it is stable and clean. The recipe's filter is broken in two ways: frozen
  dataclasses, and a stable-only name list.
- **Tenant Collector fan-out: works as written** (plus the deprecated exporter alias). It is the only pattern with
  no header leak and no host or process attributes at UsageMap. It still needs the Node ESM hook for routes, and
  per-service scoping of `traces/scf`.
- **Header merging hazard: confirmed** for Node and Python. It is **refuted for `@vercel/otel`**. A vendor
  `Authorization` in env does **not** override our bearer in Node or Python (the Rust behaviour was not tested here).

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)

- **ADR-0009 "SDK reality"**: confirmed for Node, Python and Next.js 16.4.6. Add to the text that Next's `http.route`
  uses `[param]` syntax. ADR-0012 / the normaliser must treat `[x]`, `{x}` and `:x` as template segments; all three
  were observed.
- **ADR-0009 allow-list and `scfsanitize`**: confirmed necessary. SDK-direct senders deliver `host.name`,
  `host.id`, `process.owner`, `process.command_args` and `process.executable.path` as **resource** attributes (Node
  default), and `http.host`/`http.server_name`/`net.host.port` on **metric data points** (Python old). The
  allow-list must drop them before the queue; it already lists `host.name`, `process.owner` and
  `process.command_line`. Add `host.id`, `process.command_args`, `process.command`, `process.executable.path`,
  `process.pid`, `os.*` and `http.host`/`http.server_name`/`net.host.*`. Exemplars arrive from Python; stripping
  them (c) is confirmed necessary.
- **ADR-0009 legacy metric handling**: Python old-mode metrics carry the route only in `http.target` (a template,
  not a raw path). Node 0.220 old-mode carries `http.route`. The ingest rule "`http.target` on `http.server.duration`
  = route template" holds for Python. For Next.js spans, `http.target` is the raw path plus query and must go
  through the normaliser.
- **C-22**: Next.js sends no `service.instance.id`. Span-derived streams are delta, so this is harmless, but nothing
  may assume the attribute exists. With the tenant Collector, express and FastAPI reached UsageMap as two stream groups
  (metrics + spans) until the span filter was scoped. C-22's "one preferred group" rule is exercised by exactly this
  case and must stay.
- **ADR-0009 header hazard paragraph**: correct for JS and Python. Add that `@vercel/otel` exporters do **not**
  merge env headers, and that in JS and Python a code `Authorization` beats an env `authorization`. The
  gateway-side rule (read only `Authorization`, never log other headers) is still needed: `x-vendor-key` really
  arrived.
- **Onboarding recipes (§A/§B.1/§B.2 of the recipe research)** must be replaced by the
  tested snippets below. The corrections, in order of impact:
  1. Python: no in-place mutation; filter both metric names.
  2. Node: `BatchSpanProcessor({ exporter })` (3.x).
  3. Node ESM: register the loader hook (in-SDK and zero-code).
  4. Python/uvicorn: flush in `lifespan`.
  5. Next.js: SERVER-only wrapper plus `NEXT_MANUAL_SIG_HANDLE=true` flush.
  6. Collector: `otlp_http`, image `0.165.0`, scope `traces/scf` per service.
- The Collector version pin in ADR-0009 / ADR-0023 says contrib v0.165.1; **the published image is 0.165.0**. Pin
  0.165.0 or build with `ocb` (S-04).

## Values the implementation must use (env vars, headers, config keys, flags, limits)

**Onboarding quickstarts (tested):**

**Recipe A: tenant Collector** (`otel/opentelemetry-collector-contrib:0.165.0`). This is `collectors/tenant.yaml`
with the stand-in endpoints replaced:

```yaml
receivers:
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }
processors:
  memory_limiter: { check_interval: 1s, limit_percentage: 80, spike_limit_percentage: 20 }
  batch: {}
  filter/scf_metrics_only_http_server:
    error_mode: ignore
    metric_conditions:
      - not (metric.name == "http.server.request.duration" or metric.name == "http.server.duration")
  transform/scf_minimal_metric_attrs:
    error_mode: ignore
    metric_statements:
      - keep_keys(datapoint.attributes, ["http.route", "http.request.method", "http.response.status_code", "error.type", "url.scheme", "network.protocol.version", "http.method", "http.status_code", "http.target"])
      - keep_keys(resource.attributes, ["service.name", "service.namespace", "service.version", "service.instance.id", "deployment.environment.name"])
  # span branch: only for services that emit no HTTP server metric (e.g. Next.js)
  filter/scf_server_spans_only:
    error_mode: ignore
    trace_conditions:
      - span.kind != SPAN_KIND_SERVER
      - not IsMatch(resource.attributes["service.name"], "^(my-next-app|my-other-span-only-svc)$")
  transform/scf_minimal_span_attrs:
    error_mode: ignore
    trace_statements:
      - replace_pattern(span.attributes["http.target"], "\\?.*$", "")
      - keep_keys(span.attributes, ["http.route", "http.request.method", "http.response.status_code", "error.type", "url.path", "url.scheme", "http.method", "http.status_code", "http.target", "next.route"])
      - keep_keys(resource.attributes, ["service.name", "service.namespace", "service.version", "service.instance.id", "deployment.environment.name"])
exporters:
  otlp_http/apm:
    endpoint: https://apm.example
    headers: { api-key: "${env:APM_API_KEY}" }
  otlp_http/scf:
    endpoint: https://ingest.scf.example
    headers: { Authorization: "Bearer ${env:SCF_OTLP_TOKEN}" }
    compression: gzip
    sending_queue: { enabled: true }
    retry_on_failure: { enabled: true }
service:
  pipelines:
    traces/apm:  { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp_http/apm] }
    metrics/apm: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp_http/apm] }
    logs/apm:    { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp_http/apm] }
    metrics/scf: { receivers: [otlp], processors: [memory_limiter, filter/scf_metrics_only_http_server, transform/scf_minimal_metric_attrs, batch], exporters: [otlp_http/scf] }
    traces/scf:  { receivers: [otlp], processors: [memory_limiter, filter/scf_server_spans_only, transform/scf_minimal_span_attrs, batch], exporters: [otlp_http/scf] }
```

Zero-code SDKs pointing at it:

- Node (ESM): `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 OTEL_LOGS_EXPORTER=none node
  --experimental-loader=@opentelemetry/instrumentation/hook.mjs --import @opentelemetry/auto-instrumentations-node/register app.mjs`
  (deps: `@opentelemetry/auto-instrumentations-node@0.83.0`, `@opentelemetry/instrumentation@0.301.1`).
- Python: `OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
  OTEL_SEMCONV_STABILITY_OPT_IN=http opentelemetry-instrument uvicorn app:app`, plus the `lifespan` flush below.

**Recipe B.1: Node.js / Express in-SDK.** `package.json` deps: `@opentelemetry/api@1.10.0`,
`@opentelemetry/sdk-node@0.301.1`, `@opentelemetry/auto-instrumentations-node@0.83.0`,
`@opentelemetry/instrumentation@0.301.1`, `@opentelemetry/sdk-metrics@3.1.1`, `@opentelemetry/sdk-trace@3.1.1`,
`@opentelemetry/exporter-metrics-otlp-proto@0.301.1`, `@opentelemetry/exporter-trace-otlp-proto@0.301.1`. Run with
`OTEL_LOGS_EXPORTER=none node --import ./otel.mjs app.mjs`. Leave `OTEL_EXPORTER_OTLP_*HEADERS` **unset**.

```js
// otel.mjs
import { register } from 'node:module';
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url); // ESM apps: without it, no http.route
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace';

const SCF_METRICS = ['http.server.request.duration', 'http.server.duration'];
function onlyHttpServer(inner) {            // UsageMap reader gets only the HTTP server duration metric
  return {
    export(rm, cb) {
      const scopeMetrics = rm.scopeMetrics
        .map((sm) => ({ ...sm, metrics: sm.metrics.filter((m) => SCF_METRICS.includes(m.descriptor.name)) }))
        .filter((sm) => sm.metrics.length > 0);
      if (scopeMetrics.length === 0) return cb({ code: 0 });
      inner.export({ ...rm, scopeMetrics }, cb);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
    selectAggregationTemporality: inner.selectAggregationTemporality?.bind(inner),
    selectAggregation: inner.selectAggregation?.bind(inner),
  };
}
const apmHeaders = { 'api-key': process.env.APM_API_KEY };
const sdk = new NodeSDK({
  serviceName: 'my-api',
  instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })],
  spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: 'https://apm.example/v1/traces', headers: apmHeaders }) })],
  metricReaders: [
    new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter({ url: 'https://apm.example/v1/metrics', headers: apmHeaders }) }),
    new PeriodicExportingMetricReader({
      exporter: onlyHttpServer(new OTLPMetricExporter({
        url: 'https://ingest.scf.example/v1/metrics',
        headers: { Authorization: `Bearer ${process.env.SCF_OTLP_TOKEN}` },
      })),
    }),
  ],
});
sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
```

**Recipe B.1-Next: Next.js 16.4.6 + `@vercel/otel` 2.3.0** (OTel JS 2.x: `@opentelemetry/sdk-trace-base@2.12.1`,
`@opentelemetry/api@1.10.0`). Run `next start` with **`NEXT_MANUAL_SIG_HANDLE=true`**, and start `node
node_modules/next/dist/bin/next start` directly (or make sure your process manager signals the node process).

```js
// instrumentation.js (or .ts)
import { registerOTel, OTLPHttpProtoTraceExporter } from '@vercel/otel';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanKind, trace } from '@opentelemetry/api';

class ServerSpansOnly {                       // UsageMap needs SERVER spans only
  constructor(inner) { this.inner = inner; }
  export(spans, done) {
    const server = spans.filter((s) => s.kind === SpanKind.SERVER);
    if (server.length === 0) return done({ code: 0 });
    this.inner.export(server, done);
  }
  shutdown() { return this.inner.shutdown(); }
  forceFlush() { return this.inner.forceFlush?.() ?? Promise.resolve(); }
}
export function register() {
  registerOTel({
    serviceName: 'my-next-app',
    spanProcessors: [
      'auto',                                  // existing export (Vercel or OTEL_EXPORTER_OTLP_* env)
      new BatchSpanProcessor(new ServerSpansOnly(new OTLPHttpProtoTraceExporter({
        url: 'https://ingest.scf.example/v1/traces',
        headers: { Authorization: `Bearer ${process.env.SCF_OTLP_TOKEN}` },
      }))),
    ],
  });
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_MANUAL_SIG_HANDLE === 'true') {
    process.once('SIGTERM', async () => {     // next start would exit without flushing
      const tp = trace.getTracerProvider();
      try { await (tp.getDelegate?.() ?? tp).forceFlush?.(); } finally { process.exit(0); }
    });
  }
}
```

**Recipe B.2: Python / FastAPI in-SDK.** `requirements.txt`: `opentelemetry-api==1.45.2 opentelemetry-sdk==1.45.2
opentelemetry-exporter-otlp-proto-http==1.45.2 opentelemetry-instrumentation-fastapi==0.66b2` (tested with
fastapi 0.162.5 and uvicorn 0.54.0). Set **`OTEL_SEMCONV_STABILITY_OPT_IN=http`** and leave
`OTEL_EXPORTER_OTLP_*HEADERS` **unset**.

```python
# otel_setup.py — import before the app starts serving
import os
from dataclasses import replace
from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricExporter, MetricExportResult, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

SCF_METRICS = ("http.server.request.duration", "http.server.duration")

class OnlyHttpServer(MetricExporter):
    """Forward only the HTTP server duration metric to UsageMap (point types are frozen: copy, never mutate)."""
    def __init__(self, inner):
        super().__init__(preferred_temporality=inner._preferred_temporality,
                         preferred_aggregation=inner._preferred_aggregation)
        self._inner = inner
    def export(self, metrics_data, timeout_millis: float = 10_000, **kw):
        rms = []
        for rm in metrics_data.resource_metrics:
            sms = [replace(sm, metrics=[m for m in sm.metrics if m.name in SCF_METRICS]) for sm in rm.scope_metrics]
            sms = [sm for sm in sms if sm.metrics]
            if sms:
                rms.append(replace(rm, scope_metrics=sms))
        if not rms:
            return MetricExportResult.SUCCESS
        return self._inner.export(replace(metrics_data, resource_metrics=rms), timeout_millis=timeout_millis)
    def force_flush(self, timeout_millis: float = 10_000) -> bool:
        return self._inner.force_flush(timeout_millis)
    def shutdown(self, timeout_millis: float = 30_000, **kw) -> None:
        self._inner.shutdown(timeout_millis=timeout_millis)

resource = Resource.create({"service.name": "my-api"})
apm_headers = {"api-key": os.environ["APM_API_KEY"]}
metrics.set_meter_provider(MeterProvider(resource=resource, metric_readers=[
    PeriodicExportingMetricReader(OTLPMetricExporter(endpoint="https://apm.example/v1/metrics", headers=apm_headers)),
    PeriodicExportingMetricReader(OnlyHttpServer(OTLPMetricExporter(
        endpoint="https://ingest.scf.example/v1/metrics",
        headers={"Authorization": f"Bearer {os.environ['SCF_OTLP_TOKEN']}"}))),
]))
tp = TracerProvider(resource=resource)
tp.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="https://apm.example/v1/traces", headers=apm_headers)))
trace.set_tracer_provider(tp)
```

```python
# app.py — flush on shutdown (uvicorn re-raises SIGTERM, so atexit never runs)
from contextlib import asynccontextmanager
from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

@asynccontextmanager
async def lifespan(_app):
    yield
    for p in (trace.get_tracer_provider(), metrics.get_meter_provider()):
        getattr(p, "shutdown", lambda: None)()

app = FastAPI(lifespan=lifespan)
FastAPIInstrumentor.instrument_app(app)
```

**For the UsageMap ingest side (observed values):**

- Metric names: `http.server.request.duration` (unit `s`, bounds `[0.005,0.01,0.025,0.05,0.075,0.1,0.25,0.5,0.75,1,2.5,5,7.5,10]`)
  and `http.server.duration` (unit `ms`, bounds `[0,5,10,25,50,75,100,250,500,750,1000,2500,5000,7500,10000]`).
  All observed points are explicit-bucket `histogram`, `AGGREGATION_TEMPORALITY_CUMULATIVE` (2).
- Scope names: `@opentelemetry/instrumentation-http` and `opentelemetry.instrumentation.fastapi`. Next.js spans use
  scope `next.js`. Schema URLs: Python old `…/schemas/1.11.0`, Python stable `…/schemas/1.21.0`; Node and Next send
  none.
- `error.type` on 5xx is the status code as a string (`"500"`). Unmatched routes have no `http.route` and no
  (Python-old) `http.target`, and must map to `(unmatched)`.
- Exporter user agents: `OTel-OTLP-Exporter-JavaScript/<ver>`, `OTel-OTLP-Exporter-Python/<ver>`,
  `OpenTelemetry Collector Contrib/<ver>`. The Collector path sends `content-encoding: gzip`.
- Tenant-facing env vars: `OTEL_SEMCONV_STABILITY_OPT_IN=http` (Python), `OTEL_LOGS_EXPORTER=none` (Node),
  `NEXT_MANUAL_SIG_HANDLE=true` (Next.js). For in-SDK dual export from Node/Python, `OTEL_EXPORTER_OTLP_HEADERS`
  and `OTEL_EXPORTER_OTLP_METRICS_HEADERS` must be unset.

## Open issues

- Not tested here: Go, Rust, Java and .NET (the Rust env-overrides-code `Authorization` hazard remains unverified);
  gRPC export; JSON encoding; declarative config (`OTEL_CONFIG_FILE`, recipe C); and the Collector's
  `bearertokenauth` variant.
- A tenant-side OTTL statement to clear exemplars was not tried. Python sends exemplars by default; the alternative
  `OTEL_METRICS_EXEMPLAR_FILTER=always_off` also affects the APM export.
- Recipe A's span filter needs the tenant to list span-only services by name. A cleaner rule ("drop spans of
  services that also send the metric") is not expressible in a stateless filter.
- `--experimental-loader` prints an ExperimentalWarning on Node 24. The in-file `module.register()` form (used in
  B.1) is the supported one. Whether a future `auto-instrumentations-node/register` registers the hook itself
  should be re-checked on upgrade.
- `NEXT_MANUAL_SIG_HANDLE=true` makes the app responsible for graceful HTTP shutdown. Platforms that already
  handle SIGTERM (or Vercel itself) were not tested.
- Node package versions are younger than the repo's `minimumReleaseAge` (3 days). Re-resolve them through the
  normal policy before the apps become e2e fixtures.
- Unmatched-route 404s (`/nope/...`) carry no route in every stack. Whether UsageMap should count
  them under `(unmatched)` or drop them is a product decision (ADR-0012).
