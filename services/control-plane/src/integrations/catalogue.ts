// SPDX-License-Identifier: Apache-2.0
// The integration catalogue: every integration follows the same loop — pick → generated
// config → test → see it arrive live. This file is pure: the definitions (what each integration measures, what it
// never sends, which target it configures, how it is tested and checked live) and the rendering of each card's
// configuration and test command from the tenant's own rows. The handler (handlers.ts) supplies the rows.
//
// Reuse, so a card can never drift from the page that already generates the same text:
//   script tag, framework starters, wallet adapters — onboarding/kit.ts (held equal to getSnippet by its own tests);
//   OpenTelemetry per stack — api/otel.ts `otelConfig`, the text getOtelConfig returns;
//   test commands — test-commands.ts (web: dev-origin event; OTLP: cumulative baseline point; never counted).
// Secrets never appear: the site key is public (it is in every page's script tag); ingest tokens, share keys and
// operator keys stay placeholders or are read from the user's environment.
// Availability is stated honestly per card: `ready` (works against this deployment today), `package_unpublished`
// (works from the repository; the npm package is not on the registry yet), `beta` (built in the repository this
// week, not yet run against the upstream tool or runtime itself).

import { otelConfig, type Stack, TOKEN_PLACEHOLDER } from "../api/otel.ts";
import {
  frameworkSnippet,
  type KitCode,
  type KitSite,
  scriptTag,
  type TrackerPin,
  walletSnippets,
} from "../onboarding/kit.ts";
import type { KitFramework } from "../onboarding/registry.ts";
import {
  APP_TEST_EVENT,
  appTestCurl,
  badgeTestCurl,
  INGEST_PLACEHOLDER,
  OTLP_PLACEHOLDER,
  OTLP_TEST_POINTS,
  OTLP_TEST_ROUTE,
  type OtlpTestFamily,
  otlpTestCurl,
  pinTestCommand,
  RPC_TEST_AGGREGATE,
  stellarTestEvent,
  WEB_TEST_PAGEVIEW,
  WEB_TEST_PATH,
  type WebTestEvent,
  webTestCurl,
} from "./test-commands.ts";

export const GROUPS = ["web", "wallets", "api", "mobile", "onchain", "tooling"] as const;
export type Group = (typeof GROUPS)[number];
export const AUDIENCES = ["website", "dapp", "api", "anchor", "contracts", "devtool"] as const;
export type Audience = (typeof AUDIENCES)[number];
export type Availability = "ready" | "package_unpublished" | "beta";
export type Target = "site" | "service" | "tenant" | "local";
export type TestKind =
  | "web_dev_event"
  | "otlp_baseline"
  | "app_event"
  | "browser"
  | "local_command"
  | "portal";
export type LiveCheck =
  | "dev_events"
  | "otlp_baseline"
  | "app_events"
  | "public_badge"
  | "footprint"
  | "none";
export type Status =
  | "not_started"
  | "configured"
  | "test_received"
  | "live_data_seen"
  | "not_observable";

export interface Block {
  title: string;
  filename: string | null;
  language: "html" | "ts" | "js" | "sh" | "env" | "yaml" | "json" | "text" | "python" | "go";
  code: string;
}

export interface CardTest {
  kind: TestKind;
  instructions: string;
  command: Block | null;
  expect: string[];
  /** what must be in place before the test can arrive (shown as a checklist) */
  requires: string[];
}

export interface Card {
  id: string;
  group: Group;
  title: string;
  summary: string;
  measures: string[];
  privacy: string[];
  availability: Availability;
  availability_note: string | null;
  target: Target;
  audiences: Audience[];
  stacks: string[];
  guide_path: string | null;
  /** the minimal runnable app of this integration in the repository (examples/<name>), if there is one */
  example_path: string | null;
  /** set when the card cannot be generated yet (no website, no service, no active tracker version) */
  needs: string | null;
  setup: Block[];
  test: CardTest;
  live_check: LiveCheck;
}

export interface RenderCtx {
  site: (KitSite & { dev_origins: string[] }) | null;
  pin: TrackerPin | null;
  ingestOrigin: string | undefined;
  otlpEndpoint: string | undefined;
  service: { service_id: string; service_name: string } | null;
  portalOrigin: string;
  /** every ingest origin compiled into the active tracker version (the pin Action checks tags against them) */
  ingestOrigins: string[];
  /** the project: its public slug and whether its statistics are public (badges answer only then) */
  tenant: { slug: string; public_stats: boolean } | null;
}

interface Def {
  id: string;
  group: Group;
  title: string;
  summary: string;
  measures: string[];
  privacy: string[];
  availability: Availability;
  availability_note?: string;
  target: Target;
  audiences: Audience[];
  stacks: string[];
  guide_path: string | null;
  example_path: string | null;
  live_check: LiveCheck;
  render(ctx: RenderCtx): { needs: string | null; setup: Block[]; test: CardTest };
}

// ------------------------------------------------------------------------------------------------ shared texts

const NPM_UNPUBLISHED =
  "The npm package is published together with the public repository; until then use the script tag, which the live " +
  "ingest hosts serve, or install the package from the repository.";
const PRIVACY_WEB = [
  "No cookies and no visitor identifier stored in the browser; the IP address and User-Agent are used in memory only.",
  "The path is sent without its query string or fragment; page titles are never sent.",
];
const PRIVACY_WALLET = [
  "Never a wallet address, public key, transaction, signature or hash: only the event name and closed-vocabulary " +
    "values (wallet type, network, outcome class).",
  ...PRIVACY_WEB.slice(0, 1),
];
const PRIVACY_OTLP = [
  "Only the HTTP server request-duration metric is stored: method, route template, status code and duration.",
  "Never request or response bodies, headers, IP addresses, User-Agents, query strings or traces; logs are refused.",
  "Stellar secret seeds and addresses in paths are replaced by placeholders before anything is stored.",
];
const MEASURES_WEB = [
  "Page views and visits (verified and raw side by side)",
  "Referrer hosts, countries, screen classes and languages (standard profile)",
  "Custom events you name",
];
const MEASURES_API = [
  "Requests per route template, method and status class",
  "Latency percentiles (p50/p95/p99) and error rate",
  "Data-quality counters: what was dropped and why",
];

const NO_SITE = "Add a website to this project first.";
const NO_PIN = "No tracker version is active on this deployment yet.";
const NO_SERVICE = "Register an API service first (API services → Register a service).";
const MEASURES_APP = [
  "Named app events and their closed properties, per day, platform and app version",
  "Distinct sessions per day (an upper bound) and SDK versions",
];
const PRIVACY_APP = [
  "No device, install, advertising or user id and no wallet address: the request has no field for them, and the " +
    "edge never reads the User-Agent.",
  "Property values are short closed tokens; values shaped like keys, addresses or long numbers are dropped.",
  "Self-attested: kept apart from verified web figures, public statistics, snapshots and the Usage Map.",
];
const APP_NOTE =
  "Beta: the helper is copied from the repository (no package yet). App counts are stored once this deployment's " +
  "operator enables them (edge_counter_features lists app); a tenant view of them is not in the portal yet.";

const trackerPkg = (site: { tracker_profile: "standard" | "strict" }) =>
  site.tracker_profile === "strict" ? "@usagemap/tracker/strict" : "@usagemap/tracker";

const installBlock = (pin: TrackerPin): Block => ({
  title: "Install",
  filename: null,
  language: "sh",
  code: `pnpm add --save-exact @usagemap/tracker@${pin.version}`,
});

const appEndpoint = (ctx: RenderCtx) =>
  `${(ctx.ingestOrigin ?? INGEST_PLACEHOLDER).replace(/\/+$/, "")}/v1/app-events`;

function block(k: KitCode, language: Block["language"]): Block[] {
  const out: Block[] = [];
  if (k.install) out.push({ title: "Install", filename: null, language: "sh", code: k.install });
  out.push({ title: k.title, filename: k.filename, language, code: k.code });
  return out;
}

const empty = (needs: string, test: CardTest) => ({ needs, setup: [], test });

// ------------------------------------------------------------------------------------------------ web test steps

function webTest(ctx: RenderCtx, extra: string[] = []): CardTest {
  const requires = [
    "localhost declared as a dev or preview origin of this website (one click below)",
    ...extra,
  ];
  if (!ctx.site || !ctx.pin)
    return {
      kind: "web_dev_event",
      instructions: "",
      command: null,
      expect: [],
      requires,
    };
  return {
    kind: "web_dev_event",
    instructions:
      "Send one test page view from the dev origin localhost. Dev-origin events are never counted anywhere; they " +
      "only appear in the first-event panel below, within seconds.",
    command: {
      title: "Test page view (never counted)",
      filename: null,
      language: "sh",
      code: webTestCurl({
        ingestOrigin: ctx.ingestOrigin,
        siteKey: ctx.site.site_key,
        profile: ctx.site.tracker_profile,
        trackerVersion: ctx.pin.version,
      }),
    },
    expect: [
      "HTTP 202 from the edge.",
      `The first-event panel lists a page view of ${WEB_TEST_PATH}, "would be rejected (challenge_missing)": curl ` +
        "cannot solve the proof of work the tracker solves, so this proves the site key, the edge and the dev origin.",
      'Then open a page of your app on localhost with the snippet installed: it appears as "would be verified". ' +
        "Once the snippet is live on your declared domain, the status turns to live data seen.",
    ],
    requires,
  };
}

