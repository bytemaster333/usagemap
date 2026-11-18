# API: Next.js (`@vercel/otel`, SERVER spans only)

**Status (docs.quickstarts-run): measured in a spike, not yet against the real endpoint.** The UsageMap endpoint (OTLP front door, ingest tokens) is built and the Node, Python, Go and Rust recipes run against it in `tests/e2e/api/30-api.e2e.test.ts`; this recipe was measured only against the spike's stand-in endpoint. Source: `spikes/s06a-dual-export-node-python/README.md` §2 and
"Recipe B.1-Next" (app `apps/nextjs/instrumentation.js`). Read [api-common.md](api-common.md) first.

Measured with Next.js 16.4.6 and `@vercel/otel` 2.3.0: Next.js produces **spans only, no metrics**; one SERVER span per
request, old attribute names, `http.route` in bracket syntax (`/accounts/[id]`), and `http.target` holding the **raw
URL including the query string**. The platform converts bracket routes to `{id}` and strips queries (C-102), but send
SERVER spans only. `@vercel/otel`'s exporter does **not** merge `OTEL_EXPORTER_OTLP_HEADERS`.

## Dependencies (as tested)

`next@16.4.6`, `@vercel/otel@2.3.0`, `@opentelemetry/sdk-trace-base@2.12.1`, `@opentelemetry/api@1.10.0`.

## `instrumentation.js` (or `.ts`)

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

Run `next start` with **`NEXT_MANUAL_SIG_HANDLE=true`**, started as `node node_modules/next/dist/bin/next start` (the
pnpm shim `node_modules/.bin/next` does not forward SIGTERM to the server), or make sure your process manager signals
the node process.

## Pitfalls the spike hit

1. **Without the `ServerSpansOnly` wrapper** the recipe ships about five INTERNAL spans per request (271 INTERNAL vs 54
   SERVER in the run). The platform drops them, but they cost bandwidth and carry more attributes.
2. **Spans lost on shutdown:** `next start` exits on SIGTERM without flushing; with two requests and then SIGTERM, zero
   spans arrived. `NEXT_MANUAL_SIG_HANDLE=true` plus the awaited flush fixed it. With it, your app is responsible for
   graceful HTTP shutdown. Vercel's own runtime and platforms that already handle SIGTERM were **not** tested.
3. **No `service.instance.id`** is sent. Span-derived streams are delta, so this is harmless.
4. Unmatched 404s carry no route and are counted under `{unknown}`.

Alternative: the [tenant Collector](api-collector-fanout.md) with the Next.js service listed in the span filter.
