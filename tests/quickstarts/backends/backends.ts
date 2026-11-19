// SPDX-License-Identifier: Apache-2.0
// api.dual-export, api.drop-traces backend examples (examples/api-*): how each one is built and started in its two documented modes.
//
//   scf-only     UsageMap is the only destination; everything is configured by the standard OTEL_* environment variables
//                (docs/onboarding/api-<stack>.md).
//   dual-export  the tenant's APM keeps its export; a second, filtered export goes to UsageMap with endpoint and token set
//                in code or in the agent's declarative file (docs/onboarding/api-dual-export.md).
//
// Runtimes: Node and Go run on the host (mise toolchain); Python, Java, Rust and the Anchor Platform run in pinned
// images (the digests below) on the host network, so that they reach the test receivers on 127.0.0.1 and listen on a
// port the suite picked. Build outputs and package caches live outside the repository (`cacheDir`).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../../lib/env.ts";

export const EXAMPLES = join(REPO_ROOT, "examples");

export const IMAGES = {
  python:
    "python:3.13-alpine3.23@sha256:bf88c40985006a79ca25458159a4da1dffc457f9ae234e948b2d6df56ca5ebd2",
  rust: "rust:1.99.1-slim-trixie@sha256:f6c4a35d21dbb3c89d7a8d056c193e94fc09037f2b58dd858b09c39a47dd02d7",
  maven:
    "maven:3.9.16-eclipse-temurin-25@sha256:93b8a14ea2f412782e4e842651273b4d903e35cc496284f178fbbe2d67d00976",
  jre: "eclipse-temurin:25.0.5_8-jre@sha256:a640968ae55027b322cedd5f8228b01a84baff0b9e9360e47601c6a111ba1699",
  anchor:
    "stellar/anchor-platform:5.0.0@sha256:bb1487fa38665dcbf0879a2303fc113dea021f73570c49da112292ec2d52c009",
  postgres:
    "postgres:18.6-alpine@sha256:9ba53c7d41ea093baf5c1ba635ba5434c4f979880527d49bb7d9237d3193085b",
} as const;

export type Mode = "scf-only" | "dual-export";

export interface Request {
  path: string;
  n: number;
  /** the status the app must answer */
  status: number;
  /** the `http.route` the UsageMap export must carry for these requests */
  route: string;
}

/** What the suite hands a backend when it starts it. */
export interface RunContext {
  mode: Mode;
  port: number;
  /** UsageMap stand-in base URL (no trailing slash) and its bearer token */
  scf: string;
  token: string;
  /** the tenant APM stand-in (dual-export) */
  apm: string;
  apmKey: string;
  /** a value unique to this run, for service.instance.id and container names */
  id: string;
  cache: string;
  /** helper ports a backend may need besides `port` (Anchor: management port, PostgreSQL) */
  extraPorts: number[];
}

/** A process to start: on the host, or `docker run` in the foreground (stopped with `docker stop`, i.e. SIGTERM). */
export interface Launch {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** set when the process is a container: its name */
  container?: string;
  /** containers to start before (and remove after) the app, e.g. a database */
  sidecars?: { name: string; args: string[]; ready: string[] }[];
}

/** Runs a command to completion (non-zero exit rejects); `docker` goes through the same helper. */
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
) => Promise<string>;

export interface Backend {
  id: string;
  /** directory under examples/ */
  dir: string;
  /** the tenant guide in docs/onboarding this example proves */
  guide: string;
  /** "docker" backends are skipped when Docker is unavailable */
  needs: ("docker" | "go" | "node")[];
  /** the request mix; the readiness request (first entry's path) is added to the 200 count */
  mix: Request[];
  /** how long the app may take to answer the first request */
  startTimeoutMs: number;
  /** metric names UsageMap may receive in dual-export mode besides the duration metric (no filter possible) */
  dualExtraMetrics?: RegExp;
  /** prepare once per suite run (install, build); returns nothing, throws on failure */
  prepare(cache: string, run: Runner): Promise<void>;
  launch(ctx: RunContext): Launch;
}

const ACCOUNTS = (route: string): Request[] => [
  { path: "/accounts/GABC", n: 10, status: 200, route },
  { path: "/accounts/GMISSING", n: 5, status: 404, route },
  { path: "/accounts/GBOOM", n: 3, status: 500, route },
];