function browserTest(ctx: RenderCtx, what: string): CardTest {
  return {
    kind: "browser",
    instructions:
      `Run your app on localhost (a declared dev origin) with the tracker started, then ${what}. Use testnet: ` +
      "events from dev origins are never counted and appear in the first-event panel within seconds.",
    command: null,
    expect: [
      "The first-event panel lists the wallet events (kind stellar) with the verdict they would have had.",
      "With the tracker's debug mode (data-debug on the script tag, or init({ debug: true })) the browser console " +
        "explains every event that would not be counted.",
    ],
    requires: [
      "localhost declared as a dev or preview origin of this website (one click below)",
      ...(ctx.site ? [] : [NO_SITE]),
    ],
  };
}

/**
 * The web test with the integration's own events: closed-vocabulary Stellar events (each a dev entry of kind
 * `stellar`), or the page view plus an RPC aggregate. `what` names them in the instructions.
 */
function webEventsTest(
  ctx: RenderCtx,
  events: readonly WebTestEvent[],
  what: string,
  expect: string[],
): CardTest {
  const t = webTest(ctx);
  if (!t.command || !ctx.site || !ctx.pin) return t;
  return {
    ...t,
    instructions:
      `Send ${what} from the dev origin localhost, exactly as the integration would. Dev-origin events are never ` +
      "counted anywhere; they only appear in the first-event panel below, within seconds.",
    command: {
      title: "Test events (never counted)",
      filename: null,
      language: "sh",
      code: webTestCurl({
        ingestOrigin: ctx.ingestOrigin,
        siteKey: ctx.site.site_key,
        profile: ctx.site.tracker_profile,
        trackerVersion: ctx.pin.version,
        events,
      }),
    },
    expect: [
      "HTTP 202 from the edge (a value outside the closed vocabulary would be 400 for the whole batch).",
      ...expect,
      'curl cannot solve the proof of work the tracker solves, so every entry reads "would be rejected ' +
        '(challenge_missing)"; your app on localhost shows the verdict it would really get.',
    ],
  };
}

// ------------------------------------------------------------------------------------------------ app-event test

function appTest(ctx: RenderCtx, platform: "ios" | "android" | "web"): CardTest {
  const requires = [
    "app counts enabled on this deployment (the operator setting edge_counter_features lists app)",
  ];
  if (!ctx.site)
    return { kind: "app_event", instructions: "", command: null, expect: [], requires };
  return {
    kind: "app_event",
    instructions:
      "Send one test app event with this website's public key to the same endpoint your app uses. Its time is " +
      "two days old, so the edge checks the key, the project and the limits, then drops it as stale: it is " +
      "recorded as one dropped event and never counted as an event or a session.",
    command: {
      title: "Test app event (never counted)",
      filename: null,
      language: "sh",
      code: appTestCurl({
        ingestOrigin: ctx.ingestOrigin,
        siteKey: ctx.site.site_key,
        platform,
        sdkVersion: "usagemap-test/1.0.0",
      }),
    },
    expect: [
      'HTTP 202 with {"accepted":0,"dropped":1} = key and project are right. 404 unknown_site = wrong key; ' +
        "403 = project pending or suspended; 429 = retry later.",
      `Within about two minutes the live check below sees one more stale drop for this website (event ` +
        `${APP_TEST_EVENT}, not counted).`,
      "Events from your app then turn the status to live data seen (self-attested counts).",
    ],
    requires,
  };
}

// ------------------------------------------------------------------------------------------------ OTLP test steps

function otlpTest(ctx: RenderCtx, family: OtlpTestFamily = "http"): CardTest {
  const requires = [
    "an ingest token of this project in the shell variable SCF_OTLP_TOKEN (Ingest tokens → Create; shown once)",
  ];
  if (!ctx.service)
    return { kind: "otlp_baseline", instructions: "", command: null, expect: [], requires };
  return {
    kind: "otlp_baseline",
    instructions:
      `Send one test data point for the service "${ctx.service.service_name}" through the same endpoint your SDK ` +
      "uses" +
      (family === "http"
        ? ""
        : `, in the metric this integration exports (${OTLP_TEST_POINTS[family].metric}), so it also shows that ` +
          "UsageMap accepts that metric") +
      ". It is a cumulative baseline point from a fresh process id: UsageMap records that it arrived and keeps " +
      "it only as a starting point, so it never adds anything to any figure.",
    command: {
      title: "Test data point (never counted)",
      filename: null,
      language: "sh",
      code: otlpTestCurl({
        otlpEndpoint: ctx.otlpEndpoint,
        serviceName: ctx.service.service_name,
        family,
      }),
    },
    expect: [
      'HTTP 200 with {"partialSuccess":{}} = accepted. 401 = token missing or wrong; 403 = project pending or ' +
        "suspended; 429/503 = retry later.",
      `Within about a minute the live check below sees one more "baseline point" for this service ` +
        (family === "http"
          ? `(route ${OTLP_TEST_ROUTE}, not counted). The API dashboard does not change.`
          : "(not counted). No panel of the service changes; any other drop reason in its data-quality table " +
            "names what was refused."),
      "Real traffic from your SDK then turns the status to live data seen.",
    ],
    requires,
  };
}

function localTest(command: Block, expect: string[], instructions: string): CardTest {
  return { kind: "local_command", instructions, command, expect, requires: [] };
}

// ------------------------------------------------------------------------------------------------ definitions

/** The examples of the OpenTelemetry recipes (examples/README.md, "APIs and backends"). */
const OTEL_EXAMPLES: Partial<Record<Stack, string>> = {
  node: "examples/api-node-express",
  fastapi: "examples/api-python-fastapi",
  go: "examples/api-go-nethttp",
  rust: "examples/api-rust-axum",
  java: "examples/api-java-spring",
};

const FRAMEWORKS: Array<{
  id: string;
  fw: KitFramework;
  title: string;
  stacks: string[];
  language: Block["language"];
  example: string;
}> = [
  {
    id: "web_nextjs",
    fw: "nextjs",
    title: "Next.js",
    stacks: ["javascript", "react", "nextjs"],
    language: "ts",
    example: "examples/nextjs",
  },
  {
    id: "web_nuxt",
    fw: "nuxt",
    title: "Nuxt",
    stacks: ["javascript", "vue", "nuxt"],
    language: "ts",
    example: "examples/nuxt",
  },
  {
    id: "web_sveltekit",
    fw: "sveltekit",
    title: "SvelteKit",
    stacks: ["javascript", "svelte"],
    language: "html",
    example: "examples/sveltekit",
  },
  {
    id: "web_astro",
    fw: "astro",
    title: "Astro",
    stacks: ["javascript", "astro"],
    language: "html",
    example: "examples/astro",
  },
  {
    id: "web_react_spa",
    fw: "react_spa",
    title: "React single-page app (Vite)",
    stacks: ["javascript", "react", "vite"],
    language: "ts",
    example: "examples/vite-react",
  },
];

