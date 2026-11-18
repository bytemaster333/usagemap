// SPDX-License-Identifier: Apache-2.0
// usagemap-op: the SCF operator's command line over the UsageMap operator APIs. Node standard library only.
// Run through tools/usagemap-op/run; usage below (`run help`). Guide: docs/guides/first-projects.md.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  ApiError,
  loadOperatorKey,
  loadSession,
  OpClient,
  permissionWarning,
  redact,
} from "./src/client.ts";
import {
  coverage,
  enrolOnBehalf,
  type Io,
  invite,
  link,
  projectsList,
  projectsShow,
  remove,
  STATUSES,
} from "./src/commands.ts";
import { diffFingerprints, parseFingerprint, renderDiff } from "./src/fingerprint.ts";

export const USAGE = `usagemap-op — SCF-operator command line for UsageMap (docs/guides/first-projects.md)

  projects list [--status S] [--q TEXT]   SCF-awarded registry projects with onboarding status
  projects show <registry-id>             one registry project: status, tenants, links, invite link
  coverage [--list] [--status S]          not enrolled / enrolled / verified / measuring counts
  invite <registry-id> [--message]        print the invite link (never sends anything)
  invite --search TEXT                    find a project in the public registry and print invite links (no credential)
  enrol-on-behalf                         explains why there is no API for it and the supported path (exit 3)
  link <tenant-id|slug> <registry-id> --confirm|--reject [--yes]   decide a registry match (dry run without --yes)
  remove <tenant-id|slug> --reason TEXT [--yes]   remove a tenant (dry run without --yes)
  adoption-report [args…]                 adoption report (tools/adoption-report; args passed through)
  verify-migration <fingerprint-a> <fingerprint-b>   diff two handover fingerprints (tests/handover/fingerprint.sh)

Options
  --api URL            base URL (default $USAGEMAP_API_URL or https://app.usagemap.dev)
  --key-file FILE      SCF-operator API key scfa_op_… for /op/v1 (default $USAGEMAP_OPERATOR_KEY_FILE)
  --session-file FILE  SCF-operator portal session (the __Host-scf_session cookie value) for /v1/operator
                       (default $USAGEMAP_SESSION_FILE); coverage, status and remove need it
  --portal-origin URL  Origin sent on state-changing session calls (default: the base URL's origin)
  --measuring-days N   window for "measuring" (1–90, default 7)
  --json               machine-readable output

Credentials are read from files and never printed. Exit: 0 ok · 1 not found / differs · 2 usage or API error ·
3 not available through an API.
`;

export interface Env {
  [k: string]: string | undefined;
}

