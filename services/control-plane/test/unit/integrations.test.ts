// SPDX-License-Identifier: Apache-2.0
// Integration catalogue, pure parts: the catalogue covers every group, filters by group,
// project kind and stack, generates each card from the tenant's rows without any secret, reuses the kit's and the
// OTel wizard's text, and its test commands — executed by a real POSIX shell with `curl` replaced by a recorder —
// send exactly what the never-counted mechanisms need: a dev-origin page view (wire-formats §a.8) and a cumulative
// first point from a fresh source whose stream started more than the writer's fresh window earlier (C-122) — in the
// metric family of the integration, with values the Collector's closed sets contain — a dev batch of the
// integration's own Stellar events or RPC aggregate, a stale app event (§a.9), the badge document and the pin check.
// The same commands run verbatim against the real local stack in test/live/integration-test-commands.sh.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { otelConfig } from "../../src/api/otel.ts";
import {
  AUDIENCES,
  definition,
  GROUPS,
  INTEGRATION_IDS,
  type RenderCtx,
  render,
  select,
} from "../../src/integrations/catalogue.ts";
import { recommendation, type Signals, statusOf } from "../../src/integrations/status.ts";
import {
  APP_TEST_AGE_S,
  APP_TEST_EVENT,
  appTestCurl,
  badgeTestCurl,
  heredocEscape,
  OTLP_TEST_POINTS,
  OTLP_TEST_START_OFFSET_S,
  type OtlpTestFamily,
  otlpTestCurl,
  pinTestCommand,
  RPC_TEST_AGGREGATE,
  WEB_TEST_EVENT_ID,
  WEB_TEST_PATH,
  webTestCurl,
} from "../../src/integrations/test-commands.ts";
import { scriptTag } from "../../src/onboarding/kit.ts";

const ROOT = new URL("../../../../", import.meta.url).pathname;
const SITE_KEY = "AbCdEfGhIjKlMnOpQrStUv";
const PIN = {
  version: "1.1.0",
  src: "https://e1.example.test/lib/1.1.0/standard.js",
  integrity: "sha384-FxNgk7NxOM+wn1+YzTarNIjhhYKozNHG07tn6+vmn40B9r5FEisJQKqbUUglWFdk",
};
const CTX: RenderCtx = {
  site: {
    site_id: "00000000-0000-4000-8000-000000000001",
    name: "Docs",
    site_key: SITE_KEY,
    tracker_profile: "standard",
    domains: [{ domain_id: "d", host: "app.example.org", state: "verified" }],
    dev_origins: ["localhost"],
  },
  pin: PIN,
  ingestOrigin: "https://e1.example.test",
  otlpEndpoint: "https://e1.example.test",
  service: { service_id: "00000000-0000-4000-8000-000000000002", service_name: "anchor-api" },
  portalOrigin: "https://app.example.test",
  ingestOrigins: ["https://e1.example.test", "https://e2.example.test"],
  tenant: { slug: "my-project", public_stats: false },
};
const EMPTY: RenderCtx = { ...CTX, site: null, pin: null, service: null };

/** The writer's fresh window (metrics-writer internal/cumul FreshWindow, C-122). */
const FRESH_WINDOW_S = 10 * 60;

const all = (ctx: RenderCtx) =>
  INTEGRATION_IDS.map((id) =>
    render(definition(id) as NonNullable<ReturnType<typeof definition>>, ctx),
  );

// ------------------------------------------------------------------------------------------------ shell harness

