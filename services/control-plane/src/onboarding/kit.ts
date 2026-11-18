// SPDX-License-Identifier: Apache-2.0
// The integration kit (getIntegrationKit): after sign-up, one page with everything a project copies, its own public
// site key filled in. Pure functions; the handler supplies the tenant's rows.
//
//   script tag   — the pinned, SRI-protected tag, byte for byte what getSnippet(format=html) returns (a unit test holds
//                  them equal), so the kit can never drift from the snippet page;
//   framework    — the starter for the chosen framework, the same code as the tested guides in docs/onboarding;
//   wallets      — the Wallets Kit / Freighter / RPC adapter lines (docs/onboarding/wallets.md), recommended for dApps;
//   OpenTelemetry — environment variables for a service whose only OTLP backend is SCF; dual export next to an existing
//                  APM is the API set-up wizard's job (getOtelConfig, C-102, C-105). The ingest token stays a
//                  placeholder: tokens are shown once at creation and never stored in readable form (C-14);
//   test commands — one curl for the web edge (the challenge call `/v1/c`, wire-formats §a.2: answers 200 for a live
//                  site key and 404 `unknown_site` otherwise — events themselves need the tracker's proof of work), one
//                  for OTLP (`/v1/metrics`, wire-formats §f: 200 when accepted).
// Nothing here contains a secret, an IP address or a visitor identifier.

import { otlpTestCurl } from "../integrations/test-commands.ts";
import { compareSemver, type TrackerVersionView } from "../tracker.ts";
import type { FrameworkHint, KitFramework, ProjectSummary } from "./registry.ts";

export const TOKEN_PLACEHOLDER = "<INGEST_TOKEN>";
export const OTLP_PLACEHOLDER = "https://<OTLP_ENDPOINT>";
export const INGEST_PLACEHOLDER = "https://<INGEST_HOST>";
const WALLET_ADAPTERS_SINCE = "1.1.0";

export interface KitCode {
  title: string;
  filename: string | null;
  install: string | null;
  code: string;
  guide_path: string | null;
}

export interface KitSite {
  site_id: string;
  name: string;
  site_key: string;
  tracker_profile: "standard" | "strict";
  domains: Array<{ domain_id: string; host: string; state: string }>;
}

const GUIDES: Record<KitFramework, string> = {
  nextjs: "docs/onboarding/web-nextjs.md",
  nuxt: "docs/onboarding/web-nuxt.md",
  sveltekit: "docs/onboarding/web-sveltekit.md",
  astro: "docs/onboarding/web-astro.md",
  react_spa: "docs/onboarding/web-react-spa.md",
  html: "docs/onboarding/web-html.md",
  nocode: "docs/onboarding/web-cms.md",
  other: "docs/onboarding/README.md",
};

function htmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface TrackerPin {
  version: string;
  src: string;
  integrity: string;
}

/** The pinned file of the newest active version for the site's profile (same choice as getSnippet without `version`). */
export function trackerPin(
  versions: readonly TrackerVersionView[],
  hosts: (version: string) => string[],
  profile: "standard" | "strict",
): TrackerPin | null {
  const v = versions.find((x) => x.status === "active");
  const file = v?.files.find((f) => f.profile === profile);
  const origin = v ? hosts(v.version)[0] : undefined;
  if (!v || !file || !origin) return null;
  return { version: v.version, src: `${origin}${file.url}`, integrity: file.integrity };
}

/** The script tag exactly as getSnippet(format=html) builds it. */
export function scriptTag(pin: TrackerPin, siteKey: string): string {
  return [
    "<script",
    `  src="${htmlAttr(pin.src)}"`,
    `  integrity="${htmlAttr(pin.integrity)}"`,
    '  crossorigin="anonymous"',
    `  data-site="${htmlAttr(siteKey)}"`,
    "  defer",
    "></script>",
  ].join("\n");
}

const pkgOf = (profile: "standard" | "strict") =>
  profile === "strict" ? "@usagemap/tracker/strict" : "@usagemap/tracker";

