// SPDX-License-Identifier: Apache-2.0
// Wires the operations of the OpenAPI document to their handlers. Every operation in the document is routed on the
// public listener (except the internal edge operations); an operation without a handler answers 501 after the same
// authentication and authorisation checks as a built one, so the isolation matrix applies to it already.

import type { FastifyInstance } from "fastify";
import { apiHandlers } from "./api/handlers.ts";
import { appEventsHandlers } from "./app-events/handlers.ts";
import { type GithubClient, githubHandlers } from "./auth/github.ts";
import { passkeyHandlers } from "./auth/passkeys.ts";
import { Sep10 } from "./auth/sep10.ts";
import { SessionStore } from "./auth/sessions.ts";
import { type HorizonClient, stellarHandlers } from "./auth/stellar.ts";
import { browserRpcHandlers } from "./browser-rpc/handlers.ts";
import { type Config, isLoopbackHost } from "./config.ts";
import type { Database } from "./db/database.ts";
import { accountHandlers } from "./domain/account.ts";
import { publicHandlers } from "./domain/public.ts";
import { siteHandlers } from "./domain/sites.ts";
import { tenantHandlers } from "./domain/tenants.ts";
import { registerInternalRoutes } from "./edge/internal.ts";
import { erasureHandlers } from "./erasure/handlers.ts";
import { userTrackingHandlers } from "./evidence/user-tracking-handler.ts";
import { ConcurrencyGate } from "./http/concurrency.ts";
import { OpenApi } from "./http/openapi.ts";
import { buildHandler, type Handler } from "./http/pipeline.ts";
import { type Limiter, PgRateLimiter, RateLimiter } from "./http/ratelimit.ts";
import { createServer, type LogSink } from "./http/server.ts";
import { integrationMetricsHandlers } from "./integration-metrics/handlers.ts";
import { integrationHandlers } from "./integrations/handlers.ts";
import { authenticateFootprintKey, footprintKeyHandlers } from "./keys/footprint-keys.ts";
import { lifecycleHandlers } from "./lifecycle/handlers.ts";
import { oauthHandlers } from "./oauth/handlers.ts";
import { OAUTH_PROTOCOL_OPS, registerOAuthProtocol } from "./oauth/protocol.ts";
import { OAuthService } from "./oauth/service.ts";
import { onboardingHandlers } from "./onboarding/handlers.ts";
import { operatorFootprintHandlers } from "./operator/footprint.ts";
import { operatorConsoleHandlers } from "./operator/handlers.ts";
import { operatorProgrammeHandlers } from "./operator/programme.ts";
import { OpKeyAuth } from "./opmetrics/keyauth.ts";
import { registerOperatorMetrics } from "./opmetrics/routes.ts";
import { healthHandlers } from "./programme/health.ts";
import { SnapshotKeys } from "./programme/keys.ts";
import { metricsEndpointHandlers } from "./programme/metrics-endpoint.ts";
import { sealHandlers } from "./programme/seal.ts";
import { shareKeyHandlers } from "./programme/share-keys.ts";
import { snapshotHandlers } from "./programme/snapshots.ts";
import { protocolsHandlers } from "./protocols/handlers.ts";
import { stellarClientHandlers } from "./stellar-client/handlers.ts";
import type { TrackerRegistry } from "./tracker.ts";
import { trustHandlers } from "./trust/handlers.ts";
import { usageMapHandlers } from "./usagemap/handlers.ts";
import { footprintHandlers } from "./verify/footprint.ts";
import { verificationHandlers } from "./verify/handlers.ts";
import { ladderHandlers } from "./verify/ladder.ts";
import { DomainVerifier, type TextFetcher } from "./verify/verifier.ts";
import { verifyPublicHandlers } from "./verify-public/handlers.ts";
import { type LiveReader, webHandlers } from "./web/handlers.ts";
import { type ReportReader, reportHandlers } from "./web/reports.ts";
import { stellarSiteHandlers } from "./web/stellar.ts";

