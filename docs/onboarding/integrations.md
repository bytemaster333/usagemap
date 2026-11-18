# Integrations: pick, configure, test, see it arrive

The portal's **Integrations** page (project → **Integrations**) lists every way to send data to UsageMap: websites,
wallets, APIs, mobile apps, on-chain registration and developer tools. Every integration works the same way:

1. **Pick** it. Filter by kind (websites, wallets, APIs, mobile apps, on-chain, developer tools) or type a stack such as
   `nextjs`, `python` or `workers`. Integrations that fit what we already see from your project are shown first.
2. **Copy the configuration.** It is generated for the website and API service you select, with your public site
   key and your service name already filled in. Ingest tokens are never shown here: they are shown once, when you
   create them under **Ingest tokens**. Configurations either contain the placeholder `<INGEST_TOKEN>` or read the
   token from the shell variable `SCF_OTLP_TOKEN`.
3. **Run the test command.** It sends one test event or data point through the same endpoint your app will use.
   **Test traffic is never counted** in any figure, dashboard, public statistic or snapshot.
4. **See it arrive.** Press **Start live check**, run the command, and the page shows the test arriving within
   seconds (websites) or about a minute (APIs, app events). Each card also links its guide and, where there is one,
   the minimal runnable app in [`examples/`](../../examples/README.md).

Each card also says what the integration measures, what it never sends, and how ready it is:

| Label | Meaning |
|---|---|
| Ready | Works against this deployment today. |
| From the repository | Works today; the npm package is published together with the public repository. Until then use the script tag or install from the repository. |
| Beta | Built and tested in the repository, but not yet run against the upstream tool or hosting platform itself. |

## Status

| Status | Meaning |
|---|---|
| Not started | Nothing has arrived for this website or service yet. |
| Test received | Something arrived and nothing has been counted yet: an event from a dev origin in the last 24 hours (websites, wallets), a data-quality entry for the service in the last 7 days (APIs), or a dropped app event of the website (mobile apps). |
| Live data seen | Counted events (websites, wallets), stored requests or client metrics (APIs), stored browser RPC totals, or accepted (self-attested) app events in the last 7 days. |
| Configured | Contracts or accounts are registered (on-chain); the statistics are public (badges). |
| Runs locally | A tool on your machine that sends nothing to UsageMap. |

The status belongs to the website or API service, not to one card: UsageMap cannot tell whether a page view came
from the script tag or from the npm package, so both cards of one website show the same status.

## How the website test works

The test command sends one page view of `/usagemap-test` with the header `Origin: http://localhost:5173`:

```sh
curl -sS -i 'https://<INGEST_HOST>/v1/e' \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: text/plain;charset=UTF-8' \
  --data '{"v":1,"s":"YOUR_22_CHAR_SITE_KEY","p":"standard","tv":"1.1.0","e":[{"id":"usagemap-test-event-01","k":"pv","u":"/usagemap-test"}]}'
```

- `localhost` must be a dev or preview origin of the website. The card adds it with one click. Events from dev
  origins are never forwarded, stored as analytics or counted. They appear only in the
  [first-event panel](dev-origins-and-debug.md) for 24 hours.
- The answer is `HTTP 202`. The panel then lists the page view as *would be rejected (`challenge_missing`)*. That
  is expected: the real tracker solves a small proof of work before it sends events, and curl does not. The test
  proves that the site key, the edge and your dev origin are right.
- Then open a page of your app on `localhost` with the snippet installed: it appears as *would be verified*.
  Once the snippet is live on your declared domain, the status changes to **Live data seen**.

**Wallet cards** (Privy, failed connects and WalletConnect) send the integration's own events instead, in the closed
vocabulary of the tracker, for example `{"k":"wl","sv":1,"n":"wallet_connect_failed","wt":"privy","net":"testnet",
"fr":"user_rejected","wc":"none"}`. They appear in the panel as wallet events, would be rejected for the same reason,
and turn the wallet card to *Test received*. The Wallets Kit, Freighter and passkey cards are tested in the browser:
run your app on `localhost`, connect a wallet on testnet and sign one transaction.