export function frameworkSnippet(framework: KitFramework, site: KitSite, pin: TrackerPin): KitCode {
  const pkg = pkgOf(site.tracker_profile);
  const install = `pnpm add --save-exact @usagemap/tracker@${pin.version}`;
  const init = `init({ site: "${site.site_key}" })`;
  const guide_path = GUIDES[framework];
  const tag = scriptTag(pin, site.site_key);
  switch (framework) {
    case "nextjs":
      return {
        title: "Next.js (App Router): a client component rendered once in the root layout",
        filename: "app/analytics.tsx",
        install,
        code: [
          '"use client";',
          'import { useEffect } from "react";',
          `import { init } from "${pkg}";`,
          "",
          "// Render <Analytics /> once in app/layout.tsx. Client-side navigations are followed automatically.",
          "export function Analytics() {",
          "  useEffect(() => {",
          `    ${init};`,
          "  }, []);",
          "  return null;",
          "}",
        ].join("\n"),
        guide_path,
      };
    case "nuxt":
      return {
        title: "Nuxt: a client-only plugin (Nuxt 3: plugins/ at the project root)",
        filename: "app/plugins/scf-analytics.client.ts",
        install,
        code: [
          `import { init } from "${pkg}";`,
          "",
          "export default defineNuxtPlugin(() => {",
          `  const scf = ${init};`,
          "  // available as useNuxtApp().$scf in components (undefined if the tracker did not start)",
          "  return { provide: { scf } };",
          "});",
        ].join("\n"),
        guide_path,
      };
    case "sveltekit":
      return {
        title: "SvelteKit: start the tracker once in the root layout",
        filename: "src/routes/+layout.svelte",
        install,
        code: [
          '<script lang="ts">',
          'import { onMount } from "svelte";',
          `import { init } from "${pkg}";`,
          "",
          "let { children } = $props();",
          "onMount(() => {",
          `  ${init}; // once, in the browser; client-side navigations are followed`,
          "});",
          "</script>",
          "",
          "{@render children()}",
        ].join("\n"),
        guide_path,
      };
    case "astro":
      return {
        title: "Astro: the tag in the <head> of your base layout",
        filename: "src/layouts/Layout.astro",
        install: null,
        code: tag.replace("<script", "<script is:inline"),
        guide_path,
      };
    case "react_spa":
      return {
        title: "React single-page app (Vite, Create React App, React Router)",
        filename: "src/main.tsx",
        install,
        code: [
          `import { init } from "${pkg}";`,
          "",
          `${init}; // before rendering; History API navigations are followed`,
        ].join("\n"),
        guide_path,
      };
    case "nocode":
      return {
        title:
          "WordPress, Webflow, Framer and other builders: paste into the site-wide <head> custom code " +
          "(Webflow: Site settings → Custom code → Head code; Framer: Site settings → General → Custom code → " +
          "Start of <head>; WordPress: a header-scripts plugin or the theme's header)",
        filename: null,
        install: null,
        code: tag,
        guide_path,
      };
    case "html":
      return {
        title: "Plain HTML: the tag in the <head> of every page",
        filename: null,
        install: null,
        code: tag,
        guide_path,
      };
    default:
      return {
        title: "Any other stack: the tag in the <head> of every page, or the npm package",
        filename: null,
        install: null,
        code: tag,
        guide_path,
      };
  }
}

export function walletSnippets(site: KitSite, pin: TrackerPin): KitCode[] {
  const pkg = pkgOf(site.tracker_profile);
  const old = compareSemver(pin.version, WALLET_ADAPTERS_SINCE) < 0;
  const install = `pnpm add --save-exact @usagemap/tracker@${old ? WALLET_ADAPTERS_SINCE : pin.version}`;
  const guide_path = "docs/onboarding/wallets.md";
  const init = `init({ site: "${site.site_key}" })`;
  return [
    {
      title:
        "Stellar Wallets Kit (2.x): connects, signatures and submissions as closed-vocabulary events",
      filename: null,
      install,
      code: [
        `import { init } from "${pkg}";`,
        'import { attachWalletsKit } from "@usagemap/tracker/wallets-kit";',
        'import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";',
        "",
        `${init};`,
        "const detach = attachWalletsKit(StellarWalletsKit); // call detach() to undo",
      ].join("\n"),
      guide_path,
    },
    {
      title: "Freighter called directly: wrap it once and use the wrapped object",
      filename: null,
      install,
      code: [
        'import * as freighterApi from "@stellar/freighter-api";',
        'import { wrapFreighter } from "@usagemap/tracker/wallets";',
        "",
        "export const freighter = wrapFreighter(freighterApi);",
      ].join("\n"),
      guide_path,
    },
    {
      title: "Your own submissions through Stellar RPC",
      filename: null,
      install,
      code: [
        'import { rpc } from "@stellar/stellar-sdk";',
        'import { attachRpcServer } from "@usagemap/tracker/wallets";',
        "",
        '// `server`: the rpc.Server your app already submits through, e.g. new rpc.Server("https://…")',
        "attachRpcServer(server); // no request of its own; no address or transaction hash is sent",
      ].join("\n"),
      guide_path,
    },
  ];
}