/** The UsageMap-only environment of the onboarding guides, pointed at the stand-in. */
export function scfOnlyEnv(ctx: RunContext, service = "my-api"): Record<string, string> {
  return {
    OTEL_SERVICE_NAME: service,
    OTEL_EXPORTER_OTLP_ENDPOINT: ctx.scf,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${ctx.token}`,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "none",
    OTEL_RESOURCE_ATTRIBUTES: `service.instance.id=${ctx.id}`,
  };
}

/** The dual-export environment the examples read (endpoint and token for UsageMap, endpoint and key for the APM). */
export function dualEnv(ctx: RunContext, service = "my-api"): Record<string, string> {
  return {
    OTEL_SERVICE_NAME: service,
    OTEL_RESOURCE_ATTRIBUTES: `service.instance.id=${ctx.id}`,
    SCF_OTLP_ENDPOINT: ctx.scf,
    SCF_OTLP_TOKEN: ctx.token,
    APM_OTLP_ENDPOINT: ctx.apm,
    APM_API_KEY: ctx.apmKey,
  };
}

const uidgid = () => `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

/** `docker run` arguments shared by every container the suite starts. */
export function dockerRun(name: string, env: Record<string, string>, extra: string[]): string[] {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "host",
    "--user",
    uidgid(),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "-e",
    "HOME=/tmp",
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...extra,
  ];
}

/** `KEY=value` lines of an env file (comments and blank lines skipped), as `docker run --env-file` reads them. */
export function envFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** The start command of a package.json script, split into argv (the scripts are plain `node …` commands). */
export function nodeScript(name: string): string[] {
  const pkg = JSON.parse(readFileSync(join(EXAMPLES, "api-node-express/package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const s = pkg.scripts[name];
  if (!s) throw new Error(`api-node-express/package.json: no script ${name}`);
  return s.split(/\s+/);
}

export const BACKENDS: Backend[] = [
  {
    id: "node-express",
    dir: "api-node-express",
    guide: "api-node-express.md",
    needs: ["node"],
    mix: ACCOUNTS("/accounts/:id"),
    startTimeoutMs: 30_000,
    async prepare() {
      // examples/ is its own workspace; the suite's run.sh installs it from the frozen lockfile
    },
    launch(ctx) {
      const [cmd, ...args] = nodeScript(`start:${ctx.mode}`) as [string, ...string[]];
      const env =
        ctx.mode === "scf-only" ? scfOnlyEnv(ctx) : { ...dualEnv(ctx), OTEL_LOGS_EXPORTER: "none" };
      return {
        cmd: cmd === "node" ? process.execPath : cmd,
        args,
        cwd: join(EXAMPLES, "api-node-express"),
        env: { ...env, PORT: String(ctx.port), HOST: "127.0.0.1" },
      };
    },
  },
  {
    id: "python-fastapi",
    dir: "api-python-fastapi",
    guide: "api-python-fastapi.md",
    needs: ["docker"],
    mix: ACCOUNTS("/accounts/{account_id}"),
    startTimeoutMs: 60_000,
    async prepare(cache, run) {
      const src = join(EXAMPLES, "api-python-fastapi");
      await run(
        "docker",
        dockerRun(`qsb-py-deps-${process.pid}`, {}, [
          "-v",
          `${src}:/src:ro`,
          "-v",
          `${cache}/python:/deps`,
          IMAGES.python,
          "sh",
          "-c",
          "test -f /deps/.done-$(sha256sum /src/requirements.txt | cut -c1-16) || " +
            "(rm -rf /deps/site && pip install -q --no-cache-dir --disable-pip-version-check --no-deps " +
            "--target /deps/site -r /src/requirements.txt && touch /deps/.done-$(sha256sum /src/requirements.txt | cut -c1-16))",
        ]),
      );
    },
    launch(ctx) {
      const name = `qsb-py-${ctx.id}`;
      const env =
        ctx.mode === "scf-only"
          ? { ...scfOnlyEnv(ctx), OTEL_SEMCONV_STABILITY_OPT_IN: "http" }
          : { ...dualEnv(ctx), OTEL_SEMCONV_STABILITY_OPT_IN: "http", PORT: String(ctx.port) };
      const cmd =
        ctx.mode === "scf-only"
          ? [
              "opentelemetry-instrument",
              "uvicorn",
              "app:app",
              "--host",
              "127.0.0.1",
              "--port",
              String(ctx.port),
            ]
          : ["python", "serve_dual_export.py"];
      return {
        cmd: "docker",
        container: name,
        args: dockerRun(
          name,
          {
            ...env,
            PYTHONPATH: "/deps/site",
            PATH: "/deps/site/bin:/usr/local/bin:/usr/bin:/bin",
            PYTHONDONTWRITEBYTECODE: "1",
          },
          [
            "-v",
            `${join(EXAMPLES, "api-python-fastapi")}:/app:ro`,
            "-v",
            `${ctx.cache}/python:/deps:ro`,
            "-w",
            "/app",
            IMAGES.python,
            ...cmd,
          ],
        ),
      };
    },
  },
  {
    id: "go-nethttp",
    dir: "api-go-nethttp",
    guide: "api-go.md",
    needs: ["go"],
    mix: ACCOUNTS("/accounts/{id}"),
    startTimeoutMs: 30_000,
    async prepare(cache, run) {
      for (const mode of ["scf-only", "dual-export"])
        await run("go", ["build", "-trimpath", "-o", join(cache, "go", mode), `./cmd/${mode}`], {
          cwd: join(EXAMPLES, "api-go-nethttp"),
          env: { GOWORK: "off", GOFLAGS: "-mod=readonly", CGO_ENABLED: "0" },
        });
    },
    launch(ctx) {
      // Go's dual export: the APM exporter is configured from the standard environment, *including* a header — the
      // suite checks that it does not reach UsageMap.
      const env =
        ctx.mode === "scf-only"
          ? scfOnlyEnv(ctx)
          : {
              ...dualEnv(ctx),
              OTEL_EXPORTER_OTLP_ENDPOINT: ctx.apm,
              OTEL_EXPORTER_OTLP_HEADERS: `api-key=${ctx.apmKey}`,
            };
      return {
        cmd: join(ctx.cache, "go", ctx.mode),
        args: [],
        env: { ...env, PORT: String(ctx.port) },
      };
    },
  },
  {
    id: "java-spring",
    dir: "api-java-spring",
    guide: "api-java-spring.md",
    needs: ["docker"],
    mix: ACCOUNTS("/accounts/{id}"),
    startTimeoutMs: 180_000,
    dualExtraMetrics: /^(jvm\.|otel\.sdk\.|otlp\.exporter\.)/,
    async prepare(cache, run) {
      // build a copy outside the repository: Maven writes target/ next to the pom
      await run(
        "docker",
        dockerRun(`qsb-java-build-${process.pid}`, {}, [
          "-v",
          `${join(EXAMPLES, "api-java-spring")}:/example:ro`,
          "-v",
          `${cache}/java:/work`,
          "-v",
          `${cache}/m2:/m2`,
          IMAGES.maven,
          "sh",
          "-c",
          "rm -rf /work/src /work/pom.xml && cp -r /example/pom.xml /example/src /work/ && cd /work && " +
            "mvn -q -B -Dmaven.repo.local=/m2 package -DskipTests",
        ]),
      );
    },
    launch(ctx) {
      const name = `qsb-java-${ctx.id}`;
      // The Java agent attaches exemplars by default, and they carry client.address, url.query and
      // user_agent.original even with OTEL_TRACES_EXPORTER=none (measured): the guide switches them off.
      const env =
        ctx.mode === "scf-only"
          ? { ...scfOnlyEnv(ctx), OTEL_METRICS_EXEMPLAR_FILTER: "always_off" }
          : {
              ...dualEnv(ctx),
              OTEL_CONFIG_FILE: "/otel/sdk.yaml",
              // ignored in declarative mode: the suite checks that this key never reaches UsageMap
              OTEL_EXPORTER_OTLP_HEADERS: `api-key=${ctx.apmKey}`,
            };
      return {
        cmd: "docker",
        container: name,
        args: dockerRun(
          name,
          { ...env, SERVER_PORT: String(ctx.port), SERVER_ADDRESS: "127.0.0.1" },
          [
            "-v",
            `${ctx.cache}/java/target:/app:ro`,
            "-v",
            `${join(EXAMPLES, "api-java-spring/otel")}:/otel:ro`,
            IMAGES.jre,
            "java",
            "-javaagent:/app/opentelemetry-javaagent.jar",
            "-jar",
            "/app/app.jar",
          ],
        ),
      };
    },
  },
  {
    id: "rust-axum",
    dir: "api-rust-axum",
    guide: "api-rust-axum.md",
    needs: ["docker"],
    mix: ACCOUNTS("/accounts/{id}"),
    startTimeoutMs: 30_000,
    // the tower layer's other metrics: a filter cannot be written in opentelemetry 0.33.1
    dualExtraMetrics: /^http\.server\.(active_requests|request\.body\.size|response\.body\.size)$/,
    async prepare(cache, run) {
      await run(
        "docker",
        dockerRun(
          `qsb-rust-build-${process.pid}`,
          { CARGO_HOME: "/cache/cargo", CARGO_TARGET_DIR: "/cache/target" },
          [
            "-v",
            `${join(EXAMPLES, "api-rust-axum")}:/src:ro`,
            "-v",
            `${cache}/cargo:/cache/cargo`,
            "-v",
            `${cache}/rust-target:/cache/target`,
            "-w",
            "/src",
            IMAGES.rust,
            "cargo",
            "build",
            "--release",
            "--locked",
          ],
        ),
      );
    },
    launch(ctx) {
      const name = `qsb-rust-${ctx.id}`;
      const env = ctx.mode === "scf-only" ? scfOnlyEnv(ctx) : dualEnv(ctx);
      return {
        cmd: "docker",
        container: name,
        args: dockerRun(name, { ...env, PORT: String(ctx.port) }, [
          "-v",
          `${ctx.cache}/rust-target/release:/app:ro`,
          IMAGES.rust,
          `/app/${ctx.mode}`,
        ]),
      };
    },
  },
  {
    id: "anchor-platform",
    dir: "api-anchor-platform",
    guide: "api-anchor-platform.md",
    needs: ["docker"],
    mix: [
      { path: "/.well-known/stellar.toml", n: 10, status: 200, route: "/.well-known/stellar.toml" },
      { path: "/sep6/info", n: 5, status: 404, route: "/**" },
    ],
    startTimeoutMs: 240_000,
    dualExtraMetrics: /^(jvm\.|otel\.sdk\.|otlp\.exporter\.|db\.client\.)/,
    async prepare(cache, run) {
      // the guide's own download script (Maven Central, SHA-256 checked)
      const dir = join(cache, "anchor-otel");
      if (!existsSync(join(dir, "opentelemetry-javaagent.jar")))
        await run(join(EXAMPLES, "api-anchor-platform/fetch-agent.sh"), [dir]);
    },
    launch(ctx) {
      const name = `qsb-ap-${ctx.id}`;
      const [mgmt, pg] = ctx.extraPorts as [number, number];
      const ex = join(EXAMPLES, "api-anchor-platform");
      const otel =
        ctx.mode === "scf-only"
          ? {
              ...envFile(join(ex, "otel-scf-only.env")),
              OTEL_SERVICE_NAME: "my-anchor",
              OTEL_EXPORTER_OTLP_ENDPOINT: ctx.scf,
              OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer%20${ctx.token}`,
              OTEL_RESOURCE_ATTRIBUTES: `service.instance.id=${ctx.id}`,
            }
          : { ...envFile(join(ex, "otel-dual-export.env")), ...dualEnv(ctx, "my-anchor") };
      const pgName = `qsb-ap-pg-${ctx.id}`;
      return {
        cmd: "docker",
        container: name,
        sidecars: [
          {
            name: pgName,
            args: dockerRun(
              pgName,
              {
                POSTGRES_USER: "anchor",
                POSTGRES_PASSWORD: "anchor",
                POSTGRES_DB: "anchor",
                PGPORT: String(pg),
              },
              [
                "-d",
                "--tmpfs",
                "/var/lib/postgresql:mode=1777",
                "--user",
                "70:70",
                IMAGES.postgres,
                "-c",
                "listen_addresses=127.0.0.1",
              ],
            ),
            ready: [
              "exec",
              pgName,
              "pg_isready",
              "-h",
              "127.0.0.1",
              "-p",
              String(pg),
              "-U",
              "anchor",
            ],
          },
        ],
        args: dockerRun(
          name,
          {
            ...envFile(join(ex, "anchor-demo.env")),
            DATA_SERVER: `127.0.0.1:${pg}`,
            SEP_SERVER_PORT: String(ctx.port),
            SEP_SERVER_MANAGEMENT_SERVER_PORT: String(mgmt),
            ...otel,
          },
          [
            "-v",
            `${join(EXAMPLES, "api-java-spring/otel")}/sdk.yaml:/otel/sdk.yaml:ro`,
            "-v",
            `${ctx.cache}/anchor-otel/opentelemetry-javaagent.jar:/otel/opentelemetry-javaagent.jar:ro`,
            // the stock start script (`bash start.sh` → `java …`, no exec) never passes SIGTERM on to Java: measured,
            // the container is killed after the grace period and the agent's last export is lost
            "--entrypoint",
            "java",
            IMAGES.anchor,
            "-jar",
            "/app/anchor-platform-runner.jar",
            "--sep-server",
          ],
        ),
      };
    },
  },
];
