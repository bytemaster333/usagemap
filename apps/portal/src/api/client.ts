// SPDX-License-Identifier: Apache-2.0
// Typed client for the control-plane API (docs/api/control-plane.openapi.yaml), the portal's only backend (ADR-0024).
// Types come from @usagemap/api-types (generated from the OpenAPI document); the runtime table below names the
// method and path of every operation the portal calls and is checked against those types at compile time, so a
// contract change that moves or renames an operation breaks the build instead of the page.
//
// Contract rules implemented here:
// - same origin: the portal's web server proxies /v1/* to the control plane, so requests are relative and carry the
//   session cookie (`credentials: "same-origin"`); the cookie is HttpOnly and never touched by script;
// - CSRF (C-20): every POST/PUT/PATCH/DELETE sends `X-SCF-Request: 1` (the browser adds `Origin`);
// - errors are RFC 9457 problem details (`ApiError.problem`);
// - `403 recent_auth_required` / `403 step_up_required` (C-87, C-09, C-114) ask the registered re-authentication
//   handler for a fresh sign-in and retry the request once;
// - `401` tells the registered handler that the session is gone.

import type { ControlPlane } from "@usagemap/api-types";

export type Ops = ControlPlane.Operations;
export type OpId = keyof Ops;
export type Problem = ControlPlane.Problem;
export type ProblemCode = ControlPlane.ProblemCode;

type OpTable = { [K in OpId]?: { method: Ops[K]["method"]; path: Ops[K]["path"] } };

