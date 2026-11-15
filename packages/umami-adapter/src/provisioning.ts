// SPDX-License-Identifier: Apache-2.0
// Bootstrap B1–B5 and provisioning P1–P12 (wire-formats §j.2, C-85, C-99, C-104, C-112(7), C-112(9)).
// Used only by the provisioning worker (job `umami_reconcile`); its mTLS identity is the only one the engine proxy lets
// through to these routes (§c.5).

import { randomBytes } from "node:crypto";
import {
  engineMessage,
  HttpClient,
  type HttpClientOptions,
  UmamiConflictError,
  UmamiError,
  UmamiHttpError,
} from "./http.ts";

/** Umami's seeded admin (S-01): fixed id, username `admin`, password `umami`. */
export const SEED_ADMIN_ID = "41e2b680-648e-4b09-bcd7-3e2b10c06264";
export const SEED_ADMIN_USERNAME = "admin";
export const SEED_ADMIN_PASSWORD = "umami";

export interface BootstrapSecrets {
  /** B2: the seed admin's interim password, from SOPS (≥ 8 characters, never generated on the fly). */
  seedInterimPassword: string;
  /** B3/P1: the provisioning admin's username and password, from SOPS. */
  provisioningUsername: string;
  provisioningPassword: string;
}

export type BootstrapStep = "B1" | "B2" | "B3" | "B4" | "B5";

export interface BootstrapResult {
  /** Session token of the provisioning admin (P1), held in memory only. */
  token: string;
  /** Steps that this run had to perform (empty when everything was already done). */
  performed: BootstrapStep[];
}

/** Credentials of a provisioned tenant; the caller encrypts `password` and `apiKey` before storing (C-85). */
export interface TenantEngineIdentity {
  teamId: string;
  userId: string;
  username: string;
  password: string;
  apiKeyId: string;
  apiKey: string;
}

export interface WebsiteSpec {
  /** Our pre-assigned id (`sites.umami_website_id` or `umami_twin_website_id`). */
  id: string;
  /** `<site_id>` for the main website, `<site_id>/twin` for the twin (P7t). */
  name: string;
  /** First declared host, or `invalid.example`. */
  domain: string;
  teamId: string;
}

/** The parts of Umami's login answer the worker reads (P1, P5). */
export interface LoginDetail {
  token: string;
  /** `user.id`; null if the engine did not send it. */
  userId: string | null;
  /** `user.teams[].id`: the teams the user is a member of. */
  teamIds: string[];
}

/** Called before P9 for each website; must purge the visit tokens on every core and resolve only when all did. */
export type VisitTokenPurge = (websiteId: string) => Promise<void>;

function str(v: unknown, field: string, template: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new UmamiError(`umami response lacks ${field}`, "POST", template);
  }
  return v;
}

/** `scf-t-<32 hex>` (data-model §8.7 `umami_username`). */
export function tenantUsername(tenantId: string): string {
  const hex = tenantId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error("tenant id must be a UUID");
  return `scf-t-${hex}`;
}

/** 32 random bytes, base64url (P2). */
export function randomPassword(): string {
  return randomBytes(32).toString("base64url");
}

export class UmamiProvisioner {
  readonly #http: HttpClient;

  constructor(opts: HttpClientOptions | HttpClient) {
    this.#http = opts instanceof HttpClient ? opts : new HttpClient(opts);
  }

  /** P1 / B1 / P5: log in; returns the session token, or null on 401 (wrong credentials or no such user). */
  async login(username: string, password: string): Promise<string | null> {
    return (await this.loginDetail(username, password))?.token ?? null;
  }