export interface AppDeps {
  config: Config;
  db: Database;
  tracker: TrackerRegistry;
  github?: GithubClient | undefined;
  horizon: HorizonClient;
  openapi?: OpenApi;
  logStream?: LogSink;
  limiter?: Limiter | undefined;
  /** Live-window reads through the engine proxy (wire-formats §j.3); without it every range is answered from rollups. */
  reader?: LiveReader | undefined;
  /** Report reads R6–R8 (§j.3); default: `reader` when it has them (the adapter's UmamiReader does). */
  reports?: ReportReader | undefined;
  /** In-process wake-up of a domain_verification worker (tests); production: NOTIFY scf_verify to the jobs service. */
  wakeVerifier?: (() => void) | undefined;
  /** scf_metrics_ro pool for the operator metrics API (`/op/v1`); without it that API answers 503. */
  metricsDb?: Database | undefined;
  /** In-process wake-up of an erasure worker (tests); production: NOTIFY scf_erasure to the jobs service. */
  wakeErasure?: (() => void) | undefined;
  /** In-process wake-up of a traction-snapshot signer (tests); production: NOTIFY scf_snapshot. */
  wakeSigner?: (() => void) | undefined;
  /** Clock for the analytics handlers (tests). */
  now?: (() => number) | undefined;
  /** HTTPS fetcher for `stellar.toml` (L2 proof); default: the SSRF-safe domain verifier. */
  textFetcher?: TextFetcher | undefined;
  /** Shared verifier of SCF-operator API keys (`/op/v1` and the metrics_endpoint). */
  opKeys?: OpKeyAuth | undefined;
  /** MCP OAuth authorization server state (src/oauth); default: one over `db` with `config.oauth`. */
  oauth?: OAuthService | undefined;
}

export interface Apps {
  publicApp: FastifyInstance;
  internalApp: FastifyInstance;
  openapi: OpenApi;
  handlers: Record<string, Handler>;
}

