# @usagemap/partner-otel

OpenTelemetry metric for a backend's outbound calls to the HTTP APIs of SCF Integration List partners: Soroswap,
DeFindex, Trustless Work, Stellar Broker, Etherfuse, alfredpay, BlindPay, Bridge, Mercuryo, Koywe, Abroad,
Allbridge, SODAX and Aquarius. It emits `stellar.partner.call.duration` (s) with four closed attributes:
`stellar.partner`, `stellar.partner.operation` (route template), `stellar.partner.outcome` and `stellar.network`.
Calls to other hosts pass through untouched and are not measured. URLs, query strings, path ids, headers, bodies
and amounts are never recorded.

```ts
import { partnerFetch, instrumentPartnerAxios, recordPartnerCall } from "@usagemap/partner-otel";
const fetch = partnerFetch();                          // wraps globalThis.fetch
instrumentPartnerAxios(axios.create({ baseURL: "https://api.bridge.xyz/v0" }));
```

Options, the attribute table and the plain-OpenTelemetry recipe for other languages are in
[docs/onboarding/api-partner-calls.md](../../docs/onboarding/api-partner-calls.md). The partner table and its
sources are in `src/partners.ts`. The UsageMap Collector enforces the same table (step 4b,
`collector/processor/scfsanitizeprocessor/partner.go`; `TestPartnerTableMatchesPackage` keeps the two identical).

Tests: `pnpm --filter @usagemap/partner-otel test` (fetch against a local server standing in for the partner
hosts, axios through its real interceptors). `node scripts/collector-fixture.ts` regenerates the Collector's fixture
`testdata/sdk/partner-otel.metrics.json`.