  /**
   * P1 / P5 with the fields of Umami's login answer that reconciliation needs (verified against 3.5.0): `user.id` and
   * the ids of the teams the user belongs to (`user.teams[].id`). Null on 401/404.
   */
  async loginDetail(username: string, password: string): Promise<LoginDetail | null> {
    const res = await this.#http.call({
      method: "POST",
      path: "/api/auth/login",
      template: "/api/auth/login",
      body: { username, password },
    });
    if (res.status === 401 || res.status === 404) return null;
    if (res.status !== 200) throw new UmamiHttpError("POST", "/api/auth/login", res.status);
    const body = res.body as { token?: unknown; user?: { id?: unknown; teams?: unknown } };
    const token = str(body.token, "token", "/api/auth/login");
    const userId = typeof body.user?.id === "string" ? body.user.id : null;
    const teams = Array.isArray(body.user?.teams)
      ? (body.user.teams as Array<{ id?: unknown }>)
      : [];
    return {
      token,
      userId,
      teamIds: teams.map((t) => t.id).filter((id): id is string => typeof id === "string"),
    };
  }

  /**
   * P2–P6, restartable (C-85, §j.2): `password` must be derivable again after a crash (the control plane derives it
   * from K_umami_creds and the tenant id), so a retry first logs in as the tenant user (P5) and continues from the
   * first missing piece — user, team membership, key. `step` is called after each completed step (tests inject a crash
   * there). A team created by P3 whose P4 never ran stays empty in the engine (Umami lists teams only per member); a
   * new team is created on the retry.
   */
  async ensureTenantIdentity(
    adminToken: string,
    tenantId: string,
    password: string,
    step: (name: "P2" | "P3" | "P4" | "P6") => void = () => {},
  ): Promise<TenantEngineIdentity> {
    const username = tenantUsername(tenantId);
    const login = await this.loginDetail(username, password);
    let userId = login?.userId ?? null;
    if (!login) {
      const user = (await this.#http.expect({
        method: "POST",
        path: "/api/users",
        template: "/api/users",
        bearer: adminToken,
        body: { username, password, role: "view-only" },
      })) as { id?: unknown };
      userId = str(user.id, "id", "/api/users");
      step("P2");
    }
    if (!userId)
      throw new UmamiError("umami login answer lacks user.id", "POST", "/api/auth/login");
    let teamId = login?.teamIds[0];
    if (!teamId) {
      const team = (await this.#http.expect({
        method: "POST",
        path: "/api/teams",
        template: "/api/teams",
        bearer: adminToken,
        body: { name: username },
      })) as unknown;
      const first = Array.isArray(team)
        ? (team[0] as { id?: unknown } | undefined)
        : (team as { id?: unknown });
      teamId = str(first?.id, "team id", "/api/teams");
      step("P3");
      await this.#http.expect({
        method: "POST",
        path: `/api/teams/${teamId}/users`,
        template: "/api/teams/{teamId}/users",
        bearer: adminToken,
        body: { userId, role: "team-view-only" },
      });
      step("P4");
    }
    const key = await this.mintApiKey(username, password);
    step("P6");
    return { teamId, userId, username, password, apiKeyId: key.id, apiKey: key.key };
  }

  /**
   * Restartable bootstrap (C-112(7)). Tries P1 first; if the provisioning admin can log in, it only finishes B4/B5.
   * Otherwise it resumes from the first incomplete step: B1 with `umami`, or B1 with the B2 password when B2 already ran.
   * Throws when the engine is in a state no step sequence explains (e.g. neither password works).
   */
  async ensureBootstrap(secrets: BootstrapSecrets): Promise<BootstrapResult> {
    if (secrets.seedInterimPassword.length < 8 || secrets.provisioningPassword.length < 8) {
      throw new Error("bootstrap passwords must have at least 8 characters");
    }
    const performed: BootstrapStep[] = [];
    let token = await this.login(secrets.provisioningUsername, secrets.provisioningPassword);
    if (!token) {
      // B1 with the original password, else with the interim one (B2 already ran in an earlier attempt).
      let t2: string | null = null;
      const t = await this.login(SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD);
      if (t) {
        performed.push("B1");
        const body = (await this.#http.expect({
          method: "POST",
          path: "/api/me/password",
          template: "/api/me/password",
          bearer: t,
          body: { currentPassword: SEED_ADMIN_PASSWORD, newPassword: secrets.seedInterimPassword },
        })) as { token?: unknown };
        performed.push("B2");
        t2 = str(body.token, "token", "/api/me/password");
      } else {
        t2 = await this.login(SEED_ADMIN_USERNAME, secrets.seedInterimPassword);
        if (!t2) {
          throw new UmamiError(
            "bootstrap cannot proceed: neither the provisioning admin nor the seed admin can log in",
            "POST",
            "/api/auth/login",
          );
        }
        performed.push("B1");
      }
      await this.#http.expect({
        method: "POST",
        path: "/api/users",
        template: "/api/users",
        bearer: t2,
        body: {
          username: secrets.provisioningUsername,
          password: secrets.provisioningPassword,
          role: "admin",
        },
      });
      performed.push("B3");
      token = await this.login(secrets.provisioningUsername, secrets.provisioningPassword);
      if (!token)
        throw new UmamiError(
          "provisioning admin cannot log in after B3",
          "POST",
          "/api/auth/login",
        );
    }
    // B4: the seed admin must be gone. Umami 3.5.0 answers 500 (Prisma P2025) to a DELETE of a missing record, so
    // the lookup P13 decides first (a missing user is `200 null`).
    if (await this.exists(token, "user", SEED_ADMIN_ID)) {
      await this.#http.expect({
        method: "DELETE",
        path: `/api/users/${SEED_ADMIN_ID}`,
        template: "/api/users/{userId}",
        bearer: token,
      });
      performed.push("B4");
    }
    // B5: the seed admin's original credentials must be refused; this opens the engine proxy's gate.
    if ((await this.login(SEED_ADMIN_USERNAME, SEED_ADMIN_PASSWORD)) !== null) {
      throw new UmamiError(
        "bootstrap check B5 failed: seed admin still logs in",
        "POST",
        "/api/auth/login",
      );
    }
    performed.push("B5");
    return { token, performed };
  }

  /** P2–P6: one view-only user, one team, the user as `team-view-only`, and an API key minted by the user itself. */
  async provisionTenant(adminToken: string, tenantId: string): Promise<TenantEngineIdentity> {
    const username = tenantUsername(tenantId);
    const password = randomPassword();
    const user = (await this.#http.expect({
      method: "POST",
      path: "/api/users",
      template: "/api/users",
      bearer: adminToken,
      body: { username, password, role: "view-only" },
    })) as { id?: unknown };
    const userId = str(user.id, "id", "/api/users");
    const team = (await this.#http.expect({
      method: "POST",
      path: "/api/teams",
      template: "/api/teams",
      bearer: adminToken,
      body: { name: username },
    })) as unknown;
    // P3 answers an array [team, membership] (S-01); accessCode is never read beyond this point.
    const first = Array.isArray(team)
      ? (team[0] as { id?: unknown } | undefined)
      : (team as { id?: unknown });
    const teamId = str(first?.id, "team id", "/api/teams");
    await this.#http.expect({
      method: "POST",
      path: `/api/teams/${teamId}/users`,
      template: "/api/teams/{teamId}/users",
      bearer: adminToken,
      body: { userId, role: "team-view-only" },
    });
    const key = await this.mintApiKey(username, password);
    return { teamId, userId, username, password, apiKeyId: key.id, apiKey: key.key };
  }

  /** P5 + P6: the tenant user logs in and creates an API key (shown once). */
  async mintApiKey(username: string, password: string): Promise<{ id: string; key: string }> {
    const session = await this.login(username, password);
    if (!session) throw new UmamiHttpError("POST", "/api/auth/login", 401);
    const body = (await this.#http.expect({
      method: "POST",
      path: "/api/me/api-keys",
      template: "/api/me/api-keys",
      bearer: session,
      body: { name: "scf-control-plane" },
    })) as { id?: unknown; key?: unknown };
    const key = str(body.key, "key", "/api/me/api-keys");
    if (!/^umami_[A-Za-z0-9]{32}$/.test(key))
      throw new UmamiError("unexpected api key format", "POST", "/api/me/api-keys");
    return { id: str(body.id, "id", "/api/me/api-keys"), key };
  }

  /**
   * Rotation (C-85): P5 → P6 (new key) → `verify(newKey)` (the caller stores the key, then proves a read works) → P10.
   * The old key answers 401 afterwards.
   */
  async rotateApiKey(
    username: string,
    password: string,
    oldKeyId: string,
    verify: (newKey: { id: string; key: string }) => Promise<void>,
  ): Promise<{ id: string; key: string }> {
    const fresh = await this.mintApiKey(username, password);
    await verify(fresh);
    const session = await this.login(username, password);
    if (!session) throw new UmamiHttpError("POST", "/api/auth/login", 401);
    await this.#http.expect({
      method: "DELETE",
      path: `/api/me/api-keys/${oldKeyId}`,
      template: "/api/me/api-keys/{keyId}",
      bearer: session,
    });
    return fresh;
  }

  /**
   * P7 / P7t. Idempotent: `400 ID already in use.` counts as success only when the existing website belongs to the
   * same team (an earlier attempt of ours); in any other team, or owned by a user, it is a UmamiConflictError (#26).
   */
  async createWebsite(adminToken: string, spec: WebsiteSpec): Promise<"created" | "exists"> {
    const res = await this.#http.call({
      method: "POST",
      path: "/api/websites",
      template: "/api/websites",
      bearer: adminToken,
      body: { id: spec.id, name: spec.name, domain: spec.domain, teamId: spec.teamId },
    });
    if (res.status === 200) return "created";
    const msg = engineMessage(res.body);
    // Our ids are random UUIDs chosen by the control plane, so "already in use" means an earlier attempt created it.
    if (res.status === 400 && msg === "ID already in use.") {
      const owner = await this.#http.expect({
        method: "GET",
        path: `/api/websites/${spec.id}`,
        template: "/api/websites/{websiteId}",
        bearer: adminToken,
      });
      const teamId =
        typeof owner === "object" && owner !== null
          ? (owner as { teamId?: unknown }).teamId
          : undefined;
      if (teamId === spec.teamId) return "exists";
      throw new UmamiConflictError(
        "POST",
        "/api/websites",
        "website id already in use by another owner",
      );
    }
    throw new UmamiHttpError("POST", "/api/websites", res.status, msg);
  }

  /** P8. */
  async updateWebsite(
    adminToken: string,
    websiteId: string,
    name: string,
    domain: string,
  ): Promise<void> {
    await this.#http.expect({
      method: "POST",
      path: `/api/websites/${websiteId}`,
      template: "/api/websites/{websiteId}",
      bearer: adminToken,
      body: { name, domain },
    });
  }

  /**
   * P9 with the C-112(9) order: the visit-token purge on every core runs first (`purge` resolves only when every core
   * answered 204); only then is the website deleted. A website that is already gone counts as deleted.
   */
  async deleteWebsite(
    adminToken: string,
    websiteId: string,
    purge: VisitTokenPurge,
  ): Promise<void> {
    await purge(websiteId);
    if (!(await this.exists(adminToken, "website", websiteId))) return;
    await this.#http.expect({
      method: "DELETE",
      path: `/api/websites/${websiteId}`,
      template: "/api/websites/{websiteId}",
      bearer: adminToken,
    });
  }

  /** P11: remove the tenant's engine user and team (after P9 for each of its websites). Idempotent through P13. */
  async purgeTenant(adminToken: string, userId: string, teamId: string): Promise<void> {
    if (await this.exists(adminToken, "user", userId)) {
      await this.#http.expect({
        method: "DELETE",
        path: `/api/users/${userId}`,
        template: "/api/users/{userId}",
        bearer: adminToken,
      });
    }
    if (await this.exists(adminToken, "team", teamId)) {
      await this.#http.expect({
        method: "DELETE",
        path: `/api/teams/${teamId}`,
        template: "/api/teams/{teamId}",
        bearer: adminToken,
      });
    }
  }

  /**
   * P13 (addition to §j.2): admin lookup before every DELETE, because Umami 3.5.0 answers a DELETE of a missing record
   * with 500. Measured: a missing user or website is `200 null`, a missing team `404`.
   */
  async exists(
    adminToken: string,
    kind: "user" | "team" | "website",
    id: string,
  ): Promise<boolean> {
    const template = `/api/${kind}s/{${kind}Id}`;
    const res = await this.#http.call({
      method: "GET",
      path: `/api/${kind}s/${id}`,
      template,
      bearer: adminToken,
    });
    if (res.status === 404) return false;
    if (res.status !== 200) throw new UmamiHttpError("GET", template, res.status);
    return res.body !== null && res.body !== "" && typeof res.body === "object";
  }

  /** P12: every website id known to the engine (reconciliation). `team.accessCode` is never read. */
  async listWebsiteIds(adminToken: string, pageSize = 100): Promise<string[]> {
    return (await this.listWebsites(adminToken, pageSize)).map((w) => w.id);
  }

  /**
   * P12 with the owning team (`data[].teamId`, null for a website owned by a user): a website of a tenant's site must
   * belong to that tenant's team, or the tenant's view-only key cannot read it (live reads answer 401).
   */
  async listWebsites(
    adminToken: string,
    pageSize = 100,
  ): Promise<Array<{ id: string; teamId: string | null }>> {
    const out: Array<{ id: string; teamId: string | null }> = [];
    for (let page = 1; ; page++) {
      const body = (await this.#http.expect({
        method: "GET",
        path: "/api/admin/websites",
        template: "/api/admin/websites",
        bearer: adminToken,
        query: { page, pageSize },
      })) as { data?: Array<{ id?: unknown; teamId?: unknown }>; count?: unknown };
      const data = Array.isArray(body.data) ? body.data : [];
      for (const w of data)
        if (typeof w.id === "string")
          out.push({ id: w.id, teamId: typeof w.teamId === "string" ? w.teamId : null });
      const count = typeof body.count === "number" ? body.count : out.length;
      if (data.length === 0 || out.length >= count) return out;
    }
  }
}

