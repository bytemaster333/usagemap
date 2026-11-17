// SPDX-License-Identifier: Apache-2.0
// Public reads for "verify this number" (2026-11-19; wire-formats §i.1, §i.3, §m.1, §m.2; migration 0077):
//   - getVerifierKeys        GET /public/v1/verifier-keys — the snapshot signing keys, the seal network and accounts,
//                            the SEP-10 key (stellar-toml.ts);
//   - getStellarToml         GET /public/v1/stellar.toml — the same keys as SEP-1 text for the product's apex domain;
//   - getSealedAuditAnchor   GET /public/v1/audit-anchors/{day} — the audit-anchor document a day's seal committed to
//                            (scf.sealed_audit_anchors, written by job daily_seal only when it matched the seal), so a
//                            browser recomputes its sha256 and reads the operator chain's head;
//   - getProjectBadgeSvg / getProjectBadgeJson — badges of a project with PUBLIC stats only (anonymous metrics document;
//                            badge.ts), `public, max-age=3600` with an ETag, like metrics.json.
// Anonymous context throughout; every answer is public data. Unknown, private or inactive → 404 (no existence oracle).

import { createHash } from "node:crypto";
import { encodeAccountId } from "../auth/stellar.ts";
import type { Tx } from "../db/database.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import type { SnapshotKeys } from "../programme/keys.ts";
import { explorerUrl, type SealNetworkConfig, sealNetworkView } from "../programme/seal-network.ts";
import { type BadgeDoc, type BadgeMetric, badgeSvg, shieldsEndpoint } from "./badge.ts";
import { stellarToml, verifierKeys } from "./stellar-toml.ts";

const ANON = { tenantId: null, actorKind: "anonymous" as const, actorId: null };
const PUBLIC_CORS = { "access-control-allow-origin": "*" };

export interface VerifyPublicDeps {
  portalOrigin: string;
  seal: SealNetworkConfig;
  keys: SnapshotKeys;
  /** the SEP-10 server account and home domain, when the deployment has a SEP-10 key */
  sep10: { homeDomain: string; account: string } | null;
  /** the domain whose stellar.toml this is (default: the portal host without a leading `app.`) */
  tomlDomain?: string | undefined;
  now?: (() => number) | undefined;
}

function etagOf(body: string): string {
  return `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`;
}

function cached(
  ctx: { header(n: string): string | undefined },
  text: string,
  contentType: string,
  maxAge: number,
  extra: Record<string, string> = {},
) {
  const etag = etagOf(text);
  const headers: Record<string, string> = {
    etag,
    "cache-control": `public, max-age=${maxAge}`,
    "x-content-type-options": "nosniff",
    ...extra,
  };
  if (
    ctx
      .header("if-none-match")
      ?.split(",")
      .some((t) => t.trim() === etag)
  )
    return { status: 304, headers };
  return { status: 200, body: text, contentType, headers };
}

export function apexDomain(portalOrigin: string): string {
  const host = new URL(portalOrigin).hostname;
  return host.startsWith("app.") ? host.slice(4) : host;
}

