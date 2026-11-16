// SPDX-License-Identifier: Apache-2.0
// Prometheus metrics of the control plane (`scf_cp_*`, docs/monitoring-plan.md §4.4, ops/alerts/coverage.json), served
// on a separate listener that is never the public one (SCF_METRICS_LISTEN_HOST / SCF_METRICS_PORT).
//
// Privacy: label values are fixed words from closed sets (methods, outcomes, kinds, route classes); the only
// per-person label is `operator_ref` of scf_cp_operator_reads_total — a pseudonym (first 12 hex digits of SHA-256 over
// a fixed label and the operator's user id), never a name, address or e-mail. Unknown label values are mapped to
// `other`, so a caller can never add a series.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

type Labels = Record<string, string>;

interface Family {
  help: string;
  type: "counter" | "gauge";
  series: Map<string, { labels: Labels; value: number }>;
}

const AUTH_METHODS = new Set(["github", "stellar", "passkey"]);
const AUTH_OUTCOMES = new Set([
  "success",
  "failed",
  "passkey_failed",
  "passkey_registered",
  "step_up_failed",
  "recovery",
  "break_glass",
]);
const OP_KEY_KINDS = new Set([
  "bad_checksum",
  "key_in_url",
  "rate_limited",
  "invalid",
  "revoked",
  "expired",
  "accepted",
]);
const ROUTE_CLASSES = new Set(["auth", "create", "op_key", "other"]);
const LIVE_REASONS = new Set([
  "not_provisioned",
  "key_unavailable",
  "unauthorized",
  "timeout",
  "engine_error",
]);
const BLOCKED_CLASSES = new Set(["private", "loopback", "own", "other"]);