const dir = mkdtempSync(join(tmpdir(), "scf-integrations-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fakeCurl = join(dir, "curl");
writeFileSync(
  fakeCurl,
  `#!/bin/sh\n# records its arguments (one per line) and stdin\nfor a in "$@"; do printf '%s\\n' "$a"; done > "$REC.args"\ncat > "$REC.stdin"\necho 'HTTP/1.1 200 OK'\n`,
);
chmodSync(fakeCurl, 0o755);

function runShell(script: string, env: Record<string, string> = {}) {
  const rec = join(dir, `rec-${Math.random().toString(36).slice(2)}`);
  execFileSync("/bin/sh", ["-c", script], {
    cwd: dir,
    env: { PATH: `${dir}:/usr/bin:/bin`, REC: rec, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    args: readFileSync(`${rec}.args`, "utf8").split("\n").slice(0, -1),
    stdin: readFileSync(`${rec}.stdin`, "utf8"),
  };
}

// ------------------------------------------------------------------------------------------------ catalogue

describe("catalogue", () => {
  it("covers every group the plan names, with unique ids", () => {
    expect(new Set(INTEGRATION_IDS).size).toBe(INTEGRATION_IDS.length);
    for (const g of GROUPS) expect(select({ group: g }).length).toBeGreaterThan(0);
    for (const id of [
      "web_script_tag",
      "web_npm",
      "web_nextjs",
      "web_nuxt",
      "web_sveltekit",
      "web_astro",
      "web_react_spa",
      "web_react_router",
      "web_static_generators",
      "web_cms",
      "wallet_wallets_kit",
      "wallet_freighter",
      "wallet_passkeys",
      "api_otel_node",
      "api_otel_fastapi",
      "api_otel_go",
      "api_otel_rust",
      "api_otel_java",
      "api_otel_dotnet",
      "api_otel_collector",
      "api_anchor_platform",
      "api_edge",
      "api_stellar_sdk",
      "onchain_contracts",
      "onchain_scaffold",
      "tool_cli",
      "tool_mcp",
      // the API integration cards
      "wallet_privy",
      "wallet_walletconnect",
      "wallet_browser_rpc",
      "api_stellar_sdk_python",
      "api_partner_calls",
      "api_payments",
      "api_anchor_wallet_sdk",
      "api_anchor_platform_events",
      "app_react_native",
      "app_flutter",
      "app_telegram_mini_app",
      "tool_badges",
      "tool_pin_action",
    ])
      expect(INTEGRATION_IDS).toContain(id);
  });

  it("links only guides and examples that exist in the repository", () => {
    for (const c of all(CTX)) {
      if (c.guide_path) expect(existsSync(join(ROOT, c.guide_path)), c.id).toBe(true);
      if (c.example_path) {
        expect(c.example_path, c.id).toMatch(/^examples\/[a-z0-9-]+$/);
        expect(existsSync(join(ROOT, c.example_path, "README.md")), c.id).toBe(true);
      }
    }
  });

  it("links every example of examples/README.md that has a card of its own", () => {
    const linked = new Set(all(CTX).map((c) => c.example_path));
    for (const ex of [
      "privy",
      "walletconnect",
      "stellar-rpc-browser",
      "stellar-rpc-python",
      "partner-calls",
      "api-x402",
      "anchor-wallet-sdk",
      "anchor-platform-listener",
      "mobile-react-native",
      "mobile-flutter",
      "telegram-mini-app",
      "pin-action",
      "edge-cloudflare-workers",
      "wallets-kit",
      "html",
    ])
      expect(linked.has(`examples/${ex}`), ex).toBe(true);
  });

  it("filters by group, project kind and stack (cards for any stack always stay)", () => {
    expect(select({ group: "wallets" }).map((d) => d.id)).toEqual([
      "wallet_wallets_kit",
      "wallet_freighter",
      "wallet_passkeys",
      "wallet_privy",
      "wallet_walletconnect",
      "wallet_browser_rpc",
    ]);
    expect(select({ group: "mobile" }).map((d) => d.id)).toEqual([
      "app_react_native",
      "app_flutter",
      "app_telegram_mini_app",
    ]);
    const anchor = select({ audience: "anchor" }).map((d) => d.id);
    expect(anchor).toContain("api_anchor_platform");
    expect(anchor).not.toContain("web_cms");
    expect(anchor).not.toContain("wallet_freighter");
    const py = select({ stack: "python" }).map((d) => d.id);
    expect(py).toContain("api_otel_fastapi");
    expect(py).toContain("api_stellar_sdk_python");
    expect(py).toContain("web_script_tag"); // `any`
    expect(py).not.toContain("api_otel_go");
    expect(select({ stack: "PYTHON" }).map((d) => d.id)).toEqual(py);
    expect(select({ group: "api", stack: "cloudflare-workers" }).map((d) => d.id)).toEqual([
      "api_otel_collector",
      "api_edge",
    ]);
    for (const a of AUDIENCES) expect(select({ audience: a }).length).toBeGreaterThan(0);
  });

  it("says what each integration measures and never sends, and how it is available", () => {
    for (const c of all(CTX)) {
      expect(c.measures.length, c.id).toBeGreaterThan(0);
      expect(c.privacy.length, c.id).toBeGreaterThan(0);
      if (c.availability !== "ready") expect(c.availability_note, c.id).toBeTruthy();
    }
    expect(render(definition("api_stellar_sdk") as never, CTX).availability).toBe("beta");
    expect(render(definition("api_edge") as never, CTX).availability).toBe("beta");
  });
});

describe("generated configuration", () => {
  it("is the kit's script tag byte for byte, with the site key filled in", () => {
    const c = render(definition("web_script_tag") as never, CTX);
    expect(c.needs).toBeNull();
    expect(c.setup[0]?.code).toBe(scriptTag(PIN, SITE_KEY));
    expect(c.setup[0]?.code).toContain(`data-site="${SITE_KEY}"`);
  });

  it("reuses getOtelConfig's text for every OpenTelemetry stack", () => {
    for (const stack of [
      "node",
      "nextjs",
      "fastapi",
      "go",
      "rust",
      "java",
      "dotnet",
      "collector",
    ] as const) {
      const c = render(definition(`api_otel_${stack}`) as never, CTX);
      const r = otelConfig(stack, "anchor-api", "https://e1.example.test");
      for (const f of r.files)
        expect(c.setup.find((b) => b.filename === f.filename)?.code).toBe(f.content);
      for (const [k, v] of Object.entries(r.env))
        expect(c.setup.find((b) => b.language === "env")?.code).toContain(`${k}=${v}`);
    }
  });

  it("asks for a website or service first instead of rendering placeholders", () => {
    for (const c of all(EMPTY)) {
      if (c.target === "site" || c.target === "service") {
        expect(c.needs, c.id).toMatch(/first|active/);
        expect(c.setup, c.id).toEqual([]);
        expect(c.test.command, c.id).toBeNull();
      }
    }
    expect(render(definition("tool_mcp") as never, EMPTY).needs).toBeNull();
  });

  it("never contains a secret: tokens are placeholders or read from the shell", () => {
    const text = JSON.stringify(all(CTX));
    expect(text).not.toMatch(/scfa_(ing|op|pub)_[A-Za-z0-9]/);
    expect(text).not.toMatch(/\bS[A-Z2-7]{55}\b/); // Stellar secret seed shape
    const otlp = render(definition("api_otel_node") as never, CTX);
    expect(otlp.test.command?.code).toContain("$SCF_OTLP_TOKEN");
    expect(JSON.stringify(otlp.setup)).toContain("<INGEST_TOKEN>");
  });

  it("every site card with a test sends the web test; every service card the OTLP test", () => {
    for (const c of all(CTX)) {
      if (c.test.kind === "web_dev_event") expect(c.test.command?.code, c.id).toContain("/v1/e");
      if (c.test.kind === "otlp_baseline")
        expect(c.test.command?.code, c.id).toContain("/v1/metrics");
      if (c.test.kind === "app_event")
        expect(c.test.command?.code, c.id).toContain("/v1/app-events");
      if (c.target === "service") expect(c.test.kind, c.id).toBe("otlp_baseline");
      if (c.live_check === "otlp_baseline") expect(c.target, c.id).toBe("service");
      if (c.live_check === "app_events") expect(c.test.kind, c.id).toBe("app_event");
      // every card that can be tested from a shell has its command (the four steps: pick, config, test, live)
      if (c.needs === null && !["browser", "portal"].includes(c.test.kind))
        expect(c.test.command, c.id).not.toBeNull();
    }
  });

  it("each client-metric card tests with its own metric family", () => {
    const fam = (id: string) => {
      const code = render(definition(id) as never, CTX).test.command?.code ?? "";
      return code.slice(code.indexOf("<<EOF"));
    };
    expect(fam("api_stellar_sdk")).toContain('"stellar.tx.simulations"');
    expect(fam("api_stellar_sdk_python")).toContain('"stellar.tx.simulations"');
    expect(fam("api_partner_calls")).toContain('"stellar.partner.call.duration"');
    expect(fam("api_payments")).toContain('"payment.server.events"');
    expect(fam("api_anchor_wallet_sdk")).toContain('"stellar.anchor.events"');
    expect(fam("api_anchor_platform_events")).toContain('"stellar.anchor.transfer.created"');
    expect(fam("api_otel_node")).toContain('"http.server.request.duration"');
  });

  it("uses the integration's real API in the generated configuration", () => {
    const code = (id: string) =>
      render(definition(id) as never, CTX)
        .setup.map((b) => b.code)
        .join("\n");
    expect(code("wallet_privy")).toContain(
      "wrapPrivyStellar(useSignRawHash(), { networkPassphrase })",
    );
    expect(code("wallet_privy")).toContain('from "@usagemap/tracker/privy"');
    expect(code("wallet_walletconnect")).toContain("wrapWalletsKitModules([walletConnect])");
    expect(code("wallet_browser_rpc")).toContain(
      'attachRpcTelemetry(server, { network: "testnet" })',
    );
    expect(code("api_stellar_sdk_python")).toContain('client=StellarRpcClient(network="testnet")');
    expect(code("api_partner_calls")).toContain("partnerFetch(globalThis.fetch");
    expect(code("api_payments")).toContain("instrumentX402Http(httpServer)");
    expect(code("api_payments")).toContain("instrumentMppx(mppx)");
    expect(code("api_anchor_wallet_sdk")).toContain("instrumentWalletSdk(wallet)");
    expect(code("api_anchor_platform_events")).toContain("OTEL_SERVICE_NAME=anchor-api");
    expect(code("app_react_native")).toContain(`siteKey: "${SITE_KEY}"`);
    expect(code("app_react_native")).toContain('"https://e1.example.test/v1/app-events"');
    expect(code("app_flutter")).toContain(`siteKey: '${SITE_KEY}'`);
    expect(code("app_telegram_mini_app")).toContain("tmaPlatform(tg?.platform)");
    expect(code("tool_badges")).toContain(
      "https://app.example.test/public/v1/projects/my-project/badge.svg",
    );
    expect(code("tool_pin_action")).toContain("hosts: e1.example.test,e2.example.test");
    // every snippet line that names a package export is one the examples use (no invented API)
    for (const [id, ex, needle] of [
      [
        "wallet_privy",
        "privy/src/App.tsx",
        "wrapPrivyStellar(useCreateWallet(), { networkPassphrase })",
      ],
      [
        "wallet_walletconnect",
        "walletconnect/src/main.ts",
        "modules: wrapWalletsKitModules([walletConnect]),",
      ],
      [
        "wallet_browser_rpc",
        "stellar-rpc-browser/src/main.ts",
        'attachRpcTelemetry(server, { network: "testnet" });',
      ],
      ["api_partner_calls", "partner-calls/index.mjs", "partnerFetch(globalThis.fetch, opts)"],
      ["api_anchor_wallet_sdk", "anchor-wallet-sdk/index.mjs", "instrumentWalletSdk(wallet);"],
      [
        "app_telegram_mini_app",
        "telegram-mini-app/src/main.ts",
        "tmaPlatform: tmaPlatform(tg?.platform),",
      ],
    ] as const) {
      const src = readFileSync(join(ROOT, "examples", ex), "utf8");
      expect(src, id).toContain(needle);
    }
  });
});

// ------------------------------------------------------------------------------------------------ test commands

describe("web test command (dev-origin page view, never counted)", () => {
  it("posts one schema-valid page view of the test path from localhost", () => {
    const { args } = runShell(
      webTestCurl({
        ingestOrigin: "https://e1.example.test/",
        siteKey: SITE_KEY,
        profile: "strict",
        trackerVersion: "1.1.0",
      }),
    );
    expect(args).toContain("https://e1.example.test/v1/e");
    expect(args).toContain("Origin: http://localhost:5173");
    expect(args).toContain("Content-Type: text/plain;charset=UTF-8");
    const body = JSON.parse(args[args.indexOf("--data") + 1] as string);
    expect(body).toEqual({
      v: 1,
      s: SITE_KEY,
      p: "strict",
      tv: "1.1.0",
      e: [{ id: WEB_TEST_EVENT_ID, k: "pv", u: WEB_TEST_PATH }],
    });
    expect(body.e[0].id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.t).toBeUndefined(); // no token: challenge_missing, which a dev entry reports and never counts
  });
});

describe("OTLP test command (cumulative baseline point, never counted)", () => {
  it("refuses to run without SCF_OTLP_TOKEN", () => {
    expect(() =>
      runShell(
        otlpTestCurl({ otlpEndpoint: "https://e1.example.test", serviceName: "anchor-api" }),
      ),
    ).toThrow();
  });

  it("sends a cumulative first point that only seeds state (C-122), with the token from the shell", () => {
    const before = Math.floor(Date.now() / 1000);
    const { args, stdin } = runShell(
      otlpTestCurl({ otlpEndpoint: "https://e1.example.test", serviceName: "anchor-api" }),
      { SCF_OTLP_TOKEN: "test-token-value" },
    );
    expect(args).toContain("https://e1.example.test/v1/metrics");
    expect(args).toContain("Authorization: Bearer test-token-value");
    expect(args).toContain("Content-Type: application/json");
    const body = JSON.parse(stdin);
    const rm = body.resourceMetrics[0];
    const attrs = Object.fromEntries(
      rm.resource.attributes.map((a: { key: string; value: { stringValue: string } }) => [
        a.key,
        a.value.stringValue,
      ]),
    );
    expect(attrs["service.name"]).toBe("anchor-api");
    expect(attrs["service.instance.id"]).toMatch(/^usagemap-test-\d{19}-\d+$/);
    const m = rm.scopeMetrics[0].metrics[0];
    expect(m.name).toBe("http.server.request.duration");
    expect(m.unit).toBe("s");
    expect(m.histogram.aggregationTemporality).toBe(2); // CUMULATIVE
    const p = m.histogram.dataPoints[0];
    const start = BigInt(p.startTimeUnixNano);
    const time = BigInt(p.timeUnixNano);
    expect(Number(time / 1_000_000_000n)).toBeGreaterThanOrEqual(before);
    // started more than the fresh window before the point → a first point that only seeds (cumulative_first_point)
    expect(Number((time - start) / 1_000_000_000n)).toBeGreaterThan(FRESH_WINDOW_S);
    expect(Number((time - start) / 1_000_000_000n)).toBeGreaterThanOrEqual(
      OTLP_TEST_START_OFFSET_S - 1,
    );
    // and well inside the Collector's 48-hour late-data bound
    expect(Number((time - start) / 1_000_000_000n)).toBeLessThan(48 * 3600);
    expect(p.count).toBe("1");
    expect(p.bucketCounts.reduce((a: number, b: string) => a + Number(b), 0)).toBe(1);
    expect(p.bucketCounts.length).toBe(p.explicitBounds.length + 1);
  });

  it("uses a fresh instance id on every run, so each run is a first point again", () => {
    const script = otlpTestCurl({ otlpEndpoint: undefined, serviceName: "anchor-api" });
    const id = () =>
      JSON.parse(runShell(script, { SCF_OTLP_TOKEN: "x" }).stdin).resourceMetrics[0].resource
        .attributes[1].value.stringValue;
    expect(id()).not.toBe(id());
    expect(runShell(script, { SCF_OTLP_TOKEN: "x" }).args).toContain(
      "https://<OTLP_ENDPOINT>/v1/metrics",
    );
  });

  it("carries any printable service name byte for byte (JSON and here-document escaping)", () => {
    for (const name of ['we"ird\\name', "dollar$HOME`id`", "plain-svc.v2", "$(touch pwned)"]) {
      const { stdin } = runShell(
        otlpTestCurl({ otlpEndpoint: "https://x.test", serviceName: name }),
        {
          SCF_OTLP_TOKEN: "x",
        },
      );
      expect(JSON.parse(stdin).resourceMetrics[0].resource.attributes[0].value.stringValue).toBe(
        name,
      );
    }
    expect(existsSync(join(dir, "pwned"))).toBe(false);
    expect(heredocEscape("a$b`c\\d")).toBe("a\\$b\\`c\\\\d");
  });
});

describe("wallet and RPC test commands (dev-origin Stellar events, never counted)", () => {
  const body = (id: string) => {
    const code = render(definition(id) as never, CTX).test.command?.code as string;
    const { args } = runShell(code);
    expect(args).toContain("https://e1.example.test/v1/e");
    expect(args).toContain("Origin: http://localhost:5173");
    return JSON.parse(args[args.indexOf("--data") + 1] as string);
  };
  // the closed vocabulary of wire-formats §a.3.1 / $defs/stellar for the fields the tests use
  const STELLAR = {
    n: ["wallet_connect", "wallet_connect_failed", "walletconnect_session"],
    wt: ["privy", "walletconnect"],
    net: ["testnet"],
    ck: ["new", "restored"],
    fr: [
      "user_rejected",
      "wallet_not_installed",
      "wallet_locked",
      "network_mismatch",
      "timeout",
      "error_other",
    ],
    wc: ["none", "varial_inapp", "dcent_inapp", "scopuly_inapp", "other_inapp", "unknown"],
    ws: ["proposed", "approved", "rejected"],
  } as Record<string, string[]>;

  it("sends the integration's own closed-vocabulary events on the test path, ids unique", () => {
    for (const [id, names] of [
      ["wallet_privy", ["wallet_connect", "wallet_connect_failed"]],
      ["wallet_walletconnect", ["walletconnect_session", "wallet_connect_failed"]],
    ] as const) {
      const b = body(id);
      expect(b).toMatchObject({ v: 1, s: SITE_KEY, p: "standard", tv: PIN.version });
      expect(b.t).toBeUndefined();
      expect(b.e.map((e: { n: string }) => e.n)).toEqual(names);
      expect(new Set(b.e.map((e: { id: string }) => e.id)).size).toBe(b.e.length);
      for (const e of b.e) {
        expect(e.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(e).toMatchObject({ k: "wl", sv: 1, u: WEB_TEST_PATH });
        for (const [k, v] of Object.entries(e))
          if (!["id", "k", "sv", "u"].includes(k))
            expect(STELLAR[k], `${id} ${k}=${v}`).toContain(v);
      }
    }
    expect(body("wallet_privy").e[0].wt).toBe("privy");
  });

  it("sends the page view and one schema-shaped RPC aggregate", () => {
    const b = body("wallet_browser_rpc");
    expect(b.e[0]).toEqual({ id: WEB_TEST_EVENT_ID, k: "pv", u: WEB_TEST_PATH });
    expect(b.e[1]).toEqual(RPC_TEST_AGGREGATE);
    expect(b.e[1]).toMatchObject({ k: "wl", sv: 1, n: "stellar_rpc" });
    for (const c of b.e[1].c) {
      expect(c).toHaveLength(6);
      expect(["rpc", "horizon"]).toContain(c[0]);
      expect(c[1]).toMatch(/^[a-z0-9_]{1,40}$/);
      expect([
        "ok",
        "rpc_error",
        "http_4xx",
        "http_429",
        "http_5xx",
        "timeout",
        "network_error",
      ]).toContain(c[3]);
      expect(["lt100ms", "100_500ms", "500_2000ms", "gt2000ms"]).toContain(c[4]);
      expect(Number.isInteger(c[5]) && c[5] >= 1).toBe(true);
    }
  });
});

describe("OTLP test points per metric family", () => {
  const COLLECTOR = join(ROOT, "collector/processor/scfsanitizeprocessor");
  const rules = ["stellar.go", "partner.go", "payments.go", "anchors.go", "clientrules.go"]
    .map((f) => readFileSync(join(COLLECTOR, f), "utf8"))
    .join("\n");
  // open-valued keys the Collector keeps when they are a public DNS name (anchors.go)
  const OPEN = new Set(["stellar.anchor.home_domain", "stellar.anchor.client"]);

  it("each family is one cumulative point the Collector's closed sets keep, from a fresh source", () => {
    for (const family of Object.keys(OTLP_TEST_POINTS) as OtlpTestFamily[]) {
      const { stdin } = runShell(
        otlpTestCurl({
          otlpEndpoint: "https://e1.example.test",
          serviceName: "anchor-api",
          family,
        }),
        { SCF_OTLP_TOKEN: "x" },
      );
      const rm = JSON.parse(stdin).resourceMetrics[0];
      expect(rm.resource.attributes[1].value.stringValue).toMatch(/^usagemap-test-\d{19}-\d+$/);
      const m = rm.scopeMetrics[0].metrics[0];
      const spec = OTLP_TEST_POINTS[family];
      expect(m.name, family).toBe(spec.metric);
      const data = spec.kind === "sum" ? m.sum : m.histogram;
      expect(data.aggregationTemporality, family).toBe(2);
      const p = data.dataPoints[0];
      const age = Number((BigInt(p.timeUnixNano) - BigInt(p.startTimeUnixNano)) / 1_000_000_000n);
      expect(age).toBeGreaterThan(FRESH_WINDOW_S);
      if (spec.kind === "sum") {
        expect(m.sum.isMonotonic).toBe(true);
        expect(p.asInt).toBe("1");
      } else {
        expect(p.bucketCounts.length).toBe(p.explicitBounds.length + 1);
        expect(p.bucketCounts.reduce((a: number, b: string) => a + Number(b), 0)).toBe(1);
      }
      if (family === "http") continue;
      expect(rules, family).toContain(`"${spec.metric}"`);
      for (const [k, v] of spec.attributes) {
        expect(rules, `${family} ${k}`).toContain(`"${k}"`);
        if (OPEN.has(k)) expect(v).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
        else expect(rules, `${family} ${k}=${v}`).toContain(`"${v}"`);
      }
    }
  });

  it("the HTTP family is the original test point, byte for byte", () => {
    const a = otlpTestCurl({ otlpEndpoint: "https://x.test", serviceName: "s" });
    expect(otlpTestCurl({ otlpEndpoint: "https://x.test", serviceName: "s", family: "http" })).toBe(
      a,
    );
    expect(a).toContain('"http.route","value":{"stringValue":"/usagemap-test"}');
    expect(a).toContain('"http.response.status_code","value":{"intValue":"200"}');
  });
});

describe("app-event test command (stale event, never counted)", () => {
  it("posts one schema-valid app event two days old with the public site key", () => {
    const now = Math.floor(Date.now() / 1000);
    const code = render(definition("app_react_native") as never, CTX).test.command?.code as string;
    expect(code).toBe(
      appTestCurl({
        ingestOrigin: "https://e1.example.test",
        siteKey: SITE_KEY,
        platform: "android",
        sdkVersion: "usagemap-test/1.0.0",
      }),
    );
    const { args, stdin } = runShell(code);
    expect(args).toContain("https://e1.example.test/v1/app-events");
    expect(args).toContain("Content-Type: application/json");
    const b = JSON.parse(stdin);
    expect(Object.keys(b).sort()).toEqual([
      "app_version",
      "events",
      "k",
      "platform",
      "sdk_version",
      "v",
    ]);
    expect(b).toMatchObject({ v: 1, k: SITE_KEY, platform: "android", app_version: "0.0.0" });
    expect(b.sdk_version).toMatch(/^[a-z][a-z0-9-]{0,23}\/[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/);
    expect(b.events).toHaveLength(1);
    const e = b.events[0];
    expect(Object.keys(e).sort()).toEqual(["name", "session", "ts"]);
    expect(e.name).toBe(APP_TEST_EVENT);
    expect(e.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
    expect(e.session).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // outside [now − 24 h, now + 5 min]: dropped as stale, never an event or a session
    const ageS = now - Math.floor(e.ts / 1000);
    expect(ageS).toBeGreaterThan(24 * 3600);
    expect(ageS).toBeGreaterThanOrEqual(APP_TEST_AGE_S - 2);
  });
});

describe("badge and pin test commands", () => {
  it("fetches the project's Shields badge document", () => {
    const code = render(definition("tool_badges") as never, CTX).test.command?.code as string;
    expect(code).toBe(
      badgeTestCurl({ portalOrigin: "https://app.example.test", slug: "my-project" }),
    );
    const { args } = runShell(code);
    expect(args).toContain("https://app.example.test/public/v1/projects/my-project/badge.json");
  });

  it("runs the pin Action on one page holding this website's tag, against this deployment", () => {
    const code = render(definition("tool_pin_action") as never, CTX).test.command?.code as string;
    expect(code).toBe(
      pinTestCommand({
        portalOrigin: "https://app.example.test",
        hosts: ["e1.example.test", "e2.example.test"],
        tag: scriptTag(PIN, SITE_KEY),
      }),
    );
    const work = mkdtempSync(join(dir, "pin-"));
    mkdirSync(join(work, "tools/pin-action"), { recursive: true });
    const fake = join(work, "tools/pin-action/run");
    writeFileSync(
      fake,
      '#!/usr/bin/env bash\n# bash, like the real run script: dash would drop INPUT_MANIFEST-URL (not a shell name)\nprintf \'%s\\n\' "$@" > args\nenv | grep ^INPUT_ | sort > inputs\ncp "$2/index.html" page\n',
    );
    chmodSync(fake, 0o755);
    execFileSync("/bin/sh", ["-c", code], { cwd: work, env: { PATH: "/usr/bin:/bin" } });
    expect(readFileSync(join(work, "args"), "utf8")).toBe("check\nusagemap-pin-test\n");
    expect(readFileSync(join(work, "inputs"), "utf8")).toBe(
      "INPUT_HOSTS=e1.example.test,e2.example.test\n" +
        "INPUT_MANIFEST-URL=https://app.example.test/v1/tracker/versions\n",
    );
    expect(readFileSync(join(work, "page"), "utf8")).toBe(`${scriptTag(PIN, SITE_KEY)}\n`);
    // without a website or tracker version only the self-test is offered
    expect(render(definition("tool_pin_action") as never, EMPTY).test.command?.code).toBe(
      "tools/pin-action/run selftest",
    );
  });
});

// ------------------------------------------------------------------------------------------------ status

const SIG: Signals = {
  site: {
    site_id: "s",
    dev_origins: [],
    dev_events_24h: 0,
    wallet_dev_events_24h: 0,
    test_events_24h: 0,
    last_dev_event_at: null,
    counted_7d: false,
    wallet_counted_7d: false,
    passkey_counted_7d: false,
    wallets_kit_seen_7d: false,
    rpc_counted_7d: false,
    app_events_7d: 0,
    app_stale_drops_2d: 0,
    app_reports_7d: 0,
  },
  service: {
    service_id: "v",
    service_name: "api",
    baseline_points_2d: 0,
    reports_7d: 0,
    counted_7d: false,
  },
  footprint_items: 0,
  public_stats: false,
};
const st = (id: string, s: Signals) => statusOf(definition(id) as never, s).status;
const withSite = (p: Partial<NonNullable<Signals["site"]>>): Signals => ({
  ...SIG,
  site: { ...(SIG.site as NonNullable<Signals["site"]>), ...p },
});

describe("status", () => {
  it("web: not started → test received (dev events) → live data seen (counted)", () => {
    expect(st("web_script_tag", SIG)).toBe("not_started");
    expect(st("web_script_tag", withSite({ dev_events_24h: 1 }))).toBe("test_received");
    expect(st("web_nextjs", withSite({ dev_events_24h: 1, counted_7d: true }))).toBe(
      "live_data_seen",
    );
    expect(st("web_script_tag", { ...SIG, site: null })).toBe("not_started");
  });

  it("wallets: only wallet events count, passkeys only passkey events", () => {
    expect(st("wallet_wallets_kit", withSite({ dev_events_24h: 5, counted_7d: true }))).toBe(
      "not_started",
    );
    expect(st("wallet_wallets_kit", withSite({ wallet_dev_events_24h: 1 }))).toBe("test_received");
    expect(st("wallet_freighter", withSite({ wallet_counted_7d: true }))).toBe("live_data_seen");
    expect(st("wallet_passkeys", withSite({ wallet_counted_7d: true }))).toBe("not_started");
    expect(st("wallet_passkeys", withSite({ passkey_counted_7d: true }))).toBe("live_data_seen");
  });

  it("API: a data-quality counter (the baseline test point) is a test received; stored requests are live", () => {
    const svc = (p: Partial<NonNullable<Signals["service"]>>): Signals => ({
      ...SIG,
      service: { ...(SIG.service as NonNullable<Signals["service"]>), ...p },
    });
    expect(st("api_otel_node", SIG)).toBe("not_started");
    expect(st("api_edge", svc({ baseline_points_2d: 1, reports_7d: 1 }))).toBe("test_received");
    expect(st("api_otel_go", svc({ reports_7d: 3, counted_7d: true }))).toBe("live_data_seen");
    expect(st("api_otel_go", { ...SIG, service: null })).toBe("not_started");
  });

  it("contracts are configured once registered; local tools are not observable", () => {
    expect(st("onchain_contracts", SIG)).toBe("not_started");
    expect(st("onchain_contracts", { ...SIG, footprint_items: 2 })).toBe("configured");
    expect(st("tool_cli", SIG)).toBe("not_observable");
    expect(st("tool_mcp", SIG)).toBe("not_observable");
  });

  it("browser RPC: the test's page view is a test received; stored RPC totals are live", () => {
    expect(st("wallet_browser_rpc", SIG)).toBe("not_started");
    expect(st("wallet_browser_rpc", withSite({ dev_events_24h: 1 }))).toBe("test_received");
    expect(st("wallet_browser_rpc", withSite({ wallet_counted_7d: true }))).toBe("not_started");
    expect(st("wallet_browser_rpc", withSite({ rpc_counted_7d: true }))).toBe("live_data_seen");
    // the other new wallet cards follow the wallet events
    expect(st("wallet_privy", withSite({ wallet_dev_events_24h: 2 }))).toBe("test_received");
    expect(st("wallet_walletconnect", withSite({ wallet_counted_7d: true }))).toBe(
      "live_data_seen",
    );
  });

  it("app events: the stale test event is a test received; accepted events are live (self-attested)", () => {
    for (const id of ["app_react_native", "app_flutter"]) {
      expect(st(id, SIG)).toBe("not_started");
      expect(st(id, withSite({ dev_events_24h: 3, counted_7d: true }))).toBe("not_started");
      expect(st(id, withSite({ app_stale_drops_2d: 1, app_reports_7d: 1 }))).toBe("test_received");
      expect(st(id, withSite({ app_events_7d: 4, app_reports_7d: 5 }))).toBe("live_data_seen");
      expect(st(id, { ...SIG, site: null })).toBe("not_started");
    }
    // the Mini App's page views are web traffic
    expect(st("app_telegram_mini_app", withSite({ dev_events_24h: 1 }))).toBe("test_received");
  });

  it("badges are configured exactly while the statistics are public; the pin Action is local", () => {
    expect(st("tool_badges", SIG)).toBe("not_started");
    expect(st("tool_badges", { ...SIG, public_stats: true })).toBe("configured");
    expect(st("tool_badges", { ...SIG, footprint_items: 3 })).toBe("not_started");
    expect(st("tool_pin_action", SIG)).toBe("not_observable");
  });

  it("recommends the Wallets Kit adapter when the kit is on the pages but no wallet event counts", () => {
    expect(
      recommendation({ id: "wallet_wallets_kit" }, withSite({ wallets_kit_seen_7d: true })),
    ).toMatch(/Kit/);
    expect(
      recommendation(
        { id: "wallet_wallets_kit" },
        withSite({ wallets_kit_seen_7d: true, wallet_counted_7d: true }),
      ),
    ).toBeNull();
    expect(recommendation({ id: "web_script_tag" }, SIG)).toMatch(/Start here/);
    expect(recommendation({ id: "web_script_tag" }, withSite({ counted_7d: true }))).toBeNull();
  });
});
