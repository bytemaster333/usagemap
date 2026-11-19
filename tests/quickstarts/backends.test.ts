// SPDX-License-Identifier: Apache-2.0
// api.dual-export, api.drop-traces: the backend examples (examples/api-*), the tenant guides that show them (docs/onboarding/api-*.md)
// and the suite that runs them (backends/backends.spec.ts) cannot drift apart. No Docker, no network:
//   - the local OTLP receiver decodes what an SDK sends (protobuf and JSON, gzip), enforces the bearer token and
//     refuses logs, and counts cumulative and delta histograms correctly;
//   - every file a guide shows in full is byte-for-byte the example's file (without its SPDX line), and every
//     version a guide names is the example's exact pin;
//   - every example has a backend in the suite, every backend's guide exists, and every image is pinned by digest.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/env.ts";
import { BACKENDS, EXAMPLES, envFile, IMAGES, nodeScript } from "./backends/backends.ts";
import {
  attributeKeys,
  decodeMetricsJson,
  decodeMetricsProto,
  type Receiver,
  requestsByRouteStatus,
  startReceiver,
} from "./backends/otlp-receiver.ts";
import { parseBlocks } from "./extract.ts";

const ONBOARDING = join(REPO_ROOT, "docs/onboarding");
const guide = (name: string): string => readFileSync(join(ONBOARDING, name), "utf8");
const example = (path: string): string => readFileSync(join(EXAMPLES, path), "utf8");
const shown = (path: string): string => {
  const lines = example(path).split("\n");
  if (lines[0]?.includes("SPDX-License-Identifier")) lines.shift();
  if (lines[0] === "") lines.shift(); // Go: blank line between the SPDX comment and the package comment
  return lines.join("\n").replace(/\n*$/, "\n");
};
const codeBlocks = (name: string, lang: string): string[] =>
  parseBlocks(name, guide(name))
    .filter((b) => b.lang === lang)
    .map((b) => b.code.replace(/\n*$/, "\n"));

// ---------------------------------------------------------------- a minimal protobuf encoder for the tests

const varint = (n: number | bigint): Buffer => {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
};
const tag = (no: number, wire: number) => varint((no << 3) | wire);
const len = (no: number, b: Buffer) => Buffer.concat([tag(no, 2), varint(b.length), b]);
const str = (no: number, s: string) => len(no, Buffer.from(s));
const f64 = (no: number, v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return Buffer.concat([tag(no, 1), b]);
};
const dbl = (no: number, v: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return Buffer.concat([tag(no, 1), b]);
};
const kvStr = (no: number, k: string, v: string) =>
  len(no, Buffer.concat([str(1, k), len(2, str(1, v))]));
const kvInt = (no: number, k: string, v: number) =>
  len(no, Buffer.concat([str(1, k), len(2, Buffer.concat([tag(3, 0), varint(v)]))]));

function histPoint(
  route: string,
  status: number,
  count: number,
  sum: number,
  time: bigint,
  exemplarKey?: string,
) {
  return Buffer.concat([
    kvStr(9, "http.route", route),
    kvInt(9, "http.response.status_code", status),
    f64(2, 1n),
    f64(3, time),
    f64(4, BigInt(count)),
    dbl(5, sum),
    len(6, Buffer.concat([1, 2].map((x) => f64(0, BigInt(x)).subarray(1)))), // packed fixed64
    ...(exemplarKey ? [len(8, kvStr(7, exemplarKey, "x"))] : []),
  ]);
}

function request(temporality: number, points: Buffer[], instance = "i-1"): Buffer {
  const metric = Buffer.concat([
    str(1, "http.server.request.duration"),
    str(3, "s"),
    len(9, Buffer.concat([...points.map((p) => len(1, p)), tag(2, 0), varint(temporality)])),
  ]);
  const scope = Buffer.concat([len(1, str(1, "io.opentelemetry.tomcat-10.0")), len(2, metric)]);
  const resource = Buffer.concat([
    kvStr(1, "service.name", "my-api"),
    kvStr(1, "service.instance.id", instance),
  ]);
  return len(1, Buffer.concat([len(1, resource), len(2, scope)]));
}

