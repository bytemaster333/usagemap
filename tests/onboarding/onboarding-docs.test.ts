// SPDX-License-Identifier: Apache-2.0
// Tenant documentation as a test target (plan E6, C2, C4; no Docker). The code samples of docs/onboarding/* and the
// public methodology must agree with the contracts and the code they describe, so that a contract or code change
// that makes a page wrong fails here:
//   - every Stellar event name, wire field and enum value in a sample is the schema v1 one (wire-formats §a.3.1),
//     legacy names never appear, the counted-only list is the contract's, custom-event samples never borrow a v1 name;
//   - imports from the tracker resolve to its published subpaths; the adapter and debug API the pages document is
//     what the tracker exports, once the adapter release is in the tree;
//   - every OpenTelemetry variable is one the primary sources define; package versions are the ones the test
//     fixtures run; the script tag's SRI hash is the tracker build's;
//   - every public URL is a path the control-plane OpenAPI or the portal router serves;
//   - the methodology's trust weights, thresholds, confidence reasons and floors are the code's and the settings';
//   - no internal identifiers, every relative link and anchor resolves, and no page claims an endorsement.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALGORITHM_VERSION, THRESHOLDS } from "../../services/jobs/src/trust/algorithm.ts";
import { REPO_ROOT } from "../lib/env.ts";
import { parseBlocks } from "../quickstarts/extract.ts";
import {
  anchors,
  type Doc,
  docsIn,
  inlineCode,
  links,
  METHODOLOGY_DIR,
  matchesTemplate,
  ONBOARDING_DIR,
  openApiPaths,
  openApiServer,
  portalRoutes,
  prose,
  slug,
  stellarSchema,
  tenantDocs,
  wireFormats,
} from "./docs.ts";

const docs = tenantDocs();
const onboarding = docsIn(ONBOARDING_DIR);
const schema = stellarSchema();
const doc = (name: string): Doc => {
  const d = docs.find((x) => x.rel.endsWith(`/${name}`));
  if (!d) throw new Error(`no document ${name}`);
  return d;
};
const allCode = (d: Doc) => d.blocks.map((b) => b.code).join("\n");

/** Tokens shaped like a Stellar event name (or a rollup key of one). */
const EVENTISH = /\b(?:wallet|sign|tx|smart_wallet|passkey|connect)_[a-z_]+\b/g;

describe("the contracts the documents are checked against", () => {
  it("parses schema v1 from wire-formats §a.3 / §a.3.1", () => {
    expect(schema.events).toEqual([
      "wallet_modal_opened",
      "wallet_modal_closed",
      "wallet_selected",
      "wallet_connect",
      "wallet_disconnect",
      "sign_requested",
      "sign_approved",
      "sign_rejected",
      "tx_submitted",
      "smart_wallet_created",
      "passkey_used",
      // tracker 1.2.0 (wire-formats §a.3.1)
      "wallet_connect_failed",
      "walletconnect_session",
      "walletconnect_request",
    ]);
    expect(Object.keys(schema.placement).sort()).toEqual([...schema.events].sort());
    expect(schema.placement.wallet_connect).toEqual(["wt", "net", "ck"]);
    expect(schema.placement.tx_submitted).toEqual(["rc", "net", "wt"]);
    expect(schema.countedOnly).toEqual(
      [
        "passkey_used",
        "sign_approved",
        "sign_rejected",
        "sign_requested",
        "smart_wallet_created",
        "tx_submitted",
      ].sort(),
    );
    expect(schema.legacyOnly).toEqual(
      expect.arrayContaining(["wallet_connected", "sign_completed", "sign_failed"]),
    );
  });

  it("slug() and anchors() follow GitHub's heading anchors", () => {
    expect(slug("6.1 Web trust score (`web_trust_scores`, windows 1 and 28 days)")).toBe(
      "61-web-trust-score-web_trust_scores-windows-1-and-28-days",
    );
    expect(anchors("# A\n```md\n# not a heading\n```\n## Counted-only events")).toEqual(
      new Set(["a", "counted-only-events"]),
    );
  });

  it("matchesTemplate() matches one segment per parameter", () => {
    expect(
      matchesTemplate(
        "/public/v1/projects/x/metrics.json",
        "/public/v1/projects/{slug}/metrics.json",
      ),
    ).toBe(true);
    expect(
      matchesTemplate(
        "/public/v1/projects/a/b/metrics.json",
        "/public/v1/projects/{slug}/metrics.json",
      ),
    ).toBe(false);
  });
});

