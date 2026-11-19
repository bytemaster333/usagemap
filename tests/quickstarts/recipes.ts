// SPDX-License-Identifier: Apache-2.0
// docs.quickstarts-run: which code blocks of which quickstart guide run, and the minimum harness around them. A guide shows the part a
// tenant writes (exporter set-up, filter wrapper, Collector config, run command); where it shows a fragment, the
// harness supplies only what the guide says is the tenant's own code — the package manifest pinned to the versions the
// guide lists, the imports, an HTTP handler, and the tenant's APM. The guide's code is inserted verbatim, apart from the
// documented placeholders (extract.ts `substitute`).
//
// Every API recipe serves the one route its guide uses, `/accounts/{id}`: `GABC` → 200, `GMISSING` → 404,
// `GBOOM` → 500.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { TESTS_DIR } from "../lib/env.ts";
import { type CodeBlock, type Pick, PLACEHOLDER, pick, readGuide, substitute } from "./extract.ts";

export const FIXTURES = join(TESTS_DIR, "fixtures/api");

/** The runnable blocks, by guide. The unit test checks that each resolves to exactly the expected block. */
export const PICKS = {
  scriptTag: { file: "web-script-tag.md", section: "1. Copy the snippet", lang: "html" },
  scriptTagEvent: { file: "web-script-tag.md", section: "3. Custom events", lang: "html" },
  npmInstall: { file: "web-npm.md", section: "1. Install, pinned exactly", lang: "sh" },
  npmInit: { file: "web-npm.md", section: "2. Start it once on the client", lang: "ts" },
  nodeOtel: { file: "api-node-express.md", section: "`otel.mjs`", lang: "js" },
  nodeRun: { file: "api-node-express.md", section: "`otel.mjs`", lang: "sh" },
  pyRequirements: {
    file: "api-python-fastapi.md",
    section: "Requirements (as tested)",
    lang: "text",
  },
  pyOtelSetup: { file: "api-python-fastapi.md", section: "`otel_setup.py`", lang: "python" },
  pyApp: { file: "api-python-fastapi.md", section: "`app.py`", lang: "python" },
  goSetup: { file: "api-go.md", section: "Setup", lang: "go", nth: 0 },
  goWrapper: { file: "api-go.md", section: "Setup", lang: "go", nth: 1 },
  rustCargo: { file: "api-rust-axum.md", section: "`Cargo.toml` (as tested)", lang: "toml" },
  rustSetup: { file: "api-rust-axum.md", section: "Setup", lang: "rust" },
  collectorConfig: {
    file: "api-collector-fanout.md",
    section: "Collector configuration",
    lang: "yaml",
  },
  collectorNode: {
    file: "api-collector-fanout.md",
    section: "Pointing your services at the Collector",
    lang: "sh",
    nth: 0,
  },
} as const satisfies Record<string, Pick>;

export type PickName = keyof typeof PICKS;
export const block = (n: PickName): CodeBlock => pick(PICKS[n]);

/** Where the recipes reach UsageMap and the tenant's APM from inside the test network. */
export interface Endpoints {
  /** UsageMap OTLP base URL that replaces `https://ingest.scf.example` (no trailing slash) */
  scf: string;
  /** the tenant's APM sink base URL that replaces `https://apm.example` */
  apm: string;
}

const otlpSubst = (e: Endpoints) => ({ [PLACEHOLDER.otlp]: e.scf, [PLACEHOLDER.apm]: e.apm });

// --- web ---

