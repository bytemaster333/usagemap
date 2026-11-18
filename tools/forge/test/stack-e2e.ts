// SPDX-License-Identifier: Apache-2.0
// End-to-end run of tools/forge against a real local stack (tests/load/stack: project rvt, ports 56540–56549):
// creates a tenant and a site through the real control-plane API (tests/lib/fixture.ts; domain marked verified as the
// superuser, as every suite does), an ingest token through the API, and an SCF-operator key minted as the superuser
// (the operator path needs a passkey step-up a headless run cannot do; the key has the production format and is
// checked by the real control plane). Then runs the forge tool exactly as a visitor would, with --strict, and
// asserts every step passed and that no secret reached its output. Also records the adoption-report fixture
// (tools/adoption-report/test/fixtures/) from the same stack's operator API.
//
//   eval "$(tests/load/stack/env.sh)" && node tools/forge/test/stack-e2e.ts [--no-evidence] [--record-adoption FILE]

import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { crc32 } from "node:zlib";
import { Compose } from "../../../tests/lib/compose.ts";
import { loadEnv, REPO_ROOT } from "../../../tests/lib/env.ts";
import { writeEvidence } from "../../../tests/lib/evidence.ts";
import { createFixture, waitForGateway } from "../../../tests/lib/fixture.ts";

const run = promisify(execFile);
const { values: a } = parseArgs({
  options: {
    "no-evidence": { type: "boolean", default: false },
    "record-adoption": { type: "string" },
  },
});
const env = loadEnv();
const compose = new Compose(env);
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function base62(n: bigint, width: number): string {
  let s = "";
  while (n > 0n) {
    s = B62[Number(n % 62n)] + s;
    n /= 62n;
  }
  return s.padStart(width, "0");
}

/** wire-formats §k key, its row stored as the control plane would (HMAC with pepper_op v1). */
function mintOperatorKey(): { key: string; id: string; hash: Buffer; last4: string } {
  const id = base62(BigInt(`0x${randomBytes(9).toString("hex")}`), 12).slice(-12);
  const secret = base62(BigInt(`0x${randomBytes(20).toString("hex")}`), 27);
  const crc = base62(BigInt(crc32(Buffer.from(`scfa_op_${id}_${secret}`, "ascii")) >>> 0), 6);
  const pepperLine = readFileSync(
    join(REPO_ROOT, "infra/compose/.secrets/pepper_op"),
    "utf8",
  ).trim();
  const m = /^1:(.+)$/.exec(pepperLine.split(",")[0] ?? "");
  if (!m) throw new Error("pepper_op has no version-1 entry");
  const hash = createHmac("sha256", Buffer.from(m[1] as string, "base64"))
    .update(secret, "ascii")
    .digest();
  return { key: `scfa_op_${id}_${secret}${crc}`, id, hash, last4: secret.slice(-4) };
}

const t0 = Date.now();
const slug = `rvt-forge-${Date.now().toString(36)}`;
const fx = await createFixture(env, compose, slug, [{ key: "forge", host: `${slug}.rvt.test` }]);
const s = fx.sites.forge;
if (!s) throw new Error("no site");
await waitForGateway(env, compose, [s]);
const tok = await fx.cp.json<{ token: string }>(
  "POST",
  `/v1/tenants/${fx.tenantId}/ingest-tokens`,
  {
    label: "forge e2e",
  },
);
const k = mintOperatorKey();
await compose.sql(
  "scf",
  `INSERT INTO scf.operator_api_keys (key_id, secret_hash, pepper_version, last4, label, scopes, created_by, expires_at)
   VALUES ('${k.id}', '\\x${k.hash.toString("hex")}', 1, '${k.last4}', 'forge e2e',
           ARRAY['web:read','api:read','registry:read'], '${fx.userId}', now() + interval '7 days')`,
);
const dir = mkdtempSync(join(tmpdir(), "forge-e2e-"));
writeFileSync(join(dir, "op.key"), `${k.key}\n`, { mode: 0o600 });
writeFileSync(join(dir, "ing.key"), `${tok.token}\n`, { mode: 0o600 });
await new Promise((r) => setTimeout(r, 12_000)); // the ingest token reaches the gateway with the next snapshots

