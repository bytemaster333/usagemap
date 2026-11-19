// SPDX-License-Identifier: Apache-2.0
// Mobile and tooling integration examples, run as their READMEs say against local stand-ins:
//
//   mobile-react-native  usagemap.ts (byte copy of packages/mobile-rn) with App.tsx's options and calls, in Node,
//                        against a stand-in of the edge's /v1/app-events (no device: the request shape is checked)
//   mobile-flutter       bin/send.dart in the pinned Dart image against the same stand-in (no Flutter SDK)
//   scaffold-stellar     the overlay copies; try-extension.sh as a dry run and registering against a control plane
//   stellar-scf-cli      tools/stellar-scf built; check.sh on both payloads, route, test --dry-run, test → OTLP
//   pin-action           tools/pin-action on site/ against a stand-in release list built from tracker/releases
//   mcp-claude           the client configs parsed; the server started with them, initialize → tools/list → tools/call
//   footprint-register   register.sh against a control-plane stand-in, checked against registerFootprintContract
//
// Run: tests/quickstarts/integrations/run.sh (QS_INTEGRATIONS=mobile-flutter,… limits it). Docker is needed for
// mobile-flutter, Go for stellar-scf-cli; a missing toolchain fails unless QS_INTEGRATIONS_ALLOW_SKIP=1.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../lib/env.ts";
import { requestsByRouteStatus, startReceiver } from "../backends/otlp-receiver.ts";
import {
  allowSkip,
  dockerRun,
  EXAMPLES,
  exec,
  type Hit,
  has,
  json,
  runWithInput,
  selected,
  standIn,
} from "./lib.ts";

const ex = (...p: string[]) => join(EXAMPLES, ...p);
/** The example's usagemap.ts (a byte copy of the package source, checked below), typed as the package. */
type MobileRn = typeof import("../../../packages/mobile-rn/src/index.ts");
const loadRnExample = () => import(ex("mobile-react-native/usagemap.ts")) as Promise<MobileRn>;
const repo = (...p: string[]) => join(REPO_ROOT, ...p);
const read = (p: string) => readFileSync(p, "utf8");
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `qs-int-${prefix}-`));

/** Runs a command to its exit (never rejects on a non-zero code). */
const sh = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {},
) => runWithInput(cmd, args, opts.input ?? "", opts);

/** Skips (QS_INTEGRATIONS_ALLOW_SKIP=1) or fails when a toolchain is missing. */
function need(ok: boolean, what: string, skip: (note?: string) => void) {
  if (ok) return;
  if (allowSkip) skip(`${what} not available`);
  else throw new Error(`${what} not available (QS_INTEGRATIONS_ALLOW_SKIP=1 to skip)`);
}

// ---------------------------------------------------------------- app events (wire-formats §a.9)

const SITE = "QsSiteKey0123456789Abc"; // 22 characters, the shape of a site key
const APP_EVENT_FIELDS = ["app_version", "events", "k", "platform", "sdk_version", "v"];

/** The edge's answer and what one app-events request must look like. */
function appEventsStandIn() {
  return standIn((hit, res) => {
    if (hit.method !== "POST" || hit.path !== "/v1/app-events") return false;
    const n = (hit.json as { events?: unknown[] } | undefined)?.events?.length ?? 0;
    json(res, 202, { accepted: n, dropped: 0 });
  });
}

