// SPDX-License-Identifier: Apache-2.0
// The bridge to the control plane's former in-process workers (F16): their pino-style log calls pass this service's
// redaction, and without SCF_JOBS_DATABASE_URL-derived configuration nothing starts.

import { describe, expect, it } from "vitest";
import { workerLog, workerMetricsText } from "../../src/core-workers.ts";
import { createLogger } from "../../src/log.ts";

describe("core workers bridge", () => {
  it("maps (obj, msg) to (event, fields) and redacts values and error messages", () => {
    const lines: string[] = [];
    const log = workerLog(createLogger({}, (l) => lines.push(l)));
    log.info({ sequence: 7 }, "edge snapshot issued");
    log.error(
      {
        tenant: "0193b7e2-0000-7000-8000-000000000001",
        err: new Error("host 203.0.113.9 said no"),
      },
      "traction snapshot signing failed",
    );
    log.warn({ url: "https://example.org/?q=1", ip: "203.0.113.9" }, "x");
    const all = lines.map((l) => JSON.parse(l));
    expect(all[0]).toMatchObject({ event: "edge_snapshot_issued", sequence: 7 });
    expect(all[1]).toMatchObject({
      event: "traction_snapshot_signing_failed",
      error_class: "Error",
    });
    expect(lines.join("\n")).not.toMatch(/203\.0\.113\.9|example\.org|said no/);
  });

  it("exports only the verifier's refused-target counter from the control-plane module metrics", async () => {
    const text = await workerMetricsText();
    expect(text).not.toMatch(/scf_cp_signups_total|scf_cp_auth_events_total/);
  });
});
