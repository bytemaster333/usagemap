// SPDX-License-Identifier: Apache-2.0
// Test commands of the integration catalogue (step 3 of pick → config → test → live). Each one sends something through the
// tenant's real ingest path that is provably never counted, using mechanisms the platform already has — no test
// marker that a client could set on real traffic:
//
//   web  — one page view to `/v1/e` from a declared dev origin (`localhost`, wire-formats §a.8). A dev request is
//          never forwarded, spooled or counted; it lands only in the first-event panel (`web_dev_events`). curl
//          cannot solve the proof of work (§b.2), so the entry reads "would be rejected (challenge_missing)": the
//          test proves the site key, the edge and the dev origin, the tracker in a real page proves the rest.
//   OTLP — one cumulative `http.server.request.duration` point from a fresh `service.instance.id` whose stream
//          started an hour before the point. Under C-122 (wire-formats §g.4, metrics-writer `cumul.Step`) the first
//          point of an unseen source that started more than 10 minutes earlier only seeds the stream state and is
//          counted `cumulative_first_point` in the data-quality counters: it passes the gateway (token, tenant state,
//          allowed services), the Collector's sanitiser and the writer's service resolution, and adds nothing to any
//          metric. A fresh instance id per run keeps it a first point every time. Client-metric integrations (Stellar
//          SDK hooks, partner calls, payments, anchors) send one point of their own metric family instead
//          (OTLP_TEST_POINTS): the same rule holds for every cumulative stream the writer keeps (store/stellar.go,
//          store/integration.go), so the test also proves the Collector's allow-list for that family is on.
//   wallet — the web test with closed-vocabulary Stellar events (`wl`, `sv: 1`, §a.3.1) instead of the page view: a
//          dev entry of kind `stellar` each, which is what the wallet cards' status reads.
//   RPC  — the web test page view plus one browser RPC aggregate (§a.3.2). A malformed aggregate costs the batch a
//          400, so the 202 proves its shape; dev aggregates are dropped in memory by design (never stored, never in
//          the panel), so the page view is what arrives.
//   app  — one app event (§a.9) whose `ts` is two days old. The edge checks key, content type, shape, tenant state,
//          quota and rate limits, then drops the event as `stale`: `202 {"accepted":0,"dropped":1}` and one
//          `_dropped/reason/stale` cell in the self-attested daily counts, never an event or a session.
//   badge, pin — read-only public requests (the badge document; the release list the pin Action reads).
// Nothing here contains a secret: the ingest token is read from `$SCF_OTLP_TOKEN` in the user's shell.

export const OTLP_PLACEHOLDER = "https://<OTLP_ENDPOINT>";
export const INGEST_PLACEHOLDER = "https://<INGEST_HOST>";
/** The path every web test event carries; it is how a test entry is told apart in the first-event panel. */
export const WEB_TEST_PATH = "/usagemap-test";
/** The route every OTLP test point carries. */
export const OTLP_TEST_ROUTE = "/usagemap-test";
/** 22 characters of the event-id alphabet (wire-formats §a.3 `eventId`); dev batches skip duplicate detection. */
export const WEB_TEST_EVENT_ID = "usagemap-test-event-01";
/** The dev origin the web test claims (`localhost` matches any port, http or https, §a.8). */
export const WEB_TEST_ORIGIN = "http://localhost:5173";
/** How long before the point the test stream "started": more than the writer's 10-minute fresh window (C-122). */
export const OTLP_TEST_START_OFFSET_S = 3600;

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const base = (u: string | undefined, placeholder: string) => (u ?? placeholder).replace(/\/+$/, "");

/** One web-ingest event of a test batch (wire-formats §a.3): a page view, a Stellar event or an RPC aggregate. */
export type WebTestEvent = Record<string, unknown> & { id: string; k: "pv" | "wl"; u: string };

/** The page view every web test sends. */
export const WEB_TEST_PAGEVIEW: WebTestEvent = { id: WEB_TEST_EVENT_ID, k: "pv", u: WEB_TEST_PATH };

/** Closed-vocabulary Stellar test events (schema v1, §a.3.1); ids 02… so a batch never repeats one. */
export function stellarTestEvent(n: number, fields: Record<string, string>): WebTestEvent {
  return {
    id: `usagemap-test-event-${String(n).padStart(2, "0")}`,
    k: "wl",
    sv: 1,
    u: WEB_TEST_PATH,
    ...fields,
  };
}

/** One browser RPC aggregate cell per call kind the test claims (§a.3.2): [api, operation, network, outcome, latency, count]. */
export const RPC_TEST_AGGREGATE: WebTestEvent = {
  ...stellarTestEvent(2, { n: "stellar_rpc" }),
  c: [["rpc", "get_health", "testnet", "ok", "lt100ms", 1]],
};

