// SPDX-License-Identifier: Apache-2.0
// C-124 reason texts and the traction-snapshot create answer (201 signed / 202 pending, F16).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REASON_TEXT } from "../../src/pages/Installation.tsx";
import { isPending } from "../../src/pages/TractionSnapshots.tsx";

describe("installation check reason texts", () => {
  it("explain every web reason code of wire-formats §h.2, including transport_mismatch", () => {
    const doc = readFileSync(
      new URL("../../../../docs/contracts/wire-formats.md", import.meta.url),
      "utf8",
    );
    const table = doc.slice(doc.indexOf("### h.2"), doc.indexOf("### h.3"));
    const codes = [...table.matchAll(/^\| `([a-z_]+)` \| (suspect|rejected) \|/gm)].map(
      (m) => m[1],
    );
    expect(codes).toContain("transport_mismatch");
    for (const c of codes) expect(REASON_TEXT[c as string], c).toBeTruthy();
  });
});

describe("traction snapshot create answer", () => {
  it("tells a pending (202) answer from a signed (201) one", () => {
    expect(
      isPending({
        snapshot_id: "d5000000-0000-4000-8000-000000000001",
        status: "pending",
        verify_url: "https://portal.example.invalid/public/v1/snapshots/d5",
      }),
    ).toBe(true);
    expect(
      isPending({
        snapshot: { snapshot_id: "d5000000-0000-4000-8000-000000000001" },
        signature: { alg: "Ed25519", kid: "snap-1", sig: "x" },
      }),
    ).toBe(false);
  });
});
