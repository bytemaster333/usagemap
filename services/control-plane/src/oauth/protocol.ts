// SPDX-License-Identifier: Apache-2.0
// The protocol endpoints of the MCP OAuth authorization server, registered outside the generated pipeline (their
// bodies are form-encoded and their errors are OAuth errors, RFC 6749 §5.2, not problem documents); they are
// documented in docs/api/control-plane.openapi.yaml like every other route (route parity):
//
//   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata (issuer = portal origin)
//   POST /v1/oauth/register                        RFC 7591 Dynamic Client Registration (public clients, rate-limited)
//   GET  /v1/oauth/authorize                       authorization request → the portal consent page
//   POST /v1/oauth/token                           authorization_code (PKCE S256), refresh_token (rotated),
//                                                  token exchange (RFC 8693; the MCP server only)
//   POST /v1/oauth/revoke                          RFC 7009
//
// The authorization endpoint never shows a page itself: it validates the request (a bad client or redirect URI is
// answered here and never redirected, OAuth 2.1 §4.1.2.1), stores it for ≤ 10 minutes and sends the browser to
// `<portal>/oauth/consent?request=<id>`, where the existing portal sign-in (GitHub, SEP-10/53, passkey) applies and
// the user picks the ONE tenant (or, for an SCF operator, the operator view) the client may read.
// Logs: the server logs route templates only; nothing here logs a token, code, verifier, client secret or address.

import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../http/problem.ts";
import { type Limiter, subnetOf } from "../http/ratelimit.ts";
import type { TextFetcher } from "../verify/verifier.ts";
import { CIMD_TTL_MS, fetchClientMetadata } from "./cimd.ts";
import { EXCHANGE_CLIENT_ID } from "./config.ts";
import {
  ACCESS_TOKEN_TYPE,
  CHALLENGE_RE,
  CONTROL_PLANE_AUDIENCE,
  canonicalResource,
  grantedScope,
  isCimdClientId,
  newDcrClientId,
  READ_SCOPE,
  redirectMatches,
  SCOPES_SUPPORTED,
  TOKEN_EXCHANGE_GRANT,
  validateClientMetadata,
  withParams,
} from "./rules.ts";
import { type ClientRow, OAuthError, type OAuthService } from "./service.ts";

/** Operations of the OpenAPI document served by this module instead of the generated pipeline. */
export const OAUTH_PROTOCOL_OPS = new Set([
  "getOAuthServerMetadata",
  "oauthRegisterClient",
  "oauthAuthorize",
  "oauthToken",
  "oauthRevoke",
]);

export interface OAuthProtocolDeps {
  service: OAuthService;
  limiter: Limiter;
  portalOrigin: string;
  fetcher: TextFetcher | undefined;
  now?: () => number;
}

