// SPDX-License-Identifier: Apache-2.0
// Dev/preview origins of a site (wire-formats §a.8; C-136, decision D8 amending ADR-0008; data-model §12.1). Events
// from these origins are accepted as the never-counted class `dev`. Grammar (the database checks it too):
//   - `localhost` or `127.0.0.1` (any port, http or https);
//   - an exact host (lower-case A-label, no port);
//   - a preview-host pattern with ONE `*` in its leftmost label (`myapp-*.vercel.app`, `*.preview.example.org`).
// The control plane adds the two rules the grammar cannot express:
//   - a wildcard label needs at least 3 literal characters around the `*`, unless the rest of the pattern is a host the
//     tenant has verified (or lies under one);
//   - a bare `*.` directly above a public suffix of the Public Suffix List (private section included: `*.vercel.app`,
//     `*.netlify.app`, `*.pages.dev`) is refused whatever is verified: it would admit every user of that host.

import { getPublicSuffix } from "tldts";
import { ApiError } from "../http/problem.ts";

export const MAX_DEV_ORIGINS = 10;
const MIN_WILDCARD_LITERALS = 3;

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const GRAMMAR = new RegExp(
  `^(localhost|127\\.0\\.0\\.1|([a-z0-9-]*\\*[a-z0-9-]*|${LABEL})(\\.${LABEL})+)$`,
);

export interface DevOriginProblem {
  index: number;
  detail: string;
}

/** True when `host` is itself a public suffix (ICANN or private section of the PSL). */
export function isPublicSuffix(host: string): boolean {
  return getPublicSuffix(`x.${host}`, { allowPrivateDomains: true }) === host;
}

function underVerified(host: string, verified: ReadonlySet<string>): boolean {
  for (const v of verified) if (host === v || host.endsWith(`.${v}`)) return true;
  return false;
}

/**
 * The problems of a dev-origin list (empty = accepted). `verifiedHosts` are the tenant's verified domain hosts
 * (lower-case A-labels).
 */
export function checkDevOrigins(
  list: readonly string[],
  verifiedHosts: ReadonlySet<string>,
): DevOriginProblem[] {
  const out: DevOriginProblem[] = [];
  if (list.length > MAX_DEV_ORIGINS)
    out.push({ index: MAX_DEV_ORIGINS, detail: `at most ${MAX_DEV_ORIGINS} dev origins` });
  const seen = new Set<string>();
  list.forEach((o, index) => {
    if (typeof o !== "string" || o.length === 0 || o.length > 253 || !GRAMMAR.test(o)) {
      out.push({
        index,
        detail:
          "must be localhost, 127.0.0.1, a lower-case host or a host with one * in its leftmost label",
      });
      return;
    }
    if (seen.has(o)) out.push({ index, detail: "listed twice" });
    seen.add(o);
    if (!o.includes("*")) return;
    const dot = o.indexOf(".");
    const label = o.slice(0, dot);
    const rest = o.slice(dot + 1);
    if (label === "*" && isPublicSuffix(rest)) {
      out.push({
        index,
        detail: `*.${rest} would admit every user of ${rest} (a public suffix); name your own preview host`,
      });
      return;
    }
    if (label.length - 1 < MIN_WILDCARD_LITERALS && !underVerified(rest, verifiedHosts)) {
      out.push({
        index,
        detail: `a wildcard label needs at least ${MIN_WILDCARD_LITERALS} literal characters unless ${rest} is a verified domain of this project`,
      });
    }
  });
  return out;
}

/** Throws `400 validation_failed` with one error per refused entry (pointer `/dev_origins/<i>`). */
export function assertDevOrigins(
  list: readonly string[],
  verifiedHosts: ReadonlySet<string>,
): void {
  const problems = checkDevOrigins(list, verifiedHosts);
  if (problems.length === 0) return;
  throw new ApiError("validation_failed", "dev_origins refused", {
    errors: problems.map((p) => ({ pointer: `/dev_origins/${p.index}`, detail: p.detail })),
  });
}