/** The tenant page of the script-tag guide: the snippet in <head>, the custom-event button in <body>. */
export function scriptTagPage(siteKey: string): string {
  const snippet = substitute(block("scriptTag").code, { [PLACEHOLDER.siteKey]: siteKey });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quickstart: script tag</title>
${snippet}</head><body><h1>Script tag quickstart</h1>
${block("scriptTagEvent").code}</body></html>`;
}

/** `name@version` the npm guide installs. */
export function npmInstallSpec(): { command: string[]; name: string; version: string } {
  const line = block("npmInstall")
    .code.split("\n")
    .find((l) => l.trim() !== "");
  const argv = (line ?? "").trim().split(/\s+/);
  const spec = argv[argv.length - 1] ?? "";
  const m = /^(@?[^@]+)@(\d+\.\d+\.\d+)$/.exec(spec);
  if (!m) throw new Error(`web-npm.md: cannot read the package spec from "${line}"`);
  return { command: argv, name: m[1] as string, version: m[2] as string };
}

/**
 * The npm guide's client code as a browser module: types stripped (Node's own TypeScript stripping, nothing else
 * changed), site key substituted. The bare import resolves through an import map to the installed package.
 */
export function npmPage(siteKey: string, importMap: Record<string, string>): string {
  const code = substitute(stripTypeScriptTypes(block("npmInit").code), {
    [PLACEHOLDER.siteKey]: siteKey,
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Quickstart: npm</title>
<script type="importmap">${JSON.stringify({ imports: importMap })}</script>
<script type="module">
${code}</script></head><body><h1>npm quickstart</h1></body></html>`;
}

// --- API recipes ---

export type ApiRecipe =
  | "node-express"
  | "python-fastapi"
  | "go-nethttp"
  | "rust-axum"
  | "collector-fanout";
export const API_RECIPES: ApiRecipe[] = [
  "node-express",
  "python-fastapi",
  "go-nethttp",
  "rust-axum",
  "collector-fanout",
];

const NODE_APP = `// harness (docs.quickstarts-run quickstart fixture): the tenant's Express app — one route, as in the guide
import express from 'express';
const app = express();
app.get('/accounts/:id', (req, res) => {
  const id = req.params.id;
  if (id === 'GMISSING') return res.status(404).json({ error: 'not found' });
  if (id === 'GBOOM') return res.status(500).json({ error: 'internal' });
  res.json({ id });
});
app.listen(8080, '0.0.0.0');
`;

const NODE_IMAGE_PIN =
  "node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995";

function nodeDockerfile(cmd: string): string {
  return `# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip test fixture (generated by tests/quickstarts), never shipped
FROM ${NODE_IMAGE_PIN}
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && printf 'minimumReleaseAge: 0\\nallowBuilds:\\n  protobufjs: false\\n' > pnpm-workspace.yaml \\
 && pnpm install --frozen-lockfile --prod
COPY . ./
USER 1000:1000
EXPOSE 8080
CMD ["sh", "-c", ${JSON.stringify(cmd)}]
`;
}

const PY_MAIN = `# harness (docs.quickstarts-run quickstart fixture): providers first (the guide's otel_setup.py), then the guide's app.py,
# then the tenant's one route, served by uvicorn.
import otel_setup  # noqa: F401
import uvicorn
from fastapi.responses import JSONResponse

from app import app


@app.get("/accounts/{account_id}")
async def account(account_id: str):
    if account_id == "GMISSING":
        return JSONResponse({"error": "not found"}, status_code=404)
    if account_id == "GBOOM":
        return JSONResponse({"error": "internal"}, status_code=500)
    return {"id": account_id}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="warning")
`;

const GO_TEMPLATE = (
  setup: string,
  wrapper: string,
) => `// harness (docs.quickstarts-run quickstart fixture): imports, the handler the guide's mux registers, and main(); the two blocks of
// docs/guides/quickstarts/api-go.md § Setup are inserted verbatim.
package main

import (
	"context"
	"net/http"
	"os"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
)

func getAccount(w http.ResponseWriter, r *http.Request) {
	switch r.PathValue("id") {
	case "GMISSING":
		http.Error(w, "not found", http.StatusNotFound)
	case "GBOOM":
		http.Error(w, "internal", http.StatusInternalServerError)
	default:
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte("{}"))
	}
}

func main() {
	ctx := context.Background()
	// ---- guide block 1 ----
${setup
  .trimEnd()
  .split("\n")
  .map((l) => `\t${l}`)
  .join("\n")}
	// ---- end ----
}

// ---- guide block 2 ----
${wrapper}`;

