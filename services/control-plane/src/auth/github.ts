// SPDX-License-Identifier: Apache-2.0
// GitHub OAuth App sign-in: authorization-code flow with PKCE (S256), scope `read:user` only (C-20). The GitHub token
// is used once to read the numeric id, login and account creation time, then discarded. Endpoints are configurable so
// tests run against a local fake.

import { createHash, timingSafeEqual } from "node:crypto";
import type { GithubConfig } from "../config.ts";
import type { Handler } from "../http/pipeline.ts";
import { ApiError } from "../http/problem.ts";
import { newOpaqueToken, sha256 } from "../util/ids.ts";
import {
  clearCookie,
  isComplete,
  OAUTH_COOKIE,
  recentAuthValidUntil,
  type SessionStore,
  sessionCookie,
} from "./sessions.ts";
import { completeSignIn, resolveUser } from "./signin.ts";

const STATE_TTL_MS = 10 * 60_000;

export interface GithubUser {
  id: number;
  login: string;
  created_at?: string;
}

export interface GithubClient {
  /** Exchanges the code; returns the access token (never stored, never logged). */
  exchange(code: string, verifier: string): Promise<string>;
  user(token: string): Promise<GithubUser>;
}

export function httpGithubClient(cfg: GithubConfig, timeoutMs = 10_000): GithubClient {
  return {
    async exchange(code, verifier) {
      const res = await fetch(cfg.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code,
          redirect_uri: cfg.redirectUri,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as { access_token?: unknown };
      if (!res.ok || typeof body.access_token !== "string")
        throw new ApiError("validation_failed", "GitHub sign-in failed");
      return body.access_token;
    },
    async user(token) {
      const res = await fetch(`${cfg.apiUrl.replace(/\/$/, "")}/user`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "scf-control-plane",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<GithubUser>;
      if (!res.ok || typeof body.id !== "number" || typeof body.login !== "string") {
        throw new ApiError("validation_failed", "GitHub sign-in failed");
      }
      return {
        id: body.id,
        login: body.login,
        ...(body.created_at ? { created_at: body.created_at } : {}),
      };
    },
  };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * `return_to` (C-114): a same-origin path — printable ASCII only (no control character, no space, no DEL), no
 * backslash anywhere, not scheme-relative — that resolves to the portal origin. Anything else becomes `/`.
 */
export function safeReturnTo(v: unknown, portalOrigin: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) return "/";
  if (!/^\/(?:[!-.0-[\]-~][!-[\]-~]*)?$/.test(v)) return "/";
  try {
    const u = new URL(v, portalOrigin);
    if (u.origin !== portalOrigin) return "/";
  } catch {
    return "/";
  }
  return v;
}

interface StatePayload {
  verifier: string;
  binder: string;
  return_to: string;
  link_user_id: string | null;
}

export function githubHandlers(deps: {
  cfg: GithubConfig | undefined;
  client: GithubClient | undefined;
  sessions: SessionStore;
  portalOrigin: string;
}) {
  const authGithubStart: Handler = async (ctx) => {
    if (!deps.cfg || !deps.client)
      throw new ApiError("unavailable", "GitHub sign-in is not configured");
    const link = ctx.query.link === true;
    if (link) {
      // Adding a sign-in identity is adding a credential (C-114): a complete session with recent authentication
      // (SCF operators: a step-up), so a stolen or half-finished session cannot plant its own way back in.
      const s = ctx.session;
      if (!s || !isComplete(s)) throw new ApiError("unauthenticated");
      const until = recentAuthValidUntil(s);
      if (!until || until.getTime() <= Date.now()) {
        throw new ApiError(
          s.platformRole && s.passkeyCount > 0 ? "step_up_required" : "recent_auth_required",
        );
      }
    }
    const state = newOpaqueToken();
    const binder = newOpaqueToken();
    const verifier = newOpaqueToken();
    const payload: StatePayload = {
      verifier,
      binder: sha256(binder).toString("base64url"),
      return_to: safeReturnTo(ctx.query.return_to, deps.portalOrigin),
      link_user_id: link ? (ctx.session?.userId ?? null) : null,
    };
    await ctx.tx((tx) =>
      tx.query(
        `INSERT INTO scf.auth_challenges (kind, secret_hash, user_id, payload, expires_at)
         VALUES ('github_oauth', $1, $2, $3, now() + interval '10 minutes')`,
        [sha256(state), payload.link_user_id, JSON.stringify(payload)],
      ),
    );
    const url = new URL(deps.cfg.authorizeUrl);
    url.searchParams.set("client_id", deps.cfg.clientId);
    url.searchParams.set("redirect_uri", deps.cfg.redirectUri);
    url.searchParams.set("scope", "read:user");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("allow_signup", "true");
    return {
      status: 302,
      headers: {
        location: url.toString(),
        "set-cookie": `${OAUTH_COOKIE}=${binder}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_MS / 1000}`,
        "cache-control": "no-store",
      },
    };
  };

  const authGithubCallback: Handler = async (ctx) => {
    if (!deps.cfg || !deps.client)
      throw new ApiError("unavailable", "GitHub sign-in is not configured");
    const state = String(ctx.query.state);
    const code = String(ctx.query.code);
    const binder = ctx.cookies.get(OAUTH_COOKIE);
    // Consume the state first (single use), whatever happens next.
    const row = await ctx.tx((tx) =>
      tx.maybeOne<{ payload: StatePayload }>(
        `UPDATE scf.auth_challenges SET consumed_at = now()
          WHERE secret_hash = $1 AND kind = 'github_oauth' AND consumed_at IS NULL AND expires_at > now()
          RETURNING payload`,
        [sha256(state)],
      ),
    );
    const expected = row ? Buffer.from(row.payload.binder, "base64url") : undefined;
    const presented = binder ? sha256(binder) : undefined;
    if (
      !row ||
      !expected ||
      !presented ||
      expected.length !== presented.length ||
      !timingSafeEqual(expected, presented)
    ) {
      throw new ApiError("validation_failed", "invalid or expired sign-in state");
    }
    const ghToken = await deps.client.exchange(code, row.payload.verifier);
    const gh = await deps.client.user(ghToken);
    const subject = String(gh.id);
    const createdAt = gh.created_at ? new Date(gh.created_at) : null;
    const identity = {
      provider: "github" as const,
      subject,
      handle: gh.login.slice(0, 39),
      providerCreatedAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null,
      displayName: gh.login.slice(0, 80),
    };
    const headers: Record<string, string | string[]> = { "cache-control": "no-store" };
    const cookies = [clearCookie(OAUTH_COOKIE)];

    if (row.payload.link_user_id) {
      const linkTo = row.payload.link_user_id;
      if (!ctx.session || ctx.session.userId !== linkTo || !isComplete(ctx.session))
        throw new ApiError("validation_failed", "sign in again to link");
      await ctx.tx(
        async (tx) => {
          const taken = await tx.maybeOne(
            `SELECT 1 FROM scf.external_identities WHERE provider = 'github' AND subject = $1`,
            [subject],
          );
          if (taken)
            throw new ApiError("validation_failed", "this GitHub account is already linked");
          await tx.query(
            `INSERT INTO scf.external_identities (user_id, provider, subject, display_handle, provider_created_at, last_used_at)
             VALUES ($1, 'github', $2, $3, $4, now())`,
            [linkTo, subject, identity.handle, identity.providerCreatedAt],
          );
          await tx.audit({
            action: "auth.identity_linked",
            targetType: "user",
            targetId: linkTo,
            details: { provider: "github" },
          });
        },
        { tenantId: null, actorKind: "user", actorId: linkTo },
      );
      headers["set-cookie"] = cookies;
      headers.location = safeReturnTo(row.payload.return_to, deps.portalOrigin);
      return { status: 303, headers };
    }

    const out = await ctx.tx(
      async (tx) => {
        const { userId } = await resolveUser(tx, identity);
        return completeSignIn(tx, deps.sessions, userId, "github", ctx.session, {});
      },
      { tenantId: null, actorKind: "anonymous", actorId: null },
    );
    cookies.push(sessionCookie(out.token, out.session));
    headers["set-cookie"] = cookies;
    headers.location = safeReturnTo(row.payload.return_to, deps.portalOrigin);
    return { status: 303, headers };
  };

  return { authGithubStart, authGithubCallback };
}
