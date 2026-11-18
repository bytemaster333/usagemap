# `@usagemap/edge-otel`: UsageMap API analytics for edge runtimes

One wrapper around a fetch-style handler gives a **Cloudflare Worker, a Vercel Edge function, a Next.js route
handler, a Deno server or a Bun server** the one metric UsageMap stores for an API: `http.server.request.duration`
with **route templates** (`/sep24/transactions/{id}`, not `/sep24/transactions/7f8a2c1e`). The metric is exported as
OTLP/HTTP JSON to the project's UsageMap ingest. No runtime dependencies, about 46 kB unminified.

Cloudflare's own OTLP export sends traces only, with no `http.route` and no metrics. This package fills that gap.

> The package is not on npm yet. Until it is, build it from this
> repository (`pnpm --filter @usagemap/edge-otel build`) and vendor `dist/` or `npm pack` it.

## What leaves the runtime

Per request it keeps four values: the **method**, the **route**, the **status code** and the **duration**. They are
aggregated into one delta histogram per window (10 s by default), and each window is one export. The request's
query string, headers (IP address, `User-Agent`, cookies, `Authorization`), body and client address are **never
read**. `test/package.test.ts` checks the source for any access to them, and `test/runtimes.test.ts` sends canary
values for all of them and checks that none reaches the export.

The route is the matching template from `routes`. If no template matches, the path is **normalised exactly as the
UsageMap Collector would normalise it** (rule set `scf-path-rules/1.1.0`, [`packages/pathnorm`](../pathnorm/README.md)):

| Input | Becomes |
|---|---|
| a Stellar account, contract, pool… | `{account}`, `{contract}`, `{pool}` … |
| a transaction hash | `{hash}` |
| a number, a UUID | `{int}`, `{uuid}` |
| a secret seed, JWT, API key, e-mail, phone or IP address | `{redacted}` |
| a query string or fragment | removed |

Set `unmatched: "unknown"` to send no route for unmatched paths; they are then stored under `{unknown}`.

## Quickstart

You need three values from the portal (**Project → API services**):

- the ingest endpoint, e.g. `https://e1.usagemap.dev`;
- an ingest token `scfa_ing_…`, which is a secret;
- a registered service name.

The standard OpenTelemetry variables work, so the same settings serve any OTel SDK:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://e1.usagemap.dev
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20scfa_ing_…
OTEL_SERVICE_NAME=anchor-api
# or the shorter USAGEMAP_ENDPOINT / USAGEMAP_TOKEN / USAGEMAP_SERVICE_NAME (these win)
```

If any of the three is missing or invalid (for example `http://` to a non-local host), the wrapper **turns itself
off**. The handler then runs unchanged, and one `console.warn` gives the reason. Analytics never breaks the app.

### Cloudflare Workers

```ts
import { optionsFromEnv, withUsageMap } from "@usagemap/edge-otel";
import app from "./app";

export default withUsageMap(app, (env) => ({
  ...optionsFromEnv(env), // wrangler secret put OTEL_EXPORTER_OTLP_HEADERS
  routes: ["/.well-known/stellar.toml", "/auth", "/sep24/transactions/:id", "/sep12/customer"],
}));
```

The export is handed to `ctx.waitUntil`, so the response is never delayed.

### Vercel Edge function

```ts
export const config = { runtime: "edge" };
export default withUsageMap(handler, { ...optionsFromEnv(process.env), routes: ["/api/orders/[id]"] });
```

The request context's `waitUntil` is found and used.

### Next.js App Router route handlers (edge or Node runtime)

A route file handles one route, so give each handler its template. Use one shared instance, so that all handlers
share one batch:

```ts
// lib/usagemap.ts
import { waitUntil } from "@vercel/functions"; // on Vercel; elsewhere omit it
import { createUsageMap, optionsFromEnv } from "@usagemap/edge-otel";
export const usagemap = createUsageMap({ ...optionsFromEnv(process.env), waitUntil });

// app/api/items/[id]/route.ts
export const GET = usagemap.wrap(async (req, { params }) => Response.json(await load((await params).id)), {
  route: "/api/items/[id]",
});
```

**Next.js `middleware.ts` is not supported.** Middleware runs before the route and does not see the final status
code, so its timing is not the server's request duration.