export function verifyPublicHandlers(deps: VerifyPublicDeps): Record<string, Handler> {
  const cfg = deps.seal;
  const now = () => deps.now?.() ?? Date.now();

  const keysDoc = async (ctx: Parameters<Handler>[0]) => {
    const seal = await ctx.tx(
      async (tx: Tx) => ({
        accounts: await tx.query<{ a: string }>(
          `SELECT source_account AS a FROM scf.seal_days
            WHERE network = $1 AND source_account IS NOT NULL
            GROUP BY source_account ORDER BY min(day), source_account`,
          [cfg.name],
        ),
        latest: await tx.maybeOne<{ day: string; ledger: string; tx_hash: string }>(
          `SELECT day::text AS day, ledger::text AS ledger, encode(tx_hash, 'hex') AS tx_hash FROM scf.seal_days
            WHERE network = $1 AND status = 'confirmed' ORDER BY day DESC LIMIT 1`,
          [cfg.name],
        ),
      }),
      ANON,
    );
    return verifierKeys({
      now: now(),
      portalOrigin: deps.portalOrigin,
      jwks: deps.keys.jwks(),
      encodeKey: encodeAccountId,
      network: sealNetworkView(cfg),
      accounts: seal.accounts.map((r) => r.a),
      latest: seal.latest
        ? {
            day: seal.latest.day,
            ledger: Number(seal.latest.ledger),
            tx_hash: seal.latest.tx_hash,
            explorer_url: explorerUrl(cfg, seal.latest.tx_hash),
          }
        : null,
      sep10: deps.sep10
        ? { home_domain: deps.sep10.homeDomain, signing_key: deps.sep10.account }
        : null,
    });
  };

  const getVerifierKeys: Handler = async (ctx) => {
    const doc = await keysDoc(ctx);
    // generated_at changes every request: the ETag covers the keys, not the timestamp.
    const { generated_at: _g, ...stable } = doc;
    const r = cached(ctx, JSON.stringify(stable), "application/json", 300, PUBLIC_CORS);
    return r.status === 304 ? r : { status: 200, body: doc, headers: r.headers };
  };

  const getStellarToml: Handler = async (ctx) => {
    const doc = await keysDoc(ctx);
    const domain = deps.tomlDomain ?? apexDomain(deps.portalOrigin);
    const text = stellarToml(doc, {
      domain,
      description:
        "Privacy-first web and API analytics for Stellar ecosystem projects, with published numbers signed and sealed on Stellar.",
    });
    const etag = etagOf(text.replace(/^# \(.*\)\.$/m, ""));
    if (
      ctx
        .header("if-none-match")
        ?.split(",")
        .some((t) => t.trim() === etag)
    )
      return { status: 304, headers: { etag } };
    return {
      status: 200,
      body: text,
      contentType: "text/plain; charset=utf-8",
      headers: {
        etag,
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
        ...PUBLIC_CORS,
      },
    };
  };

  const getSealedAuditAnchor: Handler = async (ctx) => {
    const day = ctx.params.day as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)))
      throw new ApiError("not_found");
    const row = await ctx.tx(
      (tx: Tx) =>
        tx.maybeOne<{ document: Record<string, unknown> }>(
          `SELECT document FROM scf.sealed_audit_anchors WHERE day = $1::date`,
          [day],
        ),
      ANON,
    );
    if (!row) throw new ApiError("not_found");
    // Immutable once stored (trigger): cacheable for a day.
    return {
      status: 200,
      body: row.document,
      headers: { "cache-control": "public, max-age=86400", ...PUBLIC_CORS },
    };
  };

  const badgeDoc = async (ctx: Parameters<Handler>[0]): Promise<BadgeDoc> => {
    const slug = ctx.params.slug as string;
    // Public stats only: the anonymous definer function (no share key, no operator key — a badge is for everyone).
    const doc = await ctx.tx(
      async (tx: Tx) =>
        (
          await tx.maybeOne<{ d: BadgeDoc | null }>(
            `SELECT scf.public_metrics_document($1, NULL) AS d`,
            [slug],
          )
        )?.d ?? null,
      ANON,
    );
    if (!doc) throw new ApiError("not_found");
    return doc;
  };
  const metricOf = (q: Record<string, unknown>): BadgeMetric =>
    q.metric === "api" ? "api" : "visitors";

  const getProjectBadgeSvg: Handler = async (ctx) => {
    const svg = badgeSvg(await badgeDoc(ctx), metricOf(ctx.query));
    return cached(ctx, svg, "image/svg+xml; charset=utf-8", 3600, {
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    });
  };

  const getProjectBadgeJson: Handler = async (ctx) => {
    const body = shieldsEndpoint(await badgeDoc(ctx), metricOf(ctx.query));
    const r = cached(ctx, JSON.stringify(body), "application/json", 3600, PUBLIC_CORS);
    return r.status === 304 ? r : { status: 200, body, headers: r.headers };
  };

  return {
    getVerifierKeys,
    getStellarToml,
    getSealedAuditAnchor,
    getProjectBadgeSvg,
    getProjectBadgeJson,
  };
}
