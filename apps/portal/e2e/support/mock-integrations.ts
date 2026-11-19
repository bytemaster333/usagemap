// SPDX-License-Identifier: Apache-2.0
// Mock answers of the integration catalogue (listIntegrations, getIntegrationStatus) for the portal's browser tests.
// It follows the contract where the portal depends on it: the oldest site and service by default, 404 for a foreign
// one, a site key filled into the generated text, `needs` with an empty setup when the target is missing, statuses
// per target computed from the mock state — dev-origin events of the site (`/__mock/dev-event`, what the edge
// reports for the web test curl) and the service's baseline-point counter (`/__mock/otlp-test-point`, what the
// metrics writer counts for the OTLP test curl). Every body is validated against the OpenAPI document by the server.

import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import { type Answer, MockProblem } from "./mock-extra.ts";

type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
}) => Answer;

export interface IntegrationsCtx {
  session(req: IncomingMessage): { userId: string };
  tenants(): Map<string, ControlPlane.Tenant & { members: Map<string, ControlPlane.TenantRole> }>;
  sites(): Map<string, ControlPlane.Site & { tenantId: string }>;
  services(): Map<string, ControlPlane.Service & { tenantId: string }>;
  devEvents(siteId: string): ControlPlane.DevEvent[];
  /** the site's script tag as getSnippet(format=html) answers it */
  scriptTag(site: ControlPlane.Site): { code: string; version: string };
}

export interface IntegrationsState {
  /** cumulative_first_point counters per service (today and yesterday) */
  baseline: Map<string, number>;
}

export const seedIntegrations = (): IntegrationsState => ({ baseline: new Map() });

const notFound = () => new MockProblem(404, "not_found", "Not found");
const INGEST = "https://ingest.example.invalid";
const OTLP = "https://otlp.example.invalid";

type Card = ControlPlane.Integration;
type Base = Omit<Card, "status" | "status_detail" | "recommended" | "needs" | "setup" | "test">;

function webTest(site: ControlPlane.Site | undefined, version: string): Card["test"] {
  const requires = [
    "localhost declared as a dev or preview origin of this website (one click below)",
  ];
  if (!site)
    return { kind: "web_dev_event", instructions: "", command: null, expect: [], requires };
  const body = JSON.stringify({
    v: 1,
    s: site.site_key,
    p: site.tracker_profile,
    tv: version,
    e: [{ id: "usagemap-test-event-01", k: "pv", u: "/usagemap-test" }],
  });
  return {
    kind: "web_dev_event",
    instructions: "Send one test page view from the dev origin localhost. It is never counted.",
    command: {
      title: "Test page view (never counted)",
      filename: null,
      language: "sh",
      code: `curl -sS -i '${INGEST}/v1/e' \\\n  -H 'Origin: http://localhost:5173' \\\n  -H 'Content-Type: text/plain;charset=UTF-8' \\\n  --data '${body}'`,
    },
    expect: [
      "HTTP 202 from the edge.",
      "The first-event panel lists a page view of /usagemap-test.",
    ],
    requires,
  };
}

function otlpTest(svc: ControlPlane.Service | undefined): Card["test"] {
  const requires = ["an ingest token of this project in the shell variable SCF_OTLP_TOKEN"];
  if (!svc) return { kind: "otlp_baseline", instructions: "", command: null, expect: [], requires };
  return {
    kind: "otlp_baseline",
    instructions: `Send one test data point for the service "${svc.service_name}". It is never counted.`,
    command: {
      title: "Test data point (never counted)",
      filename: null,
      language: "sh",
      code: `T=$(date +%s)000000000\ncurl -sS -i '${OTLP}/v1/metrics' \\\n  -H "Authorization: Bearer $SCF_OTLP_TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  --data-binary @- <<EOF\n{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"${svc.service_name}"}}]}}]}\nEOF`,
    },
    expect: ['HTTP 200 with {"partialSuccess":{}} = accepted.'],
    requires,
  };
}