export async function main(
  argv: string[],
  env: Env,
  io: Io,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    io.out(USAGE);
    return cmd ? 0 : 2;
  }
  if (cmd === "adoption-report") return adoptionReport(rest, env);
  if (cmd === "enrol-on-behalf" || cmd === "enroll-on-behalf") return enrolOnBehalf(io);

  const { values: a, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      api: { type: "string" },
      "key-file": { type: "string" },
      "session-file": { type: "string" },
      "portal-origin": { type: "string" },
      "measuring-days": { type: "string" },
      status: { type: "string" },
      q: { type: "string" },
      search: { type: "string" },
      reason: { type: "string" },
      list: { type: "boolean", default: false },
      message: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      confirm: { type: "boolean", default: false },
      reject: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      max: { type: "string" },
    },
  });

  if (cmd === "verify-migration") {
    const [fa, fb] = positionals;
    if (!fa || !fb || positionals.length !== 2)
      throw new ApiError(0, "verify-migration takes two fingerprint files");
    const d = diffFingerprints(
      parseFingerprint(readFileSync(fa, "utf8"), fa),
      parseFingerprint(readFileSync(fb, "utf8"), fb),
    );
    io.out(
      a.json
        ? `${JSON.stringify(d, null, 2)}\n`
        : renderDiff(d, { a: fa, b: fb }, a.max ? Number(a.max) : 50),
    );
    return d.equal ? 0 : 1;
  }

  const measuringDays = a["measuring-days"] === undefined ? undefined : Number(a["measuring-days"]);
  if (
    measuringDays !== undefined &&
    (!Number.isInteger(measuringDays) || measuringDays < 1 || measuringDays > 90)
  )
    throw new ApiError(0, "--measuring-days must be an integer 1–90");
  if (a.status !== undefined && !(STATUSES as string[]).includes(a.status))
    throw new ApiError(0, `--status must be one of ${STATUSES.join(", ")}`);

  const keyFile = a["key-file"] ?? env.USAGEMAP_OPERATOR_KEY_FILE;
  const sessionFile = a["session-file"] ?? env.USAGEMAP_SESSION_FILE;
  for (const f of [keyFile, sessionFile]) {
    const w = f ? permissionWarning(f) : null;
    if (w) io.err(`${w}\n`);
  }
  const c = new OpClient({
    baseUrl: a.api ?? env.USAGEMAP_API_URL ?? "https://app.usagemap.dev",
    key: keyFile ? loadOperatorKey(keyFile) : undefined,
    session: sessionFile ? loadSession(sessionFile) : undefined,
    portalOrigin: a["portal-origin"],
    fetch: fetchImpl,
  });
  const json = a.json;

  switch (cmd) {
    case "projects": {
      const [sub, id, ...more] = positionals;
      if (more.length) throw new ApiError(0, "too many arguments");
      if (sub === "list" && !id)
        return projectsList(c, io, { json, status: a.status, q: a.q, measuringDays });
      if (sub === "show" && id) return projectsShow(c, io, { json, id, measuringDays });
      throw new ApiError(0, "usage: projects list | projects show <registry-id>");
    }
    case "coverage":
      if (positionals.length) throw new ApiError(0, "coverage takes no arguments");
      return coverage(c, io, { json, list: a.list, status: a.status, measuringDays });
    case "invite":
      if (positionals.length > 1 || (a.search !== undefined && positionals.length))
        throw new ApiError(0, "usage: invite <registry-id> | invite --search TEXT");
      return invite(c, io, { json, id: positionals[0], search: a.search, message: a.message });
    case "remove": {
      const [tenant] = positionals;
      if (!tenant || positionals.length !== 1)
        throw new ApiError(0, "usage: remove <tenant-id|slug> --reason TEXT [--yes]");
      return remove(c, io, { json, tenant, reason: a.reason, yes: a.yes });
    }
    case "link": {
      const [tenant, registryId] = positionals;
      if (!tenant || !registryId || positionals.length !== 2 || (a.confirm && a.reject))
        throw new ApiError(
          0,
          "usage: link <tenant-id|slug> <registry-id> --confirm|--reject [--yes]",
        );
      const decision = a.confirm ? "confirm" : a.reject ? "reject" : undefined;
      return link(c, io, { json, tenant, registryId, decision, yes: a.yes });
    }
    default:
      throw new ApiError(0, `unknown command ${cmd} (run help)`);
  }
}

/** Runs tools/adoption-report with the CLI's defaults for --api and --operator-key-file (when not given). */
export function adoptionReportArgs(rest: string[], env: Env): string[] {
  const args = [...rest];
  const has = (f: string) => args.some((x) => x === f || x.startsWith(`${f}=`));
  // --key-file is this CLI's name for the report's --operator-key-file
  const i = args.findIndex((x) => x === "--key-file" || x.startsWith("--key-file="));
  if (i >= 0) {
    const x = args[i] as string;
    if (x.includes("=")) args[i] = `--operator-key-file=${x.slice("--key-file=".length)}`;
    else args[i] = "--operator-key-file";
  }
  if (!has("--api") && env.USAGEMAP_API_URL) args.push("--api", env.USAGEMAP_API_URL);
  if (!has("--operator-key-file") && !has("--fixtures") && env.USAGEMAP_OPERATOR_KEY_FILE)
    args.push("--operator-key-file", env.USAGEMAP_OPERATOR_KEY_FILE);
  return args;
}

function adoptionReport(rest: string[], env: Env): Promise<number> {
  const script = join(import.meta.dirname, "..", "adoption-report", "report.ts");
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...adoptionReportArgs(rest, env)], {
      stdio: "inherit",
    });
    p.on("exit", (code) => resolve(code ?? 2));
    p.on("error", () => resolve(2));
  });
}

if (import.meta.main) {
  const io: Io = {
    out: (s) => process.stdout.write(redact(s)),
    err: (s) => process.stderr.write(redact(s)),
  };
  main(process.argv.slice(2), process.env, io).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      io.err(`usagemap-op: ${redact(e instanceof Error ? e.message : String(e))}\n`);
      process.exitCode = 2;
    },
  );
}