describe("the tenant documents exist and are self-contained", () => {
  it("one first-10-minutes page per stack, plus the reference pages", () => {
    const names = onboarding.map((d) => d.rel.split("/").pop());
    expect(names).toEqual(
      expect.arrayContaining([
        "README.md",
        "web-html.md",
        "web-nextjs.md",
        "web-react-spa.md",
        "api-node-express.md",
        "api-nextjs.md",
        "api-rust-axum.md",
        "api-go.md",
        "api-python-fastapi.md",
        "api-cloudflare-workers.md",
        "api-dual-export.md",
        "wallets.md",
        "dev-origins-and-debug.md",
        "footprint.md",
        "troubleshooting.md",
        "share-with-scf.md",
      ]),
    );
    expect(existsSync(join(METHODOLOGY_DIR, "scf-methodology-1.0.0.md"))).toBe(true);
  });

  it("no internal identifiers (register rows, ADRs, requirement ids, spikes, build phases, contract sections)", () => {
    const internal =
      /\b(?:C|CR|Q|S|F|TM|D)-\d{1,3}[a-z]?\b|\bADR-\d{4}\b|\b(?:SCP|BKG|GEN|WEB|NICE|API|OPS|EVAL|DEL|BUD)-\d{2}\b|\bWave [A-Z]\d\b|references\/|spikes\/|wire-formats|data-model\.md|§[a-z]\.\d|\bplan [A-E]\d\b/;
    for (const d of docs) {
      d.text.split("\n").forEach((l, i) => {
        expect(internal.exec(l)?.[0], `${d.rel}:${i + 1}: ${l}`).toBeUndefined();
      });
    }
  });

  it("every relative link resolves to a file, and every anchor to a heading", () => {
    let checked = 0;
    for (const d of docs) {
      for (const target of links(d)) {
        if (/^[a-z]+:/.test(target)) continue; // absolute URLs are not followed
        const [file, anchor] = target.split("#") as [string, string | undefined];
        const path = file === "" ? d.abs : resolve(dirname(d.abs), file);
        expect(existsSync(path), `${d.rel}: ${target}`).toBe(true);
        if (anchor && path.endsWith(".md")) {
          expect(anchors(readFileSync(path, "utf8")).has(anchor), `${d.rel}: ${target}`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("no endorsement claims (wording rule): only in sentences that forbid them", () => {
    const claim =
      /\b(?:SCF|SDF)[ -](?:verified|approved|endorsed|certified)\b|\b(?:verified|approved|endorsed|certified) by (?:SCF|SDF|the Stellar Development Foundation)\b/i;
    for (const d of docs) {
      // per paragraph (or table row, or list item): a sentence may wrap across lines
      for (const p of prose(d).split(/\n\s*\n|\n(?=\||\s*- )/)) {
        if (!claim.test(p)) continue;
        expect(/\b(?:never|not|no)\b/i.test(p), `${d.rel}: ${p}`).toBe(true);
      }
    }
  });
});

describe("Stellar event names and fields in the samples are schema v1", () => {
  it("every event-shaped token in code and inline code is a v1 event or a rollup key; no legacy name", () => {
    const allowed = new Set([
      ...schema.events,
      ...schema.rollupKeys,
      ...Object.values(schema.fields).flatMap((v) => v ?? []),
    ]);
    // Pages that quote a third-party platform's own Prometheus label names (`wallet_id`, …) — not tracker events.
    const thirdPartyLabels = new Set([
      "docs/onboarding/api-sdp.md",
      "docs/onboarding/api-oz-relayer.md",
    ]);
    let seen = 0;
    for (const d of onboarding) {
      const tokens = (thirdPartyLabels.has(d.rel) ? [] : [allCode(d), ...inlineCode(d)]).flatMap(
        (t) => [...t.matchAll(EVENTISH)].map((m) => m[0]),
      );
      for (const t of tokens) {
        expect(allowed.has(t), `${d.rel}: "${t}" is not a schema v1 event name or rollup key`).toBe(
          true,
        );
        seen++;
      }
      for (const legacy of schema.legacyOnly) {
        expect(d.text.includes(legacy), `${d.rel}: legacy event name ${legacy}`).toBe(false);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("the wallets page lists every v1 event, every wallet type, network and error class", () => {
    const w = doc("wallets.md").text;
    for (const n of schema.events) expect(w, n).toContain(`\`${n}\``);
    for (const k of ["wt", "net", "ec", "rc", "sk", "dur", "out", "po", "ck"] as const)
      for (const v of schema.fields[k] ?? []) expect(w, `${k}=${v}`).toContain(`\`${v}\``);
  });

  it("the counted-only section names exactly the contract's counted-only events", () => {
    const w = doc("wallets.md").text;
    const sec = w.slice(
      w.indexOf("## Counted-only events"),
      w.indexOf("\n## ", w.indexOf("## Counted-only events") + 5),
    );
    const firstPara = sec.split("\n\n")[1] ?? "";
    const named = [...firstPara.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string).sort();
    expect(named).toEqual(schema.countedOnly);
    for (const d of onboarding)
      for (const l of links(d))
        if (l.includes("counted-only"))
          expect(l.endsWith("wallets.md#counted-only-events"), `${d.rel}: ${l}`).toBe(true);
  });

  it("every wire-format JSON sample validates against $defs.stellar, with the contract's field placement", () => {
    let events = 0;
    for (const d of onboarding) {
      for (const b of d.blocks.filter((x) => x.lang === "json")) {
        const body = JSON.parse(b.code) as { e?: Record<string, unknown>[] };
        for (const e of body.e ?? []) {
          if (e.k !== "wl") continue;
          const where = `${d.rel}:${b.line} ${JSON.stringify(e)}`;
          expect(e.sv, where).toBe(1);
          const n = e.n as string;
          expect(schema.events, where).toContain(n);
          const allowed = new Set(["id", "k", "u", "sv", "n", ...(schema.placement[n] ?? [])]);
          for (const [k, v] of Object.entries(e)) {
            expect(allowed.has(k), `${where}: field ${k} not allowed on ${n}`).toBe(true);
            const en = schema.fields[k];
            if (en) expect(en, `${where}: ${k}=${String(v)}`).toContain(v);
          }
          expect(e.id, where).toMatch(/^[A-Za-z0-9_-]{22}$/);
          expect(e.u, where).toMatch(/^\//);
          events++;
        }
      }
    }
    expect(events).toBeGreaterThanOrEqual(2);
  });

  it("custom-event samples use valid names and keys and never a v1 event name", () => {
    let calls = 0;
    for (const d of onboarding) {
      const text = [allCode(d), ...inlineCode(d)].join("\n");
      for (const m of text.matchAll(/\btrack\(\s*["']([^"']+)["']\s*(?:,\s*\{([^}]*)\})?/g)) {
        const name = m[1] as string;
        const where = `${d.rel}: track("${name}")`;
        expect(name, where).toMatch(schema.customName);
        expect(name.length, where).toBeLessThanOrEqual(50);
        // the wallets page shows track("wallet_connect") only to say it is NOT a wallet event
        if (!(d.rel.endsWith("wallets.md") && /never counted in the wallet funnel/.test(d.text)))
          expect(schema.events, where).not.toContain(name);
        for (const k of (m[2] ?? "").matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g))
          expect(k[1], `${where} key ${k[1]}`).toMatch(schema.propKey);
        calls++;
      }
    }
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

// --- tracker API ---

const trackerPkg = JSON.parse(readFileSync(join(REPO_ROOT, "tracker/package.json"), "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, { default?: string } | string>;
};

/** What the pages document of the tracker's API beyond 1.0.0 (adapters and debug mode, tracker 1.1.0). */
const DOCUMENTED_ADAPTER_API: Record<string, string[]> = {
  "./wallets-kit": ["attachWalletsKit", "wrapWalletsKitModules"],
  "./wallets": [
    "wrapFreighter",
    "wrapAlbedo",
    "wrapXBull",
    "wrapLobstr",
    "wrapHana",
    "wrapHot",
    "wrapInjected",
    "attachRpcServer",
    "attachHorizonServer",
  ],
  "./passkey": ["attachPasskeyKit", "attachSmartAccountKit"],
  "./debug": ["debug"],
  // tracker 1.2.0
  "./privy": ["wrapPrivyStellar", "privyLoginCallbacks"],
  "./stellar-rpc": ["attachRpcTelemetry", "attachHorizonTelemetry"],
};

/** The adapter release is in the tree once the Wallets Kit entry exports anything (1.0.0 reserves it empty). */
const wkSource = readFileSync(join(REPO_ROOT, "tracker/src/wallets-kit.ts"), "utf8");
const adaptersShipped = /\bexport\s+(?:function|const|\{\s*\w)/.test(wkSource);

function importsFrom(d: Doc): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  for (const m of allCode(d).matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["'](@usagemap\/tracker[^"']*)["']/g,
  ))
    out.push({
      spec: m[2] as string,
      names: (m[1] as string)
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0] as string)
        .filter(Boolean),
    });
  return out;
}

describe("tracker API used by the samples", () => {
  const imports = onboarding.flatMap((d) => importsFrom(d).map((i) => ({ ...i, doc: d.rel })));

  it("every import is a documented entry: the core, strict, or a documented adapter", () => {
    expect(imports.length).toBeGreaterThanOrEqual(8);
    for (const i of imports) {
      const sub = `.${i.spec.slice(trackerPkg.name.length)}`;
      const where = `${i.doc}: import { ${i.names.join(", ")} } from "${i.spec}"`;
      if (sub === "." || sub === "./strict") {
        expect(i.names, where).toEqual(["init"]);
        expect(trackerPkg.exports[sub], where).toBeDefined();
      } else {
        expect(DOCUMENTED_ADAPTER_API[sub], where).toBeDefined();
        for (const n of i.names) expect(DOCUMENTED_ADAPTER_API[sub], where).toContain(n);
      }
    }
    expect(trackerPkg.exports["./wallets-kit"]).toBeDefined();
  });

  it("init() options are site and consent only (debug mode is the separate debug entry)", () => {
    for (const d of onboarding)
      for (const m of [allCode(d), ...inlineCode(d)].join("\n").matchAll(/\binit\(\{([^}]*)\}\)/g))
        for (const k of (m[1] as string).matchAll(/([A-Za-z_]+)\s*:/g))
          expect(["site", "consent"], `${d.rel}: init option ${k[1]}`).toContain(k[1]);
  });

  it.skipIf(!adaptersShipped)(
    "the adapter release exports every subpath and name the pages document or mention",
    () => {
      for (const [sub, names] of Object.entries(DOCUMENTED_ADAPTER_API)) {
        expect(trackerPkg.exports[sub], `tracker/package.json exports ${sub}`).toBeDefined();
        const src = join(REPO_ROOT, "tracker/src", `${sub.slice(2)}.ts`);
        expect(existsSync(src), src).toBe(true);
        const text = readFileSync(src, "utf8");
        for (const n of names)
          expect(
            new RegExp(
              `export\\s+(?:async\\s+)?(?:function|const)\\s+${n}\\b|export\\s*\\{[^}]*\\b${n}\\b`,
            ).test(text),
            `${sub} exports ${n}`,
          ).toBe(true);
      }
      // dynamic imports of an entry (the debug module in development) resolve to a published subpath too
      for (const d of onboarding)
        for (const m of allCode(d).matchAll(/import\(["'](@usagemap\/tracker[^"']*)["']\)/g))
          expect(
            trackerPkg.exports[`.${(m[1] as string).slice(trackerPkg.name.length)}`],
            `${d.rel}: ${m[1]}`,
          ).toBeDefined();
      // every adapter function a page names in prose is exported
      const named = new Set(
        onboarding.flatMap((d) => inlineCode(d).filter((c) => /^(?:wrap|attach)[A-Z]\w+$/.test(c))),
      );
      const all = Object.values(DOCUMENTED_ADAPTER_API).flat();
      for (const n of named) expect(all, n).toContain(n);
    },
  );
});

// --- OpenTelemetry recipes ---

/**
 * Every variable the pages use, with its primary source (read 2026-11-16):
 *   spec — opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/ and …/protocol/exporter/
 *   node — github.com/open-telemetry/opentelemetry-js-contrib packages/auto-instrumentations-node README
 *   semconv — the HTTP semantic-convention migration switch (opentelemetry.io/docs/specs/semconv/http/)
 */
const OTEL_VARS: Record<string, "spec" | "node" | "semconv"> = {
  OTEL_SERVICE_NAME: "spec",
  OTEL_RESOURCE_ATTRIBUTES: "spec",
  OTEL_EXPORTER_OTLP_ENDPOINT: "spec",
  OTEL_EXPORTER_OTLP_HEADERS: "spec",
  OTEL_EXPORTER_OTLP_METRICS_HEADERS: "spec",
  OTEL_EXPORTER_OTLP_PROTOCOL: "spec",
  OTEL_METRICS_EXPORTER: "spec",
  OTEL_TRACES_EXPORTER: "spec",
  OTEL_LOGS_EXPORTER: "spec",
  OTEL_NODE_ENABLED_INSTRUMENTATIONS: "node",
  OTEL_SEMCONV_STABILITY_OPT_IN: "semconv",
  // SDK environment variables (exemplar filter) and declarative configuration (config file), both spec-defined
  OTEL_METRICS_EXEMPLAR_FILTER: "spec",
  OTEL_CONFIG_FILE: "spec",
};

describe("OpenTelemetry recipes", () => {
  const apiDocs = onboarding.filter((d) => /\/api-[a-z-]+\.md$/.test(d.rel));

  it("use only OpenTelemetry variables the primary sources define", () => {
    for (const d of apiDocs.concat(doc("troubleshooting.md")))
      for (const m of d.text.matchAll(/\bOTEL_[A-Z_]+\b/g)) {
        if (m[0].endsWith("_")) continue; // a family written as `OTEL_EXPORTER_OTLP_*`
        expect(OTEL_VARS[m[0]], `${d.rel}: ${m[0]}`).toBeDefined();
      }
  });

  it("UsageMap-only recipes: endpoint and token from the environment, one destination, metrics only, no logs", () => {
    for (const name of [
      "api-node-express.md",
      "api-python-fastapi.md",
      "api-go.md",
      "api-rust-axum.md",
    ]) {
      const env = doc(name)
        .blocks.filter((b) => b.lang === "sh")
        .map((b) => b.code)
        .join("\n");
      expect(env, name).toMatch(/OTEL_EXPORTER_OTLP_ENDPOINT=https:\/\/ingest\.scf\.example\s/);
      expect(env, name).toMatch(/OTEL_EXPORTER_OTLP_HEADERS="?Authorization=Bearer%20/);
      expect(env, name).toContain("OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf");
      expect(env, name).toContain("service.instance.id=");
      if (name !== "api-rust-axum.md") expect(env, name).toContain("OTEL_METRICS_EXPORTER=otlp");
      if (name === "api-node-express.md" || name === "api-python-fastapi.md") {
        expect(env, name).toContain("OTEL_TRACES_EXPORTER=none");
        expect(env, name).toContain("OTEL_LOGS_EXPORTER=none");
      }
      // no endpoint or token in code
      const code = doc(name)
        .blocks.filter((b) => b.lang !== "sh")
        .map((b) => b.code)
        .join("\n");
      expect(code, name).not.toMatch(/ingest\.scf\.example|scfa_ing_|Bearer/);
    }
  });

  const FIX = join(REPO_ROOT, "tests/fixtures/api");

  it("Node: the packages are the fixture's pins; the start command is the tested zero-code command", () => {
    const pkg = JSON.parse(readFileSync(join(FIX, "node-express/package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const g = doc("api-node-express.md");
    const deps = [...allCode(g).matchAll(/(@opentelemetry\/[a-z0-9-]+)@(\d+\.\d+\.\d+)/g)];
    expect(deps.length).toBe(2);
    for (const m of deps) expect(pkg.dependencies[m[1] as string], m[1]).toBe(m[2]);
    const tested = parseBlocks(
      "api-collector-fanout.md",
      readFileSync(join(REPO_ROOT, "docs/guides/quickstarts/api-collector-fanout.md"), "utf8"),
    ).find((b) => b.section.startsWith("Pointing your services") && b.lang === "sh");
    for (const flag of [
      "--experimental-loader=@opentelemetry/instrumentation/hook.mjs",
      "--import @opentelemetry/auto-instrumentations-node/register",
    ]) {
      expect(tested?.code, flag).toContain(flag);
      expect(allCode(g), flag).toContain(flag);
    }
  });

  it("Python: every pin is the fixture's", () => {
    const req = readFileSync(join(FIX, "python-fastapi/requirements.txt"), "utf8");
    const block = doc("api-python-fastapi.md").blocks.find((b) => b.lang === "text");
    const pins = (block?.code ?? "").trim().split("\n");
    expect(pins.length).toBeGreaterThanOrEqual(3);
    for (const p of pins) expect(req.split("\n"), p).toContain(p);
  });

  it("Go: otel and otelhttp versions are the fixture go.mod's; autoexport is from the same contrib release", () => {
    const gomod = readFileSync(join(FIX, "go-nethttp/go.mod.fixture"), "utf8");
    const code = allCode(doc("api-go.md"));
    const mods = [...code.matchAll(/(go\.opentelemetry\.io\/[a-z0-9/]+)@(v\d+\.\d+\.\d+)/g)];
    expect(mods.length).toBe(4);
    for (const m of mods) {
      if ((m[1] as string).endsWith("/autoexport")) {
        expect(m[2]).toBe(/otelhttp (v\d+\.\d+\.\d+)/.exec(gomod)?.[1]);
        continue;
      }
      expect(gomod, m[1]).toContain(`${m[1]} ${m[2]}`);
    }
  });

  it("Rust: crate versions are the fixture lockfile's", () => {
    const lock = readFileSync(join(FIX, "rust-axum/Cargo.lock"), "utf8");
    const toml = doc("api-rust-axum.md").blocks.find((b) => b.lang === "toml")?.code ?? "";
    const crates = [
      ...toml.matchAll(/^(opentelemetry[a-z_-]*) = (?:\{ version = )?"(\d+\.\d+\.\d+)"/gm),
    ];
    expect(crates.length).toBe(4);
    for (const m of crates)
      expect(lock, m[1]).toMatch(
        new RegExp(`name = "${m[1]}"\\nversion = "${(m[2] as string).replace(/\./g, "\\.")}"`),
      );
  });

  it("Next.js: package versions are the measured recipe's", () => {
    const measured = readFileSync(join(REPO_ROOT, "docs/guides/quickstarts/api-nextjs.md"), "utf8");
    const install = allCode(doc("api-nextjs.md"));
    const pins = [...install.matchAll(/(@[a-z-]+\/[a-z-]+)@(\d+\.\d+\.\d+)/g)];
    expect(pins.length).toBe(3);
    for (const m of pins) expect(measured, m[0]).toContain(`\`${m[0]}\``);
  });
});

// --- web snippets ---

describe("web snippets", () => {
  it("the plain-HTML snippet's SRI hash is the tracker build's manifest value", () => {
    const tag = doc("web-html.md").blocks.find((b) => b.lang === "html")?.code ?? "";
    const src =
      /src="https:\/\/ingest-a\.example-analytics\.org\/lib\/(\d+\.\d+\.\d+)\/(\w+)\.js"/.exec(tag);
    const sri = /integrity="(sha384-[A-Za-z0-9+/=]+)"/.exec(tag);
    expect(src && sri).toBeTruthy();
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, `tracker/dist/${src?.[1]}/manifest.json`), "utf8"),
    ) as { files: { path: string; integrity: string }[] };
    expect(manifest.files.find((f) => f.path === `${src?.[2]}.js`)?.integrity).toBe(sri?.[1]);
    expect(tag).toContain('crossorigin="anonymous"');
  });

  it("every npm install pins the tracker's exact version", () => {
    for (const d of onboarding)
      for (const m of allCode(d).matchAll(/pnpm add[^\n]*@usagemap\/tracker(@\S+)?/g)) {
        expect(m[0], d.rel).toContain("--save-exact");
        expect(m[1], d.rel).toBe(`@${trackerPkg.version}`);
      }
  });

  it("only placeholder or documentation hosts appear in samples", () => {
    const allowed = new Set([
      "ingest-a.example-analytics.org",
      "ingest-b.example-analytics.net",
      "ingest.scf.example",
      new URL(openApiServer()).host,
      "localhost",
      "staging.example.org",
      "myapp-git-main-myteam.vercel.app",
      "soroban-testnet.stellar.org", // the public testnet RPC in the submission sample
    ]);
    // The partner-calls page names the partner API hosts the package measures (its table is the source).
    const partnerHosts = new Set(
      [
        ...readFileSync(join(REPO_ROOT, "packages/partner-otel/src/partners.ts"), "utf8").matchAll(
          /^\s+hosts: \{([^}]*)\}/gm,
        ),
      ].flatMap((m) =>
        [...(m[1] as string).matchAll(/"([a-z0-9.-]+)":/g)].map((h) => h[1] as string),
      ),
    );
    expect(partnerHosts.has("api.soroswap.finance")).toBe(true);
    for (const d of onboarding)
      for (const m of [allCode(d), prose(d)].join("\n").matchAll(/https?:\/\/([a-z0-9.-]+)/g)) {
        const host = m[1] as string;
        if (
          allowed.has(host) ||
          (d.rel === "docs/onboarding/api-partner-calls.md" && partnerHosts.has(host)) ||
          host.endsWith(".example") ||
          /^(?:[a-z0-9-]+\.)*example\.(?:org|com)$/.test(host)
        )
          continue;
        throw new Error(`${d.rel}: unexpected host ${host}`);
      }
  });
});

// --- "Paste this URL" (C2) ---

describe("the URLs to paste into SCF are ones the platform serves", () => {
  const share = doc("share-with-scf.md");
  const portal = openApiServer();
  const urls = [...share.text.matchAll(/https:\/\/portal\.example\.invalid(\/[^\s`|)]*)/g)].map(
    (m) => m[1] as string,
  );

  it("uses the OpenAPI document's portal host", () => {
    expect(portal).toBe("https://portal.example.invalid");
    expect(urls.length).toBeGreaterThanOrEqual(4);
  });

  it("every /public/ URL is an OpenAPI path, every page URL a portal route or the contract's verify link", () => {
    const paths = openApiPaths();
    const routes = portalRoutes();
    for (const u of urls) {
      const [path, query] = u.split("?") as [string, string | undefined];
      if (path.startsWith("/public/")) {
        expect(
          paths.some((t) => matchesTemplate(path, t)),
          u,
        ).toBe(true);
      } else if (path === "/verify") {
        // traction snapshot v2 `links.verify` (the pasteable text's verify link)
        expect(query, u).toMatch(/^snapshot=/);
        expect(wireFormats()).toContain(
          "`verify` = `https://<portal>.<domain-a>/verify?snapshot={snapshot_id}`",
        );
      } else {
        expect(
          routes.some((t) => matchesTemplate(path, t)),
          u,
        ).toBe(true);
      }
    }
    for (const p of [
      "/public/v1/projects/your-project/metrics.json",
      "/public/v1/projects/your-project/snapshots",
      "/p/your-project",
    ])
      expect(urls, p).toContain(p);
  });

  it("names the documents' schema and the snapshot presets as the contract does", () => {
    expect(share.text).toContain('"schema": "scf-analytics/metrics-endpoint/1"');
    const wf = wireFormats();
    for (const label of [
      "SCF Build tranche",
      "before Growth Hack campaign",
      "during Growth Hack campaign",
      "Public Goods renewal quarter",
      "custom period",
    ]) {
      expect(wf, label).toContain(`"${label}"`);
      expect(share.text, label).toContain(label);
    }
    expect(share.text).toContain(
      '"Verified" means passed our bot checks, not endorsed by SCF or SDF.',
    );
  });
});

// --- methodology (C4) ---

describe("public methodology scf-methodology/1.0.0 matches the code", () => {
  const m = readFileSync(join(METHODOLOGY_DIR, "scf-methodology-1.0.0.md"), "utf8");
  const settings = readFileSync(join(REPO_ROOT, "db/migrations/0006_settings.sql"), "utf8");
  const wf = wireFormats();

  it("its version is the one snapshots name", () => {
    expect(m).toContain("`scf-methodology/1.0.0`");
    expect(wf).toContain("`scf-methodology/1.0.0`");
    expect(m).toContain(`\`${ALGORITHM_VERSION}\``);
  });

  it("trust weights are the platform default setting", () => {
    const w = JSON.parse(/\('trust_weights',\s*'([^']+)'/.exec(settings)?.[1] ?? "{}") as Record<
      string,
      number
    >;
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBe(100);
    for (const [k, v] of Object.entries(w)) {
      const row = new RegExp(`^\\| \`${k}\` \\|[^\\n]*\\| ${v} \\| [^|]*\\|$`, "m");
      expect(m, `${k} = ${v}`).toMatch(row);
    }
  });

  it("trust thresholds are the algorithm's", () => {
    const row = (k: string) =>
      new RegExp(`^\\| \`${k}\` \\|[^|]*\\| ([0-9.]+) \\| ([0-9.]+) \\|`, "m").exec(m);
    for (const k of [
      "proof_coverage",
      "network_quality",
      "multiplicity",
      "engagement",
      "mix",
      "pow_latency",
    ] as const) {
      const r = row(k);
      expect(r, k).toBeTruthy();
      expect([Number(r?.[1]), Number(r?.[2])], k).toEqual([...THRESHOLDS[k]]);
    }
    const t = /^\| `temporal` \|([^|]*)\|/m.exec(m)?.[1] ?? "";
    expect(t).toContain(`lo ${THRESHOLDS.step[0]}, hi ${THRESHOLDS.step[1]}`);
    expect(t).toContain(`lo ${THRESHOLDS.burst[0]}, hi ${THRESHOLDS.burst[1]}`);
  });

  it("the confidence reasons are the snapshot v2 schema's, and the rule's numbers the contract's", () => {
    const en = /"items": \{ "enum": \[("few_events"[^\]]+)\]/.exec(wf)?.[1] ?? "";
    const reasons = [...en.matchAll(/"([a-z_]+)"/g)].map((x) => x[1] as string);
    expect(reasons.length).toBe(7);
    for (const r of reasons) expect(m, r).toMatch(new RegExp(`^\\| \`${r}\` \\|`, "m"));
    for (const fact of ["< 10 × days", "< 80 %", "> 0.30"]) expect(m).toContain(fact);
  });

  it("the small-count floors are the settings' values", () => {
    const val = (k: string) => /'(\d+)'/.exec(settings.slice(settings.indexOf(`('${k}'`)))?.[1];
    expect(val("op_min_count")).toBe("10");
    expect(val("ecosystem_percentile_min_tenants")).toBe("20");
    const cohort = readFileSync(join(REPO_ROOT, "db/migrations/0064_registry_cohorts.sql"), "utf8");
    expect(/\('cohort_min_tenants', '(\d+)'/.exec(cohort)?.[1]).toBe("5");
    expect(m).toContain("fewer than 5 projects");
    expect(m).toContain("at least 20 active projects");
  });

  it("states the seal's limits and the testnet notice", () => {
    expect(m).toContain("tamper-evidence of published numbers, never proof that they are genuine");
    expect(m).toMatch(/Stellar testnet/);
    expect(m).toMatch(/demonstration, not durable evidence/);
    expect(m).toMatch(/## Per-round freeze/);
    expect(m).toMatch(/## Flags and appeals/);
  });
});