export const OPERATIONS = {
  authStellarChallenge: { method: "post", path: "/v1/auth/stellar/challenge" },
  authStellarVerify: { method: "post", path: "/v1/auth/stellar/verify" },
  authPasskeyRegistrationOptions: {
    method: "post",
    path: "/v1/auth/passkeys/registration/options",
  },
  authPasskeyRegistrationVerify: { method: "post", path: "/v1/auth/passkeys/registration/verify" },
  authPasskeyAssertionOptions: { method: "post", path: "/v1/auth/passkeys/assertion/options" },
  authPasskeyAssertionVerify: { method: "post", path: "/v1/auth/passkeys/assertion/verify" },
  authGetSession: { method: "get", path: "/v1/auth/session" },
  authLogout: { method: "post", path: "/v1/auth/logout" },
  getMe: { method: "get", path: "/v1/me" },
  listMyTenants: { method: "get", path: "/v1/me/tenants" },
  listMyIdentities: { method: "get", path: "/v1/me/identities" },
  unlinkIdentity: { method: "delete", path: "/v1/me/identities/{identityId}" },
  listMyPasskeys: { method: "get", path: "/v1/me/passkeys" },
  deletePasskey: { method: "delete", path: "/v1/me/passkeys/{credentialId}" },
  createTenant: { method: "post", path: "/v1/tenants" },
  getTenant: { method: "get", path: "/v1/tenants/{tenantId}" },
  listSites: { method: "get", path: "/v1/tenants/{tenantId}/sites" },
  createSite: { method: "post", path: "/v1/tenants/{tenantId}/sites" },
  getSite: { method: "get", path: "/v1/tenants/{tenantId}/sites/{siteId}" },
  updateSite: { method: "patch", path: "/v1/tenants/{tenantId}/sites/{siteId}" },
  setSiteAnonymousReports: {
    method: "put",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/anonymous-reports",
  },
  listDomains: { method: "get", path: "/v1/tenants/{tenantId}/sites/{siteId}/domains" },
  addDomain: { method: "post", path: "/v1/tenants/{tenantId}/sites/{siteId}/domains" },
  removeDomain: {
    method: "delete",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/domains/{domainId}",
  },
  startDomainVerification: {
    method: "post",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/domains/{domainId}/verifications",
  },
  checkDomainVerification: {
    method: "post",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/domains/{domainId}/verifications/{verificationId}/check",
  },
  getInstallationCheck: {
    method: "get",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/installation",
  },
  getSnippet: { method: "get", path: "/v1/tenants/{tenantId}/sites/{siteId}/snippet" },
  listTrackerVersions: { method: "get", path: "/v1/tracker/versions" },
  getWebStats: { method: "get", path: "/v1/tenants/{tenantId}/sites/{siteId}/web/stats" },
  getWebTimeseries: {
    method: "get",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/web/timeseries",
  },
  getWebBreakdown: { method: "get", path: "/v1/tenants/{tenantId}/sites/{siteId}/web/breakdown" },
  exportWebDaily: { method: "get", path: "/v1/tenants/{tenantId}/sites/{siteId}/web/export" },
  // API analytics and onboarding (dashboard.api-*, isolation.api-dashboard, operator.api-*)
  listServices: { method: "get", path: "/v1/tenants/{tenantId}/services" },
  createService: { method: "post", path: "/v1/tenants/{tenantId}/services" },
  getService: { method: "get", path: "/v1/tenants/{tenantId}/services/{serviceId}" },
  updateService: { method: "patch", path: "/v1/tenants/{tenantId}/services/{serviceId}" },
  getOtelConfig: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/otel-config",
  },
  getServiceDataQuality: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/data-quality",
  },
  getSecretSeedWarning: { method: "get", path: "/v1/tenants/{tenantId}/secret-seed-warning" },
  acknowledgeSecretSeedWarning: {
    method: "post",
    path: "/v1/tenants/{tenantId}/secret-seed-warning/acknowledge",
  },
  listIngestTokens: { method: "get", path: "/v1/tenants/{tenantId}/ingest-tokens" },
  createIngestToken: { method: "post", path: "/v1/tenants/{tenantId}/ingest-tokens" },
  revokeIngestToken: { method: "delete", path: "/v1/tenants/{tenantId}/ingest-tokens/{tokenId}" },
  updateTenant: { method: "patch", path: "/v1/tenants/{tenantId}" },
  // Members and invitations (tenancy.sites-and-services, C-08)
  listMembers: { method: "get", path: "/v1/tenants/{tenantId}/members" },
  updateMember: { method: "patch", path: "/v1/tenants/{tenantId}/members/{userId}" },
  removeMember: { method: "delete", path: "/v1/tenants/{tenantId}/members/{userId}" },
  listInvitations: { method: "get", path: "/v1/tenants/{tenantId}/invitations" },
  createInvitation: { method: "post", path: "/v1/tenants/{tenantId}/invitations" },
  revokeInvitation: {
    method: "delete",
    path: "/v1/tenants/{tenantId}/invitations/{invitationId}",
  },
  acceptInvitation: { method: "post", path: "/v1/invitations/accept" },
  // Verification ladder: level, evidence and the L2 Stellar account link (C-19)
  getVerification: { method: "get", path: "/v1/tenants/{tenantId}/verification" },
  verificationStellarChallenge: {
    method: "post",
    path: "/v1/tenants/{tenantId}/verification/stellar/challenge",
  },
  verificationStellarVerify: {
    method: "post",
    path: "/v1/tenants/{tenantId}/verification/stellar/verify",
  },
  // Share keys for the metrics_endpoint (C-14, C-70; recent sign-in C-129)
  listShareKeys: { method: "get", path: "/v1/tenants/{tenantId}/share-keys" },
  createShareKey: { method: "post", path: "/v1/tenants/{tenantId}/share-keys" },
  revokeShareKey: { method: "delete", path: "/v1/tenants/{tenantId}/share-keys/{keyId}" },
  // Public programme outputs (wire-formats §i; no session needed)
  getMetricsEndpoint: { method: "get", path: "/public/v1/projects/{slug}/metrics.json" },
  getPublicSnapshot: { method: "get", path: "/public/v1/snapshots/{snapshotId}" },
  getSnapshotKeys: { method: "get", path: "/.well-known/scf-snapshot-keys.json" },
  // Signed traction snapshots (C-121, F16: signed by the jobs service; 202 while pending)
  listTractionSnapshots: { method: "get", path: "/v1/tenants/{tenantId}/traction-snapshots" },
  createTractionSnapshot: { method: "post", path: "/v1/tenants/{tenantId}/traction-snapshots" },
  revokeTractionSnapshot: {
    method: "post",
    path: "/v1/tenants/{tenantId}/traction-snapshots/{snapshotId}/revoke",
  },
  getApiSummary: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/api/summary",
  },
  getApiTimeseries: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/api/timeseries",
  },
  getApiStatusCodes: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/api/status-codes",
  },
  listApiRoutes: { method: "get", path: "/v1/tenants/{tenantId}/services/{serviceId}/api/routes" },
  exportApiRoutes: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/api/routes/export",
  },
  getApiSurfaces: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/api/surfaces",
  },
  // Erasure (privacy.tenant-erasure)
  listErasureRequests: { method: "get", path: "/v1/tenants/{tenantId}/erasure-requests" },
  createErasureRequest: { method: "post", path: "/v1/tenants/{tenantId}/erasure-requests" },
  getErasureRequest: {
    method: "get",
    path: "/v1/tenants/{tenantId}/erasure-requests/{requestId}",
  },
  confirmErasureRequest: {
    method: "post",
    path: "/v1/tenants/{tenantId}/erasure-requests/{requestId}/confirm",
  },
  cancelErasureRequest: {
    method: "post",
    path: "/v1/tenants/{tenantId}/erasure-requests/{requestId}/cancel",
  },
  // SCF operator console (operator.global-view-credentials, operator.web-*, operator.api-*)
  operatorListTenants: { method: "get", path: "/v1/operator/tenants" },
  operatorGetTenant: { method: "get", path: "/v1/operator/tenants/{tenantId}" },
  operatorTransitionTenant: { method: "post", path: "/v1/operator/tenants/{tenantId}/transitions" },
  operatorRemoveTenant: { method: "post", path: "/v1/operator/tenants/{tenantId}/removal" },
  operatorRestoreTenant: { method: "post", path: "/v1/operator/tenants/{tenantId}/restoration" },
  operatorPurgeTenant: { method: "post", path: "/v1/operator/tenants/{tenantId}/purge" },
  operatorListTombstones: { method: "get", path: "/v1/operator/tombstones" },
  operatorLiftTombstone: { method: "post", path: "/v1/operator/tombstones/{tombstoneId}/lift" },
  operatorGetSettings: { method: "get", path: "/v1/operator/settings" },
  operatorGetEnrollmentMode: { method: "get", path: "/v1/operator/settings/enrollment-mode" },
  operatorSetEnrollmentMode: { method: "put", path: "/v1/operator/settings/enrollment-mode" },
  operatorUpdateSetting: { method: "patch", path: "/v1/operator/settings/{key}" },
  operatorSetSiteMultiplicityMode: {
    method: "put",
    path: "/v1/operator/tenants/{tenantId}/sites/{siteId}/multiplicity-mode",
  },
  operatorWebSummary: { method: "get", path: "/v1/operator/web/summary" },
  operatorWebProjects: { method: "get", path: "/v1/operator/web/projects" },
  operatorWebCompare: { method: "get", path: "/v1/operator/web/compare" },
  operatorWebBreakdown: { method: "get", path: "/v1/operator/web/breakdown" },
  operatorApiSummary: { method: "get", path: "/v1/operator/api/summary" },
  operatorApiServices: { method: "get", path: "/v1/operator/api/services" },
  operatorApiCompare: { method: "get", path: "/v1/operator/api/compare" },
  operatorApiRoutes: { method: "get", path: "/v1/operator/api/routes" },
  operatorListAudit: { method: "get", path: "/v1/operator/audit" },
  operatorListErasureRequests: { method: "get", path: "/v1/operator/erasure-requests" },
  operatorListApiKeys: { method: "get", path: "/v1/operator/api-keys" },
  operatorCreateApiKey: { method: "post", path: "/v1/operator/api-keys" },
  operatorRevokeApiKey: { method: "post", path: "/v1/operator/api-keys/{keyId}/revoke" },
  // Usage, trust and snapshots (C-136, C-137): overview, trust, first-event panel, wallet funnel, footprint, snapshot list, seal, cohorts
  listSiteTrustScores: {
    method: "get",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/trust-scores",
  },
  listAnnotations: { method: "get", path: "/v1/tenants/{tenantId}/annotations" },
  createAnnotation: { method: "post", path: "/v1/tenants/{tenantId}/annotations" },
  getOnchainDaily: { method: "get", path: "/v1/tenants/{tenantId}/onchain/daily" },
  getApiAssurance: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/api/assurance",
  },
  listSiteDevEvents: { method: "get", path: "/v1/tenants/{tenantId}/sites/{siteId}/dev-events" },
  setSiteDebugMode: { method: "put", path: "/v1/tenants/{tenantId}/sites/{siteId}/debug-mode" },
  getSiteWalletFunnel: {
    method: "get",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/web/wallet-funnel",
  },
  getWebFunnelReport: {
    method: "get",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/web/reports/funnel",
  },
  getWebGoalsReport: {
    method: "get",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/web/reports/goals",
  },
  getWebJourneyReport: {
    method: "get",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/web/reports/journey",
  },
  listFootprint: { method: "get", path: "/v1/tenants/{tenantId}/footprint" },
  addFootprintItem: { method: "post", path: "/v1/tenants/{tenantId}/footprint" },
  removeFootprintItem: { method: "delete", path: "/v1/tenants/{tenantId}/footprint/{itemId}" },
  verifyFootprintItem: {
    method: "post",
    path: "/v1/tenants/{tenantId}/footprint/{itemId}/verify",
  },
  getPublicSnapshotList: { method: "get", path: "/public/v1/projects/{slug}/snapshots" },
  getSnapshotSealProof: { method: "get", path: "/public/v1/snapshots/{snapshotId}/seal" },
  listSealDays: { method: "get", path: "/public/v1/seals" },
  // "Verify this number"
  getSealedAuditAnchor: { method: "get", path: "/public/v1/audit-anchors/{day}" },
  getPublishedThresholds: { method: "get", path: "/public/v1/thresholds" },
  operatorCohorts: { method: "get", path: "/v1/operator/cohorts" },
  // Onboarding of SCF-awarded projects (registry picker, pre-fill, integration kit, coverage)
  searchRegistryProjects: { method: "get", path: "/public/v1/registry/projects" },
  getRegistryProjectPrefill: {
    method: "get",
    path: "/v1/onboarding/registry-projects/{registryProjectId}",
  },
  getIntegrationKit: { method: "get", path: "/v1/tenants/{tenantId}/onboarding/kit" },
  operatorRegistryCoverage: { method: "get", path: "/v1/operator/onboarding/coverage" },
  // Integration catalogue (pick → generated config → test → live check)
  listIntegrations: { method: "get", path: "/v1/tenants/{tenantId}/integrations" },
  getIntegrationStatus: { method: "get", path: "/v1/tenants/{tenantId}/integrations/status" },
  // Ecosystem Usage Map
  operatorUsageMap: { method: "get", path: "/v1/operator/usage-map" },
  operatorUsageMapProject: { method: "get", path: "/v1/operator/usage-map/{registryProjectId}" },
  getTenantUsageMap: { method: "get", path: "/v1/tenants/{tenantId}/onchain/usage-map" },
  // Protocol interactions (migration 0082)
  getTenantProtocols: { method: "get", path: "/v1/tenants/{tenantId}/onchain/protocols" },
  operatorProtocols: { method: "get", path: "/v1/operator/protocols" },
  operatorOverview: { method: "get", path: "/v1/operator/overview" },
  operatorWebVerdicts: { method: "get", path: "/v1/operator/web/verdicts" },
  operatorCampaignComparison: { method: "get", path: "/v1/operator/comparisons/campaign" },
  operatorTrustScores: { method: "get", path: "/v1/operator/trust-scores" },
  operatorListOperators: { method: "get", path: "/v1/operator/operators" },
  operatorGrant: { method: "post", path: "/v1/operator/operators" },
  operatorRevoke: { method: "delete", path: "/v1/operator/operators/{userId}" },
  // Integration client metrics and app events (migrations 0085 / 0084)
  getPartnerCalls: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/partner-calls",
  },
  getPaymentEvents: { method: "get", path: "/v1/tenants/{tenantId}/services/{serviceId}/payments" },
  getAnchorFunnel: { method: "get", path: "/v1/tenants/{tenantId}/anchor-funnel" },
  getAppEvents: { method: "get", path: "/v1/tenants/{tenantId}/app-events" },
  // Stellar SDK client metrics of a service (C-153)
  getStellarClientMetrics: {
    method: "get",
    path: "/v1/tenants/{tenantId}/services/{serviceId}/stellar-client",
  },
  // Footprint registration keys for build tools and the user-tracking paragraph
  listFootprintKeys: { method: "get", path: "/v1/tenants/{tenantId}/footprint-keys" },
  createFootprintKey: { method: "post", path: "/v1/tenants/{tenantId}/footprint-keys" },
  revokeFootprintKey: { method: "delete", path: "/v1/tenants/{tenantId}/footprint-keys/{keyId}" },
  getUserTrackingStatement: {
    method: "get",
    path: "/v1/tenants/{tenantId}/evidence/user-tracking",
  },
  // MCP OAuth consent and connected apps
  getOAuthRequest: { method: "get", path: "/v1/oauth/requests/{requestId}" },
  approveOAuthRequest: { method: "post", path: "/v1/oauth/requests/{requestId}/approve" },
  denyOAuthRequest: { method: "post", path: "/v1/oauth/requests/{requestId}/deny" },
  listMyOAuthGrants: { method: "get", path: "/v1/me/oauth-grants" },
  revokeMyOAuthGrant: { method: "delete", path: "/v1/me/oauth-grants/{grantId}" },
  // Browser Stellar RPC/Horizon daily totals of a site (migration 0086)
  getSiteBrowserRpc: {
    method: "get",
    path: "/v1/tenants/{tenantId}/sites/{siteId}/web/browser-rpc",
  },
} as const satisfies OpTable;