export function buildHandlers(
  deps: AppDeps,
  sessions: SessionStore,
  log?: { warn(obj: object, msg: string): void },
): Record<string, Handler> {
  const c = deps.config;
  const sep10 = c.stellar.sep10Seed
    ? new Sep10({
        seed: c.stellar.sep10Seed,
        network: c.stellar.network,
        homeDomain: c.stellar.homeDomain,
        webAuthDomain: new URL(c.portalOrigin).hostname,
      })
    : undefined;
  const clock = deps.now ? { now: deps.now } : {};
  const opKeys = deps.opKeys ?? new OpKeyAuth(deps.metricsDb, c.peppers, deps.now);
  return {
    ...githubHandlers({
      cfg: c.github,
      client: deps.github,
      sessions,
      portalOrigin: c.portalOrigin,
    }),
    ...stellarHandlers({
      homeDomain: c.stellar.homeDomain,
      network: c.stellar.network,
      horizon: deps.horizon,
      sessions,
      sep10,
    }),
    ...passkeyHandlers({
      rpId: c.webauthn.rpId,
      rpName: c.webauthn.rpName,
      origin: c.portalOrigin,
      sessions,
    }),
    ...accountHandlers({ sessions }),
    ...tenantHandlers(),
    ...siteHandlers(),
    ...publicHandlers({ tracker: deps.tracker }),
    ...verificationHandlers({ ...(deps.wakeVerifier ? { wake: deps.wakeVerifier } : {}) }),
    ...webHandlers({ reader: deps.reader, credsKeys: c.umami.credsKeys, log }),
    ...reportHandlers({
      reader: deps.reports ?? asReportReader(deps.reader),
      credsKeys: c.umami.credsKeys,
      log,
      now: deps.now,
    }),
    ...lifecycleHandlers({ tracker: deps.tracker, noticeTextUrl: c.tracker.noticeTextUrl }),
    ...apiHandlers({
      peppers: c.peppers,
      otlpEndpoint: c.otlpEndpoint,
      ...(deps.now ? { now: deps.now } : {}),
    }),
    ...operatorConsoleHandlers({ peppers: c.peppers, ...(deps.now ? { now: deps.now } : {}) }),
    ...erasureHandlers({ wake: deps.wakeErasure, ...(deps.now ? { now: deps.now } : {}) }),
    ...ladderHandlers({
      homeDomain: c.stellar.homeDomain,
      network: c.stellar.network,
      horizon: deps.horizon,
      sep10,
      fetcher:
        deps.textFetcher ??
        new DomainVerifier({ dnsServers: c.verifier.dnsServers, maxBytes: 100 * 1024 }),
      ...clock,
    }),
    ...trustHandlers(),
    ...shareKeyHandlers({ peppers: c.peppers, ...clock }),
    ...snapshotHandlers({
      keys: new SnapshotKeys(c.programme),
      portalOrigin: c.portalOrigin,
      waitMs: c.programme.snapshotWaitMs,
      wakeSigner: deps.wakeSigner,
      ...clock,
    }),
    ...metricsEndpointHandlers({ peppers: c.peppers, opKeys, metricsDb: deps.metricsDb }),
    ...healthHandlers({ cfg: c.programme, version: c.version, ...clock }),
    ...operatorProgrammeHandlers(clock),
    // Stellar site operations and the Registered Footprint (C-136, C-137)
    ...stellarSiteHandlers(),
    ...footprintHandlers({
      homeDomain: c.stellar.homeDomain,
      horizon: deps.horizon,
      ...clock,
    }),
    ...operatorFootprintHandlers(),
    ...sealHandlers({ portalOrigin: c.portalOrigin, seal: c.programme.seal, ...clock }),
    // "Verify this number": verifier keys, stellar.toml, sealed audit anchors, badges
    ...verifyPublicHandlers({
      portalOrigin: c.portalOrigin,
      seal: c.programme.seal,
      keys: new SnapshotKeys(c.programme),
      sep10: sep10 ? { homeDomain: c.stellar.homeDomain, account: sep10.serverAccount } : null,
      ...clock,
    }),
    // Onboarding of SCF-awarded projects from the public registry
    ...onboardingHandlers({
      tracker: deps.tracker,
      portalOrigin: c.portalOrigin,
      otlpEndpoint: c.otlpEndpoint,
    }),
    // Integration catalogue: pick → generated config → test → live check
    ...integrationHandlers({
      tracker: deps.tracker,
      portalOrigin: c.portalOrigin,
      otlpEndpoint: c.otlpEndpoint,
    }),
    // Ecosystem Usage Map: on-chain usage of every registry project with contracts (migration 0075)
    ...usageMapHandlers({ network: c.stellar.network }),
    // Protocol interactions (migration 0082)
    ...protocolsHandlers({ network: c.stellar.network }),
    // Stellar SDK client metrics of a service (C-153, migration 0080)
    ...stellarClientHandlers(clock),
    // MCP OAuth consent and connected apps (migration 0083)
    ...oauthHandlers({ service: deps.oauth }),
    // Footprint registration keys `scfa_reg_…` for build tools (migration 0081)
    ...footprintKeyHandlers({ peppers: c.peppers, ...clock }),
    // Generated "user tracking" paragraph for ecosystem grant applications
    ...userTrackingHandlers({ portalOrigin: c.portalOrigin, docsOrigin: c.docsOrigin, ...clock }),
    // Browser Stellar RPC/Horizon daily totals of a site (migration 0086)
    ...browserRpcHandlers(),
    // Integration client metrics: partner calls, payments, anchor funnel (migration 0085)
    ...integrationMetricsHandlers(clock),
    // Self-attested app events of native apps and Mini Apps (migration 0084)
    ...appEventsHandlers(clock),
  };
}

function asReportReader(r: LiveReader | undefined): ReportReader | undefined {
  const x = r as Partial<ReportReader> | undefined;
  return x &&
    typeof x.funnel === "function" &&
    typeof x.goal === "function" &&
    typeof x.journey === "function"
    ? (x as ReportReader)
    : undefined;
}

