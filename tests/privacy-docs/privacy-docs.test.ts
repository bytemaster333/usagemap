// SPDX-License-Identifier: Apache-2.0
// privacy.strategy-docs: docs/privacy/data-inventory.md against the implementation — table-driven over CLAIMS (claims.ts), against
// a database migrated with every migration (global-setup.ts) and the repository's sources and configuration. The
// second half proves the suite fails on drift: each mutation of the document or of the implementation facts must make
// the named claim fail. SCF_DATA_INVENTORY points the suite at another copy of the document.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CLAIMS, type Claim, outcome } from "./claims.ts";
import { composeDb, type Facts, gatherFacts, ROOT } from "./facts.ts";
import { COMPOSE_FILE, PROJECT } from "./global-setup.ts";
import { cell, type Inventory, parseDuration, parseInventory, row } from "./inventory.ts";

const DOC_PATH = process.env.SCF_DATA_INVENTORY ?? join(ROOT, "docs/privacy/data-inventory.md");

let docText = "";
let inv: Inventory;
let facts: Facts;

beforeAll(() => {
  docText = readFileSync(DOC_PATH, "utf8");
  inv = parseInventory(docText);
  facts = gatherFacts(composeDb(PROJECT, COMPOSE_FILE));
});

describe("data-inventory parser", () => {
  const md = [
    "Legend — EW = **90 days by default**.",
    "## 1. Things",
    "| Field | Where it exists | Stored? |",
    "|---|---|---|",
    "| `a` thing | spool, umami | **Yes** |",
    "| b | mem | No |",
    "",
    "## 8. Fields we explicitly never collect",
    "- IP addresses in any",
    "  stored form.",
    "- Titles.",
  ].join("\n");
  it("reads rows by section and first cell, columns by prefix, bullets with continuation lines", () => {
    const p = parseInventory(md);
    expect(p.legend).toContain("90 days by default");
    expect(cell(row(p, 1, /^a thing/), "Where")).toBe("spool, umami");
    expect(cell(row(p, 1, /^a thing/), "Stored")).toBe("Yes");
    expect(p.neverCollected).toEqual(["IP addresses in any stored form.", "Titles."]);
  });
  it("fails on a missing row, an ambiguous row, a missing column or a ragged row", () => {
    const p = parseInventory(md);
    expect(() => row(p, 1, /^c/)).toThrow(/0 rows/);
    expect(() => row(p, 1, /./)).toThrow(/2 rows/);
    expect(() => cell(row(p, 1, /^b/), "Retention")).toThrow(/no column/);
    expect(() => parseInventory(md.replace("| b | mem | No |", "| b | mem |"))).toThrow(/cells/);
  });
  it("normalises durations", () => {
    expect(parseDuration("25 mo")).toEqual({ months: 25, days: 0, minutes: 0 });
    expect(parseDuration("72 h")).toEqual({ months: 0, days: 3, minutes: 0 });
    expect(parseDuration("12 h")).toEqual({ months: 0, days: 0, minutes: 720 });
    expect(parseDuration("life of the service")).toBe("indefinite");
    expect(() => parseDuration("forever-ish")).toThrow();
  });
});

describe("implementation facts", () => {
  it("were read from the migrated database and the sources", () => {
    expect(Object.keys(facts.retention).length).toBeGreaterThan(10);
    expect(facts.columns.length).toBeGreaterThan(200);
    expect(facts.spool.EventRecord?.length).toBeGreaterThan(15);
    expect(facts.collectorKeys.length).toBeGreaterThan(10);
    expect(facts.ewAccepted).toContain(90);
  });
});

describe("data-inventory claims hold (privacy.strategy-docs)", () => {
  it.each(CLAIMS.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const why = outcome(c, inv, facts);
    expect(why, `${c.claim} — implementation: ${c.source}`).toBeNull();
  });
});

// --- the suite fails on drift ---------------------------------------------------------------------------------------

const claim = (id: string): Claim => {
  const c = CLAIMS.find((x) => x.id === id);
  if (!c) throw new Error(`no claim ${id}`);
  return c;
};

const clone = (f: Facts): Facts => structuredClone(f);