function expectAppEvents(hit: Hit, sdkVersion: string) {
  expect(hit.method).toBe("POST");
  expect(hit.headers["content-type"]).toMatch(/^application\/json/);
  for (const h of ["cookie", "authorization"]) expect(hit.headerNames).not.toContain(h);
  const body = hit.json as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(APP_EVENT_FIELDS);
  expect(body).toMatchObject({
    v: 1,
    k: SITE,
    platform: "android",
    app_version: "1.0.0",
    sdk_version: sdkVersion,
  });
  const events = body.events as Record<string, unknown>[];
  expect(events.map((e) => ({ name: e.name, props: e.props }))).toEqual([
    { name: "app_open", props: undefined },
    { name: "swap_started", props: { pair_class: "stablecoin" } },
  ]);
  for (const e of events) {
    expect(Object.keys(e).every((k) => ["ts", "session", "name", "props"].includes(k))).toBe(true);
    expect(e.session).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(Math.abs(Number(e.ts) - Date.now())).toBeLessThan(5 * 60_000);
  }
  expect(events[0]?.session).toBe(events[1]?.session);
  expect(hit.body).not.toMatch(/device|install|advertis|idfa|gaid|user_?id|wallet/i);
}

describe.skipIf(!selected("mobile-react-native"))("examples/mobile-react-native", () => {
  it("usagemap.ts is the package source; App.tsx's calls send one well-formed app-events request", async () => {
    expect(read(ex("mobile-react-native/usagemap.ts"))).toBe(
      read(repo("packages/mobile-rn/src/index.ts")),
    );
    const app = read(ex("mobile-react-native/App.tsx"));
    for (const call of [
      'import { createUsageMapApp } from "./usagemap";',
      'platform: Platform.OS === "ios" ? "ios" : "android",',
      'appVersion: "1.0.0",',
      'analytics.track("app_open");',
      'analytics.track("swap_started", { pair_class: "stablecoin" })',
      "analytics.flush()",
    ])
      expect(app, call).toContain(call);
    const pkg = JSON.parse(read(ex("mobile-react-native/package.json"))) as {
      dependencies: Record<string, string>;
    };
    for (const [k, v] of Object.entries(pkg.dependencies)) expect(v, k).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read(ex("pnpm-workspace.yaml"))).toContain('"!mobile-react-native"');

    const { createUsageMapApp, SDK_VERSION } = await loadRnExample();
    const edge = await appEventsStandIn();
    try {
      // App.tsx's options with Platform.OS === "android" and EXPO_PUBLIC_USAGEMAP_ENDPOINT set
      const analytics = createUsageMapApp({
        siteKey: SITE,
        platform: "android",
        appVersion: "1.0.0",
        endpoint: `${edge.url}/v1/app-events`,
      });
      expect(analytics.track("app_open")).toBe(true);
      expect(analytics.track("swap_started", { pair_class: "stablecoin" })).toBe(true);
      // refused locally, never sent: a free-text value, an address-like value, a bad event name
      expect(analytics.track("swap_started", { pair_class: "GABC wallet" })).toBe(false);
      expect(analytics.track("swap_started", { pair_class: "GBRPYHIL2CI3" })).toBe(false);
      expect(analytics.track("swap started")).toBe(false);
      await analytics.flush();
      expect(analytics.pending()).toBe(0);
      expect(edge.hits).toHaveLength(1);
      expectAppEvents(edge.hits[0] as Hit, SDK_VERSION);
    } finally {
      await edge.close();
    }
  });
});

const DART = "dart:3.14.1@sha256:36176bf7b6400bdc4aa77ba07b733b2eabf22640f71afd1b83eba679a26d5698";

describe.skipIf(!selected("mobile-flutter"))("examples/mobile-flutter", () => {
  it("lib/ is the package source; bin/send.dart sends one well-formed app-events request", async (ctx) => {
    for (const f of ["usagemap_app_events.dart", "io_transport.dart"])
      expect(read(ex("mobile-flutter/lib", f)), f).toBe(
        read(repo("packages/mobile-flutter/lib", f)),
      );
    const main = read(ex("mobile-flutter/lib/main.dart"));
    for (const call of [
      "analytics.track('app_open');",
      "analytics.track('swap_started', {'pair_class': 'stablecoin'})",
    ])
      expect(main).toContain(call);
    need(await has("docker", ["info"]), "Docker", ctx.skip);

    const edge = await appEventsStandIn();
    try {
      const r = await sh(
        "docker",
        dockerRun(
          `qs-int-dart-${process.pid}`,
          { USAGEMAP_SITE: SITE, USAGEMAP_ENDPOINT: `${edge.url}/v1/app-events` },
          ["-v", `${ex("mobile-flutter")}:/app:ro`, "-w", "/app", DART, "dart", "bin/send.dart"],
        ),
        { timeoutMs: 300_000 },
      );
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("sent 2 events");
      expect(edge.hits).toHaveLength(1);
      expectAppEvents(edge.hits[0] as Hit, "mobile-flutter/0.1.0");
      expect(edge.hits[0]?.headerNames).not.toContain("user-agent-override");
    } finally {
      await edge.close();
    }
  });
});

