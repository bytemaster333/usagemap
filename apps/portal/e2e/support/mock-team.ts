// SPDX-License-Identifier: Apache-2.0
// Mock control plane, part 3: members and invitations (tenancy.sites-and-services) and the verification ladder's L2 step (C-19), following
// services/control-plane/src/domain/tenants.ts and verify/ladder.ts where the portal depends on them: `tenant:viewer`
// reads, `tenant:admin` writes (403 `forbidden` otherwise), the owner neither changed nor removed (403 / 409),
// invitation codes `scfi_` + 22 base62 shown once and stored as a hash, single-use, expiring; a code that is unknown,
// used, revoked or expired → 404. L2: single-use challenges bound to tenant and member, SEP-53 message signatures and
// SEP-10 challenge transactions verified for real (Ed25519), then the three checks in the control plane's order —
// home_domain set, home_domain a verified domain of the tenant, stellar.toml lists the account — each failing with
// `422 unprocessable` and the control plane's reason. The "network" (signer weights, home_domain, stellar.toml) is a
// table the tests set through /__mock/stellar-account.

import { createHash, type KeyObject, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ControlPlane } from "@usagemap/api-types";
import type { Answer } from "./mock-extra.ts";
import { MockProblem as Problem } from "./mock-extra.ts";
import { buildChallenge, signedBy } from "./sep10.ts";

type Json = Record<string, unknown>;
type Role = ControlPlane.TenantRole;
type TenantRow = ControlPlane.Tenant & { members: Map<string, Role> };

export const MOCK_PASSPHRASE = "Test SDF Network ; September 2015";
const TEN_MIN = 10 * 60_000;
const LEVELS: ControlPlane.VerificationLevel[] = ["L0", "L1", "L2", "L3", "L4"];
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const b62 = (n: number) => [...randomBytes(n)].map((b) => B62[b % 62]).join("");
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface TeamCtx {
  tenants(): Map<string, TenantRow>;
  /** complete session → internal user id */
  session(req: IncomingMessage): { userId: string };
  /** internal user id ↔ the uuid the API shows */
  userUuid(id: string): string;
  userIdOf(uuid: string): string | undefined;
  userName(id: string): string | null;
  /** SEP-53 signature check of the mock (Ed25519 over the SEP-53 digest) */
  verifySep53(account: string, message: string, signature: string): boolean;
  /** the account's Ed25519 public key (raw 32 bytes and as a KeyObject) */
  accountKey(account: string): { raw: Buffer; key: KeyObject };
  /** the deployment's SEP-10 signing key, or null when SEP-10 is not configured */
  sep10(): { pub: Buffer; key: KeyObject } | null;
}

interface Invitation extends ControlPlane.Invitation {
  tenantId: string;
  codeHash: string;
  acceptedAt: number | null;
  revokedAt: number | null;
}

export interface MockAccount {
  /** home_domain on the account (null = unset) */
  home_domain: string | null;
  /** whether the home domain's stellar.toml lists the account in ACCOUNTS */
  listed: boolean;
}

interface LinkChallenge {
  tenantId: string;
  userId: string;
  account: string;
  method: "sep53" | "sep10";
  message?: string;
  tx?: Buffer;
  expires: number;
}

export interface TeamState {
  invitations: Map<string, Invitation>;
  /** `${tenantId}:${userId}` → added_at */
  addedAt: Map<string, string>;
  evidence: Map<string, ControlPlane.Evidence[]>;
  accounts: Map<string, MockAccount>;
  challenges: Map<string, LinkChallenge>;
}

export function seedTeam(): TeamState {
  return {
    invitations: new Map(),
    addedAt: new Map(),
    evidence: new Map(),
    accounts: new Map(),
    challenges: new Map(),
  };
}

/** Test control: sets a tenant's level and its verified domains (domain evidence); clears other evidence. */
export function setVerification(
  st: TeamState,
  t: TenantRow,
  level: ControlPlane.VerificationLevel,
  domains: string[],
): void {
  t.verification_level = level;
  st.evidence.set(
    t.tenant_id,
    domains.map((d) => ({
      evidence_id: randomUUID(),
      kind: "domain" as const,
      subject: d,
      status: "valid" as const,
      verified_at: "2026-09-03T10:00:00Z",
      last_checked_at: "2026-11-01T06:00:00Z",
      details: { method: "dns_txt" },
    })),
  );
}