export type PortalOpId = keyof typeof OPERATIONS;

type SuccessStatus = "200" | "201" | "202" | "204";
/** Union of the success bodies of an operation; `undefined` for 204. */
export type Success<K extends OpId> = {
  [S in keyof Ops[K]["responses"]]: S extends SuccessStatus
    ? S extends "204"
      ? undefined
      : Ops[K]["responses"][S]
    : never;
}[keyof Ops[K]["responses"]];

/** Operations without path parameters are typed `Record<string, never>`, to which `{}` is assignable. */
type PathArg<K extends OpId> =
  Record<string, never> extends Ops[K]["pathParams"]
    ? { path?: undefined }
    : { path: Ops[K]["pathParams"] };
type BodyArg<K extends OpId> = [Ops[K]["requestBody"]] extends [never]
  ? { body?: undefined }
  : { body: Ops[K]["requestBody"] };
export type CallArgs<K extends OpId> = PathArg<K> &
  BodyArg<K> & {
    query?: Ops[K]["query"] | undefined;
    signal?: AbortSignal | undefined;
    /**
     * `Authorization: Bearer …` for the public metrics_endpoint read with a share key (C-14). The key stays in the
     * caller's memory; it is never put in the URL (the endpoint refuses that).
     */
    bearer?: string | undefined;
  };