// ---------------------------------------------------------------- footprint registration

const TENANT = "0b7c6f3e-2a51-4c8e-9d4f-6a1e2b3c4d5e";
const CONTRACT = "CAAXJETKPYAATU4HVVQUTE2FFBULNFGZNEOC3MS635U5K3GZLAY2HI4M";
const REG_KEY = `scfa_reg_AbCdEf123456_SECRETpart${"0".repeat(23)}`;

/** The FootprintRegistration schema's property names, read from the OpenAPI document. */
function registrationProperties(): string[] {
  const doc = read(repo("docs/api/control-plane.openapi.yaml"));
  const at = doc.indexOf("\n    FootprintRegistration:\n");
  expect(at).toBeGreaterThan(0);
  const rest = doc
    .slice(at + 1)
    .split("\n")
    .slice(1);
  const end = rest.findIndex((l) => /^ {4}\S/.test(l));
  const block = rest.slice(0, end);
  const props = block.indexOf("      properties:");
  return block
    .slice(props + 1)
    .filter((l) => /^ {8}[a-z_]+:$/.test(l))
    .map((l) => l.trim().slice(0, -1));
}

function expectRegistration(hit: Hit, label: string) {
  expect(hit.method).toBe("POST");
  expect(hit.path).toBe(`/v1/tenants/${TENANT}/footprint/register`);
  expect(hit.headers.authorization).toBe(`Bearer ${REG_KEY}`);
  expect(hit.headers["content-type"]).toMatch(/^application\/json/);
  expect(hit.headerNames).not.toContain("cookie");
  const body = hit.json as Record<string, unknown>;
  const allowed = registrationProperties();
  expect(allowed.sort()).toEqual(["kind", "label", "network", "subject"]);
  for (const k of Object.keys(body)) expect(allowed, k).toContain(k);
  expect(body).toEqual({ kind: "contract", subject: CONTRACT, network: "testnet", label });
  expect(body.subject).toMatch(/^C[A-Z2-7]{55}$/);
}

const controlPlane = (onHit?: () => void) =>
  standIn((hit, res) => {
    if (!hit.path.endsWith("/footprint/register")) return false;
    onHit?.();
    json(res, 201, {
      kind: "contract",
      subject: (hit.json as { subject?: string }).subject,
      network: "testnet",
      status: "claimed",
    });
  });

