// SPDX-License-Identifier: Apache-2.0
// Where the suites find the stack. Every address is a parameter, so the same suites run against `tests/stack`
// (project scf-wsl, host ports 56300–56319), any other `infra/compose` stack or a remote environment.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(TESTS_DIR, "..");

export interface StackEnv {
  /** Compose project that runs the stack (for `docker compose exec/stop/kill`), or "" when not run by Compose. */
  project: string;
  /** Compose files of that project, in order. */
  composeFiles: string[];
  /** Gateway ingest listener reachable from this process (TLS). */
  gatewayUrl: string;
  /** Gateway /metrics and /healthz. */
  gatewayMetricsUrl: string;
  /** Host names compiled into the tracker; both are mapped to `gatewayUrl` for browsers. */
  ingestHosts: string[];
  /** CA that signed the gateway's listener certificate ("" = do not verify; only for throwaway stacks). */
  gatewayCaFile: string;
  /** Control-plane public API. */
  controlPlaneUrl: string;
  /** Portal origin; also the Origin the control plane expects for state-changing calls (CSRF). */
  portalUrl: string;
  /** OTLP/HTTP front door of the gateway (same listener as ingest). "" = not wired. */
  otlpUrl: string;
  /** SCF_REQUIRE_FULL_STACK=1: a suite whose dependency is missing FAILS instead of being marked not run. */
  requireFullStack: boolean;
  /** Where evidence files go (docs/evidence by default). */
  evidenceDir: string;
  /** Scratch directory for run artefacts (dumps, logs). */
  workDir: string;
}

function list(v: string | undefined, d: string[]): string[] {
  return v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : d;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): StackEnv {
  const work = env.SCF_TEST_WORK ?? join(TESTS_DIR, ".work");
  const ca = env.SCF_GATEWAY_CA ?? join(REPO_ROOT, "infra/compose/.secrets/pki/ca.pem");
  return {
    project: env.SCF_TEST_PROJECT ?? "scf-wsl",
    composeFiles: list(env.SCF_TEST_COMPOSE_FILES, [
      join(REPO_ROOT, "infra/compose/compose.yaml"),
      join(REPO_ROOT, "infra/compose/compose.dev.yaml"),
      join(TESTS_DIR, "stack/compose.override.yaml"),
    ]),
    gatewayUrl: env.SCF_GATEWAY_URL ?? "https://127.0.0.1:56300",
    gatewayMetricsUrl: env.SCF_GATEWAY_METRICS_URL ?? "http://127.0.0.1:56301",
    ingestHosts: list(env.SCF_INGEST_HOSTS, [
      "ingest-a.example-analytics.org",
      "ingest-b.example-analytics.net",
    ]),
    gatewayCaFile: existsSync(ca) ? ca : "",
    controlPlaneUrl: env.SCF_CONTROL_PLANE_URL ?? "http://127.0.0.1:56302",
    portalUrl: env.SCF_PORTAL_URL ?? "http://localhost:56303",
    otlpUrl: env.SCF_OTLP_URL ?? "https://127.0.0.1:56300",
    requireFullStack: env.SCF_REQUIRE_FULL_STACK === "1",
    evidenceDir: env.SCF_EVIDENCE_DIR ?? join(REPO_ROOT, "docs/evidence"),
    workDir: work,
  };
}
