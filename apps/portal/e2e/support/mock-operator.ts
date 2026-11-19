// SPDX-License-Identifier: Apache-2.0
// Mock answers of the SCF operator console's newer reads and writes (operatorOverview, operatorWebVerdicts,
// operatorTrustScores, operatorCampaignComparison, operatorListOperators, operatorGrant, operatorRevoke) for the
// portal's browser tests. Every figure is FAKE and derived from the shared operator fixture; the server validates
// every JSON body against the OpenAPI document. SCF operators only (403 otherwise); grant/revoke need operator_admin.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import { OP_PROJECTS, PRIVACY } from "../../test/fixtures/operator.ts";
import { type Answer, MockProblem } from "./mock-extra.ts";

type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
  body: unknown;
}) => Answer;

export interface OperatorCtx {
  session: (req: IncomingMessage) => { userId: string; role: "operator" | "operator_admin" | null };
  tenants: () => Iterable<{
    tenant_id: string;
    status: ControlPlane.TenantStatus;
    created_at: string;
  }>;
  users: () => Map<
    string,
    {
      id: string;
      name: string;
      platformRole: "operator" | "operator_admin" | null;
      passkeys: unknown[];
      createdAt: string;
    }
  >;
}

/** The mock's user ids are not UUIDs; the contract's are. A stable UUID per mock user, and back. */
const uuidOf = (id: string) => {
  const h = createHash("sha256").update(id).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const SITE = (i: number) => `c0000000-0000-4000-8000-0000000000${String(10 + i)}`;

export function operatorHandlers(c: OperatorCtx): Record<string, Handler> {
  const operator = (req: IncomingMessage, admin = false) => {
    const s = c.session(req);
    if (!s.role) throw new MockProblem(403, "forbidden", "SCF operators only");
    if (admin && s.role !== "operator_admin")
      throw new MockProblem(403, "forbidden", "Needs the operator_admin role");
    return s;
  };
  const ranked = () =>
    OP_PROJECTS.filter((p) => p.status !== "removed" && p.verification_level !== "L0");
  return {
    operatorOverview: ({ req }) => {
      operator(req);
      const all = [...c.tenants()];
      const n = (s: ControlPlane.TenantStatus) => all.filter((t) => t.status === s).length;
      const count = (value: number, previous: number) => ({
        value,
        previous,
        delta: value - previous,
      });
      const body: ControlPlane.OperatorOverview = {
        as_of: "2026-11-16T00:00:00Z",
        month_start: "2026-11-01",
        enrolled: count(n("active") + n("suspended") + n("pending"), 3),
        pending_approval: count(n("pending"), 0),
        new_this_month: count(2, 1),
        removed_this_month: count(n("removed"), 0),
      };
      return { status: 200, body };
    },
    operatorWebVerdicts: ({ req, q }) => {
      operator(req);
      const day = (q.get("start") ?? "2026-11-01T00:00:00Z").slice(0, 10);
      const body: ControlPlane.OperatorVerdicts = {
        privacy: PRIVACY,
        rows: ranked().flatMap((p, i) => [
          {
            tenant_id: p.tenant_id,
            site_id: SITE(i),
            day,
            counter: "reason" as const,
            label: "ua_bot",
            count: 400 + i * 10,
          },
          {
            tenant_id: p.tenant_id,
            site_id: SITE(i),
            day,
            counter: "reason" as const,
            label: "proof_missing",
            count: 120,
          },
          {
            tenant_id: p.tenant_id,
            site_id: SITE(i),
            day,
            counter: "verdict" as const,
            label: "verified",
            count: p.verified.pageviews,
          },
        ]),
      };
      return { status: 200, body };
    },
    operatorTrustScores: ({ req, q }) => {
      operator(req);
      const day = (q.get("end") ?? "2026-11-16T00:00:00Z").slice(0, 10);
      const comp = (p: number): ControlPlane.TrustComponent => ({
        p,
        value: p,
        eco_percentile: null,
      });
      const items: ControlPlane.OpTrustRow[] = ranked().map((p, i) => ({
        tenant_id: p.tenant_id,
        slug: p.slug,
        site_id: SITE(i),
        day,
        window_days: 28,
        score: p.trust_score_28d,
        components:
          p.trust_score_28d === null
            ? {}
            : {
                proof_coverage: comp(p.trust_score_28d < 80 ? 0.4 : 0),
                network_quality: comp(0.1),
                multiplicity: comp(0),
                engagement: comp(0),
              },
        reason_codes:
          p.trust_score_28d === null
            ? ["insufficient_data"]
            : p.trust_score_28d < 80
              ? ["proof_coverage_low"]
              : [],
        decision_rate: 0.05,
        algorithm_version: "trust/1.0.0",
      }));
      return { status: 200, body: { items, next_cursor: null } };
    },
    operatorCampaignComparison: ({ req, q }) => {
      operator(req);
      const ids = (q.get("tenant_ids") ?? "").split(",");
      const rows = OP_PROJECTS.filter((p) => ids.includes(p.tenant_id)).map((p, i) => {
        const base = p.verified;
        const camp = { ...base, pageviews: Math.round(base.pageviews * (1.2 + i * 0.5)) };
        return {
          tenant_id: p.tenant_id,
          slug: p.slug,
          campaign: camp,
          baseline: base,
          campaign_days: 7,
          baseline_days: 7,
          pageviews_per_day_ratio: base.pageviews
            ? Math.round((camp.pageviews / base.pageviews) * 100) / 100
            : null,
          visitors_per_day_ratio: 1,
        };
      });
      const body: ControlPlane.CampaignComparison = { privacy: PRIVACY, rows };
      return { status: 200, body };
    },
    operatorListOperators: ({ req }) => {
      operator(req);
      const body: ControlPlane.PlatformOperator[] = [...c.users().values()]
        .filter((u) => u.platformRole)
        .map((u) => ({
          user_id: uuidOf(u.id),
          display_name: u.name,
          role: u.platformRole as "operator" | "operator_admin",
          granted_at: u.createdAt,
          granted_by: null,
          passkey_count: u.passkeys.length,
        }));
      return { status: 200, body };
    },
    operatorGrant: ({ req, body }) => {
      operator(req, true);
      const b = body as ControlPlane.PlatformOperatorGrant;
      const u = [...c.users().values()].find((x) => uuidOf(x.id) === b.user_id);
      if (!u) throw new MockProblem(404, "not_found", "No such account");
      u.platformRole = b.role;
      const out: ControlPlane.PlatformOperator = {
        user_id: uuidOf(u.id),
        display_name: u.name,
        role: b.role,
        granted_at: new Date().toISOString(),
        granted_by: uuidOf(c.session(req).userId),
        passkey_count: u.passkeys.length,
      };
      return { status: 201, body: out };
    },
    operatorRevoke: ({ req, p }) => {
      operator(req, true);
      const u = [...c.users().values()].find((x) => uuidOf(x.id) === p.userId);
      if (!u?.platformRole) throw new MockProblem(404, "not_found", "Not an operator");
      u.platformRole = null;
      return { status: 204, body: undefined };
    },
  };
}
