# ADR-0014: Authentication, authorisation and roles

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** isolation.tenant-vs-operator, isolation.tenant-rls, operator.global-view-credentials, dashboard.web-tenant, operator.web-global-view, operator.api-global-access, operator.api-global-view

## Context
Designated SCF operators hold credentials for the global view; tenants see only their own data; isolation, access
control and the security posture are core properties of the product. The portal serves tenant teams (often small,
GitHub-centric) and a handful of SCF operators. We must patch critical vulnerabilities within 24 h (ADR-0031), so
every dependency on the authentication path is attack surface we own.

What research established:
- **Stellar SEPs** (stellar-protocol @ `ced008c`): **SEP-53** "Sign and Verify Messages" is **Final v1.0.0**
  (2026-06-18): `ed25519(SHA256("Stellar Signed Message:\n" ‖ msg))`, with test vectors; it proves the key, not
  control of a multisig account. **SEP-10** is **Active v3.4.1** (2024-03-20): a sequence-0 challenge transaction with
  ~15 min time bounds, verified against the account's signers and thresholds; it needs our own `SIGNING_KEY` and a
  published `stellar.toml`. **SEP-45** (contract accounts) is **Draft v0.1.1** (2025-12-16), with server helpers only
  in the Python SDK. **SEP-43** (wallet interface) is Draft v1.2.1.
- **Wallet coverage** (Stellar Wallets Kit 2.8.0 source): `signMessage` exists for Varial (ex-Freighter; Freighter
  5.34.0 "Implements SEP-53 handling"), xBull, LOBSTR, Hana, WalletConnect, OneKey; it throws "not supported" for
  Albedo, Ledger and Trezor. Hence SEP-10 as fallback.
- **Libraries** (npm, 2026-11-12): `@stellar/stellar-sdk` 17.4.0 (Apache-2.0) exports `Keypair.verifyMessage` and
  `WebAuth.buildChallengeTx`/`verifyChallengeTxThreshold`; `@simplewebauthn/server` 14.1.0 (MIT; one advisory, about
  attestation chains, irrelevant with `attestation: 'none'`); `arctic` 3.7.0 (MIT) for OAuth clients. Lucia is
  deprecated.
- **Identity products:** Better Auth 1.7.22 (MIT) had **26 OSV advisories** in about two years, including
  unauthenticated API-key creation (CVE-2025-61928) and a 2FA bypass (CVE-2026-67337); Zitadel moved to AGPL-3.0 with
  v3; Hanko's backend is AGPL-3.0; Authentik and SuperTokens carry non-OSI enterprise directories; Keycloak and Ory
  are Apache-2.0 but are extra services to run and hand over.
- **E-mail:** OWASP ASVS 5.0 V6.3.6 (L3): e-mail must not be an authentication factor; magic links need an e-mail
  sub-processor; Better Auth's magic-link CVEs show the bug class.
- **GitHub:** login needs no OAuth scope (public profile, numeric `id`, account age); `read:org` gives org
  membership for verification. GitHub recommends GitHub Apps over OAuth Apps.

