# Cloudflare Workers

> **Not yet measured end to end.** This page follows Cloudflare's documentation and the platform's ingest rules, but
> no Worker has sent data to the platform in our tests yet. Treat the first deploy as a test and check the API wizard.

Workers can export **traces** (and logs) over OTLP, configured in the Cloudflare dashboard and `wrangler` without any
code in the Worker. They cannot export metrics. UsageMap derives request counts, errors and latency from root SERVER spans,
so traces are what you send.

## 1. Create the destination (Cloudflare dashboard)

Cloudflare dashboard → **Workers & Pages** → **Observability** → **Destinations** → add a destination:

| Field | Value |
|---|---|
| Type | Traces |
| Name | `scf` |
| OTLP endpoint | `https://ingest.scf.example/v1/traces` |
| Custom header | `Authorization` = `Bearer scfa_ing_...` (your ingest token) |

Do **not** create a Logs destination pointing at UsageMap: logs are refused (`404`).

## 2. Turn it on for the Worker

```toml
# wrangler.toml
[observability.traces]
enabled = true
destinations = [ "scf" ]
head_sampling_rate = 1
persist = false
```

`head_sampling_rate = 1` sends every request's trace; with sampling, UsageMap's counts become estimates. `persist = false`
keeps Cloudflare from also storing the traces in its own observability store.

## 3. What to expect

- Cloudflare sends OTLP as JSON (it does not support the binary format). The platform's OTLP endpoint accepts JSON;
  this path is the one not yet exercised in our tests.
- Worker spans may not carry an `http.route`. Requests without a route are counted by their normalised path, or under
  `{unknown}`; identifier-shaped path segments (Stellar keys, hashes, numbers) are folded, and secret-shaped ones are
  redacted, before anything is stored.
- Check the portal's API wizard after deploying and sending a few requests. Its data-quality table says what was
  received and why anything was dropped. If nothing arrives, see [troubleshooting](troubleshooting.md#api-opentelemetry).

## Where this comes from

Cloudflare documentation, *Exporting OpenTelemetry data* and *OpenTelemetry export* (developers.cloudflare.com/workers/observability/,
read 2026-11-16): traces and logs only, no metrics; destinations with an OTLP endpoint and custom headers created in
the dashboard; `observability.traces` keys in `wrangler`; binary format not supported; `persist` defaults to true.