const RUST_TEMPLATE = (
  setup: string,
) => `// harness (docs.quickstarts-run quickstart fixture): imports, the guide's handler, the tenant's APM exporter, serving and the
// shutdown the guide's comment describes; docs/guides/quickstarts/api-rust-axum.md § Setup is inserted verbatim.
use std::collections::HashMap;

use axum::{Router, extract::Path, http::StatusCode, routing::get};
use opentelemetry::global;
use opentelemetry_otlp::{MetricExporter, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{Resource, metrics::SdkMeterProvider};
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

async fn account(Path(id): Path<String>) -> (StatusCode, &'static str) {
    match id.as_str() {
        "GMISSING" => (StatusCode::NOT_FOUND, "{\\"error\\":\\"not found\\"}"),
        "GBOOM" => (StatusCode::INTERNAL_SERVER_ERROR, "{\\"error\\":\\"internal\\"}"),
        _ => (StatusCode::OK, "{}"),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync + 'static>> {
    // the tenant's APM exporter ("built the same way with its own endpoint and headers in code")
    let apm = MetricExporter::builder().with_http()
        .with_endpoint(format!("{}/v1/metrics", std::env::var("APM_ENDPOINT")?))
        .with_headers(HashMap::from([("api-key".into(), std::env::var("APM_API_KEY")?)]))
        .build()?;
    // ---- guide block ----
${setup
  .trimEnd()
  .split("\n")
  .map((l) => `    ${l}`)
  .join("\n")}
    // ---- end ----
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080").await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    let _ = tokio::task::spawn_blocking(move || mp.shutdown()).await;
    Ok(())
}
`;

/** The guide's `Tested with … fastapi X, uvicorn Y` pins (the requirements block lists only the OpenTelemetry ones). */
export function pythonServerPins(): string[] {
  const g = readGuide(PICKS.pyRequirements.file);
  const fa = /fastapi (\d+\.\d+\.\d+)/.exec(g);
  const uv = /uvicorn (\d+\.\d+\.\d+)/.exec(g);
  if (!fa || !uv) throw new Error("api-python-fastapi.md: fastapi/uvicorn versions not found");
  return [`fastapi==${fa[1]}`, `uvicorn==${uv[1]}`];
}

/** The tested Collector image (tag and digest) named in the fan-out guide. */
export function collectorImage(): string {
  const g = readGuide(PICKS.collectorConfig.file);
  const tag = /`(otel\/opentelemetry-collector-contrib:\d+\.\d+\.\d+)`/.exec(g);
  const dig = /`(sha256:[0-9a-f]{64})`/.exec(g);
  if (!tag || !dig) throw new Error("api-collector-fanout.md: Collector image or digest not found");
  return `${tag[1]}@${dig[1]}`;
}

/** The guide's run command for the Node zero-code service, joined into one shell line (comments dropped). */
export function shellCommand(code: string): string {
  return code
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .replace(/\\\n\s*/g, "")
    .trim();
}

export interface BuiltRecipe {
  /** build context of the service image */
  dir: string;
  /** for collector-fanout: the Collector configuration file to mount */
  collectorConfig?: string;
}