/** OAuth 2.0 Authorization Server Metadata (RFC 8414) for an issuer. */
export function serverMetadata(svc: OAuthService): Record<string, unknown> {
  const iss = svc.cfg.issuer;
  return {
    issuer: iss,
    authorization_endpoint: `${iss}/v1/oauth/authorize`,
    token_endpoint: `${iss}/v1/oauth/token`,
    registration_endpoint: `${iss}/v1/oauth/register`,
    revocation_endpoint: `${iss}/v1/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token", TOKEN_EXCHANGE_GRANT],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SCOPES_SUPPORTED],
    client_id_metadata_document_supported: svc.cfg.cimd,
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://docs.usagemap.dev/",
  };
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function oauthError(reply: FastifyReply, e: OAuthError): FastifyReply {
  const headers: Record<string, string> = { ...NO_STORE };
  if (e.status === 401) headers["www-authenticate"] = 'Basic realm="usagemap-oauth"';
  return reply
    .code(e.status)
    .headers(headers)
    .type("application/json")
    .send({ error: e.error, error_description: e.message });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A parameter that may appear at most once (RFC 6749 §3.1: parameters must not be repeated). */
function single(params: Record<string, unknown>, name: string): string | undefined {
  const v = params[name];
  if (Array.isArray(v)) throw new OAuthError("invalid_request", `parameter ${name} is repeated`);
  return str(v);
}

function secretEquals(given: string, hash: Buffer | null): boolean {
  if (!hash) return false;
  const h = createHash("sha256").update(given).digest();
  return timingSafeEqual(h, hash);
}

export function registerOAuthProtocol(app: FastifyInstance, deps: OAuthProtocolDeps): void {
  const svc = deps.service;
  const cfg = svc.cfg;
  const now = deps.now ?? Date.now;

  async function limit(req: FastifyRequest, key: string, n: number, windowMs: number) {
    const v = await deps.limiter.hit([{ key: `${key}:${subnetOf(req.ip)}`, limit: n, windowMs }]);
    if (!v.allowed) throw new ApiError("rate_limited", undefined, { retryAfter: v.reset });
  }

  function enabled(): void {
    if (!cfg.enabled) throw new ApiError("not_found");
  }

  void app.register(async (scope) => {
    // Form bodies (token, revoke) only inside this plugin: the rest of the API keeps refusing them.
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16 * 1024 },
      (_req, body, done) => {
        const out: Record<string, string | string[]> = {};
        for (const [k, v] of new URLSearchParams(body as string)) {
          const prev = out[k];
          out[k] = prev === undefined ? v : ([] as string[]).concat(prev, v);
        }
        done(null, out);
      },
    );

    scope.get("/.well-known/oauth-authorization-server", async (_req, reply) => {
      enabled();
      return reply
        .code(200)
        .headers({ "cache-control": "public, max-age=300", "access-control-allow-origin": "*" })
        .type("application/json")
        .send(serverMetadata(svc));
    });

    // ------------------------------------------------------------------------------------------ registration
    scope.post("/v1/oauth/register", async (req, reply) => {
      enabled();
      reply.header("access-control-allow-origin", "*");
      const subnet = subnetOf(req.ip);
      const v = await deps.limiter.hit([
        { key: `oauth-dcr:${subnet}`, limit: cfg.dcrPerHour, windowMs: 3_600_000 },
        { key: "oauth-dcr:all", limit: cfg.dcrGlobalPerHour, windowMs: 3_600_000 },
      ]);
      if (!v.allowed) throw new ApiError("rate_limited", undefined, { retryAfter: v.reset });
      const m = validateClientMetadata(req.body);
      if (!m.ok)
        return reply
          .code(400)
          .headers(NO_STORE)
          .type("application/json")
          .send({ error: m.error, error_description: m.description });
      const clientId = newDcrClientId();
      await svc.saveClient(
        {
          clientId,
          kind: "dcr",
          clientName: m.clientName,
          clientUri: m.clientUri,
          redirectUris: m.redirectUris,
        },
        req.id,
      );
      return reply
        .code(201)
        .headers(NO_STORE)
        .type("application/json")
        .send({
          client_id: clientId,
          client_id_issued_at: Math.floor(now() / 1000),
          client_name: m.clientName,
          ...(m.clientUri ? { client_uri: m.clientUri } : {}),
          redirect_uris: m.redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: READ_SCOPE,
        });
    });

    // ------------------------------------------------------------------------------------------ authorization
    scope.get("/v1/oauth/authorize", async (req, reply) => {
      enabled();
      await limit(req, "oauth-az", 60, 60_000);
      const q = req.query as Record<string, unknown>;
      // Errors about the client or the redirect URI are shown here, never redirected (OAuth 2.1 §4.1.2.1).
      const refuse = (description: string) =>
        reply
          .code(400)
          .headers(NO_STORE)
          .type("text/plain; charset=utf-8")
          .send(`This authorization request was refused: ${description}\n`);
      let clientId: string | undefined;
      let redirectUri: string | undefined;
      try {
        clientId = single(q, "client_id");
        redirectUri = single(q, "redirect_uri");
      } catch (e) {
        return refuse((e as Error).message);
      }
      if (!clientId) return refuse("client_id is missing.");
      const client = await resolveClient(clientId, req.id);
      if (!client.ok) return refuse(client.description);
      if (!redirectUri) return refuse("redirect_uri is missing.");
      if (!redirectMatches(client.row.redirect_uris, redirectUri))
        return refuse("redirect_uri is not registered for this client.");

      let state: string | undefined;
      const back = (error: string, description: string) =>
        reply
          .code(302)
          .headers({
            ...NO_STORE,
            location: withParams(redirectUri as string, {
              error,
              error_description: description,
              state,
              iss: cfg.issuer,
            }),
          })
          .send();
      try {
        state = single(q, "state");
        if (state !== undefined && state.length > 1024)
          return back("invalid_request", "state is longer than 1024 characters");
        if (single(q, "response_type") !== "code")
          return back("unsupported_response_type", "only response_type=code is supported");
        const challenge = single(q, "code_challenge");
        if (
          single(q, "code_challenge_method") !== "S256" ||
          !challenge ||
          !CHALLENGE_RE.test(challenge)
        )
          return back(
            "invalid_request",
            "PKCE is required: code_challenge with code_challenge_method=S256",
          );
        const s = grantedScope(single(q, "scope"));
        if (!s.ok) return back("invalid_scope", `supported scopes: ${SCOPES_SUPPORTED.join(" ")}`);
        const rawResource = single(q, "resource");
        const resource =
          rawResource === undefined ? cfg.mcpResource : canonicalResource(rawResource);
        if (resource !== cfg.mcpResource)
          return back("invalid_target", `tokens are issued only for ${cfg.mcpResource}`);
        const id = await svc.createRequest(
          {
            clientId,
            redirectUri,
            codeChallenge: challenge,
            state: state ?? null,
            scope: s.scope,
            resource,
          },
          req.id,
        );
        return reply
          .code(302)
          .headers({ ...NO_STORE, location: `${deps.portalOrigin}/oauth/consent?request=${id}` })
          .send();
      } catch (e) {
        if (e instanceof OAuthError) return back(e.error, e.message);
        throw e;
      }
    });

    async function resolveClient(
      clientId: string,
      requestId: string,
    ): Promise<{ ok: true; row: ClientRow } | { ok: false; description: string }> {
      let row = clientId.length <= 512 ? await svc.client(clientId, requestId) : null;
      const cimd = isCimdClientId(clientId);
      const stale =
        row?.kind === "cimd" &&
        (row.metadata_fetched_at === null ||
          now() - row.metadata_fetched_at.getTime() > CIMD_TTL_MS);
      if ((!row || stale) && cimd && cfg.cimd && deps.fetcher) {
        const m = await fetchClientMetadata(deps.fetcher, clientId);
        if (!m.ok) {
          if (!row) return { ok: false, description: m.description };
        } else {
          await svc.saveClient(
            {
              clientId,
              kind: "cimd",
              clientName: m.clientName,
              clientUri: m.clientUri,
              redirectUris: m.redirectUris,
            },
            requestId,
          );
          row = await svc.client(clientId, requestId);
        }
      }
      if (!row || row.disabled_at) return { ok: false, description: "unknown client_id." };
      return { ok: true, row };
    }

    // ------------------------------------------------------------------------------------------ token
    scope.post("/v1/oauth/token", async (req, reply) => {
      enabled();
      reply.header("access-control-allow-origin", "*");
      await limit(req, "oauth-token", 120, 60_000);
      try {
        const b = formBody(req);
        const grantType = single(b, "grant_type");
        const confidential = clientCredentials(req, b);
        if (grantType === TOKEN_EXCHANGE_GRANT) {
          if (
            !confidential ||
            confidential.id !== EXCHANGE_CLIENT_ID ||
            !secretEquals(confidential.secret, cfg.exchangeSecretHash)
          )
            throw new OAuthError("invalid_client", "client authentication failed", 401);
          if (single(b, "subject_token_type") !== ACCESS_TOKEN_TYPE)
            throw new OAuthError(
              "invalid_request",
              `subject_token_type must be ${ACCESS_TOKEN_TYPE}`,
            );
          const aud = single(b, "audience");
          if (aud !== undefined && aud !== CONTROL_PLANE_AUDIENCE)
            throw new OAuthError("invalid_target", `audience must be ${CONTROL_PLANE_AUDIENCE}`);
          const subject = single(b, "subject_token");
          if (!subject) throw new OAuthError("invalid_request", "subject_token is required");
          const x = await svc.exchange(subject, req.id);
          return reply
            .code(200)
            .headers(NO_STORE)
            .type("application/json")
            .send({
              access_token: x.token,
              issued_token_type: ACCESS_TOKEN_TYPE,
              token_type: "Bearer",
              expires_in: x.expiresIn,
              scope: x.principal.scope,
              // What the token stands for (the MCP server lists tools by it); no personal data.
              usagemap: {
                grant_id: x.principal.grantId,
                kind: x.principal.kind,
                tenant_id: x.principal.tenantId,
                client_name: x.principal.clientName,
                subject_expires_at: x.subjectExpiresAt.toISOString(),
              },
            });
        }
        if (confidential)
          throw new OAuthError(
            "invalid_client",
            "this client is not allowed to use this grant",
            401,
          );
        const clientId = single(b, "client_id");
        if (!clientId)
          throw new OAuthError("invalid_request", "client_id is required (public client)");
        const rawResource = single(b, "resource");
        const resource = rawResource === undefined ? null : canonicalResource(rawResource);
        if (rawResource !== undefined && resource === null)
          throw new OAuthError("invalid_target", "resource is not a valid absolute URI");
        let tokens: Awaited<ReturnType<OAuthService["refresh"]>>;
        if (grantType === "authorization_code") {
          const code = single(b, "code");
          const redirectUri = single(b, "redirect_uri");
          if (!code || !redirectUri)
            throw new OAuthError("invalid_request", "code and redirect_uri are required");
          tokens = await svc.exchangeCode(
            { code, clientId, redirectUri, codeVerifier: single(b, "code_verifier"), resource },
            req.id,
          );
        } else if (grantType === "refresh_token") {
          const rt = single(b, "refresh_token");
          if (!rt) throw new OAuthError("invalid_request", "refresh_token is required");
          const s = single(b, "scope");
          if (s !== undefined && !grantedScope(s).ok)
            throw new OAuthError("invalid_scope", "the requested scope exceeds the grant");
          tokens = await svc.refresh({ refreshToken: rt, clientId, resource }, req.id);
        } else {
          throw new OAuthError(
            "unsupported_grant_type",
            "supported: authorization_code, refresh_token",
          );
        }
        void svc.sweep(req.id).catch(() => undefined);
        return reply.code(200).headers(NO_STORE).type("application/json").send(tokens);
      } catch (e) {
        if (e instanceof OAuthError) return oauthError(reply, e);
        throw e;
      }
    });

    // ------------------------------------------------------------------------------------------ revocation
    scope.post("/v1/oauth/revoke", async (req, reply) => {
      enabled();
      reply.header("access-control-allow-origin", "*");
      await limit(req, "oauth-revoke", 120, 60_000);
      try {
        const b = formBody(req);
        const token = single(b, "token");
        const clientId = single(b, "client_id");
        if (!token || !clientId)
          throw new OAuthError("invalid_request", "token and client_id are required");
        await svc.revokeToken(token, clientId, req.id);
        return reply.code(200).headers(NO_STORE).send();
      } catch (e) {
        if (e instanceof OAuthError) return oauthError(reply, e);
        throw e;
      }
    });
  });
}

function formBody(req: FastifyRequest): Record<string, unknown> {
  const ct = String(req.headers["content-type"] ?? "");
  if (
    !/^application\/x-www-form-urlencoded\s*(;|$)/i.test(ct) ||
    typeof req.body !== "object" ||
    req.body === null
  )
    throw new OAuthError("invalid_request", "the body must be application/x-www-form-urlencoded");
  return req.body as Record<string, unknown>;
}

/** Client credentials from HTTP Basic (RFC 6749 §2.3.1) or the body; undefined for a public client. */
function clientCredentials(
  req: FastifyRequest,
  b: Record<string, unknown>,
): { id: string; secret: string } | undefined {
  const h = req.headers.authorization;
  if (typeof h === "string" && /^Basic /i.test(h)) {
    const raw = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
    const i = raw.indexOf(":");
    if (i < 0) throw new OAuthError("invalid_client", "malformed Basic credentials", 401);
    try {
      return {
        id: decodeURIComponent(raw.slice(0, i)),
        secret: decodeURIComponent(raw.slice(i + 1)),
      };
    } catch {
      throw new OAuthError("invalid_client", "malformed Basic credentials", 401);
    }
  }
  const secret = single(b, "client_secret");
  if (secret !== undefined) return { id: single(b, "client_id") ?? "", secret };
  return undefined;
}
