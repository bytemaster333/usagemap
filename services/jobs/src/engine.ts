// SPDX-License-Identifier: Apache-2.0
// The jobs service's only path into the engine: `packages/umami-adapter` through the engine proxy, with the
// provisioner certificate (OU provisioner, C-60, C-113) and the provisioning admin (wire-formats §j.2 P1). Used by job
// `tenant_purge` (P9, P11 with P13 look-ups, and the visit-token purge on every core first — C-110(8), C-112(9)).

import {
  HttpClient,
  purgeTenantEngine,
  type TenantEnginePurgeSpec,
  UmamiProvisioner,
  visitTokenPurgeOnEveryCore,
} from "@usagemap/umami-adapter";

export interface EngineConfig {
  /** This core's engine proxy (P1, P9, P11, P13). */
  url: string;
  /** Every core's engine proxy (visit-token purge before P9). */
  purgeUrls: string[];
  ca: string;
  cert: string;
  key: string;
  user: string;
  password: string;
}

/** What the engine holds for a tenant: every main and twin website, and its user and team when provisioned. */
export interface EngineTenant {
  websiteIds: readonly string[];
  identity: { userId: string; teamId: string } | null;
}

/** Removes a tenant's engine identity and websites; resolves only when everything is gone. */
export interface EnginePurger {
  purgeTenant(t: EngineTenant): Promise<void>;
}

export class AdapterEnginePurger implements EnginePurger {
  readonly #prov: UmamiProvisioner;
  readonly #cores: HttpClient[];
  readonly #user: string;
  readonly #password: string;

  constructor(cfg: EngineConfig) {
    const tls = { cert: cfg.cert, key: cfg.key, ca: cfg.ca };
    this.#prov = new UmamiProvisioner(new HttpClient({ baseUrl: cfg.url, tls, timeoutMs: 30_000 }));
    this.#cores = cfg.purgeUrls.map(
      (baseUrl) => new HttpClient({ baseUrl, tls, timeoutMs: 10_000 }),
    );
    this.#user = cfg.user;
    this.#password = cfg.password;
  }

  async purgeTenant(t: EngineTenant): Promise<void> {
    const token = await this.#prov.login(this.#user, this.#password);
    if (!token) {
      throw Object.assign(new Error("provisioning admin login refused"), {
        name: "EngineLoginRefused",
      });
    }
    const purge = visitTokenPurgeOnEveryCore(this.#cores);
    if (t.identity) {
      const spec: TenantEnginePurgeSpec = { ...t.identity, websiteIds: t.websiteIds };
      await purgeTenantEngine(this.#prov, token, spec, purge);
      return;
    }
    // Sites without an engine identity (provisioning never finished): P9 per website, same order and checks.
    for (const id of t.websiteIds) await this.#prov.deleteWebsite(token, id, purge);
  }
}
