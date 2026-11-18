# Next.js route handlers: the first 10 minutes

**UsageMap-only.** Next.js produces **spans, not metrics**: one SERVER span per request with the route. UsageMap derives
request counts, errors and latency from the root SERVER spans and discards the spans themselves. Next.js needs an
`instrumentation.js` file to register anything, so there is a small file; the token stays in the environment.
Already export traces somewhere? See [dual export](api-dual-export.md).

| Minute | Step |
|---|---|
| 0–2 | Portal: **Add an API**, then **Ingest tokens** → create a token |
| 2–3 | Install three packages |
| 3–6 | Add `instrumentation.js` |
| 6–10 | Deploy with the environment below; the API wizard shows data after a minute |

## 1. Packages

```sh
pnpm add --save-exact @vercel/otel@2.3.0 @opentelemetry/sdk-trace-base@2.12.1 @opentelemetry/api@1.10.0
```

Measured with Next.js 16.4.6 by our test suite; `@vercel/otel` 2.3.0 and `@opentelemetry/api` 1.10.0 are the current
releases on npm (2026-11-16).

## 2. `instrumentation.js` (project root, or `src/`)

```js
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
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'my-next-app',
    spanProcessors: [
      new BatchSpanProcessor(new ServerSpansOnly(new OTLPHttpProtoTraceExporter({
        url: `${process.env.SCF_OTLP_ENDPOINT}/v1/traces`,
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

The `ServerSpansOnly` filter keeps the roughly five internal spans Next.js creates per request (and their attributes)
in your process; without it they would be sent and then dropped.

## 3. Environment

```sh
SCF_OTLP_ENDPOINT=https://ingest.scf.example
SCF_OTLP_TOKEN=scfa_ing_...
OTEL_SERVICE_NAME=my-next-app
NEXT_MANUAL_SIG_HANDLE=true
```

- On a self-hosted `next start`, start it as `node node_modules/next/dist/bin/next start` (the pnpm shim does not pass
  SIGTERM on) so the flush runs; otherwise the last spans are lost on every deploy.
- Do not also send the `http.server.request.duration` metric for the same service: it would count twice.

## 4. Check it

The API wizard shows requests per route (`/accounts/[id]` becomes `/accounts/{id}`), status codes and latency.
Nothing arrives? See [troubleshooting](troubleshooting.md#api-opentelemetry).

## Where this comes from

The `instrumentation.js` file is our measured recipe with the second (your APM) export removed; measured with Next.js
16.4.6, `@vercel/otel` 2.3.0 and `@opentelemetry/sdk-trace-base` 2.12.1. Package versions from the npm registry
(2026-11-16).