const BASES: Base[] = [
  {
    id: "web_script_tag",
    group: "web",
    title: "Script tag (any website)",
    summary: "One pinned, Subresource-Integrity-protected tag in the <head>.",
    measures: ["Page views and visits"],
    privacy: ["No cookies and no visitor identifier stored in the browser."],
    availability: "ready",
    availability_note: null,
    target: "site",
    audiences: ["website", "dapp"],
    stacks: ["html", "any"],
    guide_path: "docs/onboarding/web-html.md",
    example_path: "examples/html",
    live_check: "dev_events",
  },
  {
    id: "wallet_wallets_kit",
    group: "wallets",
    title: "Stellar Wallets Kit",
    summary: "Connects, signatures and transaction submissions as closed-vocabulary events.",
    measures: ["Wallet funnel"],
    privacy: ["Never a wallet address, transaction or signature."],
    availability: "package_unpublished",
    availability_note: "The npm package is published together with the public repository.",
    target: "site",
    audiences: ["dapp"],
    stacks: ["javascript", "wallets-kit"],
    guide_path: "docs/onboarding/wallets.md",
    example_path: "examples/wallets-kit",
    live_check: "dev_events",
  },
  {
    id: "api_otel_node",
    group: "api",
    title: "OpenTelemetry: Node.js / Express",
    summary: "The tested dual-export recipe.",
    measures: ["Requests per route template"],
    privacy: ["Only the HTTP server request-duration metric is stored."],
    availability: "ready",
    availability_note: null,
    target: "service",
    audiences: ["api"],
    stacks: ["javascript", "node"],
    guide_path: "docs/onboarding/api-node-express.md",
    example_path: "examples/api-node-express",
    live_check: "otlp_baseline",
  },
  {
    id: "api_edge",
    group: "api",
    title: "Edge middleware (Cloudflare Workers, Vercel edge, Deno, Bun)",
    summary: "One dependency-free wrapper around your fetch handler.",
    measures: ["Requests per route template"],
    privacy: ["Only the HTTP server request-duration metric is stored."],
    availability: "beta",
    availability_note:
      "Built and tested in the repository; not yet run on the providers' platforms.",
    target: "service",
    audiences: ["api"],
    stacks: ["javascript", "cloudflare-workers"],
    guide_path: "docs/onboarding/api-cloudflare-workers.md",
    example_path: "examples/edge-cloudflare-workers",
    live_check: "otlp_baseline",
  },
  {
    id: "tool_cli",
    group: "tooling",
    title: "Stellar CLI plugin: stellar scf check",
    summary: "Offline dry run with the production sanitiser.",
    measures: ["Nothing: a local check, no data is sent"],
    privacy: ["Runs offline."],
    availability: "beta",
    availability_note: "Beta: build it from the repository.",
    target: "local",
    audiences: ["api"],
    stacks: ["cli", "any"],
    guide_path: null,
    example_path: "examples/stellar-scf-cli",
    live_check: "none",
  },
];

