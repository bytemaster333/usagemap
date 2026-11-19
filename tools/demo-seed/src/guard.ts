// SPDX-License-Identifier: Apache-2.0
// Guards of the demo seed. The seed writes straight into the database as its superuser, grants the
// operator role and derives keys from a phrase; on a deployed stack that would hand out access. So:
//   - it runs only against a LOCAL stack: the portal origin is a loopback address, and the PostgreSQL container was
//     started with the development overlay `infra/compose/compose.dev.yaml` (C-139: every local launcher adds it, no
//     deployment loads it) — or, for a throwaway container, carries the label `scf.local-stack=1`;
//   - the demo operator's key is never derived from a public phrase: it comes from a separate secret
//     (`--operator-secret` / SCF_DEMO_OPERATOR_SECRET, at least 16 characters), or a random one printed once.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export class SeedGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedGuardError";
  }
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** Whether the portal origin is on this machine (localhost, 127.0.0.0/8, ::1). */
export function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || LOOPBACK_V4.test(h) || h === "[::1]";
}

/** Whether a container's labels say it belongs to a local stack (dev overlay or explicit label). */
export function isLocalStackLabels(labels: Record<string, string> | null | undefined): boolean {
  if (!labels) return false;
  if (labels["scf.local-stack"] === "1") return true;
  const files = labels["com.docker.compose.project.config_files"] ?? "";
  return files
    .split(",")
    .map((f) => f.trim())
    .some((f) => /(^|\/)compose\.dev\.ya?ml$/.test(f));
}

export function containerLabels(container: string): Record<string, string> | null {
  const out = execFileSync(
    "docker",
    ["inspect", "--format", "{{json .Config.Labels}}", container],
    { encoding: "utf8" },
  ).trim();
  return JSON.parse(out) as Record<string, string> | null;
}

/** Refuses anything but a local stack (see the header). `portal` null: no portal is contacted (db mode). */
export function assertLocalStack(o: {
  portal: string | null;
  labels: Record<string, string> | null;
}): void {
  if (o.portal !== null && !isLoopbackOrigin(o.portal))
    throw new SeedGuardError(
      `refusing to seed ${o.portal}: the demo seed is for a local stack only (a loopback portal origin)`,
    );
  if (!isLocalStackLabels(o.labels))
    throw new SeedGuardError(
      "refusing to seed: the PostgreSQL container is not part of a local stack (started without " +
        "infra/compose/compose.dev.yaml, and without the label scf.local-stack=1)",
    );
}

export const MIN_OPERATOR_SECRET = 16;

/** The demo operator's secret: the given one (checked), or a fresh random one (`generated`). */
export function operatorSecret(
  given: string | undefined,
  publicPhrase: string,
): { secret: string; generated: boolean } {
  if (given === undefined || given === "")
    return { secret: randomBytes(24).toString("base64url"), generated: true };
  if (given.length < MIN_OPERATOR_SECRET)
    throw new SeedGuardError(
      `the operator secret must have at least ${MIN_OPERATOR_SECRET} characters`,
    );
  if (given === publicPhrase)
    throw new SeedGuardError("the operator secret must not be the (public) demo phrase");
  return { secret: given, generated: false };
}