const defs: Def[] = [
  {
    id: "web_script_tag",
    group: "web",
    title: "Script tag (any website)",
    summary:
      "One pinned, Subresource-Integrity-protected tag in the <head>. Works on any site, framework or builder.",
    measures: MEASURES_WEB,
    privacy: PRIVACY_WEB,
    availability: "ready",
    target: "site",
    audiences: ["website", "dapp", "devtool", "anchor"],
    stacks: ["html", "any"],
    guide_path: "docs/onboarding/web-html.md",
    example_path: "examples/html",
    live_check: "dev_events",
    render: (ctx) =>
      !ctx.site
        ? empty(NO_SITE, webTest(ctx))
        : !ctx.pin
          ? empty(NO_PIN, webTest(ctx))
          : {
              needs: null,
              setup: [
                {
                  title: "Paste into the <head> of every page",
                  filename: null,
                  language: "html",
                  code: scriptTag(ctx.pin, ctx.site.site_key),
                },
              ],
              test: webTest(ctx),
            },
  },
  {
    id: "web_npm",
    group: "web",
    title: "npm package (any bundler)",
    summary: "The same tracker as an ES module; start it once in the browser.",
    measures: MEASURES_WEB,
    privacy: PRIVACY_WEB,
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "site",
    audiences: ["website", "dapp", "devtool"],
    stacks: ["javascript"],
    guide_path: "docs/onboarding/README.md",
    example_path: "examples/vite-react",
    live_check: "dev_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, webTest(ctx));
      if (!ctx.pin) return empty(NO_PIN, webTest(ctx));
      const pkg =
        ctx.site.tracker_profile === "strict" ? "@usagemap/tracker/strict" : "@usagemap/tracker";
      return {
        needs: null,
        setup: [
          {
            title: "Install",
            filename: null,
            language: "sh",
            code: `pnpm add --save-exact @usagemap/tracker@${ctx.pin.version}`,
          },
          {
            title: "Start the tracker once, in the browser",
            filename: null,
            language: "ts",
            code: `import { init } from "${pkg}";\n\ninit({ site: "${ctx.site.site_key}" });`,
          },
        ],
        test: webTest(ctx),
      };
    },
  },
  ...FRAMEWORKS.map(
    (f): Def => ({
      id: f.id,
      group: "web",
      title: f.title,
      summary: `The tested ${f.title} starter: started once, client-side navigations followed automatically.`,
      measures: MEASURES_WEB,
      privacy: PRIVACY_WEB,
      availability: f.fw === "astro" ? "ready" : "package_unpublished",
      ...(f.fw === "astro" ? {} : { availability_note: NPM_UNPUBLISHED }),
      target: "site",
      audiences: ["website", "dapp", "devtool"],
      stacks: f.stacks,
      guide_path: `docs/onboarding/web-${f.fw === "react_spa" ? "react-spa" : f.fw}.md`,
      example_path: f.example,
      live_check: "dev_events",
      render: (ctx) =>
        !ctx.site
          ? empty(NO_SITE, webTest(ctx))
          : !ctx.pin
            ? empty(NO_PIN, webTest(ctx))
            : {
                needs: null,
                setup: block(frameworkSnippet(f.fw, ctx.site, ctx.pin), f.language),
                test: webTest(ctx),
              },
    }),
  ),
  {
    id: "web_react_router",
    group: "web",
    title: "React Router (framework mode) / Remix",
    summary:
      "Start the tracker after hydration in app/root.tsx; History API navigations are followed.",
    measures: MEASURES_WEB,
    privacy: PRIVACY_WEB,
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "site",
    audiences: ["website", "dapp"],
    stacks: ["javascript", "react", "react-router"],
    guide_path: "docs/onboarding/web-react-router.md",
    example_path: "examples/react-router",
    live_check: "dev_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, webTest(ctx));
      if (!ctx.pin) return empty(NO_PIN, webTest(ctx));
      const pkg =
        ctx.site.tracker_profile === "strict" ? "@usagemap/tracker/strict" : "@usagemap/tracker";
      return {
        needs: null,
        setup: [
          {
            title: "Install",
            filename: null,
            language: "sh",
            code: `pnpm add --save-exact @usagemap/tracker@${ctx.pin.version}`,
          },
          {
            title: "Start it once, after hydration",
            filename: "app/root.tsx (excerpt)",
            language: "ts",
            code: [
              'import { useEffect } from "react";',
              `import { init } from "${pkg}";`,
              "",
              "export default function App() {",
              `  useEffect(() => void init({ site: "${ctx.site.site_key}" }), []);`,
              "  return <Outlet />;",
              "}",
            ].join("\n"),
          },
        ],
        test: webTest(ctx),
      };
    },
  },
  {
    id: "web_static_generators",
    group: "web",
    title: "Static site generators and docs sites (Eleventy, Hugo, Jekyll, Docusaurus)",
    summary:
      "The pinned tag in the base layout's <head>, exactly as copied; Docusaurus through `scripts`.",
    measures: MEASURES_WEB,
    privacy: PRIVACY_WEB,
    availability: "ready",
    target: "site",
    audiences: ["website", "devtool"],
    stacks: ["html", "eleventy", "hugo", "jekyll", "docusaurus"],
    guide_path: "docs/onboarding/web-static-site-generators.md",
    example_path: "examples/eleventy",
    live_check: "dev_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, webTest(ctx));
      if (!ctx.pin) return empty(NO_PIN, webTest(ctx));
      const s = ctx.site;
      const pin = ctx.pin;
      return {
        needs: null,
        setup: [
          {
            title: "Eleventy, Hugo, Jekyll: the base layout's <head>",
            filename: null,
            language: "html",
            code: scriptTag(pin, s.site_key),
          },
          {
            title: "Docusaurus",
            filename: "docusaurus.config.js (excerpt)",
            language: "js",
            code: [
              "export default {",
              "  scripts: [",
              "    {",
              `      src: ${JSON.stringify(pin.src)},`,
              `      integrity: ${JSON.stringify(pin.integrity)},`,
              '      crossorigin: "anonymous",',
              `      "data-site": ${JSON.stringify(s.site_key)},`,
              "      defer: true,",
              "    },",
              "  ],",
              "};",
            ].join("\n"),
          },
        ],
        test: webTest(ctx),
      };
    },
  },
  {
    id: "web_cms",
    group: "web",
    title: "Site builders and CMSs (WordPress, Webflow, Framer, Ghost)",
    summary: "Paste the tag into the site-wide head code; nothing to install.",
    measures: MEASURES_WEB,
    privacy: PRIVACY_WEB,
    availability: "ready",
    target: "site",
    audiences: ["website"],
    stacks: ["nocode", "wordpress", "webflow", "framer", "ghost"],
    guide_path: "docs/onboarding/web-cms.md",
    example_path: null,
    live_check: "dev_events",
    render: (ctx) =>
      !ctx.site
        ? empty(NO_SITE, webTest(ctx))
        : !ctx.pin
          ? empty(NO_PIN, webTest(ctx))
          : {
              needs: null,
              setup: block(frameworkSnippet("nocode", ctx.site, ctx.pin), "html"),
              test: webTest(ctx, [
                "builders preview on their own host: add it as a dev origin too (for example myapp-*.webflow.io)",
              ]),
            },
  },
  // -------------------------------------------------------------------------------------------- wallets
  {
    id: "wallet_wallets_kit",
    group: "wallets",
    title: "Stellar Wallets Kit",
    summary:
      "Connects, signature requests and outcomes and submissions from every kit wallet module, as closed-vocabulary " +
      "events; restored sessions reported as restored, never as new connections.",
    measures: [
      "Wallet funnel: modal opened → wallet selected → connected → sign requested → approved/rejected → submitted",
      "Wallet types and networks used",
    ],
    privacy: PRIVACY_WALLET,
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "site",
    audiences: ["dapp"],
    stacks: ["javascript", "wallets-kit"],
    guide_path: "docs/onboarding/wallets.md",
    example_path: "examples/wallets-kit",
    live_check: "dev_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, browserTest(ctx, "connect a wallet"));
      if (!ctx.pin) return empty(NO_PIN, browserTest(ctx, "connect a wallet"));
      const [kit] = walletSnippets(ctx.site, ctx.pin);
      return {
        needs: null,
        setup: [
          ...block(kit as KitCode, "ts"),
          {
            title:
              "Optional: if your app also calls a kit wallet module directly, wrap the modules where the kit is " +
              "initialised (still counted once with attachWalletsKit)",
            filename: null,
            language: "ts",
            code: [
              'import { wrapWalletsKitModules } from "@usagemap/tracker/wallets-kit";',
              'import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";',
              "",
              "StellarWalletsKit.init({ modules: wrapWalletsKitModules(defaultModules()) });",
            ].join("\n"),
          },
        ],
        test: browserTest(ctx, "connect a wallet on testnet and sign one transaction"),
      };
    },
  },
  {
    id: "wallet_freighter",
    group: "wallets",
    title: "Freighter (and other wallets called directly)",
    summary:
      "Wrap the wallet API object once and use the wrapped one; Albedo, xBull, LOBSTR, Hana and HOT likewise.",
    measures: ["Wallet funnel events from the wrapped wallet", "Outcome classes of sign requests"],
    privacy: PRIVACY_WALLET,
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "site",
    audiences: ["dapp"],
    stacks: ["javascript", "freighter"],
    guide_path: "docs/onboarding/wallets.md",
    example_path: "examples/freighter",
    live_check: "dev_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, browserTest(ctx, "connect Freighter"));
      if (!ctx.pin) return empty(NO_PIN, browserTest(ctx, "connect Freighter"));
      const snippets = walletSnippets(ctx.site, ctx.pin);
      return {
        needs: null,
        setup: [
          ...block(snippets[1] as KitCode, "ts"),
          ...block({ ...(snippets[2] as KitCode), install: null }, "ts"),
        ],
        test: browserTest(ctx, "connect Freighter on testnet and sign one transaction"),
      };
    },
  },
  {
    id: "wallet_passkeys",
    group: "wallets",
    title: "Passkey wallets and smart accounts (passkey-kit, smart-account-kit)",
    summary: "Smart-wallet creation and each passkey ceremony, from the library's own events.",
    measures: ["Smart wallets created", "Passkey ceremonies (register, authenticate, sign)"],
    privacy: [
      "The libraries' payloads carry the user's C… address; the adapter reads only the event name.",
      ...PRIVACY_WALLET.slice(1),
    ],
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "site",
    audiences: ["dapp"],
    stacks: ["javascript", "passkeys"],
    guide_path: "docs/onboarding/wallets.md",
    example_path: "examples/passkey",
    live_check: "dev_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, browserTest(ctx, "create or use a passkey wallet"));
      if (!ctx.pin) return empty(NO_PIN, browserTest(ctx, "create or use a passkey wallet"));
      return {
        needs: null,
        setup: [
          {
            title: "Install",
            filename: null,
            language: "sh",
            code: `pnpm add --save-exact @usagemap/tracker@${ctx.pin.version}`,
          },
          {
            title: "passkey-kit (0.20.0)",
            filename: null,
            language: "ts",
            code: [
              'import { attachPasskeyKit } from "@usagemap/tracker/passkey";',
              "",
              "attachPasskeyKit(passkeyKit); // your PasskeyKit instance",
            ].join("\n"),
          },
          {
            title: "smart-account-kit (0.10.0)",
            filename: null,
            language: "ts",
            code: [
              'import { attachSmartAccountKit } from "@usagemap/tracker/passkey";',
              "",
              "attachSmartAccountKit(smartAccountKit); // your SmartAccountKit instance",
            ].join("\n"),
          },
        ],
        test: browserTest(ctx, "create a smart wallet or sign in with a passkey on testnet"),
      };
    },
  },
  {
    id: "wallet_privy",
    group: "wallets",
    title: "Privy embedded Stellar wallets",
    summary:
      "Wrap Privy's own hooks once: connects, failed connects, signatures and disconnects of Privy's Stellar " +
      "wallets, as closed-vocabulary events with wallet type privy. EVM and Solana wallets pass through untouched.",
    measures: [
      "Wallet funnel of Privy Stellar wallets: created or connected → sign requested → approved/rejected",
      "Failed connects by reason class",
    ],
    privacy: [
      "Never the Privy user, e-mail, wallet id, address, hash or signature: only the event name and closed values.",
      ...PRIVACY_WEB.slice(0, 1),
    ],
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "site",
    audiences: ["dapp"],
    stacks: ["javascript", "react", "privy"],
    guide_path: "docs/onboarding/wallets.md",
    example_path: "examples/privy",
    live_check: "dev_events",
    render: (ctx) => {
      const events = [
        stellarTestEvent(2, { n: "wallet_connect", wt: "privy", net: "testnet", ck: "new" }),
        stellarTestEvent(3, {
          n: "wallet_connect_failed",
          wt: "privy",
          net: "testnet",
          fr: "user_rejected",
          wc: "none",
        }),
      ];
      const test = () =>
        webEventsTest(ctx, events, "one Privy connect and one failed Privy connect", [
          "The first-event panel lists wallet_connect and wallet_connect_failed (kind stellar) on " +
            `${WEB_TEST_PATH}; the status turns to test received.`,
        ]);
      if (!ctx.site) return empty(NO_SITE, test());
      if (!ctx.pin) return empty(NO_PIN, test());
      return {
        needs: null,
        setup: [
          installBlock(ctx.pin),
          {
            title: "Start the tracker once (page views)",
            filename: "src/main.tsx (excerpt)",
            language: "ts",
            code: `import { init } from "${trackerPkg(ctx.site)}";\n\ninit({ site: "${ctx.site.site_key}" });`,
          },
          {
            title: "Use Privy's hooks through the wrapper (only chainType stellar is counted)",
            filename: "src/App.tsx (excerpt)",
            language: "ts",
            code: [
              'import { useLogin, usePrivy } from "@privy-io/react-auth";',
              'import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";',
              'import { privyLoginCallbacks, wrapPrivyStellar } from "@usagemap/tracker/privy";',
              "",
              'const networkPassphrase = "Test SDF Network ; September 2015";',
              "",
              "// inside your component",
              "const { createWallet } = wrapPrivyStellar(useCreateWallet(), { networkPassphrase });",
              "const { signRawHash } = wrapPrivyStellar(useSignRawHash(), { networkPassphrase });",
              "const { logout } = wrapPrivyStellar(usePrivy());",
              "const { login } = useLogin(privyLoginCallbacks({ onComplete: () => {}, onError: () => {} }));",
            ].join("\n"),
          },
        ],
        test: test(),
      };
    },
  },
  {
    id: "wallet_walletconnect",
    group: "wallets",
    title: "Failed connects, wallet context and the WalletConnect funnel",
    summary:
      "Tracker 1.2.0 adds failed connects (by reason class), the in-app wallet browser a connect came from, and the " +
      "WalletConnect funnel (session proposed → approved or rejected, each signing request) to the Wallets Kit " +
      "adapter. Wrap the kit's modules where the kit is initialised.",
    measures: [
      "Failed connects by reason (rejected, not installed, locked, network mismatch, timeout)",
      "WalletConnect sessions proposed / approved / rejected and signing requests by method",
      "In-app wallet browsers that opened your dApp (closed list)",
    ],
    privacy: PRIVACY_WALLET,
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "site",
    audiences: ["dapp"],
    stacks: ["javascript", "wallets-kit", "walletconnect"],
    guide_path: "docs/onboarding/wallets.md",
    example_path: "examples/walletconnect",
    live_check: "dev_events",
    render: (ctx) => {
      const events = [
        stellarTestEvent(2, {
          n: "walletconnect_session",
          ws: "proposed",
          net: "testnet",
          wc: "none",
        }),
        stellarTestEvent(3, {
          n: "wallet_connect_failed",
          wt: "walletconnect",
          net: "testnet",
          fr: "user_rejected",
          wc: "none",
        }),
      ];
      const test = () =>
        webEventsTest(ctx, events, "one proposed WalletConnect session and one rejected connect", [
          "The first-event panel lists walletconnect_session and wallet_connect_failed (kind stellar) on " +
            `${WEB_TEST_PATH}; the status turns to test received.`,
        ]);
      if (!ctx.site) return empty(NO_SITE, test());
      if (!ctx.pin) return empty(NO_PIN, test());
      return {
        needs: null,
        setup: [
          installBlock(ctx.pin),
          {
            title: "Start the tracker, then initialise the kit with wrapped modules",
            filename: "src/main.ts (excerpt)",
            language: "ts",
            code: [
              'import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";',
              "import {",
              "  WalletConnectModule,",
              "  WalletConnectTargetChain,",
              '} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";',
              `import { init } from "${trackerPkg(ctx.site)}";`,
              'import { attachWalletsKit, wrapWalletsKitModules } from "@usagemap/tracker/wallets-kit";',
              "",
              "const walletConnect = new WalletConnectModule({",
              '  projectId: "<your Reown project id>",',
              '  metadata: { name: "My dApp", description: "", url: location.origin, icons: [] },',
              "  allowedChains: [WalletConnectTargetChain.TESTNET],",
              "});",
              "",
              `init({ site: "${ctx.site.site_key}" });`,
              "StellarWalletsKit.init({",
              "  modules: wrapWalletsKitModules([walletConnect]), // or wrapWalletsKitModules(defaultModules())",
              "  network: Networks.TESTNET,",
              "});",
              "attachWalletsKit(StellarWalletsKit);",
            ].join("\n"),
          },
        ],
        test: test(),
      };
    },
  },
  {
    id: "wallet_browser_rpc",
    group: "wallets",
    title: "Stellar RPC and Horizon calls from the browser (aggregate only)",
    summary:
      "Counts your dApp's own RPC and Horizon calls per method, outcome class and latency bucket, and sends them as " +
      "one aggregate when the page is hidden — no visitor, session, URL, address or time of call.",
    measures: [
      "RPC methods and Horizon routes called from your pages, by outcome class and latency bucket",
      "Shown next to your backend's Stellar RPC panel (dependency health, never traffic)",
    ],
    privacy: [
      "Per-site daily totals of closed values only: never the RPC URL (provider keys stay in the browser), params, " +
        "XDR, hash or address, and no visitor key.",
      ...PRIVACY_WEB.slice(0, 1),
    ],
    availability: "package_unpublished",
    availability_note:
      `${NPM_UNPUBLISHED} The counts are stored once this deployment's operator enables them ` +
      "(edge_counter_features lists rpc); until then the edge drops them in memory.",
    target: "site",
    audiences: ["dapp"],
    stacks: ["javascript", "stellar-sdk"],
    guide_path: "docs/onboarding/wallets.md",
    example_path: "examples/stellar-rpc-browser",
    live_check: "dev_events",
    render: (ctx) => {
      const test = () =>
        webEventsTest(
          ctx,
          [WEB_TEST_PAGEVIEW, RPC_TEST_AGGREGATE],
          "one page view and one RPC aggregate (getHealth, testnet, ok)",
          [
            `The first-event panel lists the page view of ${WEB_TEST_PATH}. The aggregate itself never appears ` +
              "there: from a dev origin it is checked and then dropped in memory, by design.",
            "From your declared domain the counts appear as per-site daily totals once this deployment stores them.",
          ],
        );
      if (!ctx.site) return empty(NO_SITE, test());
      if (!ctx.pin) return empty(NO_PIN, test());
      return {
        needs: null,
        setup: [
          installBlock(ctx.pin),
          {
            title: "Attach it to the rpc.Server your page uses",
            filename: "src/main.ts (excerpt)",
            language: "ts",
            code: [
              'import { rpc } from "@stellar/stellar-sdk";',
              `import { init } from "${trackerPkg(ctx.site)}";`,
              'import { attachRpcTelemetry } from "@usagemap/tracker/stellar-rpc";',
              "",
              `init({ site: "${ctx.site.site_key}" });`,
              'const server = new rpc.Server("https://soroban-testnet.stellar.org");',
              'attachRpcTelemetry(server, { network: "testnet" });',
              '// Horizon: attachHorizonTelemetry(horizonServer, { network: "testnet" }) from the same subpath',
            ].join("\n"),
          },
        ],
        test: test(),
      };
    },
  },
  // -------------------------------------------------------------------------------------------- API
  ...(
    [
      ["node", "Node.js / Express", ["javascript", "node", "express"]],
      ["nextjs", "Next.js API routes", ["javascript", "node", "nextjs"]],
      ["fastapi", "Python / FastAPI", ["python", "fastapi"]],
      ["go", "Go (net/http)", ["go"]],
      ["rust", "Rust (axum)", ["rust", "axum"]],
      ["java", "Java (OpenTelemetry agent)", ["java", "jvm"]],
      ["dotnet", ".NET (ASP.NET Core)", ["dotnet", "csharp"]],
      ["collector", "Your own OpenTelemetry Collector", ["collector", "any"]],
    ] as const
  ).map(
    ([stack, title, stacks]): Def => ({
      id: `api_otel_${stack}`,
      group: "api",
      title: `OpenTelemetry: ${title}`,
      summary:
        stack === "collector"
          ? "Add UsageMap as a second exporter of the Collector you already run; your APM keeps everything."
          : "The tested dual-export recipe: your APM keeps receiving everything, UsageMap receives only the " +
            "request-duration metric.",
      measures: MEASURES_API,
      privacy: PRIVACY_OTLP,
      availability: "ready",
      target: "service",
      audiences: ["api", "anchor"],
      stacks: [...stacks],
      guide_path:
        stack === "collector"
          ? "docs/onboarding/api-dual-export.md"
          : stack === "node"
            ? "docs/onboarding/api-node-express.md"
            : stack === "fastapi"
              ? "docs/onboarding/api-python-fastapi.md"
              : stack === "rust"
                ? "docs/onboarding/api-rust-axum.md"
                : stack === "nextjs" || stack === "go"
                  ? `docs/onboarding/api-${stack}.md`
                  : "docs/onboarding/api-dual-export.md",
      example_path: OTEL_EXAMPLES[stack] ?? null,
      live_check: "otlp_baseline",
      render: (ctx) => {
        if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx));
        return { needs: null, setup: otelBlocks(stack, ctx), test: otlpTest(ctx) };
      },
    }),
  ),
  {
    id: "api_anchor_platform",
    group: "api",
    title: "Anchor Platform (OpenTelemetry Java agent)",
    summary:
      "Configuration only: attach the OpenTelemetry Java agent to the Anchor Platform container with environment " +
      "variables; SEP routes arrive as templates such as /sep24/transactions/{id}.",
    measures: [
      ...MEASURES_API,
      "SEP endpoints (SEP-6, SEP-10, SEP-12, SEP-24, SEP-31, SEP-38) by route template",
    ],
    privacy: [
      ...PRIVACY_OTLP,
      "Route templates keep /sep12/customer/{account} unexpanded: no customer account reaches UsageMap.",
    ],
    availability: "beta",
    availability_note:
      "Built from the tested Java agent recipe; not yet run against an Anchor Platform container itself.",
    target: "service",
    audiences: ["anchor", "api"],
    stacks: ["java", "anchor-platform"],
    guide_path: "docs/onboarding/api-dual-export.md",
    example_path: "examples/api-anchor-platform",
    live_check: "otlp_baseline",
    render: (ctx) => {
      if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx));
      const ep = (ctx.otlpEndpoint ?? OTLP_PLACEHOLDER).replace(/\/+$/, "");
      return {
        needs: null,
        setup: [
          {
            title: "Environment of the Anchor Platform container (sep-server and platform-server)",
            filename: ".env",
            language: "env",
            code: [
              "JAVA_TOOL_OPTIONS=-javaagent:/otel/opentelemetry-javaagent.jar",
              `OTEL_SERVICE_NAME=${ctx.service.service_name}`,
              "OTEL_RESOURCE_ATTRIBUTES=service.instance.id=<INSTANCE_ID>",
              `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=${ep}/v1/metrics`,
              `OTEL_EXPORTER_OTLP_METRICS_HEADERS=Authorization=Bearer%20${TOKEN_PLACEHOLDER}`,
              "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL=http/protobuf",
              "OTEL_METRICS_EXPORTER=otlp",
              "OTEL_TRACES_EXPORTER=none",
              "OTEL_LOGS_EXPORTER=none",
            ].join("\n"),
          },
          {
            title:
              "Mount the agent jar (download it from the OpenTelemetry Java instrumentation releases)",
            filename: "compose.override.yaml (excerpt)",
            language: "yaml",
            code: [
              "services:",
              "  anchor-platform:",
              "    volumes:",
              "      - ./otel/opentelemetry-javaagent.jar:/otel/opentelemetry-javaagent.jar:ro",
              "    env_file: .env",
            ].join("\n"),
          },
        ],
        test: otlpTest(ctx),
      };
    },
  },
  {
    id: "api_edge",
    group: "api",
    title: "Edge middleware (Cloudflare Workers, Vercel edge, Deno, Bun)",
    summary:
      "One dependency-free wrapper around your fetch handler; it sends route-templated request-duration metrics " +
      "after each window, through waitUntil, never in the request path.",
    measures: MEASURES_API,
    privacy: [
      ...PRIVACY_OTLP,
      "Paths that match none of your route templates are folded (addresses, ids, hashes → placeholders) before export.",
    ],
    availability: "beta",
    availability_note:
      "Built and tested in the repository against the real sanitiser; not yet run on the providers' platforms.",
    target: "service",
    audiences: ["api", "anchor", "dapp"],
    stacks: ["javascript", "cloudflare-workers", "vercel", "deno", "bun"],
    guide_path: "docs/onboarding/api-cloudflare-workers.md",
    example_path: "examples/edge-cloudflare-workers",
    live_check: "otlp_baseline",
    render: (ctx) => {
      if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx));
      const ep = (ctx.otlpEndpoint ?? OTLP_PLACEHOLDER).replace(/\/+$/, "");
      return {
        needs: null,
        setup: [
          {
            title: "Wrap the handler (list your route templates)",
            filename: "src/index.ts",
            language: "ts",
            code: [
              'import { withUsageMap } from "@usagemap/edge-otel";',
              "",
              "export default withUsageMap(app, (env) => ({",
              `  endpoint: ${JSON.stringify(ep)},`,
              "  token: env.USAGEMAP_TOKEN, // a secret: wrangler secret put USAGEMAP_TOKEN",
              `  serviceName: ${JSON.stringify(ctx.service.service_name)},`,
              '  routes: ["/.well-known/stellar.toml", "/auth", "/sep24/transactions/:id"],',
              "}));",
            ].join("\n"),
          },
          {
            title: "Store the ingest token as a secret",
            filename: null,
            language: "sh",
            code: "wrangler secret put USAGEMAP_TOKEN   # Vercel: a project environment variable",
          },
        ],
        test: otlpTest(ctx),
      };
    },
  },
  {
    id: "api_stellar_sdk",
    group: "api",
    title: "Stellar SDK calls (RPC and Horizon), server side",
    summary:
      "Instrument the rpc.Server / Horizon.Server your backend already uses: RPC latency by method and " +
      "simulate/submit/poll outcome classes, reported as outbound dependency health — not as API usage.",
    measures: [
      "Stellar RPC and Horizon latency by method",
      "Transaction submit and simulate outcome classes (decoded in memory, discarded)",
    ],
    privacy: [
      "Never the RPC URL (provider keys live in paths), an address, a transaction or a hash.",
      ...PRIVACY_OTLP.slice(1, 2),
    ],
    availability: "beta",
    availability_note:
      "Beta: the package is built in the repository this week; client metrics are stored only once the Collector's " +
      "allow-list for them is deployed — until then they are counted as client_metric_ignored in data quality.",
    target: "service",
    audiences: ["api", "dapp", "anchor"],
    stacks: ["javascript", "node", "stellar-sdk"],
    guide_path: "docs/onboarding/api-node-express.md",
    example_path: "examples/stellar-rpc-node",
    live_check: "otlp_baseline",
    render: (ctx) => {
      if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx, "stellar_client"));
      return {
        needs: null,
        setup: [
          {
            title: "Wrap the servers once, next to the OpenTelemetry SDK of the Node.js recipe",
            filename: null,
            language: "ts",
            code: [
              'import { Horizon, rpc } from "@stellar/stellar-sdk";',
              'import { instrumentHorizon, instrumentStellarRpc } from "@usagemap/stellar-otel";',
              "",
              'export const server = instrumentStellarRpc(new rpc.Server("https://soroban-testnet.stellar.org"));',
              'export const horizon = instrumentHorizon(new Horizon.Server("https://horizon-testnet.stellar.org"));',
            ].join("\n"),
          },
          ...otelBlocks("node", ctx).filter((b) => b.language === "env"),
        ],
        test: otlpTest(ctx, "stellar_client"),
      };
    },
  },
  {
    id: "api_stellar_sdk_python",
    group: "api",
    title: "Stellar SDK calls from Python (py-stellar-base), server side",
    summary:
      "Pass the instrumented HTTP client to SorobanServer and Server: RPC latency by method, Horizon latency by " +
      "route, and submit, poll and simulate outcome classes — outbound dependency health, not API usage.",
    measures: [
      "Stellar RPC and Horizon latency by method and route template",
      "Transaction submit, poll and simulate outcome classes",
    ],
    privacy: [
      "Never the RPC or Horizon URL, an address, a transaction, XDR or a hash.",
      ...PRIVACY_OTLP.slice(1, 2),
    ],
    availability: "beta",
    availability_note:
      "Beta: the package scf-analytics-stellar-otel is installed from the repository until it is on PyPI.",
    target: "service",
    audiences: ["api", "anchor", "dapp"],
    stacks: ["python", "stellar-sdk"],
    guide_path: "docs/onboarding/api-python-fastapi.md",
    example_path: "examples/stellar-rpc-python",
    live_check: "otlp_baseline",
    render: (ctx) => {
      if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx, "stellar_client"));
      return {
        needs: null,
        setup: [
          {
            title: "Install (from a clone of the repository until it is published)",
            filename: null,
            language: "sh",
            code: "pip install ./packages/stellar-otel-py",
          },
          {
            title: "Pass the instrumented client to each server",
            filename: "main.py (excerpt)",
            language: "python",
            code: [
              "from stellar_sdk import Server, SorobanServer",
              "from scf_stellar_otel import HorizonClient, StellarRpcClient",
              "",
              'rpc = SorobanServer(RPC_URL, client=StellarRpcClient(network="testnet"))',
              'horizon = Server(HORIZON_URL, client=HorizonClient(network="testnet"))',
            ].join("\n"),
          },
          ...otelBlocks("fastapi", ctx).filter((b) => b.language === "env"),
        ],
        test: otlpTest(ctx, "stellar_client"),
      };
    },
  },
  {
    id: "api_partner_calls",
    group: "api",
    title: "Calls to SCF Integration List partners (Soroswap, DeFindex, ramps, bridges)",
    summary:
      "Wrap fetch once: each call your backend makes to a listed partner API is counted by partner, operation " +
      "template and outcome class, with latency. Self-reported; your on-chain metric stays the authority.",
    measures: [
      "Partner calls per partner and operation template, by outcome class (success, auth_error, rate_limited …)",
      "Latency of each partner",
    ],
    privacy: [
      "Never the URL's query, a key, an address, an amount or a response body: the partner and operation come " +
        "from closed lists.",
      ...PRIVACY_OTLP.slice(1, 2),
    ],
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "service",
    audiences: ["api", "dapp"],
    stacks: ["javascript", "node", "defi"],
    guide_path: "docs/onboarding/api-partner-calls.md",
    example_path: "examples/partner-calls",
    live_check: "otlp_baseline",
    render: (ctx) => {
      if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx, "partner"));
      return {
        needs: null,
        setup: [
          {
            title: "Install",
            filename: null,
            language: "sh",
            code: "pnpm add --save-exact @usagemap/partner-otel",
          },
          {
            title: "Wrap fetch once, with the OpenTelemetry SDK of the Node.js recipe loaded first",
            filename: null,
            language: "ts",
            code: [
              'import { partnerFetch } from "@usagemap/partner-otel";',
              "",
              "// the host identifies the partner (api.soroswap.finance → soroswap); pass `partner` behind a proxy",
              'const fetch = partnerFetch(globalThis.fetch, { network: "testnet" });',
            ].join("\n"),
          },
          ...otelBlocks("node", ctx).filter((b) => b.language === "env"),
        ],
        test: otlpTest(ctx, "partner"),
      };
    },
  },
  {
    id: "api_payments",
    group: "api",
    title: "Agent payments: x402 and MPP",
    summary:
      "One line on your x402 or mppx server: payment required, verified, settled, paid, failed and canceled " +
      "counts by protocol, network, asset and amount bucket. Your server's own counts (self-reported).",
    measures: [
      "Payment lifecycle counts: required → verified → settled / paid, failed and canceled by reason class",
      "Protocol, scheme or method, network, asset and amount bucket (closed lists)",
    ],
    privacy: [
      "Never a payer, recipient, exact amount, payload, signature or transaction hash.",
      ...PRIVACY_OTLP.slice(1, 2),
    ],
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "service",
    audiences: ["api"],
    stacks: ["javascript", "node", "x402", "mpp"],
    guide_path: "docs/onboarding/payments.md",
    example_path: "examples/api-x402",
    live_check: "otlp_baseline",
    render: (ctx) => {
      if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx, "payments"));
      return {
        needs: null,
        setup: [
          {
            title: "Install",
            filename: null,
            language: "sh",
            code: "pnpm add --save-exact @usagemap/payments-otel",
          },
          {
            title: "x402: instrument the x402 HTTP resource server (example: examples/api-x402)",
            filename: "server.mjs (excerpt)",
            language: "js",
            code: [
              'import { instrumentX402Http } from "@usagemap/payments-otel";',
              "",
              "const payments = instrumentX402Http(httpServer); // your x402HTTPResourceServer",
              'if (!payments.instrumented) console.warn("payments-otel: x402 server without hook API");',
            ].join("\n"),
          },
          {
            title: "MPP: instrument your mppx instance instead (example: examples/payments-mpp)",
            filename: "server.mjs (excerpt)",
            language: "js",
            code: [
              'import { instrumentMppx } from "@usagemap/payments-otel";',
              "",
              "instrumentMppx(mppx);",
            ].join("\n"),
          },
          {
            title: "Start it with the Node.js recipe's OpenTelemetry SDK loaded first",
            filename: "package.json (excerpt)",
            language: "json",
            code: '"start": "node --import ./otel.mjs server.mjs"',
          },
          ...otelBlocks("node", ctx).filter((b) => b.language === "env"),
        ],
        test: otlpTest(ctx, "payments"),
      };
    },
  },
  {
    id: "api_anchor_wallet_sdk",
    group: "api",
    title: "Anchor funnel from a wallet (Stellar Wallet SDK)",
    summary:
      "Instrument the SDF Wallet SDK once: each SEP-1, 10, 12, 24 and 38 step your wallet takes with an anchor, " +
      "with outcome and latency, and the funnel events (toml resolved, authenticated, deposit started …).",
    measures: [
      "Anchor steps per anchor home domain and SEP, by outcome class, with latency",
      "Funnel events: toml_resolved → authenticated → deposit or withdraw started → completed",
    ],
    privacy: [
      "Never an account, memo, amount, customer field, JWT or transaction id; the anchor's home domain is a " +
        "public business name.",
      ...PRIVACY_OTLP.slice(1, 2),
    ],
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "service",
    audiences: ["dapp", "anchor", "api"],
    stacks: ["javascript", "node", "wallet-sdk", "anchors"],
    guide_path: "docs/onboarding/anchors.md",
    example_path: "examples/anchor-wallet-sdk",
    live_check: "otlp_baseline",
    render: (ctx) => {
      if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx, "anchor_wallet"));
      return {
        needs: null,
        setup: [
          {
            title: "Install",
            filename: null,
            language: "sh",
            code: "pnpm add --save-exact @usagemap/anchor-otel",
          },
          {
            title:
              "Instrument the wallet before wallet.anchor(…), with the Node.js recipe's SDK loaded first",
            filename: null,
            language: "js",
            code: [
              'import { Wallet } from "@stellar/typescript-wallet-sdk";',
              'import { instrumentWalletSdk } from "@usagemap/anchor-otel";',
              "",
              "const wallet = Wallet.TestNet();",
              "instrumentWalletSdk(wallet);",
            ].join("\n"),
          },
          ...otelBlocks("node", ctx).filter((b) => b.language === "env"),
        ],
        test: otlpTest(ctx, "anchor_wallet"),
      };
    },
  },
  {
    id: "api_anchor_platform_events",
    group: "api",
    title: "Anchor Platform business funnel (event listener)",
    summary:
      "A sidecar that reads Anchor Platform's TRANSACTION topic with its own Kafka consumer group: transfers " +
      "created per SEP and kind, status transitions, time per status, customer updates and quotes.",
    measures: [
      "Transfers created per SEP, kind and client wallet domain",
      "Status transitions and time spent per status",
      "SEP-12 customer updates and SEP-38 quotes",
    ],
    privacy: [
      "Amounts, accounts, memos, customers and messages are skipped while parsing; nothing of them is exported.",
      "Client wallets are kept only as public domain names; nothing in the platform changes.",
    ],
    availability: "beta",
    availability_note:
      "Beta: build it from the repository (tools/ap-listener); tested against an in-process Kafka, not yet " +
      "against a running Anchor Platform.",
    target: "service",
    audiences: ["anchor"],
    stacks: ["go", "anchor-platform", "kafka", "anchors"],
    guide_path: "docs/onboarding/anchors.md",
    example_path: "examples/anchor-platform-listener",
    live_check: "otlp_baseline",
    render: (ctx) => {
      if (!ctx.service) return empty(NO_SERVICE, otlpTest(ctx, "anchor_platform"));
      const ep = (ctx.otlpEndpoint ?? OTLP_PLACEHOLDER).replace(/\/+$/, "");
      return {
        needs: null,
        setup: [
          {
            title: "Environment of the listener (your platform's Kafka and this service)",
            filename: "examples/anchor-platform-listener/listener.env",
            language: "env",
            code: [
              "AP_KAFKA_BROKERS=127.0.0.1:9092",
              "AP_KAFKA_TOPIC=TRANSACTION",
              "AP_KAFKA_GROUP=usagemap-ap-listener",
              "STELLAR_NETWORK=testnet",
              `OTEL_SERVICE_NAME=${ctx.service.service_name}`,
              `OTEL_EXPORTER_OTLP_ENDPOINT=${ep}`,
            ].join("\n"),
          },
          {
            title: "The token from your secret store, then check the configuration and run it",
            filename: null,
            language: "sh",
            code: [
              `export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${TOKEN_PLACEHOLDER}"`,
              "examples/anchor-platform-listener/run.sh -check-config   # prints: configuration ok",
              "examples/anchor-platform-listener/run.sh",
            ].join("\n"),
          },
        ],
        test: otlpTest(ctx, "anchor_platform"),
      };
    },
  },
  // -------------------------------------------------------------------------------------------- mobile
  {
    id: "app_react_native",
    group: "mobile",
    title: "React Native and Expo apps",
    summary:
      "One dependency-free file: named app events with closed properties, sent in batches to the edge with your " +
      "website's public key. Counts from apps are self-attested: an app cannot run the browser's bot check.",
    measures: MEASURES_APP,
    privacy: PRIVACY_APP,
    availability: "beta",
    availability_note: APP_NOTE,
    target: "site",
    audiences: ["dapp"],
    stacks: ["javascript", "react-native", "expo", "mobile"],
    guide_path: "docs/onboarding/mobile.md",
    example_path: "examples/mobile-react-native",
    live_check: "app_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, appTest(ctx, "android"));
      return {
        needs: null,
        setup: [
          {
            title: "Copy the helper into your app (one file, no dependency)",
            filename: null,
            language: "sh",
            code: "cp packages/mobile-rn/src/index.ts <your app>/usagemap.ts",
          },
          {
            title: "One instance for the whole app",
            filename: "App.tsx (excerpt)",
            language: "ts",
            code: [
              'import { AppState, Platform } from "react-native";',
              'import { createUsageMapApp } from "./usagemap";',
              "",
              "export const analytics = createUsageMapApp({",
              `  siteKey: "${ctx.site.site_key}",`,
              '  platform: Platform.OS === "ios" ? "ios" : "android",',
              '  appVersion: "1.0.0",',
              `  endpoint: ${JSON.stringify(appEndpoint(ctx))},`,
              "});",
              "",
              'analytics.track("app_open");',
              'AppState.addEventListener("change", (s) => s === "background" && analytics.flush());',
              '// analytics.track("swap_started", { pair_class: "stablecoin" });',
            ].join("\n"),
          },
        ],
        test: appTest(ctx, "android"),
      };
    },
  },
  {
    id: "app_flutter",
    group: "mobile",
    title: "Flutter and Dart apps",
    summary:
      "The same app events from a Flutter app, through one Dart file with a transport you choose; self-attested " +
      "like every app count.",
    measures: MEASURES_APP,
    privacy: PRIVACY_APP,
    availability: "beta",
    availability_note:
      `${APP_NOTE} The Dart helper's own tests are not run in this repository yet; its wire format is checked ` +
      "against the edge's conformance fixtures.",
    target: "site",
    audiences: ["dapp"],
    stacks: ["dart", "flutter", "mobile"],
    guide_path: "docs/onboarding/mobile.md",
    example_path: "examples/mobile-flutter",
    live_check: "app_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, appTest(ctx, "android"));
      return {
        needs: null,
        setup: [
          {
            title: "Copy the helper and the dart:io transport into your app",
            filename: null,
            language: "sh",
            code: "cp packages/mobile-flutter/lib/usagemap_app_events.dart packages/mobile-flutter/lib/io_transport.dart <your app>/lib/",
          },
          {
            title: "One instance for the whole app",
            filename: "lib/main.dart (excerpt)",
            language: "text",
            code: [
              "import 'dart:io' show Platform;",
              "import 'io_transport.dart';",
              "import 'usagemap_app_events.dart';",
              "",
              "final analytics = UsageMapApp(",
              `  siteKey: '${ctx.site.site_key}',`,
              "  platform: Platform.isIOS ? 'ios' : 'android',",
              "  appVersion: '1.0.0',",
              "  transport: ioTransport(),",
              `  endpoint: Uri.parse('${appEndpoint(ctx)}'),`,
              ");",
              "",
              "// analytics.track('app_open'); flush() when the app is paused",
            ].join("\n"),
          },
        ],
        test: appTest(ctx, "android"),
      };
    },
  },
  {
    id: "app_telegram_mini_app",
    group: "mobile",
    title: "Telegram Mini Apps",
    summary:
      "A Mini App is a web page in Telegram's WebView: the web tracker counts its page views (verified like any " +
      "website); optional app-style counts per Telegram client go to the app-events endpoint, self-attested.",
    measures: [
      ...MEASURES_WEB.slice(0, 1),
      "Optional: named app events per Telegram client class (android, ios, macos, desktop, web)",
    ],
    privacy: [
      "Never Telegram's initData, the Telegram user or the launch parameters in the query and fragment.",
      ...PRIVACY_WEB,
    ],
    availability: "package_unpublished",
    availability_note: NPM_UNPUBLISHED,
    target: "site",
    audiences: ["dapp", "website"],
    stacks: ["javascript", "telegram", "mobile"],
    guide_path: "docs/onboarding/mobile.md",
    example_path: "examples/telegram-mini-app",
    live_check: "dev_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, webTest(ctx));
      if (!ctx.pin) return empty(NO_PIN, webTest(ctx));
      return {
        needs: null,
        setup: [
          {
            title: "Telegram's script first: it reads the launch parameters from the URL fragment",
            filename: "index.html (excerpt)",
            language: "html",
            code: '<script src="https://telegram.org/js/telegram-web-app.js"></script>',
          },
          installBlock(ctx.pin),
          {
            title:
              "Page views; optional app counts with packages/mobile-rn/src/index.ts copied as usagemap.ts",
            filename: "src/main.ts (excerpt)",
            language: "ts",
            code: [
              `import { init } from "${trackerPkg(ctx.site)}";`,
              'import { createUsageMapApp, tmaPlatform } from "./usagemap";',
              "",
              "const tg = (window as { Telegram?: { WebApp?: { platform?: string } } }).Telegram?.WebApp;",
              `init({ site: "${ctx.site.site_key}" });`,
              "",
              "// Optional. Never pass initData or the Telegram user.",
              "const app = createUsageMapApp({",
              `  siteKey: "${ctx.site.site_key}",`,
              '  platform: "web",',
              '  appVersion: "1.0.0",',
              "  tmaPlatform: tmaPlatform(tg?.platform),",
              `  endpoint: ${JSON.stringify(appEndpoint(ctx))},`,
              "});",
            ].join("\n"),
          },
        ],
        test: webTest(ctx),
      };
    },
  },
  // -------------------------------------------------------------------------------------------- on-chain
  {
    id: "onchain_contracts",
    group: "onchain",
    title: "Register your contracts (Registered Footprint)",
    summary:
      "Declare the contracts and accounts your project owns, with a proof; UsageMap then correlates on-chain " +
      "activity with your web and API usage from public ledger data.",
    measures: [
      "Invocations of your registered contracts from public ledger data",
      "Correlation with web and API",
    ],
    privacy: [
      "Only identifiers your project owns are registered; end-user addresses are never stored.",
      "Reads public ledger data only; nothing is sent from your app.",
    ],
    availability: "ready",
    target: "tenant",
    audiences: ["dapp", "contracts", "anchor"],
    stacks: ["soroban", "stellar"],
    guide_path: "docs/onboarding/footprint.md",
    example_path: "examples/footprint-register",
    live_check: "footprint",
    render: () => ({
      needs: null,
      setup: [],
      test: {
        kind: "portal",
        instructions: "Use the footprint wizard: paste a contract id, prove ownership, confirm.",
        command: null,
        expect: [
          "The contract is listed under Registered Footprint; the status turns to configured.",
        ],
        requires: [],
      },
    }),
  },
  {
    id: "onchain_scaffold",
    group: "onchain",
    title: "Scaffold Stellar template",
    summary:
      "A new Scaffold Stellar dApp measured by default: tracker and Wallets Kit adapter wired, and a post-deploy " +
      "extension that lists your deployed contract ids for registration.",
    measures: [
      ...MEASURES_WEB.slice(0, 1),
      "Wallet funnel",
      "Your deployed contracts (for registration)",
    ],
    privacy: [
      "Nothing is sent while PUBLIC_USAGEMAP_SITE is empty.",
      ...PRIVACY_WALLET.slice(0, 1),
    ],
    availability: "beta",
    availability_note:
      "Beta: `stellar scaffold init --template` needs the public repository; the overlay and extension are tested " +
      "in the repository.",
    target: "site",
    audiences: ["dapp", "contracts"],
    stacks: ["javascript", "react", "scaffold-stellar", "soroban"],
    guide_path: "docs/onboarding/README.md",
    example_path: "examples/scaffold-stellar",
    live_check: "dev_events",
    render: (ctx) => {
      if (!ctx.site) return empty(NO_SITE, webTest(ctx));
      return {
        needs: null,
        setup: [
          {
            title: "Your app's .env (public site key; empty = analytics off)",
            filename: ".env",
            language: "env",
            code: `PUBLIC_USAGEMAP_SITE=${ctx.site.site_key}`,
          },
          {
            title: "Append to scaffold.yml: record your own contracts after each deploy",
            filename: "scaffold.yml (excerpt)",
            language: "yaml",
            code: [
              "extensions:",
              "  usagemap:",
              "    networks: [testnet, mainnet]",
              "    out: .usagemap/contracts.json",
            ].join("\n"),
          },
        ],
        test: webTest(ctx),
      };
    },
  },
  // -------------------------------------------------------------------------------------------- tooling
  {
    id: "tool_cli",
    group: "tooling",
    title: "Stellar CLI plugin: stellar scf check",
    summary:
      "Offline dry run with the production sanitiser: shows exactly which points UsageMap would keep, redact and " +
      "drop from an OTLP payload, and why. --fail-on-drop for CI.",
    measures: ["Nothing: a local check, no data is sent"],
    privacy: [
      "Runs offline; prints attribute keys of removed attributes, never their values.",
      "Never reads the Stellar CLI's identity directory.",
    ],
    availability: "beta",
    availability_note:
      "Beta: build it from the repository (tools/stellar-scf) until release binaries exist.",
    target: "local",
    audiences: ["api", "anchor", "devtool"],
    stacks: ["cli", "any"],
    guide_path: "docs/onboarding/troubleshooting.md",
    example_path: "examples/stellar-scf-cli",
    live_check: "none",
    render: (ctx) => ({
      needs: null,
      setup: [
        {
          title: "Build and put it on PATH (any stellar-<name> binary is a CLI plugin)",
          filename: null,
          language: "sh",
          code: "go build -o ~/.local/bin/stellar-scf ./tools/stellar-scf && stellar plugin ls",
        },
      ],
      test: localTest(
        {
          title: "Dry-run a captured payload",
          filename: null,
          language: "sh",
          code: `stellar scf check --services ${ctx.service?.service_name ?? "my-api"} -f payload.json`,
        },
        ["KEPT / DROPPED / NEVER STORED sections, with a hint per drop reason."],
        "Capture one OTLP/JSON export of your service (for example with the Collector's file exporter) and check it.",
      ),
    }),
  },
  {
    id: "tool_mcp",
    group: "tooling",
    title: "AI assistants (MCP server)",
    summary:
      "A local, read-only Model Context Protocol server: your assistant answers questions from the same aggregates " +
      "the portal shows.",
    measures: ["Nothing new: read-only access to aggregates you can already see"],
    privacy: [
      "Read-only aggregates through a share key of this project; no raw events exist to return.",
      "The key is read from a file and never printed.",
    ],
    availability: "beta",
    availability_note:
      "Beta: runs from the repository (tools/mcp); not published as a package yet.",
    target: "local",
    audiences: ["website", "dapp", "api", "anchor", "contracts", "devtool"],
    stacks: ["mcp", "any"],
    guide_path: "docs/onboarding/README.md",
    example_path: "examples/mcp-claude",
    live_check: "none",
    render: (ctx) => ({
      needs: null,
      setup: [
        {
          title: "MCP client configuration (create a share key under Sharing; save it to a file)",
          filename: "mcp.json",
          language: "json",
          code: JSON.stringify(
            {
              mcpServers: {
                usagemap: {
                  command: "node",
                  args: ["<path to the repository>/tools/mcp/server.ts"],
                  env: {
                    USAGEMAP_API_URL: ctx.portalOrigin,
                    USAGEMAP_SHARE_KEY_FILE: "<path to the file holding the share key>",
                  },
                },
              },
            },
            null,
            2,
          ),
        },
      ],
      test: localTest(
        { title: "Self-test", filename: null, language: "sh", code: "tools/mcp/run selftest" },
        [
          "Every protocol and tool test passes; then ask your assistant for this project's usage summary.",
        ],
        "Run the self-test, then restart your assistant with the configuration above.",
      ),
    }),
  },
  {
    id: "tool_badges",
    group: "tooling",
    title: "Live README badges (SVG and Shields.io)",
    summary:
      "A badge with your verified visitors or API requests, served by UsageMap and updated hourly, for your " +
      "README or SCF project page. Exists only while the project's statistics are public.",
    measures: ["Nothing new: the public figure your project already publishes"],
    privacy: [
      'Counts below a floor (100 visitors, 1,000 API requests) read as "< floor"; API requests are labelled ' +
        "self-attested.",
      "The Shields.io form makes only Shields contact UsageMap, never your README's readers.",
    ],
    availability: "ready",
    target: "tenant",
    audiences: ["website", "dapp", "api", "anchor", "contracts", "devtool"],
    stacks: ["markdown", "any"],
    guide_path: "docs/onboarding/share-with-scf.md",
    example_path: null,
    live_check: "public_badge",
    render: (ctx) => {
      if (!ctx.tenant)
        return empty("No project.", {
          kind: "local_command",
          instructions: "",
          command: null,
          expect: [],
          requires: [],
        });
      const origin = ctx.portalOrigin.replace(/\/+$/, "");
      const base = `${origin}/public/v1/projects/${encodeURIComponent(ctx.tenant.slug)}`;
      const shields = `https://img.shields.io/endpoint?url=${encodeURIComponent(`${base}/badge.json`)}`;
      return {
        needs: null,
        setup: [
          {
            title: "README (Shields.io)",
            filename: "README.md",
            language: "text",
            code: `[![Measured by UsageMap](${shields})](${origin}/p/${encodeURIComponent(ctx.tenant.slug)})`,
          },
          {
            title: "Or the SVG served by UsageMap (add ?metric=api for API requests)",
            filename: null,
            language: "text",
            code: `${base}/badge.svg`,
          },
        ],
        test: {
          kind: "local_command",
          instructions:
            "Fetch the badge document Shields.io reads. Make the statistics public first (Sharing → public stats).",
          command: {
            title: "Badge document",
            filename: null,
            language: "sh",
            code: badgeTestCurl({ portalOrigin: ctx.portalOrigin, slug: ctx.tenant.slug }),
          },
          expect: [
            'HTTP 200 with {"schemaVersion":1,"label":…,"message":…}: the badge works.',
            "HTTP 404 while the statistics are private, and until the hourly public document has been built " +
              "after you switched them on — the same answer as for a project that does not exist.",
          ],
          requires: ["public statistics switched on for this project (Sharing)"],
        },
      };
    },
  },
  {
    id: "tool_pin_action",
    group: "tooling",
    title: "GitHub Action: keep tracker pins and SRI current",
    summary:
      "A CI step that scans your site for UsageMap script tags and fails on a withdrawn version, a wrong or " +
      "missing integrity hash or a missing crossorigin; it writes a patch with the correct pins.",
    measures: ["Nothing: it runs in your CI and sends nothing to UsageMap"],
    privacy: [
      "Its only network request is one GET of the public tracker release list.",
      "It reads your files in the CI runner only.",
    ],
    availability: "beta",
    availability_note:
      "Beta: reference it from a clone of the repository (tools/pin-action) until the repository is public and " +
      "the action is on the Marketplace.",
    target: "local",
    audiences: ["website", "dapp", "devtool"],
    stacks: ["github-actions", "ci", "html", "any"],
    guide_path: "docs/onboarding/web-html.md",
    example_path: "examples/pin-action",
    live_check: "none",
    render: (ctx) => {
      const hosts = ctx.ingestOrigins.map((o) => new URL(o).host);
      const manifest = `${ctx.portalOrigin.replace(/\/+$/, "")}/v1/tracker/versions`;
      const setup: Block[] = [
        {
          title: "Workflow step (pin the action and upload-artifact by commit)",
          filename: ".github/workflows/usagemap-pins.yml (excerpt)",
          language: "yaml",
          code: [
            "      - id: pins",
            "        uses: <owner>/<repo>/tools/pin-action@<pinned sha>",
            "        with:",
            "          path: site",
            `          manifest-url: ${manifest}`,
            `          hosts: ${hosts.length > 0 ? hosts.join(",") : "<your ingest hosts>"}`,
            "      - if: always() && steps.pins.outputs.patch-file != ''",
            "        uses: actions/upload-artifact@<pinned sha>",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a template
            '        with: { name: usagemap-tracker-pins, path: "${{ steps.pins.outputs.patch-file }}" }',
          ].join("\n"),
        },
      ];
      if (!ctx.site || !ctx.pin)
        return {
          needs: null,
          setup,
          test: localTest(
            {
              title: "Self-test (no network)",
              filename: null,
              language: "sh",
              code: "tools/pin-action/run selftest",
            },
            [
              "Every test passes. With a website and an active tracker version, the test checks a real pin.",
            ],
            "Run the action's own tests from a clone of the repository.",
          ),
        };
      return {
        needs: null,
        setup,
        test: localTest(
          {
            title: "Check this website's pinned tag against this deployment",
            filename: null,
            language: "sh",
            code: pinTestCommand({
              portalOrigin: ctx.portalOrigin,
              hosts,
              tag: scriptTag(ctx.pin, ctx.site.site_key),
            }),
          },
          [
            `"ok  index.html:1 ${ctx.site.tracker_profile} ${ctx.pin.version}" and "1 tag(s), 0 error(s), ` +
              '0 warning(s)"; exit status 0.',
            "Change one character of the integrity hash and run it again: the step fails and proposes the fix.",
          ],
          "From a clone of the repository: the action checks one page holding the tag of this website, the same way " +
            "it runs in CI.",
        ),
      };
    },
  },
];