const gw = new URL(env.gatewayUrl);
const args = [
  join(REPO_ROOT, "tools/forge/forge.ts"),
  "--base",
  `https://${env.ingestHosts[0]}`,
  "--connect",
  `${gw.hostname}:${gw.port}`,
  "--ca",
  env.gatewayCaFile,
  "--api",
  env.controlPlaneUrl,
  "--site",
  s.site_key,
  "--origin",
  s.origin,
  "--operator-key-file",
  join(dir, "op.key"),
  "--project",
  fx.tenantId,
  "--site-id",
  s.site_id,
  "--ingest-token-file",
  join(dir, "ing.key"),
  "--browser",
  "--strict",
  "--wait",
  "150",
];
let code = 0;
let stdout = "";
let stderr = "";
let human = "";
try {
  ({ stdout, stderr } = await run(process.execPath, [...args, "--json"], {
    timeout: 900_000,
    maxBuffer: 64 << 20,
  }));
} catch (e) {
  const x = e as { code?: number; stdout?: string; stderr?: string };
  code = x.code ?? 1;
  stdout = x.stdout ?? "";
  stderr = x.stderr ?? "";
}
// The human-readable form of a second, browser-free run (same stack) for the evidence file.
try {
  ({ stdout: human } = await run(
    process.execPath,
    [
      ...args.filter((x) => x !== "--browser" && x !== "--strict"),
      "--skip-browser",
      "--steps",
      "a,b,e,f",
    ],
    { timeout: 600_000 },
  ));
} catch (e) {
  human = (e as { stdout?: string }).stdout ?? "";
}

const leaks = [k.key, tok.token, k.key.slice(8, 40), tok.token.slice(9, 40)].filter(
  (x) => stdout.includes(x) || stderr.includes(x) || human.includes(x),
);
const seedLeak = /\bS[A-Z2-7]{55}\b/.test(stdout + stderr + human);
const report = JSON.parse(stdout || "{}") as {
  result?: string;
  checks?: { step: string; name: string; outcome: string; detail: string }[];
};
const checks = report.checks ?? [];
const byStep = (st: string) => checks.find((c) => c.step === st);
console.log(stdout || stderr);

if (a["record-adoption"]) {
  await run(
    process.execPath,
    [
      join(REPO_ROOT, "tools/adoption-report/report.ts"),
      "--api",
      env.controlPlaneUrl,
      "--operator-key-file",
      join(dir, "op.key"),
      "--operator-view-url",
      `${env.portalUrl}/operator`,
      "--start",
      new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
      "--end",
      new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      "--record",
      a["record-adoption"],
      "--json",
    ],
    { timeout: 120_000 },
  ).catch((e: { code?: number }) => {
    if (e.code !== 1) throw e; // 1 = written, adoption thresholds not met (no SCF-awarded projects on a test stack)
  });
  console.log(`adoption fixture recorded: ${a["record-adoption"]}`);
}
rmSync(dir, { recursive: true, force: true });

const ok = code === 0 && report.result === "pass" && leaks.length === 0 && !seedLeak;
const want = ["a", "b", "c", "c2", "d", "e", "f", "g"];
if (!a["no-evidence"]) {
  const out = writeEvidence(env.evidenceDir, {
    layer: "forge",
    name: "forge-local-stack",
    title: "Forge script (tools/forge) against a local stack",
    summary: `tools/forge/forge.ts run with --strict against the local Compose stack (project ${env.project}): a fresh tenant and site (${s.origin}), an ingest token and an SCF-operator key; counting read back from the real operator metrics API. Real Chromium (Playwright) for step d. ${((Date.now() - t0) / 1000).toFixed(0)} s.`,
    checks: [
      ...want.map((st) => {
        const c = byStep(st);
        return {
          name: `(${st}) ${c?.name ?? "missing"}`,
          outcome: (c?.outcome === "pass" ? "pass" : "fail") as "pass" | "fail",
          detail: (c?.detail ?? "step did not run").replace(/\n/g, " · "),
          ids:
            st === "g"
              ? ["api.attribute-allowlist", "privacy.minimal-erasure-scope"]
              : st === "f"
                ? ["tracker.version-pinned"]
                : [
                    "web.frontend-origin-only",
                    "bot.anti-inflation-strategy",
                    "bot.js-execution-proof",
                  ],
        };
      }),
      {
        name: "no secret (operator key, ingest token, seed) in the tool's output",
        outcome: leaks.length === 0 && !seedLeak ? "pass" : "fail",
        detail:
          leaks.length || seedLeak
            ? "a secret was printed"
            : "checked stdout and stderr of both runs",
      },
    ],
    data: { report, exitCode: code },
    notes: [
      "Human-readable output of a browser-free run (steps a, b, e, f):",
      "",
      "```",
      human.trim(),
      "```",
    ].join("\n"),
  });
  console.log(`evidence: ${out.md}`);
}
console.log(
  ok ? "FORGE E2E PASS" : `FORGE E2E FAIL (exit ${code}, leaks ${leaks.length}, seed ${seedLeak})`,
);
process.exit(ok ? 0 : 1);
