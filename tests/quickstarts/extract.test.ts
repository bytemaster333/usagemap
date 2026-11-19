// SPDX-License-Identifier: Apache-2.0
// docs.quickstarts-run, no Docker: the quickstart guides still contain exactly the blocks the fixture suite runs, with the
// placeholders it replaces, and the versions/hashes they state match the repository (tracker build, fixture lockfiles).
// A guide edit that would make the e2e fixtures run something else fails here first.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/env.ts";
import { PLACEHOLDER, parseBlocks, pick, readGuide, substitute } from "./extract.ts";
import {
  API_RECIPES,
  block,
  buildRecipe,
  collectorImage,
  FIXTURES,
  npmInstallSpec,
  npmPage,
  PICKS,
  type PickName,
  pythonServerPins,
  scriptTagPage,
  shellCommand,
} from "./recipes.ts";

describe("parseBlocks", () => {
  it("tracks sections, languages, positions and fence kinds", () => {
    const md = [
      "# T",
      "```sh",
      "a",
      "```",
      "## One",
      "````md",
      "```js",
      "inner",
      "```",
      "````",
      "### Sub (stays in One)",
      "~~~py",
      "b",
      "~~~",
      "## Two ##",
      "```",
      "c",
      "```",
    ].join("\n");
    const b = parseBlocks("x.md", md);
    expect(b.map((x) => [x.section, x.lang, x.index, x.code])).toEqual([
      ["", "sh", 0, "a\n"],
      ["One", "md", 0, "```js\ninner\n```\n"],
      ["One", "py", 1, "b\n"],
      ["Two", "", 0, "c\n"],
    ]);
    expect(b[1]?.line).toBe(6);
  });

  it("refuses an unclosed fence", () => {
    expect(() => parseBlocks("x.md", "```js\nopen")).toThrow(/unclosed/);
  });
});

describe("substitute", () => {
  it("replaces every occurrence, longest key first, and requires each key", () => {
    expect(
      substitute("https://apm.example/v1 https://apm.example", { "https://apm.example": "X" }),
    ).toBe("X/v1 X");
    expect(() => substitute("nothing", { "https://apm.example": "X" })).toThrow(/not found/);
  });
});