describe.skipIf(!selected("footprint-register"))("examples/footprint-register", () => {
  it("register.sh sends one registerFootprintContract request; the key is never on a command line", async () => {
    let keyInArgv: boolean | undefined;
    const api = await controlPlane(() => {
      // while curl waits for this answer: is the key in any process's argv?
      keyInArgv = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" }).includes("SECRETpart");
    });
    const env = {
      SCF_FOOTPRINT_KEY: REG_KEY,
      USAGEMAP_TENANT_ID: TENANT,
      USAGEMAP_API_URL: api.url,
    };
    const script = ex("footprint-register/register.sh");
    try {
      const r = await sh(script, [CONTRACT, "testnet", "my-contract"], { env });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^HTTP\/1\.1 201/);
      expect(r.stdout).toContain('"status":"claimed"');
      expect(api.hits).toHaveLength(1);
      expectRegistration(api.hits[0] as Hit, "my-contract");
      expect(keyInArgv).toBe(false);
      expect(r.stdout + r.stderr).not.toContain("SECRETpart");

      // refused before anything is sent
      const refused: [string[], Record<string, string>, RegExp][] = [
        [[`G${CONTRACT.slice(1)}`, "testnet"], env, /not a contract id/],
        [[CONTRACT, "futurenet"], env, /testnet or mainnet/],
        [
          [CONTRACT, "testnet"],
          { ...env, SCF_FOOTPRINT_KEY: "scfa_ing_AbCdEf012345_x" },
          /registration key/,
        ],
        [[CONTRACT, "testnet"], { ...env, USAGEMAP_API_URL: "http://app.usagemap.dev" }, /https/],
        [[CONTRACT, "testnet", 'x","kind":"account'], env, /label/],
      ];
      for (const [args, e, msg] of refused) {
        const x = await sh(script, args, { env: e });
        expect(x.code, args.join(" ")).toBe(2);
        expect(x.stderr).toMatch(msg);
      }
      expect(api.hits).toHaveLength(1);
    } finally {
      await api.close();
    }
  });
});

describe.skipIf(!selected("scaffold-stellar"))("examples/scaffold-stellar", () => {
  it("the shown files are the template's overlay; assemble.sh pins the upstream commit", () => {
    const overlay = repo("templates/scaffold-stellar/overlay");
    expect(read(ex("scaffold-stellar/app/src/usagemap.ts"))).toBe(
      read(join(overlay, "app/src/usagemap.ts")),
    );
    expect(read(ex("scaffold-stellar/scaffold.usagemap.yml"))).toBe(
      read(join(overlay, "scaffold.yml.fragment")),
    );
    expect(read(ex("scaffold-stellar/usagemap.env.example"))).toBe(
      read(join(overlay, "usagemap.env.example")),
    );
    expect(read(ex("scaffold-stellar/app/biome.json"))).toBe(read(join(overlay, "biome.json")));
    const { commit } = JSON.parse(read(repo("templates/scaffold-stellar/UPSTREAM.json"))) as {
      commit: string;
    };
    expect(read(ex("scaffold-stellar/assemble.sh"))).toContain(`commit=${commit} `);
    execFileSync("bash", ["-n", ex("scaffold-stellar/assemble.sh")]);
  });

  it("try-extension.sh: a dry run sends nothing; with USAGEMAP_REGISTER=1 and a key it registers the contract", async () => {
    const api = await controlPlane();
    const script = ex("scaffold-stellar/try-extension.sh");
    try {
      const dryProject = tmp("scaffold");
      const dry = await sh(script, [dryProject], { env: { USAGEMAP_API_URL: api.url } });
      expect(dry.code, dry.stderr).toBe(0);
      expect(dry.stdout).toContain('"hooks":["post-deploy"]');
      expect(dry.stdout).toMatch(/recorded guess_the_number on testnet/);
      expect(dry.stdout).toMatch(/dry run .*nothing was sent/);
      expect(JSON.parse(read(join(dryProject, ".usagemap/contracts.json")))).toEqual({
        schema: "usagemap-contracts/1",
        contracts: [
          {
            network: "testnet",
            contract: "guess_the_number",
            contract_id: CONTRACT,
            wasm_hash: "a".repeat(64),
          },
        ],
      });
      expect(api.hits).toHaveLength(0);

      const reg = await sh(script, [tmp("scaffold")], {
        env: {
          USAGEMAP_API_URL: api.url,
          USAGEMAP_REGISTER: "1",
          SCF_FOOTPRINT_KEY: REG_KEY,
          USAGEMAP_TENANT_ID: TENANT,
        },
      });
      expect(reg.code, reg.stderr).toBe(0);
      expect(reg.stdout).toMatch(/registered CAAXJE… as claimed/);
      expect(api.hits).toHaveLength(1);
      expectRegistration(api.hits[0] as Hit, "guess_the_number");
      expect(reg.stdout + reg.stderr).not.toContain("SECRETpart");
    } finally {
      await api.close();
    }
  });
});

