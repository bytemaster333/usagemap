// SPDX-License-Identifier: Apache-2.0
// Starts the jobs integration stack (compose project `scf-wsg`, host ports 56260–56279): PostgreSQL 18.6, the db/
// migrations with their runner (gates on), Umami's migrations with the pinned migrate image, the scf_ro views
// (`db/migrate.sh umami-views`), PgBouncer in transaction mode and the pinned Umami engine. KEEP=1 leaves it running;
// SCF_WSG_REUSE=1 reuses a running stack.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

const compose = join(import.meta.dirname, "compose.yaml");
const project = process.env.SCF_WSG_PROJECT ?? "scf-wsg";

declare module "vitest" {
  export interface ProvidedContext {
    pgSuperUrl: string;
    umamiSuperUrl: string;
    jobsUrl: string;
    umamiRoUrl: string;
    umamiMaintUrl: string;
    umamiApi: string;
  }
}

function dc(args: string[]): void {
  execFileSync("docker", ["compose", "-p", project, "-f", compose, ...args], { stdio: "inherit" });
}

export default function setup(p: TestProject): () => void {
  const pgPort = process.env.SCF_WSG_PG_PORT ?? "56260";
  const pgbPort = process.env.SCF_WSG_PGB_PORT ?? "56261";
  const umamiPort = process.env.SCF_WSG_UMAMI_PORT ?? "56262";
  if (process.env.SCF_WSG_REUSE !== "1") {
    dc(["down", "-v", "--remove-orphans"]);
    dc(["up", "-d", "--wait", "db"]);
    dc(["--profile", "tools", "run", "--rm", "migrate", "migrate"]);
    dc(["--profile", "tools", "run", "--rm", "umami-migrate"]);
    dc(["--profile", "tools", "run", "--rm", "migrate", "umami-views"]);
    dc(["up", "-d", "--wait", "pgbouncer", "umami"]);
  }
  const host = `127.0.0.1:${pgPort}`;
  const pgb = `127.0.0.1:${pgbPort}`;
  p.provide("pgSuperUrl", `postgres://postgres:wsg-test-super@${host}/scf`);
  p.provide("umamiSuperUrl", `postgres://postgres:wsg-test-super@${host}/umami`);
  p.provide("jobsUrl", `postgres://scf_jobs:wsg-test-jobs@${pgb}/scf`);
  p.provide("umamiRoUrl", `postgres://scf_umami_ro:wsg-test-umami-ro@${pgb}/umami`);
  p.provide("umamiMaintUrl", `postgres://scf_umami_maint:wsg-test-umami-maint@${pgb}/umami`);
  p.provide("umamiApi", `http://127.0.0.1:${umamiPort}`);
  return () => {
    if (process.env.KEEP !== "1" && process.env.SCF_WSG_REUSE !== "1") {
      dc(["down", "-v", "--remove-orphans"]);
    }
  };
}