describe("the runnable blocks of the quickstart guides", () => {
  const expectFirst: Record<PickName, RegExp> = {
    scriptTag:
      /^<script\n\s+src="https:\/\/ingest-a\.example-analytics\.org\/lib\/\d+\.\d+\.\d+\/standard\.js"/,
    scriptTagEvent: /^<button onclick="window\.scf && window\.scf\.track\('signup'/,
    npmInstall: /^pnpm add --save-exact @usagemap\/tracker@/,
    npmInit: /^import \{ init \} from "@usagemap\/tracker";/,
    nodeOtel: /^\/\/ otel\.mjs\n/,
    nodeRun: /^OTEL_LOGS_EXPORTER=none node --import \.\/otel\.mjs app\.mjs/,
    pyRequirements: /^opentelemetry-api==/,
    pyOtelSetup: /^import os\n/,
    pyApp: /^# uvicorn re-raises SIGTERM/,
    goSetup: /^res, _ := resource\.New\(ctx/,
    goWrapper: /^\/\/ onlyHTTPServer forwards only the HTTP server duration metric to UsageMap\./,
    rustCargo: /^opentelemetry = "0\.33\.1"/,
    rustSetup: /^let scf = MetricExporter::builder\(\)\.with_http\(\)/,
    collectorConfig: /^receivers:\n {2}otlp:/,
    collectorNode:
      /^OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/collector:4318 OTEL_LOGS_EXPORTER=none node/,
  };
  for (const name of Object.keys(PICKS) as PickName[]) {
    it(`${name}: ${PICKS[name].file} § ${PICKS[name].section} (${PICKS[name].lang})`, () => {
      expect(block(name).code).toMatch(expectFirst[name]);
    });
  }

  it("each picked section has exactly the blocks the suite expects (an added block must be classified)", () => {
    const count = (file: string, section: string) =>
      parseBlocks(file, readGuide(file)).filter((b) => b.section.startsWith(section)).length;
    expect(count("web-script-tag.md", "1. Copy the snippet")).toBe(1);
    expect(count("web-script-tag.md", "3. Custom events")).toBe(1);
    expect(count("web-npm.md", "1. Install")).toBe(1);
    expect(count("web-npm.md", "2. Start it once")).toBe(1);
    expect(count("api-node-express.md", "`otel.mjs`")).toBe(2);
    expect(count("api-python-fastapi.md", "Requirements")).toBe(1);
    expect(count("api-go.md", "Setup")).toBe(2);
    expect(count("api-rust-axum.md", "Setup")).toBe(1);
    expect(count("api-collector-fanout.md", "Collector configuration")).toBe(1);
  });

  it("the substituted placeholders are where the suite expects them", () => {
    expect(block("scriptTag").code).toContain(PLACEHOLDER.siteKey);
    expect(block("npmInit").code).toContain(PLACEHOLDER.siteKey);
    for (const n of ["nodeOtel", "pyOtelSetup", "collectorConfig"] as const) {
      expect(block(n).code, n).toContain(PLACEHOLDER.otlp);
      expect(block(n).code, n).toContain(PLACEHOLDER.apm);
    }
    expect(block("goSetup").code).toContain(`"${PLACEHOLDER.otlp}/v1/metrics"`);
    expect(block("rustSetup").code).toContain(`"${PLACEHOLDER.otlp}/v1/metrics"`);
  });

  it("an unknown section or language is reported with what exists", () => {
    expect(() => pick({ file: "api-go.md", section: "Nope", lang: "go" })).toThrow(/sections: /);
    expect(() => pick({ file: "api-go.md", section: "Setup", lang: "go", nth: 2 })).toThrow(
      /found go, go/,
    );
  });
});

describe("what the guides state matches the repository", () => {
  it("script tag: the SRI hash in the guide is the tracker build's manifest value for that file", () => {
    const tag = block("scriptTag").code;
    const src = /src="https:\/\/[^/]+\/lib\/(\d+\.\d+\.\d+)\/(\w+)\.js"/.exec(tag);
    const sri = /integrity="(sha384-[A-Za-z0-9+/=]+)"/.exec(tag);
    expect(src && sri).toBeTruthy();
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, `tracker/dist/${src?.[1]}/manifest.json`), "utf8"),
    ) as { files: { path: string; integrity: string }[]; config: { hosts: string[] } };
    expect(manifest.files.find((f) => f.path === `${src?.[2]}.js`)?.integrity).toBe(sri?.[1]);
    expect(tag).toContain('crossorigin="anonymous"');
    expect(manifest.config.hosts).toEqual([PLACEHOLDER.ingestA, PLACEHOLDER.ingestB]);
  });

  it("npm: the installed name and exact version are the tracker package's", () => {
    const spec = npmInstallSpec();
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "tracker/package.json"), "utf8")) as {
      name: string;
      version: string;
      exports: Record<string, unknown>;
    };
    expect(spec.command.slice(0, 3)).toEqual(["pnpm", "add", "--save-exact"]);
    expect([spec.name, spec.version]).toEqual([pkg.name, pkg.version]);
    expect(Object.keys(pkg.exports)).toEqual(expect.arrayContaining([".", "./strict"]));
  });

  const fixturePkg = JSON.parse(
    readFileSync(join(FIXTURES, "node-express/package.json"), "utf8"),
  ) as {
    dependencies: Record<string, string>;
  };

  it("Node: the dependency list of the guide is the fixture lockfile's", () => {
    const g = readGuide("api-node-express.md");
    const deps = Object.fromEntries(
      [...g.matchAll(/`(@opentelemetry\/[a-z0-9-]+)@(\d+\.\d+\.\d+)`/g)].map((m) => [m[1], m[2]]),
    );
    const express = /Express (\d+\.\d+\.\d+)/.exec(g)?.[1];
    expect({ ...deps, express }).toEqual(fixturePkg.dependencies);
  });

  it("Collector fan-out: the zero-code Node dependencies are in the fixture lockfile; the image is digest-pinned", () => {
    const deps = [
      ...block("collectorNode").code.matchAll(/(@opentelemetry\/[a-z0-9-]+)@(\d+\.\d+\.\d+)/g),
    ];
    expect(deps.length).toBe(2);
    for (const m of deps) expect(fixturePkg.dependencies[m[1] as string], m[1]).toBe(m[2]);
    expect(collectorImage()).toMatch(
      /^otel\/opentelemetry-collector-contrib:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
    );
  });

  it("Python: the requirements block pins every package exactly; fastapi/uvicorn come from the guide's text", () => {
    const lines = block("pyRequirements").code.trim().split("\n");
    for (const l of lines) expect(l).toMatch(/^[a-z0-9-]+==[0-9a-z.]+$/);
    expect(pythonServerPins()).toEqual(["fastapi==0.162.5", "uvicorn==0.54.0"]);
  });

  it("Go: every module version the guide lists is the fixture go.mod's", () => {
    const g = readGuide("api-go.md");
    const sect = g.slice(g.indexOf("## Modules"), g.indexOf("## Setup"));
    const mods = [...sect.matchAll(/`(go\.opentelemetry\.io\/[^`]+)` (v\d+\.\d+\.\d+)/g)];
    expect(mods.length).toBeGreaterThanOrEqual(2);
    const gomod = readFileSync(join(FIXTURES, "go-nethttp/go.mod.fixture"), "utf8");
    for (const m of mods) expect(gomod, m[1]).toContain(`${m[1]} ${m[2]}`);
  });

  it("Rust: the guide's crate versions are the fixture lockfile's", () => {
    const lock = readFileSync(join(FIXTURES, "rust-axum/Cargo.lock"), "utf8");
    for (const [crate, v] of [
      ["opentelemetry", "0.33.1"],
      ["opentelemetry_sdk", "0.33.1"],
      ["opentelemetry-otlp", "0.33.1"],
      ["opentelemetry-instrumentation-tower", "0.19.0"],
    ] as const) {
      expect(block("rustCargo").code).toContain(`${crate} = `);
      expect(lock, crate).toMatch(
        new RegExp(`name = "${crate}"\\nversion = "${v.replace(/\./g, "\\.")}"`),
      );
    }
  });
});

describe("generated fixtures carry the guide's code verbatim", () => {
  const work = mkdtempSync(join(tmpdir(), "scf-qs-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const e = { scf: "https://scf.test:8443", apm: "http://apm.test:4318" };
  const read = (...p: string[]) => readFileSync(join(work, ...p), "utf8");

  it("web pages", () => {
    const tag = scriptTagPage("abcdefghijklmnopqrstuv");
    expect(tag).toContain('data-site="abcdefghijklmnopqrstuv"');
    expect(tag).toContain(block("scriptTagEvent").code);
    expect(tag).not.toContain(PLACEHOLDER.siteKey);
    const npm = npmPage("abcdefghijklmnopqrstuv", { "@usagemap/tracker": "/t.js" });
    expect(npm).toContain('init({ site: "abcdefghijklmnopqrstuv" })');
    expect(npm).toContain('"@usagemap/tracker":"/t.js"');
  });

  for (const r of API_RECIPES) {
    it(r, () => {
      const out = buildRecipe(r, work, e);
      const docker = read(r, "Dockerfile");
      expect(docker).toMatch(/^# SPDX-License-Identifier: Apache-2.0\n# ci-scan: skip/);
      switch (r) {
        case "node-express":
          expect(read(r, "otel.mjs")).toBe(
            substitute(block("nodeOtel").code, {
              [PLACEHOLDER.otlp]: e.scf,
              [PLACEHOLDER.apm]: e.apm,
            }),
          );
          expect(docker).toContain(JSON.stringify(shellCommand(block("nodeRun").code)));
          break;
        case "python-fastapi":
          expect(read(r, "app.py")).toBe(block("pyApp").code);
          expect(read(r, "otel_setup.py")).toContain(`endpoint="${e.scf}/v1/metrics"`);
          expect(read(r, "requirements.txt")).toContain(block("pyRequirements").code);
          break;
        case "go-nethttp": {
          const src = read(r, "main.go.fixture");
          expect(src).toContain(block("goWrapper").code);
          for (const l of block("goSetup").code.trim().split("\n"))
            expect(src).toContain(`\t${l.replace(PLACEHOLDER.otlp, e.scf)}`);
          break;
        }
        case "rust-axum": {
          expect(read(r, "Cargo.toml")).toContain(block("rustCargo").code);
          const src = read(r, "src", "main.rs");
          for (const l of block("rustSetup").code.trim().split("\n"))
            expect(src).toContain(`    ${l.replace(PLACEHOLDER.otlp, e.scf)}`);
          break;
        }
        case "collector-fanout":
          expect(readFileSync(out.collectorConfig as string, "utf8")).toBe(
            substitute(block("collectorConfig").code, {
              [PLACEHOLDER.otlp]: e.scf,
              [PLACEHOLDER.apm]: e.apm,
            }),
          );
          expect(docker).toContain("--experimental-loader=@opentelemetry/instrumentation/hook.mjs");
          break;
      }
    });
  }
});
