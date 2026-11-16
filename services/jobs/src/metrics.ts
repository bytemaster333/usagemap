// SPDX-License-Identifier: Apache-2.0
// A minimal Prometheus registry (text exposition format 0.0.4) without dependencies. Label values are job names,
// outcomes and fixed reason words only — never tenant, site or any value derived from analytics data
// (monitoring-plan D9: last success and duration per job).

type Labels = Record<string, string>;

const NAME_RE = /^[a-z_][a-z0-9_]*$/;
const LABEL_VALUE_RE = /^[a-z0-9_.-]{0,64}$/;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => {
      const v = labels[k] ?? "";
      if (!NAME_RE.test(k) || !LABEL_VALUE_RE.test(v)) throw new Error("invalid metric label");
      return `${k}="${v}"`;
    })
    .join(",");
}

interface Family {
  type: "counter" | "gauge";
  help: string;
  values: Map<string, number>;
}

export class Registry {
  readonly #families = new Map<string, Family>();

  #family(name: string, type: Family["type"], help: string): Family {
    if (!NAME_RE.test(name)) throw new Error("invalid metric name");
    let f = this.#families.get(name);
    if (!f) {
      f = { type, help, values: new Map() };
      this.#families.set(name, f);
    }
    return f;
  }

  counter(name: string, help: string) {
    const f = this.#family(name, "counter", help);
    return {
      inc: (labels: Labels = {}, by = 1): void => {
        if (!(by >= 0)) return;
        const k = key(labels);
        f.values.set(k, (f.values.get(k) ?? 0) + by);
      },
    };
  }

  gauge(name: string, help: string) {
    const f = this.#family(name, "gauge", help);
    return {
      set: (labels: Labels, v: number): void => {
        f.values.set(key(labels), v);
      },
      get: (labels: Labels): number | undefined => f.values.get(key(labels)),
    };
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, f] of [...this.#families].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${f.help.replace(/\n/g, " ")}`);
      lines.push(`# TYPE ${name} ${f.type}`);
      for (const [k, v] of f.values) lines.push(`${name}${k ? `{${k}}` : ""} ${v}`);
    }
    return `${lines.join("\n")}\n`;
  }
}

/** The metric families of this service. */
export function jobMetrics(reg: Registry) {
  return {
    runs: reg.counter(
      "scf_job_runs_total",
      "Job runs by outcome (success, failure, skipped_locked, aborted).",
    ),
    lastSuccess: reg.gauge(
      "scf_job_last_success_timestamp_seconds",
      "Unix time of the last successful run of the job.",
    ),
    lastDuration: reg.gauge("scf_job_last_duration_seconds", "Duration of the last finished run."),
    running: reg.gauge("scf_job_running", "1 while this instance runs the job."),
    units: reg.counter(
      "scf_job_units_total",
      "Units of work (per-tenant transactions, site-days) by job and outcome.",
    ),
    rows: reg.counter(
      "scf_job_rows_total",
      "Rows affected by job, relation and action (deleted, redacted, upserted).",
    ),
    partitions: reg.counter(
      "scf_job_partitions_total",
      "Partitions created or dropped by job partitions.",
    ),
    anomalies: reg.counter(
      "scf_job_anomalies_total",
      "Unexpected data seen by a job (e.g. Umami event types outside {1,2}), by reason.",
    ),
    audit: {
      broken: reg.gauge(
        "scf_audit_chain_problems",
        "Problems found by the last audit_verify run (C-63); alert when > 0.",
      ),
      rows: reg.gauge(
        "scf_audit_rows_verified",
        "Audit rows recomputed by the last audit_verify run.",
      ),
    },
    seal: {
      historyProblems: reg.gauge(
        "scf_seal_history_problems",
        "Problems found by the last seal history walk of job daily_seal, by network; alert when > 0.",
      ),
      historyDays: reg.gauge(
        "scf_seal_history_days_checked",
        "Confirmed seal days the last history walk found on the ledger, by network.",
      ),
    },
    onchain: {
      anchorMismatchDays: reg.gauge(
        "scf_onchain_anchor_mismatch_days",
        "Days the last onchain_correlation run refused because the ledger store's day anchor hash differs from Horizon's (C-144), by network; alert when > 0.",
      ),
      anchorUnverifiedDays: reg.gauge(
        "scf_onchain_anchor_unverified_days",
        "Complete days the last onchain_correlation run could not check against Horizon (unreachable or ledger not known), by network; retried next run.",
      ),
    },
    durability: {
      reports: reg.gauge(
        "scf_durability_reports",
        "durability_reports rows of the latest reconciled day by kind (node, canary) and status (C-76).",
      ),
      shortfall: reg.gauge(
        "scf_durability_shortfall_records",
        "Event records missing in rows with status loss for the latest reconciled day, by kind.",
      ),
      lastDay: reg.gauge(
        "scf_durability_last_day_timestamp_seconds",
        "Start (Unix time) of the latest UTC day job durability_reconcile reconciled.",
      ),
    },
  };
}

export type JobMetrics = ReturnType<typeof jobMetrics>;