describe("the OTLP test receiver", () => {
  it("decodes protobuf histograms with attributes, bounds and exemplars", () => {
    const rms = decodeMetricsProto(
      request(2, [histPoint("/a/{id}", 200, 3, 0.5, 10n, "client.address")]),
    );
    const m = rms[0]?.scopeMetrics[0]?.metrics[0];
    expect(rms[0]?.resource).toEqual({ "service.name": "my-api", "service.instance.id": "i-1" });
    expect(rms[0]?.scopeMetrics[0]?.scope.name).toBe("io.opentelemetry.tomcat-10.0");
    expect(m).toMatchObject({
      name: "http.server.request.duration",
      unit: "s",
      kind: "histogram",
      temporality: 2,
    });
    expect(m?.points[0]).toMatchObject({
      attributes: { "http.route": "/a/{id}", "http.response.status_code": 200n },
      count: 3,
      sum: 0.5,
      bucketCounts: [1, 2],
    });
    expect([...attributeKeys(rms).exemplar]).toEqual(["client.address"]);
  });

  it("counts cumulative streams by their last point and sums delta streams", () => {
    const cum = [
      ...decodeMetricsProto(request(2, [histPoint("/a", 200, 2, 0.2, 10n)])),
      ...decodeMetricsProto(request(2, [histPoint("/a", 200, 5, 0.5, 20n)])),
      ...decodeMetricsProto(request(2, [histPoint("/a", 200, 1, 0.1, 15n)], "i-2")),
    ];
    expect(requestsByRouteStatus(cum)).toEqual([{ route: "/a", status: 200, count: 6, sum: 0.6 }]);
    const delta = [
      ...decodeMetricsProto(request(1, [histPoint("/a", 404, 2, 0.2, 10n)])),
      ...decodeMetricsProto(request(1, [histPoint("/a", 404, 3, 0.3, 20n)])),
    ];
    expect(requestsByRouteStatus(delta)[0]).toMatchObject({ route: "/a", status: 404, count: 5 });
  });

  it("decodes OTLP/JSON", () => {
    const rms = decodeMetricsJson(
      JSON.stringify({
        resourceMetrics: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: "my-api" } }] },
            scopeMetrics: [
              {
                scope: { name: "s" },
                metrics: [
                  {
                    name: "http.server.request.duration",
                    unit: "s",
                    histogram: {
                      aggregationTemporality: 2,
                      dataPoints: [
                        {
                          attributes: [
                            { key: "http.route", value: { stringValue: "/x" } },
                            { key: "http.response.status_code", value: { intValue: "500" } },
                          ],
                          timeUnixNano: "5",
                          count: "4",
                          sum: 0.4,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    expect(requestsByRouteStatus(rms)).toEqual([{ route: "/x", status: 500, count: 4, sum: 0.4 }]);
  });

  let r: Receiver | undefined;
  afterAll(async () => r?.close());

  it("serves like the UsageMap front door: bearer required, logs refused, gzip accepted", async () => {
    r = await startReceiver({ token: "t0k", refuseLogs: true });
    const body = request(2, [histPoint("/a", 200, 1, 0.1, 1n)]);
    const post = (path: string, headers: Record<string, string>, b: Buffer = body) =>
      fetch(`${r?.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf", ...headers },
        body: new Uint8Array(b),
      }).then((x) => x.status);
    expect(await post("/v1/metrics", {})).toBe(401);
    expect(await post("/v1/metrics", { authorization: "Bearer nope" })).toBe(401);
    expect(await post("/v1/logs", { authorization: "Bearer t0k" })).toBe(404);
    expect(
      await post(
        "/v1/metrics",
        { authorization: "Bearer t0k", "content-encoding": "gzip" },
        gzipSync(body),
      ),
    ).toBe(200);
    expect(requestsByRouteStatus(r.metrics())).toEqual([
      { route: "/a", status: 200, count: 1, sum: 0.1 },
    ]);
    expect(r.received.map((x) => x.status)).toEqual([401, 401, 404, 200]);
  });
});

describe("backend examples and their guides", () => {
  it("every examples/api-* directory is run by the suite, and every guide it names exists", () => {
    const dirs = readdirSync(EXAMPLES)
      .filter((d) => d.startsWith("api-") && d !== "api-x402") // api-x402 is run by packages/payments-otel test:example
      .sort();
    expect(BACKENDS.map((b) => b.dir).sort()).toEqual(dirs);
    for (const b of BACKENDS) expect(existsSync(join(ONBOARDING, b.guide)), b.guide).toBe(true);
    const readme = example("README.md");
    for (const d of dirs) expect(readme, d).toContain(`\`${d}\``);
  });

  it("every image the suite runs is pinned by tag and digest", () => {
    for (const [k, v] of Object.entries(IMAGES))
      expect(v, k).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it("Node: the guide's packages are the example's pins; its start command is the example's scf-only script", () => {
    const pkg = JSON.parse(example("api-node-express/package.json")) as {
      dependencies: Record<string, string>;
    };
    for (const v of Object.values(pkg.dependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    const g = guide("api-node-express.md");
    for (const m of g.matchAll(/(@opentelemetry\/[a-z0-9-]+)@(\d+\.\d+\.\d+)/g))
      expect(pkg.dependencies[m[1] as string], m[1]).toBe(m[2]);
    expect(g).toContain(`Express ${pkg.dependencies.express}`);
    const cmd = codeBlocks("api-node-express.md", "sh")
      .join("\n")
      .replace(/\\\n/g, " ")
      .split(/\s+/)
      .filter((t) => t !== "");
    const script = nodeScript("start:scf-only");
    const at = cmd.indexOf("node");
    expect(cmd.slice(at, at + script.length)).toEqual(script);
  });

  it("Python: the guide shows app.py in full; its pins and stated versions are the example's", () => {
    expect(codeBlocks("api-python-fastapi.md", "python")).toContain(
      shown("api-python-fastapi/app.py"),
    );
    const req = example("api-python-fastapi/requirements.txt").split("\n");
    for (const l of req.filter((x) => x !== "" && !x.startsWith("#")))
      expect(l).toMatch(/^[\w.-]+==[\w.]+$/);
    for (const p of (codeBlocks("api-python-fastapi.md", "text")[0] ?? "").trim().split("\n"))
      expect(req, p).toContain(p);
    const g = guide("api-python-fastapi.md");
    for (const name of ["fastapi", "uvicorn"]) {
      const v = req.find((x) => x.startsWith(`${name}==`))?.split("==")[1];
      expect(g, name).toContain(`${name} ${v}`);
    }
  });

  it("Go: the guide shows the scf-only main.go in full; its modules are the example's go.mod versions", () => {
    expect(codeBlocks("api-go.md", "go")).toContain(shown("api-go-nethttp/cmd/scf-only/main.go"));
    const gomod = example("api-go-nethttp/go.mod");
    for (const m of guide("api-go.md").matchAll(
      /(go\.opentelemetry\.io\/[a-z0-9/]+)@(v\d+\.\d+\.\d+)/g,
    )) {
      // `otel/sdk/metric` is a package of the `otel/sdk/metric` module; the others are modules themselves
      expect(gomod, m[1]).toContain(`${m[1]} ${m[2]}`);
    }
  });

  it("Rust: the guide shows scf-only.rs and lib.rs in full; its crate versions are the example's exact pins", () => {
    const rust = codeBlocks("api-rust-axum.md", "rust");
    expect(rust).toContain(shown("api-rust-axum/src/bin/scf-only.rs"));
    expect(rust).toContain(shown("api-rust-axum/src/lib.rs"));
    const cargo = example("api-rust-axum/Cargo.toml");
    const toml = codeBlocks("api-rust-axum.md", "toml")[0] ?? "";
    const crates = [...toml.matchAll(/^([a-z_-]+) = (?:\{ version = )?"(\d+\.\d+(?:\.\d+)?)"/gm)];
    expect(crates.length).toBeGreaterThanOrEqual(5);
    for (const m of crates) expect(cargo, m[1]).toMatch(new RegExp(`^${m[1]} = .*"=${m[2]}`, "m"));
    for (const l of cargo.split("\n").filter((x) => /^[a-z_-]+ = /.test(x)))
      if (!/^(name|version|edition|publish|license) = /.test(l))
        expect(l).toMatch(/"=\d+\.\d+\.\d+"/);
  });

  it("Java: agent version and checksum are the example's; the start command switches exemplars off", () => {
    const g = guide("api-java-spring.md");
    const pom = example("api-java-spring/pom.xml");
    const agent = /<otel\.javaagent\.version>([\d.]+)</.exec(pom)?.[1];
    const boot = /<artifactId>spring-boot-starter-parent<\/artifactId>\s*<version>([\d.]+)</.exec(
      pom,
    )?.[1];
    const sha = /sha256=([0-9a-f]{64})/.exec(example("api-anchor-platform/fetch-agent.sh"))?.[1];
    expect(g).toContain(`opentelemetry-javaagent-${agent}.jar`);
    expect(g).toContain(`Spring Boot ${boot}`);
    expect(g).toContain(sha);
    const sh = codeBlocks("api-java-spring.md", "sh")[0] ?? "";
    expect(sh).toContain("OTEL_METRICS_EXEMPLAR_FILTER=always_off");
    expect(sh).toContain("java -javaagent:opentelemetry-javaagent.jar -jar app.jar");
    expect(example("api-java-spring/otel/sdk.yaml")).toMatch(/^ {2}exemplar_filter: always_off$/m);
  });

  it("Anchor Platform: the guide's environment is the example's env file; image digest and version match", () => {
    const g = guide("api-anchor-platform.md");
    const env = envFile(join(EXAMPLES, "api-anchor-platform/otel-scf-only.env"));
    const block =
      codeBlocks("api-anchor-platform.md", "sh").find((b) => b.includes("JAVA_TOOL_OPTIONS")) ?? "";
    const lines = block.trim().split("\n");
    expect(lines.slice(0, Object.keys(env).length)).toEqual(
      Object.entries(env).map(([k, v]) => `${k}=${v}`),
    );
    const [, digest] = IMAGES.anchor.split("@");
    expect(g).toContain(digest);
    expect(g).toContain(`stellar/anchor-platform:${/:(\d+\.\d+\.\d+)@/.exec(IMAGES.anchor)?.[1]}`);
    expect(g).toContain("--entrypoint java");
    expect(example("api-anchor-platform/fetch-agent.sh")).toContain(
      `version=${/<otel\.javaagent\.version>([\d.]+)</.exec(example("api-java-spring/pom.xml"))?.[1]}`,
    );
  });
});
