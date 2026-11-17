// SPDX-License-Identifier: Apache-2.0
// ops.end-of-window-read-only: the aggregate-only export bundle for the no-successor case (scripts/export-aggregates.ts) against the real
// database: versioned manifest, per-file SHA-256 and row counts, only allow-listed tables and columns, the small-count
// floor on breakdowns and wallet-event counts, removed and canary tenants excluded, no event-level data.

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  exportAggregates,
  FILES,
  type Manifest,
} from "../../scripts/export-aggregates.ts";
import { type Harness, startHarness } from "../support/harness.ts";
import { type SeededProject, seedBreakdown, seedProject, seedWebDay } from "../support/op-seed.ts";

let h: Harness;
let A: SeededProject;
let R: SeededProject;
let C: SeededProject;
let dir: string;
let manifest: Manifest;
const D = "2026-10-07";
const umamiIds: string[] = [];

const lines = (file: string) =>
  readFileSync(join(dir, file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

beforeAll(async () => {
  h = await startHarness();
  A = await seedProject(h, { level: 1 });
  R = await seedProject(h, { level: 1 });
  C = await seedProject(h, { level: 1 });
  for (const p of [A, R, C]) {
    await seedWebDay(h, p, D, {
      pvVerified: 120,
      pvRaw: 150,
      visits: 60,
      bounces: 12,
      durationS: 900,
    });
    await seedBreakdown(h, p, D, "path", "/docs", 37, 80);
    await seedBreakdown(h, p, D, "country", "IS", 3, 3); // below k = 10: never exported
  }
  await h.su.query(
    `INSERT INTO scf.web_event_property_daily (tenant_id, site_id, day, event_name, network, prop_key, prop_value,
       verdict, count)
     VALUES ($1, $2, $3::date, 'wallet_connect', 'mainnet', 'wallet', 'freighter', 'verified', 42),
            ($1, $2, $3::date, 'wallet_connect', 'mainnet', 'wallet', 'xbull', 'verified', 2)`,
    [A.tenantId, A.siteId, D],
  );
  // R is removed by an operator, C is a synthetic canary: neither is exported (fixture writes, triggers off).
  const c = await h.su.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(
      `UPDATE scf.tenants SET status = 'removed', removed_at = now(), purge_after = now() + interval '30 days'
        WHERE tenant_id = $1`,
      [R.tenantId],
    );
    await c.query(`UPDATE scf.tenants SET is_canary = true WHERE tenant_id = $1`, [C.tenantId]);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const ids = await h.su.query<{ m: string; t: string | null }>(
    `SELECT umami_website_id::text AS m, umami_twin_website_id::text AS t FROM scf.sites`,
  );
  for (const r of ids.rows) umamiIds.push(r.m, ...(r.t ? [r.t] : []));

  dir = join(mkdtempSync(join(tmpdir(), "scf-export-")), "bundle");
  const client = new pg.Client({ connectionString: inject("pgSuperUrl") });
  await client.connect();
  try {
    manifest = await exportAggregates(client, dir, () => new Date("2027-01-01T00:00:00Z"));
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  if (dir) rmSync(join(dir, ".."), { recursive: true, force: true });
  await h?.close();
});

describe("aggregate-only export (ops.end-of-window-read-only)", () => {
  it("writes a versioned manifest whose hashes and row counts match the files", () => {
    expect(manifest.format).toBe(EXPORT_FORMAT);
    expect(manifest.version).toBe(EXPORT_VERSION);
    expect(manifest.generated_at).toBe("2027-01-01T00:00:00.000Z");
    expect(manifest.privacy.event_level_data).toBe(false);
    expect(manifest.privacy.min_count).toBe(10);
    const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(onDisk).toEqual(manifest);
    expect(readdirSync(dir).sort()).toEqual(["manifest.json", ...FILES.map((f) => f.file)].sort());
    for (const f of manifest.files) {
      const bytes = readFileSync(join(dir, f.name));
      expect(createHash("sha256").update(bytes).digest("hex"), f.name).toBe(f.sha256);
      expect(bytes.length).toBe(f.bytes);
      expect(lines(f.name)).toHaveLength(f.rows);
      // Every row has exactly the documented columns, in order.
      for (const row of lines(f.name))
        expect(Object.keys(row)).toEqual(f.columns.map((c) => c.name));
    }
  });

  it("contains the project's aggregates with exact totals", () => {
    expect(lines("tenants.jsonl").find((t) => t.tenant_id === A.tenantId)).toMatchObject({
      slug: A.slug,
      status: "active",
    });
    const day = lines("web_daily_totals.jsonl").find((r) => r.tenant_id === A.tenantId);
    expect(day).toMatchObject({
      site_id: A.siteId,
      day: D,
      pageviews_verified: 120,
      pageviews_raw: 150,
      visits: 60,
      bounces: 12,
      total_duration_s: 900,
      is_final: true,
    });
  });

  it("applies the small-count floor to breakdowns and wallet-event counts", () => {
    const rows = lines("web_daily_breakdowns.jsonl").filter((r) => r.tenant_id === A.tenantId);
    expect(rows).toEqual([
      expect.objectContaining({ dimension: "path", value: "/docs", visitors: 40, pageviews: 80 }),
    ]);
    const wallets = lines("web_wallet_events_daily.jsonl").filter(
      (r) => r.tenant_id === A.tenantId,
    );
    expect(wallets.map((r) => [r.prop_value, r.count])).toEqual([["freighter", 42]]);
  });

  it("excludes removed and canary tenants entirely", () => {
    const all = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    for (const p of [R, C]) {
      expect(all).not.toContain(p.tenantId);
      expect(all).not.toContain(p.siteId);
    }
  });

  it("never contains event-level data, engine identifiers, people or secrets", () => {
    const all = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    for (const id of umamiIds) expect(all).not.toContain(id);
    const columns = manifest.files.flatMap((f) => f.columns.map((c) => c.name));
    for (const banned of [
      "umami_website_id",
      "site_key",
      "created_by",
      "user_id",
      "email",
      "ip",
      "user_agent",
      "session_id",
      "query",
      "title",
      "ciphertext",
      "secret_hash",
      "token",
    ])
      expect(columns).not.toContain(banned);
    for (const f of manifest.files)
      expect(f.name).not.toMatch(
        /umami|website_event|session|dev_events|spool|audit|users|members|keys|token/,
      );
    // No end-user wallet address (G…) anywhere; contract ids (C…) of the projects are allowed.
    expect(all).not.toMatch(/\bG[A-Z2-7]{55}\b/);
  });

  it("refuses an output directory that is not empty and a role that is subject to row-level security", async () => {
    const su = new pg.Client({ connectionString: inject("pgSuperUrl") });
    await su.connect();
    try {
      await expect(exportAggregates(su, dir)).rejects.toThrow(/not empty/);
    } finally {
      await su.end();
    }
    const app = new pg.Client({ connectionString: inject("pgAppUrl") });
    await app.connect();
    try {
      await expect(exportAggregates(app, join(dir, "..", `x-${randomUUID()}`))).rejects.toThrow(
        /bypass row-level security/,
      );
    } finally {
      await app.end();
    }
  });

  it("runs as a command line tool", () => {
    const out = join(dir, "..", "cli");
    const stdout = execFileSync(
      process.execPath,
      [join(import.meta.dirname, "..", "..", "scripts", "export-aggregates.ts"), "--out", out],
      { env: { ...process.env, SCF_EXPORT_DATABASE_URL: inject("pgSuperUrl") }, encoding: "utf8" },
    );
    expect(stdout).toContain(`manifest.json\t${EXPORT_FORMAT} ${EXPORT_VERSION}`);
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as Manifest;
    expect(m.files.map((f) => f.name)).toEqual(FILES.map((f) => f.file));
  });
});
