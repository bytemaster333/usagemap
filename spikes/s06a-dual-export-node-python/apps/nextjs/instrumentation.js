// SPDX-License-Identifier: Apache-2.0
// Recipe B.1 / Next.js (tested): keep the existing export ('auto') and add UsageMap as a second span processor.
import { registerOTel, OTLPHttpProtoTraceExporter } from '@vercel/otel';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanKind, trace } from '@opentelemetry/api';

// Forward only SERVER spans to UsageMap (UsageMap discards everything else anyway).
class ServerSpansOnly {
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
  const scf = new OTLPHttpProtoTraceExporter({
    url: `${process.env.SCF_OTLP_URL ?? 'https://ingest.scf.example'}/v1/traces`,
    headers: { Authorization: `Bearer ${process.env.SCF_OTLP_TOKEN}` },
  });
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'my-next-app',
    spanProcessors: process.env.S06A_NEXT_NO_SCF === '1'
      ? ['auto'] // spike: tenant-Collector scenario, single env-configured export
      : [
          'auto', // your existing export (Vercel, or OTEL_EXPORTER_OTLP_* env)
          new BatchSpanProcessor(process.env.S06A_NEXT_ALL_SPANS === '1' ? scf : new ServerSpansOnly(scf)),
        ],
  });
  // `next start` exits on SIGTERM without flushing, losing the last ~5 s of spans on every restart.
  // Run with NEXT_MANUAL_SIG_HANDLE=true so Next leaves SIGTERM to us, then flush and exit.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_MANUAL_SIG_HANDLE === 'true') {
    process.once('SIGTERM', async () => {
      const tp = trace.getTracerProvider();
      try { await (tp.getDelegate?.() ?? tp).forceFlush?.(); } finally { process.exit(0); }
    });
  }
}
