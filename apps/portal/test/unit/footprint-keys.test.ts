// SPDX-License-Identifier: Apache-2.0
// Footprint registration keys in the portal (components/FootprintKeys.tsx): the extension's shell lines and the state
// a person reads.
import type { ControlPlane } from "@usagemap/api-types";
import { describe, expect, it } from "vitest";
import { keyState, scaffoldEnv } from "../../src/components/FootprintKeys.tsx";
import { SOURCE_TEXT } from "../../src/components/UserTrackingStatement.tsx";

const key = (o: Partial<ControlPlane.FootprintKey> = {}): ControlPlane.FootprintKey => ({
  key_id: "Abcdefghijk1",
  display: "scfa_reg_Abcdefghijk1_…wxyz",
  label: "ci",
  scope: "footprint:register",
  network: null,
  created_at: "2026-11-01T00:00:00Z",
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  ...o,
});

describe("footprint registration keys", () => {
  it("gives the two variables the Scaffold extension reads", () => {
    expect(scaffoldEnv("0199aaaa-0000-7000-8000-000000000000", "scfa_reg_x")).toBe(
      "export USAGEMAP_TENANT_ID=0199aaaa-0000-7000-8000-000000000000\nexport SCF_FOOTPRINT_KEY=scfa_reg_x",
    );
  });
  it("reads revoked before expired before an expiry date", () => {
    const now = Date.parse("2026-11-19T12:00:00Z");
    expect(keyState(key(), now)).toBe("active");
    expect(keyState(key({ expires_at: "2026-12-01T00:00:00Z" }), now)).toMatch(/^expires /);
    expect(keyState(key({ expires_at: "2026-11-02T00:00:00Z" }), now)).toMatch(/^expired /);
    expect(
      keyState(
        key({ expires_at: "2026-11-02T00:00:00Z", revoked_at: "2026-11-01T10:00:00Z" }),
        now,
      ),
    ).toMatch(/^revoked /);
  });
  it("names every source of the user-tracking statement", () => {
    for (const s of ["web", "wallet", "passkey", "api", "stellar_client", "onchain"])
      expect(SOURCE_TEXT[s]).toBeTruthy();
  });
});