/**
 * The C-112(9) purge: `DELETE /internal/v1/visit-tokens/websites/{websiteId}` on **every** core's engine proxy. Resolves
 * only when every core answered 204; otherwise rejects, so the caller retries before P9.
 */
export function visitTokenPurgeOnEveryCore(cores: readonly HttpClient[]): VisitTokenPurge {
  return async (websiteId: string) => {
    if (cores.length === 0)
      throw new Error("no engine proxies configured for the visit-token purge");
    const results = await Promise.allSettled(
      cores.map((c) =>
        c.expect(
          {
            method: "DELETE",
            path: `/internal/v1/visit-tokens/websites/${websiteId}`,
            template: "/internal/v1/visit-tokens/websites/{websiteId}",
          },
          [204],
        ),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      throw new UmamiError(
        `visit-token purge failed on ${failed} of ${cores.length} cores`,
        "DELETE",
        "visit-tokens",
      );
    }
  };
}

/** What the control plane stores about a tenant's engine identity (data-model §8.7), as needed for a purge. */
export interface TenantEnginePurgeSpec {
  userId: string;
  teamId: string;
  /** Every website of the tenant: main and twin ids of all its sites. */
  websiteIds: readonly string[];
}

/**
 * Tenant purge in the engine (§j.2 P9, P11; for job `tenant_purge`): for each website the visit-token purge on every
 * core first, then P13 + P9; then P13 + P11 for the user and the team. Idempotent and restartable: what is already
 * gone is skipped. Resolves only when everything is gone; the caller deletes `umami_credentials` afterwards.
 */
export async function purgeTenantEngine(
  provisioner: UmamiProvisioner,
  adminToken: string,
  spec: TenantEnginePurgeSpec,
  purge: VisitTokenPurge,
): Promise<void> {
  for (const id of spec.websiteIds) await provisioner.deleteWebsite(adminToken, id, purge);
  await provisioner.purgeTenant(adminToken, spec.userId, spec.teamId);
}