## Options considered
1. **Embed an identity product (Better Auth, Keycloak, Ory, Zitadel).** Pros: features ready. Cons: large surface we
   must patch within 24 h (Better Auth's advisory rate); extra services; licence issues for some.
2. **Thin core on small libraries (chosen).** GitHub OAuth, wallet signature, passkeys; a few hundred auditable lines.
   Pros: small surface; no extra service; easy handover. Cons: we own session and CSRF correctness.
3. **Passwords (+ TOTP).** Cons: credential storage, reset flows (which need e-mail), phishing.
4. **E-mail magic links.** Cons: e-mail sub-processor; ASVS L3 says no; known vulnerability class.
5. **Wallet-only login (SEP-10/SEP-45).** Pros: Stellar-native. Cons: shared team keys, no recovery, hardware
   wallet friction; SEP-45 still Draft.

## Decision
Terminology (C-59): an **SCF operator** is a portal user holding the `operator` or `operator_admin` role; the
**service operator** is the entity that hosts the service (processor for tenant analytics, **controller** for
portal account data and audit logs).

- **Sign-in:** **GitHub OAuth** or **Stellar wallet signature** (SEP-53 message signing over a server-issued,
  single-use challenge; **SEP-10** challenge as fallback for hardware wallets and multisig). **Passkeys** (WebAuthn)
  as an added factor, **mandatory for SCF operators**.
- **GitHub (C-20):** an **OAuth App** with the `read:user` scope only. GitHub organisation membership is **not** used
  for authorisation.
- **SEP-10 signing key (C-15):** the SEP-10 server signing key and the `stellar.toml` that publishes it belong to the
  service domain and are on the handover rotation list.
- No passwords, no magic links, no e-mail sub-processor (an optional contact address may be stored).
- Built from small libraries (`arctic`, `@simplewebauthn/server`, `@stellar/stellar-sdk`), not an embedded identity
  product. SEP-45 (contract accounts) stays behind a flag (C-19).
- **Sessions (C-20):** server-side in PostgreSQL (opaque random token, stored hashed). Session cookie
  `__Host-…; Secure; HttpOnly; SameSite=Lax` — Lax is required for the OAuth return from github.com. Every
  state-changing request also needs a matching `Origin` and a custom header. OAuth state lives in a separate cookie
  valid for 10 minutes. No JWTs for browser sessions; a SEP-10 JWT, if used, is exchanged at once for our own
  session.

| Session | Idle timeout | Absolute timeout |
|---|---|---|
| tenant users | 12 h | 14 days |
| SCF operators | 30 min | 12 h |

- **SCF operator passkeys and step-up (C-09, C-20).** SCF operators must register **at least two passkeys** and
  assert one at **every sign-in**. A fresh assertion (**≤ 10 minutes old**) is additionally required for: removing
  or restoring a tenant, changing `enrollment_mode`, creating or revoking operator API keys, and managing SCF
  operators. Recovery of a lost passkey is by another `operator_admin` (audited) or by the documented break-glass
  procedure on a core node.
- **Fresh sign-in for sensitive tenant actions (C-87).** Confirming an erasure, transferring ownership, removing the
  tenant and deleting an account need a fresh sign-in, **at most 10 minutes old**, by the member's own method — a
  passkey assertion if the member has registered one, otherwise a new GitHub or wallet sign-in. Passkeys stay
  optional for tenant members.
- **Tenant roles** `owner`, `admin`, `member`, `viewer`. **Platform roles** `operator` (global read, moderation) and
  `operator_admin` (SCF operators, API keys, enrollment mode). SCF operators are designated by an allow-list managed
  by `operator_admin` and seeded at bootstrap.

| Role | Scope | Can (summary; the full permission map lives in `docs/security/`) |
|---|---|---|
| `owner` | one tenant | everything in the tenant, including deleting it, managing owners and creating `pub` share keys (C-70) |
| `admin` | one tenant | members, sites, services, ingest tokens, `pub` share keys (C-70), erasure requests |
| `member` | one tenant | dashboards, edit site/service metadata |
| `viewer` | one tenant | dashboards only |
| `operator` | platform | global read of thresholded aggregates (through the `op_*` functions, ADR-0013), suspend/remove tenants with reason, read audit |
| `operator_admin` | platform | `operator` rights plus managing SCF operators, operator API keys, `enrollment_mode`, restoring a removed tenant before purge (C-08), deciding appeals and lifting re-enrollment tombstones (C-19, C-64) |

- Authorisation checks live in three places: a route-level permission declaration checked by middleware against the
  static role→permission map (also the oracle for the isolation matrix, ADR-0013); object-level checks through a
  typed tenant context that resolves every identifier in the path, query or body under the caller's tenant (C-87);
  RLS in the database. Each API operation states its required role in a machine-readable field, and actions that
  need different roles are separate operations (C-89).
- **Audit action names** are one enumerated list shared by the database and the API (C-89).
- **Audit log.** Every SCF operator read of tenant data and every privileged action is written to a **hash-chained
  audit log**. Rows reference user IDs; when an account is deleted its profile fields are removed and a tombstone
  keeps the ID, so the chain stays valid and the log no longer names the person (C-57). The head hash of the chain is
  **published daily in the public evidence repository** and, when enabled, written to the Stellar ledger from a
  platform account, so rewriting history after the fact is detectable by anyone; the anchoring account's key is a
  handover item (C-63).

## Consequences
- Positive: no password database, no e-mail dependency, no extra identity service; SCF operators are
  phishing-resistant by construction; the Stellar sign-in is native and needs no SDK beyond the official one.
- Positive: the permission map doubles as test oracle and as the access-control documentation auditors ask for.
- Positive: the published daily chain head makes silent rewriting of the audit log detectable by outsiders, not only
  by us.
- Negative: we own session management, CSRF defence and WebAuthn ceremony handling; they need their own tests
  (ASVS mapping in `docs/security/`). `SameSite=Lax` alone does not stop cross-site state changes, so the `Origin`
  check and custom header are mandatory on every state-changing route and covered by the isolation matrix.
- Negative: SEP-10 obliges us to hold a signing key and publish `/.well-known/stellar.toml` on the service domain;
  both are on the handover rotation list (C-15) and depend on the service domain.
- Negative: SEP-53 proves a key, not account control; for linking an account (L2) we also check on-chain that the
  signer meets the account's medium threshold (C-19, ADR-0015).
- Negative: for members without a passkey, the fresh sign-in for sensitive actions proves only control of the GitHub
  account or wallet at that moment; it is weaker than a passkey assertion, which we recommend to owners and admins.
- Negative: wallet-only users who lose their key lose access unless another owner exists; tenants should have two
  owners or an added passkey.
- Negative: the break-glass procedure on a core node is a privileged path outside the portal; like every privileged
  action it is written to the audit log.
- Negative: GitHub recommends GitHub Apps over OAuth Apps; we use an OAuth App limited to `read:user` (C-20), and
  organisation membership is deliberately not an authorisation input.
- Negative: contract accounts (C…, passkey smart wallets) cannot sign in while SEP-45 stays behind its flag.
- Must do: test SEP-53 against the official vectors; SEP-10 interop with `@stellar/stellar-sdk` and
  `@colibri/webauth` clients; negative tests (wrong network passphrase, expired bounds, reused nonce, extra ops,
  insufficient threshold); accept only the canonical SEP-53 form (older Freighter answered `signMessage` two ways);
  test that each step-up action is refused with an assertion older than 10 minutes, and that each sensitive tenant
  action is refused with a sign-in older than 10 minutes, for passkey and non-passkey members alike (C-87).
- Revisit if: SEP-45 becomes Final with JS server support; the operating organisation asks for SCF operator SSO through its own IdP (OIDC can
  be added through `arctic`); a chosen library loses maintenance.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Auth SEP-10 SEP-45 passkeys: §3.1 SEP status table; §3.2 SEP-10 mechanics and
  operational cost; §3.3 SEP-45; §3.4 SEP-53 vs SEP-10 and wallet coverage; §3.6 GitHub, e-mail, passkeys; §3.7
  identity products and licences; §3.8 sessions; §3.9 authorisation model.
- Multitenancy RLS isolation: §6.5 typed tenant context, audit; §6.6 isolation matrix.
- Umami authorisation API multitenancy: §4.5 why Umami's roles cannot serve the SCF operator view.
- Stellar wallets kit: Kit 2.8.0 module behaviour (Varial rename).

## Open points
1. Open: who seeds the SCF operator allow-list at bootstrap (which people, from which organisation). Closed by the
   service operator naming them at deployment.