/** A failed call: HTTP status plus the problem document (synthesised when the answer was not problem+json). */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  /** seconds, from `Retry-After` on 429/503 */
  readonly retryAfter: number | undefined;
  constructor(status: number, problem: Problem, retryAfter?: number) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
    this.retryAfter = retryAfter;
  }
  get code(): ProblemCode | undefined {
    return this.problem.code;
  }
}

export type ReauthKind = "recent_auth_required" | "step_up_required";

export interface ClientHooks {
  /** Asked for a fresh sign-in (recent authentication or step-up); resolves true when one succeeded. */
  reauthenticate?: (kind: ReauthKind) => Promise<boolean>;
  /** Told that the session is missing or expired (401 on an operation that needs one). */
  onUnauthenticated?: () => void;
}

const STATE_CHANGING = new Set(["post", "put", "patch", "delete"]);

/** The detail of the 403 every write gets while the platform is in read-only mode (ops.end-of-window-read-only). */
export const READ_ONLY_DETAIL = "the platform is in read-only mode";

/** Whether a refusal is the platform's read-only mode (not a permission problem of the caller). */
export function isReadOnlyRefusal(status: number, problem: Pick<Problem, "detail">): boolean {
  return (
    status === 403 &&
    typeof problem.detail === "string" &&
    problem.detail.startsWith(READ_ONLY_DETAIL)
  );
}