/** Writes the build context of a recipe into `<work>/<recipe>` and returns it. */
export function buildRecipe(recipe: ApiRecipe, work: string, e: Endpoints): BuiltRecipe {
  const dir = join(work, recipe);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const w = (f: string, s: string) => writeFileSync(join(dir, f), s);
  switch (recipe) {
    case "node-express": {
      for (const f of ["package.json", "pnpm-lock.yaml"])
        cpSync(join(FIXTURES, "node-express", f), join(dir, f));
      w("otel.mjs", substitute(block("nodeOtel").code, otlpSubst(e)));
      w("app.mjs", NODE_APP);
      w("Dockerfile", nodeDockerfile(shellCommand(block("nodeRun").code)));
      return { dir };
    }
    case "python-fastapi": {
      w("requirements.txt", `${block("pyRequirements").code}${pythonServerPins().join("\n")}\n`);
      w("otel_setup.py", substitute(block("pyOtelSetup").code, otlpSubst(e)));
      w("app.py", block("pyApp").code);
      w("main.py", PY_MAIN);
      w(
        "Dockerfile",
        `# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip test fixture (generated by tests/quickstarts), never shipped
FROM python:3.13-alpine3.23@sha256:bf88c40985006a79ca25458159a4da1dffc457f9ae234e948b2d6df56ca5ebd2
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . ./
USER 1000:1000
ENV OTEL_SEMCONV_STABILITY_OPT_IN=http
EXPOSE 8080
CMD ["python", "main.py"]
`,
      );
      return { dir };
    }
    case "go-nethttp": {
      cpSync(join(FIXTURES, "go-nethttp/go.mod.fixture"), join(dir, "go.mod.fixture"));
      cpSync(join(FIXTURES, "go-nethttp/go.sum.fixture"), join(dir, "go.sum.fixture"));
      // The Go guide's endpoint is a full URL including the path.
      const setup = substitute(block("goSetup").code, { [PLACEHOLDER.otlp]: e.scf });
      w("main.go.fixture", GO_TEMPLATE(setup, block("goWrapper").code));
      w(
        "Dockerfile",
        `# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip test fixture (generated by tests/quickstarts), never shipped
FROM golang:1.27.4-trixie@sha256:b54b2639de8c1bfe538ec5ffc45f29b1932235ac5f6d63c059853646677112d9 AS build
WORKDIR /src
COPY go.mod.fixture go.mod
COPY go.sum.fixture go.sum
COPY main.go.fixture main.go
RUN GOWORK=off CGO_ENABLED=0 go build -trimpath -o /app .

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
COPY --from=build /app /usr/local/bin/app
USER 1000:1000
EXPOSE 8080
CMD ["/usr/local/bin/app"]
`,
      );
      return { dir };
    }
    case "rust-axum": {
      cpSync(join(FIXTURES, "rust-axum/Cargo.lock"), join(dir, "Cargo.lock"));
      w(
        "Cargo.toml",
        `# harness (docs.quickstarts-run quickstart fixture): package, the guide's dependency block verbatim, then axum/tokio
[package]
name = "qs-rust-axum"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
${block("rustCargo").code}axum = "=0.8.9"
tokio = { version = "1", features = ["rt-multi-thread", "macros", "signal", "net"] }
`,
      );
      mkdirSync(join(dir, "src"));
      w(
        "src/main.rs",
        RUST_TEMPLATE(substitute(block("rustSetup").code, { [PLACEHOLDER.otlp]: e.scf })),
      );
      w(
        "Dockerfile",
        `# SPDX-License-Identifier: Apache-2.0
# ci-scan: skip test fixture (generated by tests/quickstarts), never shipped
FROM rust:1.99.1-slim-trixie@sha256:f6c4a35d21dbb3c89d7a8d056c193e94fc09037f2b58dd858b09c39a47dd02d7 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release && cp target/release/qs-rust-axum /app

FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /usr/local/bin/app
USER 1000:1000
EXPOSE 8080
CMD ["/usr/local/bin/app"]
`,
      );
      return { dir };
    }
    case "collector-fanout": {
      for (const f of ["package.json", "pnpm-lock.yaml"])
        cpSync(join(FIXTURES, "node-express", f), join(dir, f));
      w("app.mjs", NODE_APP);
      w("Dockerfile", nodeDockerfile(shellCommand(block("collectorNode").code)));
      const cfg = join(work, "collector-fanout.yaml");
      writeFileSync(cfg, substitute(block("collectorConfig").code, otlpSubst(e)));
      return { dir, collectorConfig: cfg };
    }
  }
}