export async function buildApps(deps: AppDeps): Promise<Apps> {
  const openapi = deps.openapi ?? new OpenApi();
  const sessions = new SessionStore(deps.db);
  const limiter =
    deps.limiter ??
    (deps.config.rateLimit.store === "postgres"
      ? new PgRateLimiter(deps.db, deps.config.rateLimit.secret)
      : new RateLimiter());
  const opKeys = deps.opKeys ?? new OpKeyAuth(deps.metricsDb, deps.config.peppers, deps.now);
  const oauth = deps.oauth ?? new OAuthService(deps.db, deps.config.oauth, deps.now);
  // The public server is created below; warnings from handlers go to its logger once it exists.
  let appLog: FastifyInstance["log"] | undefined;
  const handlers = buildHandlers({ ...deps, opKeys, oauth }, sessions, {
    warn: (obj, msg) => appLog?.warn(obj, msg),
  });
  for (const id of Object.keys(handlers)) openapi.get(id); // every handler must name a documented operation

  const common = {
    logLevel: deps.config.logLevel,
    problemBase: deps.config.problemBase,
    trustProxy: deps.config.trustProxy,
    ...(deps.logStream ? { logStream: deps.logStream } : {}),
  };
  const publicApp = createServer({ ...common, bodyLimit: 64 * 1024 });
  appLog = publicApp.log;
  const pipeline = {
    db: deps.db,
    sessions,
    limiter,
    portalOrigin: deps.config.portalOrigin,
    createLimitPerHour: deps.config.createLimitPerHour,
    oauth,
    // A quarter of the pool (at least 1) for SCF-operator console reads; a read that cannot start within 15 s gets 503.
    operatorReads: new ConcurrencyGate({
      limit: Math.max(1, Math.floor(deps.config.databasePoolMax / 4)),
      waitMs: 15_000,
    }),
    // footprint registration keys `scfa_reg_…`
    footprintKeys: {
      authenticate: (authorization: string | undefined, tenantId: string, requestId: string) =>
        authenticateFootprintKey(deps.db, deps.config.peppers, authorization, tenantId, requestId),
    },
  };
  for (const op of openapi.operations) {
    if (op.internal) continue;
    if (OAUTH_PROTOCOL_OPS.has(op.operationId)) continue; // registerOAuthProtocol below
    publicApp.route({
      method: op.method.toUpperCase() as "GET",
      url: op.routePath,
      handler: buildHandler(op, handlers[op.operationId], pipeline),
    });
  }
  registerOAuthProtocol(publicApp, {
    service: oauth,
    limiter,
    portalOrigin: deps.config.portalOrigin,
    fetcher:
      deps.textFetcher ??
      new DomainVerifier({ dnsServers: deps.config.verifier.dnsServers, maxBytes: 64 * 1024 }),
    ...(deps.now ? { now: deps.now } : {}),
  });
  registerOperatorMetrics(publicApp, {
    oauth,
    db: deps.metricsDb,
    keyAuth: opKeys,
    peppers: deps.config.peppers,
    limiter,
    ...(deps.now ? { now: deps.now } : {}),
  });
  registerHealth(publicApp, deps.db);

  const tls = deps.config.edge.tls;
  if (!tls && !isLoopbackHost(deps.config.edge.internalHost)) {
    throw new Error("the internal edge API needs mutual TLS unless it listens on loopback (C-114)");
  }
  const internalApp = createServer({
    ...common,
    trustProxy: false,
    bodyLimit: 32 * 1024 * 1024,
    ...(tls
      ? {
          https: {
            cert: tls.cert,
            key: tls.key,
            ca: tls.ca,
            requestCert: true,
            rejectUnauthorized: true,
          },
        }
      : {}),
  });
  registerInternalRoutes(internalApp, {
    db: deps.db,
    nodeHeader: deps.config.edge.nodeHeader,
    allowedClients: tls?.allowedClients,
  });
  registerHealth(internalApp, deps.db);

  return { publicApp, internalApp, openapi, handlers };
}

/** Liveness (`/healthz`: the process serves) and readiness (`/readyz`: the database answers within 2 s). */
function registerHealth(app: FastifyInstance, db: Database): void {
  app.get("/healthz", async (_req, reply) => {
    await reply.code(200).type("application/json").send({ status: "ok" });
  });
  app.get("/readyz", async (req, reply) => {
    try {
      await Promise.race([
        db.tx({ tenantId: null, actorKind: "system", actorId: "readyz", requestId: req.id }, (tx) =>
          tx.query("SELECT 1"),
        ),
        new Promise((_r, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
      ]);
      await reply.code(200).type("application/json").send({ status: "ready" });
    } catch {
      await reply
        .code(503)
        .header("retry-after", "5")
        .type("application/json")
        .send({ status: "unavailable" });
    }
  });
}
