# Calls to SCF Integration List partners (Soroswap, DeFindex, Trustless Work, ramps, bridges)

Integration Track projects must integrate at least one building block from the SCF Integration List. This recipe
measures **your backend's calls to those partners' APIs**: how often, how fast, and with which result. It records the
partner, the route template, an outcome class and the network. The counts are self-reported by your backend and
labelled as such in the portal; on-chain metrics stay the authority.

**Never recorded:** the URL, the query string, ids in the path (vaults, orders, customers, addresses), headers (your
partner API key), request or response bodies, amounts.

## Node.js: `@usagemap/partner-otel`

```ts
import { partnerFetch } from "@usagemap/partner-otel";

const fetch = partnerFetch();          // wraps globalThis.fetch; other hosts pass through unmeasured
const r = await fetch("https://api.soroswap.finance/quote?network=testnet", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.SOROSWAP_API_KEY}` },
  body: JSON.stringify(quoteRequest),
});
```

With axios (e.g. a partner SDK that accepts your instance):

```ts
import axios from "axios";
import { instrumentPartnerAxios } from "@usagemap/partner-otel";

const bridge = axios.create({ baseURL: "https://api.bridge.xyz/v0" });
instrumentPartnerAxios(bridge);
```

The metric goes through your existing OpenTelemetry `MeterProvider`, which is the one you set up for your API in
the language guide ([Node.js](api-node-express.md)).

| Option | Use |
|---|---|
| `network` | The network your calls serve (`mainnet`, `testnet` or a passphrase). By default it comes from the host: production host → `mainnet`, sandbox host → `testnet`; Soroswap and DeFindex use their `network` query parameter. Otherwise it is `unknown` |
| `partner` | Force a partner id for a partner API behind your own proxy or custom domain |
| `meter` | Your own `Meter` instead of the global one |

`recordPartnerCall({ url, durationSeconds, status | error })` records one call that you timed yourself, with any
HTTP client.

## What is sent

`stellar.partner.call.duration` (histogram, seconds) with exactly four attributes:

| Attribute | Values |
|---|---|
| `stellar.partner` | `soroswap`, `defindex`, `trustless_work`, `stellar_broker`, `etherfuse`, `alfredpay`, `blindpay`, `bridge`, `mercuryo`, `koywe`, `abroad`, `allbridge`, `sodax`, `aquarius` |
| `stellar.partner.operation` | The partner's route template, e.g. `/quote`, `/vault/{id}/deposit`, `/escrow/{type}/fund-escrow`; `_OTHER` for a route not in the table |
| `stellar.partner.outcome` | `success` (2xx/3xx), `client_error`, `auth_error` (401/403), `not_found`, `rate_limited` (429), `server_error` (5xx), `timeout`, `network` |
| `stellar.network` | `mainnet`, `testnet`, `futurenet`, `local`, `unknown` |

The host and route table, with its sources (each partner's official SDK or API reference, read 2026-11-19), is
[`packages/partner-otel/src/partners.ts`](../../packages/partner-otel/src/partners.ts). The UsageMap Collector
enforces the same table and rewrites anything else to `_OTHER`.

Some building blocks are deliberately absent from the table:

- **Blend** and **Reflector** have no partner REST API. They are contracts, so register them in your footprint.
- **MoneyGram** and other SEP anchors are measured by `@usagemap/anchor-otel` ([anchors](anchors.md)).
- **Axelar**, **CCTP**, **LayerZero**, **NEAR Intents**, **Sushiswap** and **Templar** have no verified partner REST
  host.
- **alfredpay** has a published sandbox host only. For production, pass `partner: "alfredpay"` until its host is
  listed.

## Other languages: the plain OpenTelemetry recipe

UsageMap's Collector drops generic HTTP client metrics (`http.client.request.duration` without the Stellar marker),
because they carry full URLs or hosts of anything your backend calls. To measure partner calls from Python, Go, Java
or Rust, record the same histogram yourself around the partner client:

1. Create a histogram `stellar.partner.call.duration`, unit `s`.
2. After each call, record the elapsed seconds with exactly the four attributes above.
3. Take every value from the closed lists: the partner id from the exact API host, the operation from the template
   table (path segments compared; `{id}`/`{type}` match any one segment; anything else `_OTHER`), and the outcome
   from the status class.
4. Never derive an attribute from the URL text itself.

Python example (OpenTelemetry API):

```python
import time
from urllib.parse import urlsplit
from opentelemetry import metrics

hist = metrics.get_meter("my-backend").create_histogram("stellar.partner.call.duration", unit="s")
HOSTS = {"api.soroswap.finance": "soroswap", "api.defindex.io": "defindex"}   # from partners.ts
ROUTES = {"soroswap": {("quote",): "/quote", ("quote", "build"): "/quote/build"}}

def outcome(status: int) -> str:
    if 200 <= status < 400: return "success"
    if status in (401, 403): return "auth_error"
    if status == 404: return "not_found"
    if status == 429: return "rate_limited"
    return "client_error" if status < 500 else "server_error"

def measured(session, method, url, **kw):
    u = urlsplit(url)
    partner = HOSTS.get(u.hostname or "")
    t0 = time.perf_counter()
    try:
        r = session.request(method, url, **kw)
    except Exception:
        if partner:
            hist.record(time.perf_counter() - t0, {"stellar.partner": partner, "stellar.partner.operation": "_OTHER",
                        "stellar.partner.outcome": "network", "stellar.network": "unknown"})
        raise
    if partner:
        op = ROUTES.get(partner, {}).get(tuple(s for s in u.path.split("/") if s), "_OTHER")
        hist.record(time.perf_counter() - t0, {"stellar.partner": partner, "stellar.partner.operation": op,
                    "stellar.partner.outcome": outcome(r.status_code), "stellar.network": "testnet"})
    return r
```

## Storage status

The Collector step (`client_metric_sets: [partner]`) and the writer's storage for these metrics ship in the same
release: UsageMap stores them in their own tables, never as API usage, and the portal shows them per service. A host
that still runs an older release drops the points as `metric_not_allowed` and reports them to you in
`scf.ingest.dropped`.