export function webTestCurl(p: {
  ingestOrigin: string | undefined;
  siteKey: string;
  profile: "standard" | "strict";
  trackerVersion: string;
  events?: readonly WebTestEvent[];
}): string {
  const body = JSON.stringify({
    v: 1,
    s: p.siteKey,
    p: p.profile,
    tv: p.trackerVersion,
    e: p.events ?? [WEB_TEST_PAGEVIEW],
  });
  return [
    `curl -sS -i ${shellQuote(`${base(p.ingestOrigin, INGEST_PLACEHOLDER)}/v1/e`)} \\`,
    `  -H ${shellQuote(`Origin: ${WEB_TEST_ORIGIN}`)} \\`,
    "  -H 'Content-Type: text/plain;charset=UTF-8' \\",
    `  --data ${shellQuote(body)}`,
  ].join("\n");
}

/** Escapes text for an unquoted here-document, where only `\`, `$` and backquote are special. */
export function heredocEscape(s: string): string {
  return s.replace(/[\\$`]/g, "\\$&");
}

type Attr = readonly [key: string, value: string];

/**
 * The single data point of an OTLP test: one metric of a family the Collector keeps, from scope `usagemap-test`.
 * A histogram carries one observation in its middle bucket; a sum is a monotonic counter at 1. Both are cumulative,
 * so the writer's first-point rule (C-122) applies to either.
 */
export interface OtlpTestPoint {
  metric: string;
  unit: string;
  kind: "histogram" | "sum";
  attributes: readonly Attr[];
  /** histogram only; the bounds the emitting package uses */
  bounds?: readonly number[];
}

/** The test point of each metric family, with the closed values the emitting package sends (collector clientrules). */
export const OTLP_TEST_POINTS = {
  /** the HTTP server metric of every OpenTelemetry recipe */
  http: {
    metric: "http.server.request.duration",
    unit: "s",
    kind: "histogram",
    attributes: [
      ["http.request.method", "GET"],
      ["http.route", OTLP_TEST_ROUTE],
      ["http.response.status_code", "200"],
    ],
    bounds: [0.005, 0.025],
  },
  /** step 4a, @usagemap/stellar-otel and stellar-otel-py: one simulateTransaction outcome */
  stellar_client: {
    metric: "stellar.tx.simulations",
    unit: "{call}",
    kind: "sum",
    attributes: [
      ["stellar.sim.outcome", "success"],
      ["stellar.network", "testnet"],
    ],
  },
  /** step 4b, @usagemap/partner-otel: one Soroswap quote call */
  partner: {
    metric: "stellar.partner.call.duration",
    unit: "s",
    kind: "histogram",
    attributes: [
      ["stellar.partner", "soroswap"],
      ["stellar.partner.operation", "/quote"],
      ["stellar.partner.outcome", "success"],
      ["stellar.network", "testnet"],
    ],
    bounds: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  },
  /** step 4c, @usagemap/payments-otel: one x402 "payment required" answer */
  payments: {
    metric: "payment.server.events",
    unit: "{event}",
    kind: "sum",
    attributes: [
      ["payment.protocol", "x402"],
      ["payment.stage", "required"],
      ["payment.scheme", "exact"],
      ["payment.network", "stellar:testnet"],
    ],
  },
  /** step 4d, @usagemap/anchor-otel (wallet side): one resolved stellar.toml */
  anchor_wallet: {
    metric: "stellar.anchor.events",
    unit: "{event}",
    kind: "sum",
    attributes: [
      ["stellar.anchor.event", "toml_resolved"],
      ["stellar.sep", "1"],
      ["stellar.anchor.home_domain", "testanchor.stellar.org"],
      ["stellar.network", "testnet"],
    ],
  },
  /** step 4d, tools/ap-listener (Anchor Platform side): one SEP-24 deposit created */
  anchor_platform: {
    metric: "stellar.anchor.transfer.created",
    unit: "{transaction}",
    kind: "sum",
    attributes: [
      ["stellar.sep", "24"],
      ["stellar.anchor.kind", "deposit"],
      ["stellar.anchor.client", "wallet.example.org"],
      ["stellar.network", "testnet"],
    ],
  },
} as const satisfies Record<string, OtlpTestPoint>;
export type OtlpTestFamily = keyof typeof OTLP_TEST_POINTS;

function otlpAttr([k, v]: Attr): string {
  // the HTTP status code is an int attribute in the semantic conventions; everything else is a string
  const value = k === "http.response.status_code" ? { intValue: v } : { stringValue: v };
  return JSON.stringify({ key: k, value });
}

function otlpMetric(pt: OtlpTestPoint): string {
  const attrs = `"attributes":[${pt.attributes.map(otlpAttr).join(",")}]`;
  const times = '"startTimeUnixNano":"$S","timeUnixNano":"$T"';
  const head = `{"name":${JSON.stringify(pt.metric)},"unit":${JSON.stringify(pt.unit)},`;
  if (pt.kind === "sum")
    return `${head}"sum":{"aggregationTemporality":2,"isMonotonic":true,"dataPoints":[{${attrs},${times},"asInt":"1"}]}}`;
  const bounds = pt.bounds ?? [0.005, 0.025];
  const buckets = Array.from({ length: bounds.length + 1 }, (_, i) => (i === 1 ? '"1"' : '"0"'));
  return (
    `${head}"histogram":{"aggregationTemporality":2,"dataPoints":[{${attrs},${times},` +
    `"count":"1","sum":0.012,"bucketCounts":[${buckets.join(",")}],"explicitBounds":${JSON.stringify(bounds)}}]}}`
  );
}

/**
 * The OTLP test as a POSIX shell script: the JSON body is built in an unquoted here-document so the times and the
 * instance id are computed when it runs. The service name (any printable ASCII, the `api_services` check) is
 * JSON-encoded, then escaped for the here-document, so it reaches the payload byte for byte. Every other value is a
 * constant of OTLP_TEST_POINTS (no `$`, backquote or backslash).
 */
export function otlpTestCurl(p: {
  otlpEndpoint: string | undefined;
  serviceName: string;
  family?: OtlpTestFamily;
}): string {
  const svc = JSON.stringify(p.serviceName);
  const point = [
    '{"resourceMetrics":[{"resource":{"attributes":[',
    `{"key":"service.name","value":{"stringValue":${heredocEscape(svc)}}},`,
    '{"key":"service.instance.id","value":{"stringValue":"usagemap-test-$T-$$"}}]},',
    '"scopeMetrics":[{"scope":{"name":"usagemap-test"},"metrics":[',
    otlpMetric(OTLP_TEST_POINTS[p.family ?? "http"]),
    "]}]}]}",
  ].join("");
  return [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
    ': "${SCF_OTLP_TOKEN:?export SCF_OTLP_TOKEN=<an ingest token of this project> first}"',
    "T=$(date +%s)000000000",
    `S=$(( $(date +%s) - ${OTLP_TEST_START_OFFSET_S} ))000000000`,
    `curl -sS -i ${shellQuote(`${base(p.otlpEndpoint, OTLP_PLACEHOLDER)}/v1/metrics`)} \\`,
    '  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \\',
    "  -H 'Content-Type: application/json' \\",
    "  --data-binary @- <<EOF",
    point,
    "EOF",
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------ app events

/** How old the app test event is: beyond the edge's 24-hour window, so it is dropped as `stale` (§a.9). */
export const APP_TEST_AGE_S = 2 * 24 * 3600;
/** A fixed session id of the test (16–64 of [A-Za-z0-9_-]); a stale event never opens a session. */
export const APP_TEST_SESSION = "usagemap-test-session-01";
export const APP_TEST_EVENT = "usagemap_test";

export function appTestCurl(p: {
  ingestOrigin: string | undefined;
  siteKey: string;
  platform: "ios" | "android" | "web";
  sdkVersion: string;
}): string {
  const head = JSON.stringify({
    v: 1,
    k: p.siteKey,
    platform: p.platform,
    app_version: "0.0.0",
    sdk_version: p.sdkVersion,
  }).slice(0, -1);
  const event = `{"ts":$TS,"session":"${APP_TEST_SESSION}","name":"${APP_TEST_EVENT}"}`;
  return [
    `TS=$(( $(date +%s) - ${APP_TEST_AGE_S} ))000`,
    `curl -sS -i ${shellQuote(`${base(p.ingestOrigin, INGEST_PLACEHOLDER)}/v1/app-events`)} \\`,
    "  -H 'Content-Type: application/json' \\",
    "  --data-binary @- <<EOF",
    `${heredocEscape(head)},"events":[${event}]}`,
    "EOF",
  ].join("\n");
}

// ------------------------------------------------------------------------------------------------ public reads

export function badgeTestCurl(p: { portalOrigin: string; slug: string }): string {
  const url = `${p.portalOrigin.replace(/\/+$/, "")}/public/v1/projects/${encodeURIComponent(p.slug)}/badge.json`;
  return `curl -sS -i ${shellQuote(url)}`;
}

/**
 * Runs the pin Action locally (from a clone of the repository) on one page holding the card's own pinned tag, against
 * this deployment's release list and ingest hosts. `INPUT_MANIFEST-URL` is the variable name GitHub derives from the
 * input `manifest-url`; `env` sets it although the name has a hyphen.
 */
export function pinTestCommand(p: {
  portalOrigin: string;
  hosts: readonly string[];
  tag: string;
}): string {
  const manifest = `${p.portalOrigin.replace(/\/+$/, "")}/v1/tracker/versions`;
  return [
    "mkdir -p usagemap-pin-test",
    "cat > usagemap-pin-test/index.html <<'EOF'",
    p.tag,
    "EOF",
    `env ${shellQuote(`INPUT_MANIFEST-URL=${manifest}`)} ${shellQuote(`INPUT_HOSTS=${p.hosts.join(",")}`)} \\`,
    "  tools/pin-action/run check usagemap-pin-test",
  ].join("\n");
}