### Deno

```ts
const usagemap = createUsageMap({ ...optionsFromEnv(Deno.env.toObject()), routes, flushTimer: true });
Deno.serve(usagemap.wrap(handler));
```

### Bun

```ts
Bun.serve(withUsageMap({ fetch: handler, port: 3000 }, { ...optionsFromEnv(Bun.env), routes, flushTimer: true }));
```

`this` and the `server` argument are passed through unchanged. On long-lived servers, set `flushTimer: true` so that
the last window is exported without waiting for another request. `await usagemap.shutdown()` on `SIGTERM` exports
what is left.

### Route template syntax

| Syntax | Example | Reported as |
|---|---|---|
| Express / Hono / itty | `/accounts/:id`, `/orders/:id?`, `/files/:path+` | `/accounts/{id}`, `/orders/{id}`, `/files/{wildcard}` |
| OpenAPI / chi | `/accounts/{accountId}` | `/accounts/{accountid}` |
| Next.js | `/items/[id]`, `/docs/[...slug]`, `/blog/[[...slug]]` | `/items/{id}`, `/docs/{slug}`, `/blog/{slug}` |
| catch-all | `/files/*` | `/files/{wildcard}` |

The reported route is the template as the Collector normalises an `http.route`: placeholder names are lower-cased,
and literal segments still pass every privacy rule. The most specific template wins: a literal beats a parameter,
and a parameter beats a catch-all.

## Options

| Option | Default | |
|---|---|---|
| `endpoint` / `metricsEndpoint` | — | OTLP base URL (`/v1/metrics` appended), or the full metrics URL |
| `token`, `serviceName` | — | required |
| `routes` | `[]` | route templates |
| `unmatched` | `"normalize"` | or `"unknown"` |
| `flushIntervalMs` | `10000` | delta window |
| `maxSeries` | `500` | export early at this many (method, route, status) series |
| `maxPendingBatches` | `2` | failed batches kept for a retry at the next flush (on 408/429/5xx or a network error); older ones are dropped and counted |
| `exportTimeoutMs` | `5000` | |
| `waitUntil` | from the runtime | a function that keeps the runtime alive |
| `flushTimer` | `false` | export on a timer too (long-lived servers only) |
| `enabled` / `warn` | `true` / `true` | |
| `onExportError` | — | called with `"HTTP 503"`, `"timeout"`, `"network error"`; never with data |

`usagemap.stats` gives `{ recorded, exportedBatches, failedExports, droppedBatches }`.

## Limits, stated

- **Workers clock.** `Date.now()` and `performance.now()` advance only across I/O, so durations are I/O-inclusive
  wall time. A handler that only uses CPU measures as 0.
- **Duration ends when the handler returns its `Response`.** The time to stream the body afterwards is not counted.
- **Delta windows held in memory.** An isolate that is evicted between windows loses at most that window's counts.
  On serverless runtimes without `waitUntil`, an export may be frozen with the instance.
- **One subrequest per export.** On Workers, the default window means at most one subrequest every 10 s per isolate.
- **The metric is self-reported.** Like every tenant telemetry source, it is labelled self-attested in UsageMap; it
  is not a verified figure.

## Tests

```sh
pnpm --filter @usagemap/edge-otel test        # unit, the shared pathnorm corpus, runtime shims
cd packages/edge-otel/conformance && GOWORK=off go test -count=1 ./...   # against the Go code (needs node)
```

- `test/pathnorm.test.ts` runs the shared corpus of `packages/pathnorm/testdata` (path, route and full-folding page
  vectors) through the TypeScript port.
- `test/runtimes.test.ts` reproduces the calling conventions of Workers, Vercel Edge, Next.js route handlers,
  `Deno.serve` and `Bun.serve` against a local OTLP receiver. No deploys are needed.
- `conformance/` checks the same outputs against the Go code itself, using `generate.ts` piped into Go with no
  files written:
  - the corpus plus 3,000 generated paths through `pathnorm.Normalize`, with no mismatch allowed, and every edge
    route a fixed point of the Collector's pass;
  - a Workers-style export through the real `scfsanitize` processor: every point kept, nothing dropped or redacted,
    and only `http.request.method`, `http.response.status_code`, `scf.route` and `scf.rules_version` stored.