type Handler = (ctx: {
  req: IncomingMessage;
  q: URLSearchParams;
  p: Record<string, string>;
  body: Json;
}) => Answer;

export function teamHandlers(ctx: TeamCtx, state: () => TeamState): Record<string, Handler> {
  const tenantAs = (req: IncomingMessage, tenantId: string, need: "viewer" | "admin") => {
    const { userId } = ctx.session(req);
    const t = ctx.tenants().get(tenantId);
    const role = t?.members.get(userId);
    if (!t || !role) throw new Problem(404, "not_found", "Not found");
    if (need === "admin" && role !== "owner" && role !== "admin")
      throw new Problem(403, "forbidden", "Not allowed", { detail: "requires tenant:admin" });
    return { t, userId, role };
  };
  const added = (tenantId: string, userId: string) =>
    state().addedAt.get(`${tenantId}:${userId}`) ?? "2026-09-01T12:00:00Z";
  const member = (t: TenantRow, userId: string): ControlPlane.Member => ({
    user_id: ctx.userUuid(userId),
    display_name: ctx.userName(userId),
    role: t.members.get(userId) as Role,
    added_at: added(t.tenant_id, userId),
  });
  const invitationView = (i: Invitation): ControlPlane.Invitation => ({
    invitation_id: i.invitation_id,
    role: i.role,
    note: i.note ?? null,
    created_at: i.created_at,
    expires_at: i.expires_at,
  });
  const open = (i: Invitation) =>
    i.acceptedAt === null && i.revokedAt === null && Date.parse(i.expires_at) > Date.now();
  const memberTarget = (t: TenantRow, uuid: string) => {
    const id = ctx.userIdOf(uuid);
    if (!id || !t.members.has(id)) throw new Problem(404, "not_found", "Not found");
    return id;
  };
  const evidenceOf = (tenantId: string) => state().evidence.get(tenantId) ?? [];
  const status = (t: TenantRow): ControlPlane.VerificationStatus => {
    const ev = evidenceOf(t.tenant_id);
    const lvl = LEVELS.indexOf(t.verification_level);
    const hasAccount = ev.some((e) => e.kind === "stellar_account" && e.status === "valid");
    const next: NonNullable<ControlPlane.VerificationStatus["next_steps"]> = [];
    if (lvl < 1) next.push("verify_domain");
    if (!hasAccount && lvl < 2) next.push("link_stellar_account");
    if (lvl >= 1 && lvl < 3) next.push("await_registry_match");
    if (lvl === 3) next.push("await_operator_approval");
    return { level: t.verification_level, evidence: ev, registry_links: [], next_steps: next };
  };
  const failed = (detail: string) =>
    new Problem(422, "unprocessable", "Verification failed", { detail });

  return {
    listMembers: ({ req, p }) => {
      const { t } = tenantAs(req, p.tenantId as string, "viewer");
      return { status: 200, body: [...t.members.keys()].map((u) => member(t, u)) };
    },
    updateMember: ({ req, p, body }) => {
      const { t } = tenantAs(req, p.tenantId as string, "admin");
      const id = memberTarget(t, p.userId as string);
      if (!["admin", "member", "viewer"].includes(String(body.role)))
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [{ pointer: "/role", detail: "must be admin, member or viewer" }],
        });
      if (t.members.get(id) === "owner")
        throw new Problem(403, "forbidden", "Not allowed", {
          detail: "use ownership transfer to change the owner",
        });
      t.members.set(id, body.role as Role);
      return { status: 200, body: member(t, id) };
    },
    removeMember: ({ req, p }) => {
      const { t } = tenantAs(req, p.tenantId as string, "admin");
      const id = memberTarget(t, p.userId as string);
      if (t.members.get(id) === "owner")
        throw new Problem(409, "conflict", "Conflict", { detail: "the owner cannot be removed" });
      t.members.delete(id);
      return { status: 204 };
    },
    listInvitations: ({ req, p }) => {
      const { t } = tenantAs(req, p.tenantId as string, "admin");
      return {
        status: 200,
        body: [...state().invitations.values()]
          .filter((i) => i.tenantId === t.tenant_id && open(i))
          .map(invitationView),
      };
    },
    createInvitation: ({ req, p, body }) => {
      const { t } = tenantAs(req, p.tenantId as string, "admin");
      const hours = body.expires_in_hours === undefined ? 72 : Number(body.expires_in_hours);
      const errors: Json[] = [];
      if (!["admin", "member", "viewer"].includes(String(body.role)))
        errors.push({ pointer: "/role", detail: "must be admin, member or viewer" });
      if (!Number.isInteger(hours) || hours < 1 || hours > 168)
        errors.push({ pointer: "/expires_in_hours", detail: "1–168" });
      if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 200))
        errors.push({ pointer: "/note", detail: "at most 200 characters" });
      if (errors.length)
        throw new Problem(400, "validation_failed", "Validation failed", { errors });
      const code = `scfi_${b62(22)}`;
      const now = Date.now();
      const inv: Invitation = {
        tenantId: t.tenant_id,
        invitation_id: randomUUID(),
        role: body.role as Role,
        note: (body.note as string | undefined) ?? null,
        created_at: iso(now),
        expires_at: iso(now + hours * 3600_000),
        codeHash: sha(code),
        acceptedAt: null,
        revokedAt: null,
      };
      state().invitations.set(inv.invitation_id, inv);
      return { status: 201, body: { ...invitationView(inv), code } };
    },
    revokeInvitation: ({ req, p }) => {
      const { t } = tenantAs(req, p.tenantId as string, "admin");
      const inv = state().invitations.get(p.invitationId as string);
      if (!inv || inv.tenantId !== t.tenant_id || inv.acceptedAt !== null || inv.revokedAt !== null)
        throw new Problem(404, "not_found", "Not found");
      inv.revokedAt = Date.now();
      return { status: 204 };
    },
    acceptInvitation: ({ req, body }) => {
      const { userId } = ctx.session(req);
      const code = String(body.code ?? "");
      if (!/^scfi_[0-9A-Za-z]{22}$/.test(code))
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [{ pointer: "/code", detail: "invalid invitation code" }],
        });
      const h = sha(code);
      const inv = [...state().invitations.values()].find((i) => i.codeHash === h && open(i));
      if (!inv) throw new Problem(404, "not_found", "Not found");
      const t = ctx.tenants().get(inv.tenantId) as TenantRow;
      inv.acceptedAt = Date.now();
      if (!t.members.has(userId)) {
        t.members.set(userId, inv.role);
        state().addedAt.set(`${t.tenant_id}:${userId}`, iso(Date.now()));
      }
      return {
        status: 200,
        body: {
          tenant_id: t.tenant_id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          role: t.members.get(userId) as Role,
        },
      };
    },
    getVerification: ({ req, p }) => {
      const { t } = tenantAs(req, p.tenantId as string, "viewer");
      return { status: 200, body: status(t) };
    },
    verificationStellarChallenge: ({ req, p, body }) => {
      const { t, userId } = tenantAs(req, p.tenantId as string, "admin");
      const account = String(body.account ?? "");
      let raw: Buffer;
      try {
        raw = ctx.accountKey(account).raw;
      } catch {
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [{ pointer: "/account", detail: "invalid account id" }],
        });
      }
      const id = randomUUID();
      const now = Date.now();
      if (body.method === "sep10") {
        const s10 = ctx.sep10();
        if (!s10)
          throw new Problem(503, "unavailable", "Temporarily unavailable", {
            detail: "SEP-10 is not configured on this deployment; use sep53",
          });
        const c = buildChallenge({
          serverPub: s10.pub,
          serverKey: s10.key,
          clientPub: raw,
          homeDomain: "localhost",
          passphrase: MOCK_PASSPHRASE,
          nowS: Math.floor(now / 1000),
          ttlS: 900,
        });
        state().challenges.set(id, {
          tenantId: t.tenant_id,
          userId,
          account,
          method: "sep10",
          tx: c.tx,
          expires: now + 15 * 60_000,
        });
        return {
          status: 201,
          body: {
            challenge_id: id,
            method: "sep10",
            transaction_xdr: c.xdr,
            network_passphrase: MOCK_PASSPHRASE,
            expires_at: iso(now + 15 * 60_000),
          },
        };
      }
      const message = [
        "localhost wants you to link a Stellar account to a project:",
        account,
        "",
        `Project: ${t.slug} (${t.tenant_id})`,
        "Purpose: prove control of the project's Stellar account (L2)",
        "Signing this message does not send a transaction or cost a fee.",
        "Network: testnet",
        `Nonce: ${b62(22)}`,
        `Issued At: ${new Date(now).toISOString()}`,
        `Expiration Time: ${new Date(now + TEN_MIN).toISOString()}`,
      ].join("\n");
      state().challenges.set(id, {
        tenantId: t.tenant_id,
        userId,
        account,
        method: "sep53",
        message,
        expires: now + TEN_MIN,
      });
      return {
        status: 201,
        body: {
          challenge_id: id,
          method: "sep53",
          message,
          network_passphrase: MOCK_PASSPHRASE,
          expires_at: iso(now + TEN_MIN),
        },
      };
    },
    verificationStellarVerify: ({ req, p, body }) => {
      const { t, userId } = tenantAs(req, p.tenantId as string, "admin");
      const isSep10 = typeof body.signed_transaction_xdr === "string";
      if (!isSep10 && typeof body.signature !== "string")
        throw new Problem(400, "validation_failed", "Validation failed", {
          errors: [
            {
              pointer: "/signature",
              detail: "signature (sep53) or signed_transaction_xdr (sep10) required",
            },
          ],
        });
      const id = String(body.challenge_id);
      const ch = state().challenges.get(id);
      state().challenges.delete(id); // single use, whatever the outcome
      if (
        !ch ||
        ch.tenantId !== t.tenant_id ||
        ch.userId !== userId ||
        ch.expires < Date.now() ||
        ch.method !== (isSep10 ? "sep10" : "sep53")
      )
        throw new Problem(404, "not_found", "Not found");
      if (isSep10) {
        if (
          !signedBy(
            body.signed_transaction_xdr as string,
            ch.tx as Buffer,
            ctx.accountKey(ch.account).key,
            MOCK_PASSPHRASE,
          )
        )
          throw failed(
            "the signed challenge is not valid or does not meet the account's medium threshold",
          );
      } else if (!ctx.verifySep53(ch.account, ch.message as string, body.signature as string)) {
        throw failed("the signature is not valid for this challenge");
      }
      const acct = state().accounts.get(ch.account);
      const home = acct?.home_domain?.toLowerCase().replace(/\.$/, "") ?? null;
      if (!home) throw failed("the account has no home_domain");
      const verified = evidenceOf(t.tenant_id).some(
        (e) => e.kind === "domain" && e.status === "valid" && e.subject.toLowerCase() === home,
      );
      if (!verified)
        throw failed("the account's home_domain is not a verified domain of this project");
      if (!acct?.listed)
        throw failed("the home domain's stellar.toml does not list the account in ACCOUNTS");
      const now = iso(Date.now());
      const ev = evidenceOf(t.tenant_id).filter(
        (e) => !(e.kind === "stellar_account" && e.subject === ch.account),
      );
      ev.push({
        evidence_id: randomUUID(),
        kind: "stellar_account",
        subject: ch.account,
        status: "valid",
        verified_at: now,
        last_checked_at: now,
        details: {
          method: ch.method,
          home_domain: home,
          toml_url: `https://${home}/.well-known/stellar.toml`,
          network: "testnet",
        },
      });
      state().evidence.set(t.tenant_id, ev);
      if (LEVELS.indexOf(t.verification_level) < 2) t.verification_level = "L2";
      return { status: 200, body: status(t) };
    },
  };
}
