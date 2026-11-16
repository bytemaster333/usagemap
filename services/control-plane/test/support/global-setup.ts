// SPDX-License-Identifier: Apache-2.0
// Starts PostgreSQL 18.6, applies the migrations with their runner (db/migrate.sh, gates on), and PgBouncer in
// transaction mode (compose project `scf-wsf-pg`). SCF_TEST_PG_URL / SCF_TEST_PGB_URL point at an existing setup
// instead. KEEP=1 leaves the stack running.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

const compose = join(import.meta.dirname, "compose.yaml");
// SCF_WSF_PG_PROJECT lets parallel runs use separate stacks (with their own SCF_WSF_PG_PORT / SCF_WSF_PGB_PORT).
const project = process.env.SCF_WSF_PG_PROJECT ?? "scf-wsf-pg";

declare module "vitest" {
  export interface ProvidedContext {
    pgSuperUrl: string;
    pgAppUrl: string;
    pgJobsUrl: string;
    pgJobsDirectUrl: string;
    pgMetricsUrl: string;
  }
}

function dc(args: string[]): void {
  execFileSync("docker", ["compose", "-p", project, "-f", compose, ...args], { stdio: "inherit" });
}

export default function setup(p: TestProject): () => void {
  const pgPort = process.env.SCF_WSF_PG_PORT ?? "56140";
  const pgbPort = process.env.SCF_WSF_PGB_PORT ?? "56142";
  const external = process.env.SCF_TEST_PG_HOSTPORT;
  if (!external) {
    dc(["down", "-v", "--remove-orphans"]);
    dc(["up", "-d", "--wait", "db", "pgbouncer"]);
    dc(["--profile", "migrate", "run", "--rm", "migrate"]);
  }
  const host = external ?? `127.0.0.1:${pgPort}`;
  const pgb = process.env.SCF_TEST_PGB_HOSTPORT ?? `127.0.0.1:${pgbPort}`;
  p.provide("pgSuperUrl", `postgres://postgres:wsf-test-super@${host}/scf`);
  p.provide("pgAppUrl", `postgres://scf_app:wsf-test-app@${pgb}/scf`);
  p.provide("pgJobsUrl", `postgres://scf_jobs:wsf-test-jobs@${pgb}/scf`);
  p.provide("pgJobsDirectUrl", `postgres://scf_jobs:wsf-test-jobs@${host}/scf`);
  p.provide("pgMetricsUrl", `postgres://scf_metrics_ro:wsf-test-metrics@${pgb}/scf`);
  return () => {
    if (!external && process.env.KEEP !== "1") dc(["down", "-v", "--remove-orphans"]);
  };
}