/** Fills `{name}` placeholders; every value is percent-encoded so an id can never add a path segment. */
export function buildPath(template: string, params: Record<string, string> | undefined): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === "") throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(v);
  });
}

/** Array query parameters with `explode: true` in the OpenAPI document (values may contain commas): repeated. */
export const EXPLODED_QUERY = new Set(["step", "goal"]);

/** Query string per the OpenAPI document: arrays are `form` / `explode: false` (comma-joined) unless exploded. */
export function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (EXPLODED_QUERY.has(k)) for (const x of v) sp.append(k, String(x));
      else if (v.length > 0) sp.set(k, v.map(String).join(","));
    } else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function operationUrl<K extends PortalOpId>(
  op: K,
  args: { path?: Record<string, string> | undefined; query?: Record<string, unknown> | undefined },
): string {
  const def = OPERATIONS[op];
  return buildPath(def.path, args.path) + buildQuery(args.query);
}

function retryAfterSeconds(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.round((t - Date.now()) / 1000));
}

const FALLBACK_TITLES: Record<number, string> = {
  400: "The request was not accepted",
  401: "You are not signed in",
  403: "Not allowed",
  404: "Not found",
  409: "Conflict",
  429: "Too many requests",
  500: "Server error",
  501: "Not available yet",
  502: "The service could not be reached",
  503: "Temporarily unavailable",
  504: "The service did not answer in time",
};