export function otelEnv(
  endpoint: string | undefined,
  serviceName: string,
): { endpoint: string | null; service_name: string; env: Record<string, string>; notes: string[] } {
  const ep = (endpoint ?? OTLP_PLACEHOLDER).replace(/\/+$/, "");
  const notes = [
    `Replace ${TOKEN_PLACEHOLDER} with an ingest token of this project (shown once when you create it).`,
    "Replace <INSTANCE_ID> with a value unique per running process (for example the host or pod name).",
    `Register the API service "${serviceName}" first: data of services that are not registered is not stored.`,
    "These variables make UsageMap the service's only OpenTelemetry backend. To keep your own APM and send to UsageMap as " +
      "well (dual export), use the API set-up wizard: it generates the tested configuration for your stack.",
    "Only the HTTP server request-duration metric is kept; logs are refused.",
  ];
  if (!endpoint)
    notes.unshift(`Replace ${OTLP_PLACEHOLDER} with the OTLP endpoint of this deployment.`);
  return {
    endpoint: endpoint ? ep : null,
    service_name: serviceName,
    env: {
      OTEL_SERVICE_NAME: serviceName,
      OTEL_RESOURCE_ATTRIBUTES: "service.instance.id=<INSTANCE_ID>",
      OTEL_EXPORTER_OTLP_ENDPOINT: ep,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${TOKEN_PLACEHOLDER}`,
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    },
    notes,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function testCommands(p: {
  site: KitSite | null;
  pin: TrackerPin | null;
  ingestOrigin: string | undefined;
  otlpEndpoint: string | undefined;
  serviceName: string;
}): KitCode[] {
  const out: KitCode[] = [];
  if (p.site) {
    const origin = p.site.domains[0]
      ? `https://${p.site.domains[0].host}`
      : "http://localhost:5173";
    const body = JSON.stringify({
      v: 1,
      s: p.site.site_key,
      p: p.site.tracker_profile,
      tv: p.pin?.version ?? "1.1.0",
    });
    out.push({
      title:
        'Web: is the site key live at the edge? 200 with a JSON challenge = yes; 404 {"error":"unknown_site"} = ' +
        "not yet (a new website reaches the edge within about a minute). Page views themselves come from the tracker, " +
        "which adds a proof of work; open a page with the snippet and watch the first-event panel.",
      filename: null,
      install: null,
      code: [
        `curl -sS -i ${shellQuote(`${(p.ingestOrigin ?? INGEST_PLACEHOLDER).replace(/\/+$/, "")}/v1/c`)} \\`,
        `  -H ${shellQuote(`Origin: ${origin}`)} \\`,
        "  -H 'Content-Type: text/plain;charset=UTF-8' \\",
        `  --data ${shellQuote(body)}`,
      ].join("\n"),
      guide_path: "docs/onboarding/troubleshooting.md",
    });
  }
  out.push({
    title:
      `API: one marked test data point for service "${p.serviceName}" (registered first, with an ingest token). ` +
      "200 = accepted; 401 = token missing or wrong; 403 = the project is pending or suspended. The point is the first " +
      "of a new stream, so it is recorded only as arrival in the first-event panel and is never counted as traffic.",
    filename: null,
    install: null,
    code: otlpTestCurl({ otlpEndpoint: p.otlpEndpoint, serviceName: p.serviceName }),
    guide_path: "docs/onboarding/api-dual-export.md",
  });
  return out;
}

export interface ChecklistInput {
  site: KitSite | null;
  devOrCountedEvents: boolean;
  stellarAccount: boolean;
  footprintItems: number;
  apiServices: number;
  registryMatch: boolean;
  registryKnown: boolean;
}

export interface KitCheck {
  id:
    | "project"
    | "website"
    | "domain_declared"
    | "domain_verified"
    | "snippet_live"
    | "stellar_account"
    | "contracts"
    | "api_service"
    | "registry_match";
  label: string;
  done: boolean;
  optional: boolean;
}

export function checklist(i: ChecklistInput): KitCheck[] {
  const domains = i.site?.domains ?? [];
  return [
    { id: "project", label: "Project created", done: true, optional: false },
    { id: "website", label: "Website added", done: i.site !== null, optional: false },
    {
      id: "domain_declared",
      label: "Production domain declared",
      done: domains.length > 0,
      optional: false,
    },
    {
      id: "domain_verified",
      label: "Domain verified (DNS TXT, /.well-known/ file or meta tag)",
      done: domains.some((d) => d.state === "verified"),
      optional: false,
    },
    {
      id: "snippet_live",
      label: "Snippet installed: first event received",
      done: i.devOrCountedEvents,
      optional: false,
    },
    {
      id: "stellar_account",
      label: "Stellar account linked (stellar.toml + signature)",
      done: i.stellarAccount,
      optional: true,
    },
    {
      id: "contracts",
      label: "Contracts registered (Registered Footprint)",
      done: i.footprintItems > 0,
      optional: true,
    },
    { id: "api_service", label: "API service registered", done: i.apiServices > 0, optional: true },
    {
      id: "registry_match",
      label: i.registryKnown
        ? "Matched to your SCF registry entry (automatic once the domain is verified)"
        : "Matched to an SCF registry entry",
      done: i.registryMatch,
      optional: !i.registryKnown,
    },
  ];
}

export function guideFor(framework: KitFramework): string {
  return GUIDES[framework];
}

export type { FrameworkHint, ProjectSummary };