export function integrationsHandlers(
  c: IntegrationsCtx,
  state: () => IntegrationsState,
): Record<string, Handler> {
  const load = (req: IncomingMessage, tenantId: string, q: URLSearchParams) => {
    const s = c.session(req);
    const t = c.tenants().get(tenantId);
    if (!t?.members.has(s.userId) || t.status === "removed") throw notFound();
    const sites = [...c.sites().values()].filter((x) => x.tenantId === tenantId);
    const services = [...c.services().values()].filter((x) => x.tenantId === tenantId);
    const wantSite = q.get("site_id");
    const wantSvc = q.get("service_id");
    const site = wantSite ? sites.find((x) => x.site_id === wantSite) : sites[0];
    const svc = wantSvc ? services.find((x) => x.service_id === wantSvc) : services[0];
    if ((wantSite && !site) || (wantSvc && !svc)) throw notFound();
    const events = site ? c.devEvents(site.site_id) : [];
    const signals: ControlPlane.IntegrationStatusReport["signals"] = {
      site: site
        ? {
            site_id: site.site_id,
            dev_origins: site.dev_origins ?? [],
            dev_events_24h: events.length,
            wallet_dev_events_24h: events.filter((e) => e.kind === "stellar").length,
            test_events_24h: events.filter((e) => e.path === "/usagemap-test").length,
            last_dev_event_at: events[0]?.received_at ?? null,
            counted_7d: false,
            wallet_counted_7d: false,
            passkey_counted_7d: false,
            wallets_kit_seen_7d: false,
            rpc_counted_7d: false,
            app_events_7d: 0,
            app_stale_drops_2d: 0,
            app_reports_7d: 0,
          }
        : null,
      service: svc
        ? {
            service_id: svc.service_id,
            service_name: svc.service_name,
            baseline_points_2d: state().baseline.get(svc.service_id) ?? 0,
            reports_7d: state().baseline.get(svc.service_id) ?? 0,
            counted_7d: false,
          }
        : null,
      footprint_items: 0,
      public_stats: false,
    };
    return { site, svc, signals };
  };
  const statusOf = (b: Base, s: ControlPlane.IntegrationStatusReport["signals"]) => {
    const out = (status: ControlPlane.IntegrationStatus, detail: string) => ({
      id: b.id,
      status,
      detail,
    });
    if (b.target === "local") return out("not_observable", "Runs on your machine.");
    if (b.target === "service")
      return (s.service?.reports_7d ?? 0) > 0
        ? out("test_received", "Data reached the service, nothing counted yet.")
        : out("not_started", "Nothing received yet.");
    const n =
      b.group === "wallets" ? (s.site?.wallet_dev_events_24h ?? 0) : (s.site?.dev_events_24h ?? 0);
    return n > 0
      ? out("test_received", "Events from a dev origin in the last 24 hours (not counted).")
      : out("not_started", "No event received yet.");
  };

  return {
    listIntegrations: ({ req, p, q }) => {
      const { site, svc, signals } = load(req, p.tenantId as string, q);
      const tag = site ? c.scriptTag(site) : null;
      const integrations: Card[] = BASES.map((b) => {
        const st = statusOf(b, signals);
        const common = { ...b, status: st.status, status_detail: st.detail, recommended: null };
        if (b.target === "site") {
          if (!site || !tag)
            return {
              ...common,
              needs: "Add a website to this project first.",
              setup: [],
              test: webTest(undefined, "1.0.0"),
            };
          const setup: ControlPlane.IntegrationBlock[] =
            b.id === "web_script_tag"
              ? [
                  {
                    title: "Paste into the <head> of every page",
                    filename: null,
                    language: "html",
                    code: tag.code,
                  },
                ]
              : [
                  {
                    title: "Stellar Wallets Kit (2.x)",
                    filename: null,
                    language: "ts",
                    code: `import { init } from "@usagemap/tracker";\nimport { attachWalletsKit } from "@usagemap/tracker/wallets-kit";\n\ninit({ site: "${site.site_key}" });\nattachWalletsKit(StellarWalletsKit);`,
                  },
                ];
          return {
            ...common,
            recommended:
              b.id === "web_script_tag"
                ? "Start here: the fastest way to see your first event."
                : null,
            needs: null,
            setup,
            test: webTest(site, tag.version),
          };
        }
        if (b.target === "service") {
          if (!svc)
            return {
              ...common,
              needs: "Register an API service first.",
              setup: [],
              test: otlpTest(undefined),
            };
          return {
            ...common,
            needs: null,
            setup: [
              {
                title: "Environment",
                filename: ".env",
                language: "env",
                code: `OTEL_SERVICE_NAME=${svc.service_name}\nOTEL_EXPORTER_OTLP_ENDPOINT=${OTLP}\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20<INGEST_TOKEN>`,
              },
            ],
            test: otlpTest(svc),
          };
        }
        return {
          ...common,
          needs: null,
          setup: [
            {
              title: "Build it",
              filename: null,
              language: "sh",
              code: "go build ./tools/stellar-scf",
            },
          ],
          test: {
            kind: "local_command",
            instructions: "Check a captured payload.",
            command: {
              title: "Dry run",
              filename: null,
              language: "sh",
              code: "stellar scf check -f payload.json",
            },
            expect: ["KEPT / DROPPED sections."],
            requires: [],
          },
        };
      });
      return {
        status: 200,
        body: {
          tenant_id: p.tenantId as string,
          site: site
            ? {
                site_id: site.site_id,
                name: site.name,
                site_key: site.site_key,
                tracker_profile: site.tracker_profile,
                dev_origins: site.dev_origins ?? [],
              }
            : null,
          service: svc ? { service_id: svc.service_id, service_name: svc.service_name } : null,
          ingest_origin: INGEST,
          otlp_endpoint: OTLP,
          tracker_version: tag?.version ?? null,
          integrations,
        } satisfies ControlPlane.IntegrationCatalogue,
      };
    },
    getIntegrationStatus: ({ req, p, q }) => {
      const { signals } = load(req, p.tenantId as string, q);
      return {
        status: 200,
        body: {
          checked_at: new Date().toISOString(),
          signals,
          statuses: BASES.map((b) => statusOf(b, signals)),
        } satisfies ControlPlane.IntegrationStatusReport,
      };
    },
  };
}