function pick(v: string, allowed: Set<string>): string {
  return allowed.has(v) ? v : "other";
}

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export class MetricsRegistry {
  readonly #families = new Map<string, Family>();
  readonly #collectors: Array<() => Promise<void>> = [];

  #family(name: string, help: string, type: Family["type"]): Family {
    let f = this.#families.get(name);
    if (!f) {
      f = { help, type, series: new Map() };
      this.#families.set(name, f);
    }
    return f;
  }

  /** Declares a family so that it is exported (with 0 for label-less counters) before the first event. */
  declare(name: string, help: string, type: Family["type"], zero = true): void {
    const f = this.#family(name, help, type);
    if (zero && f.series.size === 0) f.series.set("", { labels: {}, value: 0 });
  }

  inc(name: string, help: string, labels: Labels = {}, by = 1): void {
    const f = this.#family(name, help, "counter");
    const key = JSON.stringify(labels);
    if (Object.keys(labels).length > 0) f.series.delete("");
    const s = f.series.get(key) ?? { labels, value: 0 };
    s.value += by;
    f.series.set(key, s);
  }

  set(name: string, help: string, value: number, labels: Labels = {}): void {
    const f = this.#family(name, help, "gauge");
    f.series.set(JSON.stringify(labels), { labels, value });
  }

  /** A callback run before every scrape (e.g. a gauge read from the database); its failure is not fatal. */
  onCollect(fn: () => Promise<void>): void {
    this.#collectors.push(fn);
  }

  async render(): Promise<string> {
    await Promise.allSettled(this.#collectors.map((c) => c()));
    const out: string[] = [];
    for (const [name, f] of [...this.#families].sort(([a], [b]) => a.localeCompare(b))) {
      out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`);
      for (const s of f.series.values()) {
        const l = Object.entries(s.labels)
          .map(([k, v]) => `${k}="${esc(v)}"`)
          .join(",");
        out.push(`${name}${l ? `{${l}}` : ""} ${Number.isFinite(s.value) ? s.value : 0}`);
      }
    }
    return `${out.join("\n")}\n`;
  }

  /** Test helper: current value of one series (0 when absent). */
  value(name: string, labels: Labels = {}): number {
    return this.#families.get(name)?.series.get(JSON.stringify(labels))?.value ?? 0;
  }
}

/** The control plane's metrics: typed recorders over one registry. */
export class CpMetrics {
  readonly registry: MetricsRegistry;

  constructor(registry = new MetricsRegistry()) {
    this.registry = registry;
    registry.declare("scf_cp_signups_total", "New accounts created by a first sign-in", "counter");
    registry.declare(
      "scf_cp_op_key_accepted_after_revocation_total",
      "SCF-operator API key requests accepted later than the cache bound after the key's revocation (must stay 0)",
      "counter",
    );
    registry.declare(
      "scf_cp_auth_events_total",
      "Sign-in, passkey and step-up outcomes by method",
      "counter",
      false,
    );
    registry.declare(
      "scf_cp_rate_limited_total",
      "Requests refused by a rate limit, by route class",
      "counter",
      false,
    );
    registry.declare(
      "scf_cp_op_key_events_total",
      "SCF-operator API key events by kind",
      "counter",
      false,
    );
    registry.declare(
      "scf_cp_operator_reads_total",
      "Reads by SCF operators, by pseudonymous operator reference",
      "counter",
      false,
    );
    registry.declare(
      "scf_cp_verifier_blocked_targets_total",
      "Verifier connections refused because the target address is not public, by class",
      "counter",
      false,
    );
    registry.declare(
      "scf_cp_web_live_fallbacks_total",
      "Web analytics live-window reads answered from the rollups instead, by reason",
      "counter",
      false,
    );
  }

  /** Site ↔ engine-website mismatches after the last umami_reconcile pass (plan C1 #12; alert when non-zero). */
  umamiSiteDrift(d: { orphan: number; missing: number; misplaced: number }): void {
    for (const [kind, v] of Object.entries(d))
      this.registry.set(
        "scf_cp_umami_site_drift",
        "Portal sites and Umami websites that do not match after the last reconcile pass, by kind (orphan: engine website no site references; missing: site whose website is absent; misplaced: website outside the tenant team)",
        v,
        { kind },
      );
  }

  auth(method: string, outcome: string): void {
    this.registry.inc("scf_cp_auth_events_total", "", {
      method: pick(method, AUTH_METHODS),
      outcome: pick(outcome, AUTH_OUTCOMES),
    });
  }

  signup(): void {
    this.registry.inc("scf_cp_signups_total", "");
  }

  rateLimited(routeClass: string): void {
    this.registry.inc("scf_cp_rate_limited_total", "", {
      route_class: pick(routeClass, ROUTE_CLASSES),
    });
  }

  opKey(kind: string): void {
    this.registry.inc("scf_cp_op_key_events_total", "", { kind: pick(kind, OP_KEY_KINDS) });
  }

  opKeyAcceptedAfterRevocation(): void {
    this.registry.inc("scf_cp_op_key_accepted_after_revocation_total", "");
  }

  operatorRead(userId: string): void {
    this.registry.inc("scf_cp_operator_reads_total", "", { operator_ref: operatorRef(userId) });
  }

  verifierBlocked(cls: string): void {
    this.registry.inc("scf_cp_verifier_blocked_targets_total", "", {
      class: pick(cls, BLOCKED_CLASSES),
    });
  }

  liveFallback(reason: string): void {
    this.registry.inc("scf_cp_web_live_fallbacks_total", "", {
      reason: pick(reason, LIVE_REASONS),
    });
  }
}

/** Pseudonymous, stable operator reference for metric labels (never the id itself). */
export function operatorRef(userId: string): string {
  return createHash("sha256")
    .update("scf-operator-ref/1\0")
    .update(userId)
    .digest("hex")
    .slice(0, 12);
}

/** Route class of an operation for scf_cp_rate_limited_total. */
export function routeClassOf(operationId: string): string {
  if (operationId.startsWith("auth")) return "auth";
  if (
    operationId === "createTenant" ||
    operationId === "createSite" ||
    operationId === "createService"
  )
    return "create";
  return "other";
}

/** The process-wide instance (one control plane per process). */
export const cpMetrics = new CpMetrics();

/** GET /metrics (Prometheus text format 0.0.4) and nothing else. */
export function createMetricsServer(registry: MetricsRegistry): Server {
  return createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/metrics") {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
      return;
    }
    registry.render().then(
      (body) =>
        res
          .writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
          .end(body),
      () => res.writeHead(500, { "content-type": "text/plain" }).end("error\n"),
    );
  });
}
