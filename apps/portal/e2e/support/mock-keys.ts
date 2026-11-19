// SPDX-License-Identifier: Apache-2.0
// Mock answers of footprint registration keys (listFootprintKeys, createFootprintKey, revokeFootprintKey; migration
// 0081) and of the user-tracking paragraph (getUserTrackingStatement) for the portal's browser tests. Follows
// the contract where the portal depends on it: admin or owner only (403 below), recent sign-in for changes, the key in
// the creation answer only, at most 5 usable keys (409 quota_exceeded), 404 for a foreign tenant. The paragraph names
// only the sources of the mock tenant that delivered data: its websites (page views) and, with `walletData`, wallet
// events. Every body is validated against the OpenAPI document by the server.

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import { type Answer, MockProblem } from "./mock-extra.ts";

type Json = Record<string, unknown>;
type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
  body: Json;
}) => Answer;

export interface KeysCtx {
  session(req: IncomingMessage): { userId: string };
  tenants(): Map<string, ControlPlane.Tenant & { members: Map<string, ControlPlane.TenantRole> }>;
  sites(): Map<string, ControlPlane.Site & { tenantId: string }>;
  requireRecent(req: IncomingMessage): void;
}

type KeyRow = ControlPlane.FootprintKey & { tenantId: string };
export interface KeysState {
  keys: KeyRow[];
}
export const seedKeys = (): KeysState => ({ keys: [] });

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const b62 = (n: number) => [...randomBytes(n)].map((b) => B62[b % 62]).join("");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const notFound = () => new MockProblem(404, "not_found", "Not found");
const DAY = 86_400_000;

export function keysHandlers(ctx: KeysCtx, state: () => KeysState): Record<string, Handler> {
  const tenantOf = (req: IncomingMessage, tenantId: string, admin: boolean) => {
    const { userId } = ctx.session(req);
    const t = ctx.tenants().get(tenantId);
    const role = t?.members.get(userId);
    if (!t || !role) throw notFound();
    if (admin && role !== "admin" && role !== "owner")
      throw new MockProblem(403, "forbidden", "Forbidden");
    return t;
  };
  const view = ({ tenantId: _t, ...k }: KeyRow): ControlPlane.FootprintKey => k;
  return {
    listFootprintKeys: ({ req, p }) => {
      tenantOf(req, p.tenantId as string, true);
      return {
        status: 200,
        body: state()
          .keys.filter((k) => k.tenantId === p.tenantId)
          .map(view),
      };
    },
    createFootprintKey: ({ req, p, body }) => {
      tenantOf(req, p.tenantId as string, true);
      ctx.requireRecent(req);
      const label = typeof body.label === "string" ? body.label.trim() : "";
      if (label === "" || label.length > 100)
        throw new MockProblem(400, "validation_failed", "Invalid request", {
          errors: [{ pointer: "/label", detail: "1–100 characters" }],
        });
      const usable = state().keys.filter(
        (k) =>
          k.tenantId === p.tenantId &&
          !k.revoked_at &&
          (!k.expires_at || Date.parse(k.expires_at) > Date.now()),
      );
      if (usable.length >= 5)
        throw new MockProblem(409, "quota_exceeded", "Quota exceeded", {
          detail: "at most 5 usable footprint registration keys per project",
        });
      const id = b62(12);
      const key = `scfa_reg_${id}_${b62(33)}`;
      const row: KeyRow = {
        tenantId: p.tenantId as string,
        key_id: id,
        display: `scfa_reg_${id}_…${key.slice(-4)}`,
        label,
        scope: "footprint:register",
        network: (body.network as "mainnet" | "testnet" | null | undefined) ?? null,
        created_at: iso(Date.now()),
        expires_at: (body.expires_at as string | null | undefined) ?? null,
        last_used_at: null,
        revoked_at: null,
      };
      state().keys.unshift(row);
      return { status: 201, body: { ...view(row), key } };
    },
    revokeFootprintKey: ({ req, p }) => {
      tenantOf(req, p.tenantId as string, true);
      ctx.requireRecent(req);
      const k = state().keys.find((x) => x.key_id === p.keyId && x.tenantId === p.tenantId);
      if (!k) throw notFound();
      k.revoked_at ??= iso(Date.now());
      return { status: 204 };
    },
    getUserTrackingStatement: ({ req, p }) => {
      const t = tenantOf(req, p.tenantId as string, false);
      const end = Math.floor(Date.now() / DAY) * DAY;
      const sites = [...ctx.sites().values()].filter((s) => s.tenantId === t.tenant_id);
      const measured = sites.length > 0;
      const sources: ControlPlane.UserTrackingSource[] = measured
        ? [
            {
              source: "web",
              status: "measured",
              detail: `Page views on ${sites.map((s) => `${s.name} (${s.tracker_profile})`).join(", ")}.`,
            },
          ]
        : [];
      const privacy = "https://docs.example.invalid/privacy";
      const paragraph = measured
        ? `${t.name} measures usage with UsageMap, a privacy-preserving analytics service for Stellar ecosystem projects; this statement describes what was measured between ${iso(end - 30 * DAY).slice(0, 10)} and ${iso(end).slice(0, 10)}. On our website we count page views with UsageMap, a privacy-preserving analytics service, without cookies or any data stored on the visitor's device (except a note of an opt-out). No cookies, IP addresses, raw user-agent strings, end-user wallet addresses or query strings are stored. Details of what is collected and how long it is kept: ${privacy}.`
        : `${t.name} has set up UsageMap, a privacy-preserving analytics service for Stellar ecosystem projects, but no usage data was received, so no user activity is being tracked yet. Details of what is collected and how long it is kept: ${privacy}.`;
      return {
        status: 200,
        body: {
          tenant_id: t.tenant_id,
          generated_at: iso(Date.now()),
          window: { start: iso(end - 30 * DAY), end: iso(end) },
          paragraph,
          mermaid: measured
            ? "flowchart LR\n  V[Visitor browser] -->|page views, no cookies| E[UsageMap edge]"
            : "flowchart LR\n  N[No usage data received yet]",
          sources,
          never_collected: ["IP addresses (used in memory for the country lookup, then discarded)"],
          links: {
            privacy,
            public_stats: t.public_stats_enabled
              ? `https://portal.example.invalid/p/${t.slug}`
              : null,
            snapshot: null,
          },
        } satisfies ControlPlane.UserTrackingStatement,
      };
    },
  };
}