function otelBlocks(stack: Stack, ctx: RenderCtx): Block[] {
  const r = otelConfig(stack, ctx.service?.service_name ?? "my-api", ctx.otlpEndpoint);
  const lang = (f: string): Block["language"] =>
    f.endsWith(".yaml") || f.endsWith(".yml")
      ? "yaml"
      : f.endsWith(".py")
        ? "python"
        : f.endsWith(".go")
          ? "go"
          : f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".cjs")
            ? "js"
            : f.endsWith(".ts")
              ? "ts"
              : f.endsWith(".json")
                ? "json"
                : "text";
  const out: Block[] = r.files.map((f) => ({
    title: f.filename,
    filename: f.filename,
    language: lang(f.filename),
    code: f.content,
  }));
  const env = Object.entries(r.env);
  if (env.length > 0)
    out.push({
      title: "Environment",
      filename: ".env",
      language: "env",
      code: env.map(([k, v]) => `${k}=${v}`).join("\n"),
    });
  if (r.notes.length > 0)
    out.push({ title: "Notes", filename: null, language: "text", code: r.notes.join("\n") });
  return out;
}

export const INTEGRATION_IDS: readonly string[] = defs.map((d) => d.id);

export function definition(id: string): Def | undefined {
  return defs.find((d) => d.id === id);
}

export interface Filter {
  group?: Group | undefined;
  audience?: Audience | undefined;
  stack?: string | undefined;
}

/** Definitions in catalogue order, narrowed by group, audience (project kind) and stack tag. */
export function select(f: Filter): Def[] {
  const stack = f.stack?.toLowerCase();
  return defs.filter(
    (d) =>
      (!f.group || d.group === f.group) &&
      (!f.audience || d.audiences.includes(f.audience)) &&
      (!stack || d.stacks.includes(stack) || d.stacks.includes("any")),
  );
}

export function render(d: Def, ctx: RenderCtx): Card {
  const r = d.render(ctx);
  return {
    id: d.id,
    group: d.group,
    title: d.title,
    summary: d.summary,
    measures: d.measures,
    privacy: d.privacy,
    availability: d.availability,
    availability_note: d.availability_note ?? null,
    target: d.target,
    audiences: d.audiences,
    stacks: d.stacks,
    guide_path: d.guide_path,
    example_path: d.example_path,
    needs: r.needs,
    setup: r.setup,
    test: r.test,
    live_check: d.live_check,
  };
}

export type { Def };