const DOC_MUTATIONS: Array<{ id: string; from: RegExp; to: string }> = [
  { id: "RET-writer-ledger", from: /\| 7 days \(C-18\) \|/, to: "| 14 days (C-18) |" },
  { id: "RET-api-1m", from: /1-min 35 d/, to: "1-min 90 d" },
  { id: "RET-web-hourly", from: /hourly rows 25 months/, to: "hourly rows 13 months" },
  { id: "RET-erasure-selector", from: /plus 56 days/, to: "plus 30 days" },
  { id: "RET-ew", from: /90 days by/, to: "180 days by" },
  { id: "SPOOL-72h", from: /never older than 72 hours/, to: "never older than 96 hours" },
  { id: "SESSION-timeouts", from: /absolute 14 days/, to: "absolute 30 days" },
  { id: "OPKEY-expiry", from: /at most 365 days/, to: "at most 730 days" },
  {
    id: "LOGS-30d",
    from: /\| Service logs \(errors, job results\) \|([^\n]*)\| 30 days/,
    to: "| Service logs (errors, job results) |$1| 90 days",
  },
  { id: "HASH-only", from: /\| Hash only \| life of token/, to: "| Yes | life of token" },
  { id: "OTEL-logs-refused", from: /\*\*Refused\*\*/, to: "Accepted" },
  { id: "NEVER-columns", from: /- Page titles/, to: "- Page headings" },
];

const FACT_MUTATIONS: Array<{ id: string; mutate: (f: Facts) => void }> = [
  {
    id: "RET-writer-ledger",
    mutate: (f) => {
      (f.retention.api_ingest_ledger as { days: number }).days = 30;
    },
  },
  {
    id: "RET-api-1d",
    mutate: (f) => {
      f.retention.api_metrics_1d = {
        months: 25,
        days: 0,
        mechanism: "partition_drop",
        age_expr: "bucket_start",
      };
    },
  },
  {
    id: "RET-audit",
    mutate: (f) => {
      f.retention.audit_log = {
        months: 0,
        days: 365,
        mechanism: "delete",
        age_expr: "t.occurred_at",
      };
    },
  },
  {
    id: "RET-ew",
    mutate: (f) => {
      f.ewAccepted.push(500);
    },
  },
  {
    id: "NEVER-columns",
    mutate: (f) => {
      f.columns.push("web_daily_totals.client_ip");
    },
  },
  {
    id: "NEVER-columns",
    mutate: (f) => {
      f.columns.push("web_daily_breakdowns.page_title");
    },
  },
  {
    id: "NEVER-columns",
    mutate: (f) => {
      f.columns.push("sites.ua_raw");
    },
  },
  {
    id: "HASH-only",
    mutate: (f) => {
      f.columns.push("ingest_tokens.token");
    },
  },
  {
    id: "INSTANCE-not-dimension",
    mutate: (f) => {
      f.columns.push("api_metrics_1m.service_instance");
    },
  },
  {
    id: "SPOOL-event-fields",
    mutate: (f) => {
      f.spool.EventRecord?.push("ip");
    },
  },
  {
    id: "SPOOL-counter-fields",
    mutate: (f) => {
      f.spool.WebCounter?.push("subnet");
    },
  },
  {
    id: "OTEL-allow-list",
    mutate: (f) => {
      f.collectorKeys.push("client.address");
    },
  },
  {
    id: "OTEL-logs-refused",
    mutate: (f) => {
      f.collectorPipelines.push("logs");
    },
  },
  {
    id: "OTEL-logs-refused",
    mutate: (f) => {
      f.collectorProtoFields.push("exemplars");
    },
  },
  {
    id: "SPOOL-72h",
    mutate: (f) => {
      f.spoolExpiryHours = 96;
    },
  },
  {
    id: "QUEUE-72h",
    mutate: (f) => {
      f.writerMaxReceiptAgeHours = 48;
    },
  },
  {
    id: "SESSION-timeouts",
    mutate: (f) => {
      f.sessionTimeoutsMinutes.operator.idle = 60;
    },
  },
  {
    id: "BACKUP-windows",
    mutate: (f) => {
      f.previousVersionDays = [30, 30];
    },
  },
  {
    id: "PROM-13mo",
    mutate: (f) => {
      f.prometheusRetention = "90d";
    },
  },
];

describe("drift fails the suite", () => {
  it.each(DOC_MUTATIONS.map((m) => [m.id, m.from.source, m] as const))(
    "document change breaks %s (%s)",
    (_id, _src, m) => {
      expect(m.from.test(docText), `mutation anchor ${m.from} must exist in the document`).toBe(
        true,
      );
      const c = claim(m.id);
      const before = outcome(c, inv, facts);
      const after = outcome(c, parseInventory(docText.replace(m.from, m.to)), facts);
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
    },
  );
  it.each(FACT_MUTATIONS.map((m, i) => [m.id, i, m] as const))(
    "implementation change breaks %s (#%i)",
    (_id, _i, m) => {
      const c = claim(m.id);
      const f = clone(facts);
      m.mutate(f);
      const after = outcome(c, inv, f);
      expect(after).not.toBeNull();
      expect(after).not.toBe(outcome(c, inv, facts));
    },
  );
  it("a removed row fails every claim that reads it", () => {
    const cut = docText.replace(/^\| Writer de-duplication ledger.*\n/m, "");
    expect(outcome(claim("RET-writer-ledger"), parseInventory(cut), facts)).toMatch(/0 rows match/);
  });
});