// ---------------------------------------------------------------- stellar scf

/** A valid ingest token (checksum vector of tools/stellar-scf/cli_test.go). */
const INGEST_TOKEN = ["scfa", "ing", "AbCdEf012345", "ZyXwVuTsRqPoNmLkJiHgFeDcBa92ykKEm"].join("_");

describe.skipIf(!selected("stellar-scf-cli"))("examples/stellar-scf-cli", () => {
  it("check.sh keeps the clean payload, fails on drops; route, test --dry-run and test against OTLP", async (ctx) => {
    need(await has("go", ["version"]), "Go", ctx.skip);
    const bin = join(tmp("scf"), "stellar-scf");
    await exec("go", ["build", "-trimpath", "-o", bin, "."], {
      cwd: repo("tools/stellar-scf"),
      env: { ...process.env, GOWORK: "off", GOFLAGS: "-mod=readonly", CGO_ENABLED: "0" },
      timeout: 600_000,
    });
    const cwd = ex("stellar-scf-cli");
    const env = { STELLAR_SCF: bin };
    const values = [
      "GBRPYHIL2CI3",
      "cursor=1",
      "me@example.com",
      "198.51.100.7",
      "Mozilla",
      "build-host-7",
    ];

    const ok = await sh("./check.sh", [], { cwd, env });
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toMatch(/KEPT 2/);
    expect(ok.stdout).toMatch(/DROPPED 0/);
    expect(ok.stdout).toMatch(/GET\s+\/accounts\/\{id\}\s+200\s+count=12/);
    expect(ok.stdout).toMatch(/GET\s+\/accounts\/\{id\}\s+404\s+count=3/);
    expect(ok.stdout).toMatch(
      /client\.address, host\.name, url\.path, url\.query, user_agent\.original/,
    );
    for (const v of values) expect(ok.stdout, v).not.toContain(v);

    const bad = await sh("./check.sh", ["payload-with-drops.json"], { cwd, env });
    expect(bad.code, bad.stdout + bad.stderr).toBe(3);
    expect(bad.stdout).toMatch(/metric_not_allowed\s+my-api\s+1/);
    expect(bad.stdout).toMatch(/\{unknown\}/);
    for (const v of values) expect(bad.stdout, v).not.toContain(v);

    const route = await sh(bin, [
      "route",
      "/accounts/GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H/payments?cursor=1",
    ]);
    expect(route.code).toBe(0);
    expect(route.stdout).toContain("/accounts/{account}/payments");
    expect(route.stdout).not.toContain("GBRPYHIL2CI3");

    const dry = await sh(bin, ["test", "--service", "my-api", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("https://e1.usagemap.dev/v1/metrics");
    expect(dry.stdout).toContain("Authorization: Bearer <INGEST_TOKEN>");

    const otlp = await startReceiver({ token: INGEST_TOKEN, refuseLogs: true });
    try {
      const sent = await sh(bin, ["test", "--service", "my-api", "--otlp", otlp.url], {
        env: { USAGEMAP_INGEST_TOKEN: INGEST_TOKEN },
      });
      expect(sent.code, sent.stdout + sent.stderr).toBe(0);
      expect(otlp.received.map((r) => [r.path, r.status, r.authorized])).toEqual([
        ["/v1/metrics", 200, true],
      ]);
      expect(requestsByRouteStatus(otlp.metrics())).toMatchObject([
        { route: "/usagemap-test", status: 200, count: 1 },
      ]);
      expect(sent.stdout + sent.stderr).not.toContain("ZyXwVuTs");
    } finally {
      await otlp.close();
    }
  });
});

// ---------------------------------------------------------------- pin action

describe.skipIf(!selected("pin-action"))("examples/pin-action", () => {
  it("the action proposes the newest release for site/, the patch applies, a second run is clean", async () => {
    // the portal's /v1/tracker/versions, built from the real release manifests
    const versions = ["1.1.0", "1.0.0"].map((v) => {
      const m = JSON.parse(read(repo("tracker/releases", v, "manifest.json"))) as {
        version: string;
        files: { profile: string; integrity: string }[];
      };
      return {
        version: m.version,
        status: "active",
        files: m.files.map((f) => ({
          profile: f.profile,
          url: `/lib/${v}/${f.profile}.js`,
          integrity: f.integrity,
        })),
      };
    });
    const newest = versions[0]?.files.find((f) => f.profile === "standard")?.integrity as string;
    const list = await standIn((hit, res) => {
      if (hit.path !== "/v1/tracker/versions") return false;
      json(res, 200, { versions });
    });
    const site = join(tmp("pins"), "site");
    cpSync(ex("pin-action/site"), site, { recursive: true });
    const action = async () => {
      const out = join(site, "..", `out-${Date.now()}`);
      writeFileSync(out, "");
      const r = await sh(process.execPath, [repo("tools/pin-action/src/main.mjs")], {
        cwd: site,
        env: {
          "INPUT_MANIFEST-URL": `${list.url}/v1/tracker/versions`,
          INPUT_HOSTS: "e1.usagemap.dev,e2.usagemap.dev",
          "INPUT_PATCH-FILE": join(site, "..", "pins.patch"),
          GITHUB_OUTPUT: out,
        },
      });
      const outputs = Object.fromEntries(
        read(out)
          .split("\n")
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      return { ...r, outputs };
    };
    try {
      const first = await action();
      expect(first.code, first.stdout).toBe(0);
      expect(first.outputs).toMatchObject({ tags: "1", errors: "0", warnings: "1" });
      expect(first.stdout).toContain("UsageMap tracker outdated");
      const patch = read(first.outputs["patch-file"] as string);
      expect(patch).toContain(
        '+    <script defer src="https://e1.usagemap.dev/lib/1.1.0/standard.js"',
      );
      expect(patch).toContain(newest);
      await exec("git", ["apply", first.outputs["patch-file"] as string], { cwd: site });
      const second = await action();
      expect(second.code, second.stdout).toBe(0);
      expect(second.outputs).toMatchObject({
        tags: "1",
        errors: "0",
        warnings: "0",
        "patch-file": "",
      });
      expect(
        list.hits.map(
          (h) => `${h.method} ${h.path} ${h.headers.authorization ?? ""}${h.headers.cookie ?? ""}`,
        ),
      ).toEqual(["GET /v1/tracker/versions ", "GET /v1/tracker/versions "]);
    } finally {
      await list.close();
    }

    // the workflow sample only uses inputs the action declares
    const wf = read(ex("pin-action/workflow/usagemap-pins.yml"));
    const actionYml = read(repo("tools/pin-action/action.yml"));
    const withKeys = [...wf.matchAll(/^ {10}([a-z-]+):/gm)].map((m) => m[1] as string);
    expect(withKeys).toEqual(["path", "hosts"]);
    for (const k of withKeys) expect(actionYml).toMatch(new RegExp(`^ {2}${k}:$`, "m"));
    expect(wf).toContain("uses: <owner>/<repo>/tools/pin-action@<pinned sha>");
  });
});

// ---------------------------------------------------------------- MCP

const PUB_KEY = `scfa_pub_B1b2C3d4E5f6_${"y".repeat(27)}Yy0Yy0`; // the shape tools/mcp/test uses

interface McpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  type?: string;
}

describe.skipIf(!selected("mcp-claude"))("examples/mcp-claude", () => {
  it("every client config starts tools/mcp/server.ts with only the variables it reads", () => {
    const server = read(repo("tools/mcp/server.ts"));
    for (const f of ["mcp.json", "claude_desktop_config.json", "cursor-mcp.json"]) {
      const cfg = JSON.parse(read(ex("mcp-claude", f))) as {
        mcpServers: Record<string, McpServer>;
      };
      expect(Object.keys(cfg.mcpServers), f).toEqual(["usagemap"]);
      const s = cfg.mcpServers.usagemap as McpServer;
      expect(s.command).toBe("node");
      expect(s.args).toHaveLength(1);
      expect(s.args[0]).toMatch(/\/tools\/mcp\/server\.ts$/);
      expect(Object.keys(s.env).sort()).toEqual(["USAGEMAP_API_URL", "USAGEMAP_SHARE_KEY_FILE"]);
      for (const k of Object.keys(s.env)) expect(server, k).toContain(k);
      expect(s.env.USAGEMAP_API_URL).toBe("https://app.usagemap.dev");
      if (f === "mcp.json") expect(s.type).toBe("stdio");
    }
    const cli = read(ex("mcp-claude/claude-code.sh"));
    expect(cli).toContain("claude mcp add usagemap");
    expect([...cli.matchAll(/-e (\w+)=/g)].map((m) => m[1])).toEqual([
      "USAGEMAP_API_URL",
      "USAGEMAP_SHARE_KEY_FILE",
    ]);
    expect(cli).toMatch(/-- node \S+\/tools\/mcp\/server\.ts$/m);
  });

  it("the server, started with mcp.json's configuration, lists its tools and reads the metrics document", async () => {
    const cfg = JSON.parse(read(ex("mcp-claude/mcp.json"))) as {
      mcpServers: { usagemap: McpServer };
    };
    const s = cfg.mcpServers.usagemap;
    const api = await standIn((hit, res) => {
      if (hit.path !== "/public/v1/projects/my-project/metrics.json") return false;
      json(res, 200, {
        schema: "scf-metrics/1",
        project: { slug: "my-project" },
        web: { visits: 42 },
      });
    });
    const keyFile = join(tmp("mcp"), "usagemap-share.key");
    writeFileSync(keyFile, `${PUB_KEY}\n`, { mode: 0o600 });
    const env = { ...s.env, USAGEMAP_API_URL: api.url, USAGEMAP_SHARE_KEY_FILE: keyFile };
    const args = s.args.map((a) => a.replace(/^.*\/tools\/mcp\//, `${repo("tools/mcp")}/`));
    const messages = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "qs", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "project_metrics_document", arguments: { slug: "my-project" } },
      },
    ];
    try {
      const r = await sh(s.command === "node" ? process.execPath : s.command, args, {
        env,
        input: `${messages.map((m) => JSON.stringify(m)).join("\n")}\n`,
        timeoutMs: 30_000,
      });
      const replies = r.stdout
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { id: number; result?: Record<string, unknown> });
      expect(replies.map((x) => x.id)).toEqual([1, 2, 3]);
      expect(replies[0]?.result?.serverInfo).toMatchObject({ name: "usagemap-mcp" });
      const tools = ((replies[1]?.result?.tools ?? []) as { name: string }[]).map((t) => t.name);
      expect(tools).toHaveLength(7);
      expect(tools).toContain("project_metrics_document");
      expect(JSON.stringify(replies[2]?.result)).toContain("42");
      expect(replies[2]?.result?.isError).not.toBe(true);
      expect(api.hits.map((h) => `${h.method} ${h.path}`)).toEqual([
        "GET /public/v1/projects/my-project/metrics.json",
      ]);
      expect(api.hits[0]?.headers.authorization).toBe(`Bearer ${PUB_KEY}`);
      expect(r.stdout + r.stderr).not.toContain(PUB_KEY.slice(22));
    } finally {
      await api.close();
    }
  });

  it("tools/mcp/run selftest passes", async () => {
    const r = await sh(repo("tools/mcp/run"), ["selftest"], { timeoutMs: 300_000 });
    expect(r.code, r.stdout.slice(-3000) + r.stderr.slice(-3000)).toBe(0);
  });
});
