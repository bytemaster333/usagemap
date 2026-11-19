// SPDX-License-Identifier: Apache-2.0
// Runs SQL as the database superuser inside the Compose project's PostgreSQL container — the same path the portal's
// real-stack test uses for test set-up (apps/portal/e2e/real/api-operator.spec.ts). The password is read inside the
// container from its Docker secret (or the server's own POSTGRES_PASSWORD of a throwaway test container) and never passes through this process, its arguments or its environment.

import { execFileSync } from "node:child_process";

export function postgresContainer(project: string): string {
  const id = execFileSync(
    "docker",
    [
      "ps",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--filter",
      "label=com.docker.compose.service=postgres",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")[0];
  if (!id)
    throw new Error(
      `no running postgres container in Compose project "${project}" (use --project)`,
    );
  return id;
}

export function psql(container: string, database: string, sql: string, tuples = false): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "sh",
      "-c",
      `PGPASSWORD="$(cat /run/secrets/pg_superuser_password 2>/dev/null || printf %s "$POSTGRES_PASSWORD")" exec psql -h 127.0.0.1 -U postgres -d ${database} -v ON_ERROR_STOP=1 -q -X ${tuples ? "-tA -F '\t'" : ""} -f -`,
    ],
    {
      input: sql,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"],
    },
  ).trim();
}