The **browser RPC** card sends the page view plus one RPC aggregate (`n: "stellar_rpc"`). A malformed aggregate
would cost the batch a `400`; from a dev origin a valid one is dropped in memory and never shown or stored, so the
page view is what you see arrive.

## How the API test works

The test command sends one OpenTelemetry data point for your service through the OTLP endpoint your SDK uses:

```sh
: "${SCF_OTLP_TOKEN:?export SCF_OTLP_TOKEN=<an ingest token of this project> first}"
T=$(date +%s)000000000
S=$(( $(date +%s) - 3600 ))000000000
curl -sS -i 'https://<OTLP_ENDPOINT>/v1/metrics' \
  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @- <<EOF
{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"my-api"}},{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[{"name":"http.server.request.duration","unit":"s","histogram":{"aggregationTemporality":2,"dataPoints":[{"attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"http.route","value":{"stringValue":"/usagemap-test"}},{"key":"http.response.status_code","value":{"intValue":"200"}}],"startTimeUnixNano":"$S","timeUnixNano":"$T","count":"1","sum":0.012,"bucketCounts":["0","1","0"],"explicitBounds":[0.005,0.025]}]}}]}]}]}
EOF
```

- Export an ingest token first (`export SCF_OTLP_TOKEN=…`); the command stops with a message otherwise.
- `HTTP 200` with `{"partialSuccess":{}}` means accepted. `401` means the token is missing or wrong; `403` means the
  project is pending or suspended; `429` or `503` means try again shortly.
- The point is a *cumulative* point from a new process id (`usagemap-test-…`) whose counter started an hour
  earlier. UsageMap never imports the history of a process it has not seen before: the first point of such a
  process only sets the starting value. The test point is therefore recorded as one **baseline point** in the
  service's data-quality table, and it adds no request, route or latency to any figure. Every run uses a new process
  id, so every run is a baseline point again.
- The live check compares the service's baseline-point count before and after the command. The API service's list
  of stream groups shows a `usagemap-test` group without data; it never becomes the preferred group.

Cards whose package exports its own metric (the Stellar SDK hooks for Node.js and Python, partner calls, x402/MPP
payments, the wallet-side anchor funnel and the Anchor Platform event listener) send their test point **in that
metric**, for example one `payment.server.events` counter or one `stellar.anchor.transfer.created` counter, with the
same fresh process id. It is a baseline point in the same way, and it also shows that this deployment accepts that
metric: a refused metric appears under another reason in the service's data-quality table.

## How the app-event test works (mobile apps)

The React Native and Flutter cards send one app event to `/v1/app-events` with your website's public key, timed two
days ago. The edge checks the key, the project, the content and the limits, then drops the event as `stale`:
`HTTP 202 {"accepted":0,"dropped":1}`. The live check compares the website's stale drops before and after. The test
is never counted as an event or a session. App counts are stored only once your deployment's operator has enabled
them (`edge_counter_features` lists `app`). The Telegram Mini App card uses the website test (a Mini App is a web
page).

## Badges and the pin Action

- **Badges:** the test fetches `…/public/v1/projects/<slug>/badge.json`. It answers `404` while the statistics are
  private and until the hourly public document has been built after you made them public, then `200` with the
  Shields.io document.
- **Pin Action:** from a clone of the repository, the test writes one page with this website's pinned tag and runs
  `tools/pin-action/run check` against this deployment's release list: `ok`, `0 error(s)`.

To check a payload of your own without sending it, use the Stellar CLI plugin card (`stellar scf check`).

## Related pages

- [Dev origins, debug mode and the first-event panel](dev-origins-and-debug.md)
- [Dual export next to your existing APM](api-dual-export.md)
- [Wallet events and adapters](wallets.md)
- [Registered Footprint](footprint.md)
- [Troubleshooting](troubleshooting.md)
