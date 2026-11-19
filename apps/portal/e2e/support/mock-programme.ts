// SPDX-License-Identifier: Apache-2.0
// Programme outputs for the mock control plane (wire-formats §i): the per-tenant metrics document (§i.1) and signed
// traction snapshots (§i.3). Snapshots are signed for real — Ed25519 over RFC 8785 canonical JSON, with the key
// published as a JWKS — so the portal's in-browser verification is exercised against genuine signatures. One stored
// copy is deliberately altered after signing, so the "not valid" path is exercised too.

import { generateKeyPairSync, sign } from "node:crypto";
import type { ControlPlane } from "@usagemap/api-types";

export const SNAPSHOT_KID = "snap-mock-1";
/** A signed snapshot whose stored figures were changed afterwards: its signature must fail. */
export const TAMPERED_SNAPSHOT = "d5000000-0000-4000-8000-0000000000ff";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as { x: string };

export const JWKS: ControlPlane.Jwks = {
  keys: [
    {
      kty: "OKP",
      crv: "Ed25519",
      kid: SNAPSHOT_KID,
      x: jwk.x,
      use: "sig",
      not_before: "2026-01-01T00:00:00Z",
      not_after: null,
    },
  ],
};

/** RFC 8785, independent of the portal's own implementation (so the test is not circular). */
export function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
    .join(",")}}`;
}

export interface SnapshotTenant {
  slug: string;
  name: string;
  verification_level: string;
}

export function snapshotBody(
  id: string,
  t: SnapshotTenant,
  periodStart: string,
  periodEnd: string,
  issuedAt: string,
): Record<string, unknown> {
  return {
    schema: "scf-analytics/traction-snapshot/1",
    snapshot_id: id,
    issued_at: issuedAt,
    issuer: "portal.example.invalid",
    project: {
      slug: t.slug,
      name: t.name,
      verification_level: t.verification_level,
      registry_matches: [],
    },
    period: { start: periodStart, end: periodEnd },
    web: {
      verified: { pageviews: 48213, visitors_sum: 9118 },
      raw: { pageviews: 51034, visitors_sum: 9802 },
      visit_metrics: {
        visits: 12010,
        bounces: 5044,
        bounce_rate_pct: 42.0,
        avg_visit_duration_s: 91.5,
        suspect_pageview_share: 0.0553,
      },
      monthly: [{ start: periodStart, pageviews_verified: 15021, visitors_sum_verified: 2903 }],
    },
    api: {
      label: "self-attested telemetry",
      requests: 1204513,
      error_rate_5xx: 0.0031,
      p95_ms: 182.0,
      accuracy_class: "exp3",
      assurance_level: "A2",
      onchain_consistent: "not_applicable",
      monthly: [{ start: periodStart, requests: 390104 }],
    },
    definitions: "https://portal.example.invalid/docs/metric-definitions/1",
  };
}

export function signSnapshot(snapshot: Record<string, unknown>): {
  snapshot: Record<string, unknown>;
  signature: { alg: "Ed25519"; kid: string; sig: string };
} {
  const sig = sign(null, Buffer.from(jcs(snapshot), "utf8"), privateKey).toString("base64url");
  return { snapshot, signature: { alg: "Ed25519", kid: SNAPSHOT_KID, sig } };
}

const DAY = 86_400_000;
const midnight = (ms: number) =>
  new Date(Math.floor(ms / DAY) * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The hourly metrics document of a tenant (§i.1): last 30 complete UTC days, exact figures. */
export function metricsDocument(t: SnapshotTenant, now = Date.now()): Record<string, unknown> {
  const end = Math.floor(now / DAY) * DAY;
  const start = end - 30 * DAY;
  const daily = [3, 2, 1].map((back, i) => ({
    start: midnight(end - back * DAY),
    pageviews_verified: 1500 + i * 50,
    pageviews_raw: 1600 + i * 50,
    visitors_sum_verified: 300 + i,
    visitors_sum_raw: 320 + i,
  }));
  return {
    schema: "scf-analytics/metrics-endpoint/1",
    project: { slug: t.slug, name: t.name, verification_level: t.verification_level },
    generated_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
    window: { start: midnight(start), end: midnight(end), days: 30 },
    web: {
      verified: { pageviews: 48213, visitors_sum: 9118 },
      raw: { pageviews: 51034, visitors_sum: 9802 },
      visit_metrics: {
        visits: 12010,
        bounces: 5044,
        bounce_rate_pct: 42.0,
        avg_visit_duration_s: 91.5,
        suspect_pageview_share: 0.0553,
      },
      daily,
      filtered: {
        events_received: 60000,
        verified: 54000,
        suspect: 4200,
        rejected: 1800,
        not_counted_share: 0.1,
        suspect_share: 0.07,
        rejected_share: 0.03,
        reasons: [
          { code: "proof_missing", verdict: "suspect", count: 3100 },
          { code: "ua_bot", verdict: "rejected", count: 1500 },
          { code: "net_datacenter", verdict: "suspect", count: 1100 },
          { code: "origin_mismatch", verdict: "rejected", count: 300 },
        ],
        reasons_suppressed: 2,
      },
    },
    api: {
      label: "self-attested telemetry",
      requests: 1204513,
      error_rate_5xx: 0.0031,
      p95_ms: 182.0,
      accuracy_class: "exp3",
      assurance_level: "A2",
      onchain_consistent: "not_applicable",
      daily: daily.map((d) => ({ start: d.start, requests: 40120 })),
    },
    links: { definitions: "https://portal.example.invalid/docs/metric-definitions/1" },
  };
}