async function problemOf(res: Response): Promise<Problem> {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      const body = (await res.json()) as Partial<Problem>;
      if (body && typeof body === "object" && typeof body.title === "string") {
        return { type: body.type ?? "about:blank", status: res.status, ...body } as Problem;
      }
    } catch {
      // fall through to the synthesised problem
    }
  }
  return {
    type: "about:blank",
    title: FALLBACK_TITLES[res.status] ?? `Request failed (${res.status})`,
    status: res.status,
  };
}

export class ApiClient {
  readonly #fetch: typeof fetch;
  #hooks: ClientHooks = {};
  readonly #readOnlyListeners = new Set<() => void>();

  constructor(fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)) {
    this.#fetch = fetchImpl;
  }

  setHooks(hooks: ClientHooks): void {
    this.#hooks = hooks;
  }

  /** Called whenever a write is refused because the platform is in read-only mode; returns the unsubscribe. */
  onReadOnly(listener: () => void): () => void {
    this.#readOnlyListeners.add(listener);
    return () => {
      this.#readOnlyListeners.delete(listener);
    };
  }

  async call<K extends PortalOpId>(op: K, args: CallArgs<K>): Promise<Success<K>> {
    return this.#withReauth(op, args, undefined);
  }

  /**
   * For operations that can also answer `text/csv`: asks for JSON and rejects anything else, so the page gets the
   * JSON body type only.
   */
  async json<K extends PortalOpId>(op: K, args: CallArgs<K>): Promise<Exclude<Success<K>, string>> {
    const r = await this.#withReauth(op, args, undefined);
    if (typeof r === "string") throw new Error(`${op}: expected a JSON answer`);
    return r as Exclude<Success<K>, string>;
  }

  /** The `text/csv` representation of an operation that offers one (OpenAPI: same columns as the JSON rows). */
  async csv<K extends PortalOpId>(op: K, args: CallArgs<K>): Promise<string> {
    const r = await this.#withReauth(op, args, "text/csv");
    if (typeof r !== "string") throw new Error(`${op}: expected a CSV answer`);
    return r;
  }

  async #withReauth<K extends PortalOpId>(
    op: K,
    args: CallArgs<K>,
    accept: string | undefined,
  ): Promise<Success<K>> {
    try {
      return await this.#once(op, args, accept);
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 403 &&
        (e.code === "recent_auth_required" || e.code === "step_up_required") &&
        this.#hooks.reauthenticate
      ) {
        const ok = await this.#hooks.reauthenticate(e.code);
        if (ok) return this.#once(op, args, accept);
      }
      throw e;
    }
  }

  async #once<K extends PortalOpId>(
    op: K,
    args: CallArgs<K>,
    accept: string | undefined,
  ): Promise<Success<K>> {
    const def = OPERATIONS[op];
    const url = operationUrl(op, {
      path: args.path as Record<string, string> | undefined,
      query: args.query as Record<string, unknown> | undefined,
    });
    const headers: Record<string, string> = {
      Accept: accept
        ? `${accept}, application/problem+json`
        : "application/json, application/problem+json",
    };
    if (STATE_CHANGING.has(def.method)) headers["X-SCF-Request"] = "1";
    if (args.bearer) headers.Authorization = `Bearer ${args.bearer}`;
    let body: string | undefined;
    if (args.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(args.body);
    }
    const init: RequestInit = {
      method: def.method.toUpperCase(),
      headers,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    };
    if (body !== undefined) init.body = body;
    if (args.signal) init.signal = args.signal;
    const res = await this.#fetch(url, init);
    if (!res.ok) {
      const problem = await problemOf(res);
      if (res.status === 401 && op !== "authGetSession") this.#hooks.onUnauthenticated?.();
      if (isReadOnlyRefusal(res.status, problem)) for (const l of this.#readOnlyListeners) l();
      throw new ApiError(res.status, problem, retryAfterSeconds(res));
    }
    if (res.status === 204) return undefined as Success<K>;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("json")) return (await res.json()) as Success<K>;
    return (await res.text()) as Success<K>;
  }
}

export const api = new ApiClient();
