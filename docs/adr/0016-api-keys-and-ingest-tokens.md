# ADR-0016: API keys and ingest tokens

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** keys.operator-api-keys, keys.revocation, api.dual-export, api.attr-tenant-service, enrol.operator-removal

## Context
SCF operators generate and revoke API keys that grant access to metrics, intended for downstream machine consumers.
Tenants dual-export OpenTelemetry to the UsageMap collector endpoint; attribution is by `tenant.id` /
`service.name`. Both need credentials: read keys for machines that consume SCF operator metrics, and
write tokens for tenant OTLP exporters. The web tracker runs in public pages and cannot hold a secret.

What research established:
- **Umami's own API keys** (since v3.4.0): `umami_` + 32 characters, unsalted SHA-512, act as the owning user with
  full rights, **no scopes, no expiry, no IP binding**, and only the owner can manage them — unfit for this purpose.
- **Token format practice.** GitHub's token format: a short prefix plus `_`, high-entropy base62, and a **CRC32
  checksum in the last six base62 characters**; the prefix cut secret-scanning false positives to 0.5 %, and the
  checksum allows offline rejection. GitHub's secret-scanning partner programme asks for a "uniquely defined prefix",
  "high entropy random strings" and "a 32-bit checksum", plus an HTTPS endpoint that verifies GitHub's ECDSA P-256
  signature and revokes.
- **Hashing.** OWASP ASVS 5.0 6.5.2: "A standard hash function can be used if the secret has 112 bits of entropy or
  more"; 7.2.3 asks ≥ 128-bit CSPRNG reference tokens; 11.2.4 constant-time comparison; 14.2.1 no keys in URLs.
  Password hashing (Argon2/bcrypt) adds 10–100 ms per request for no gain on a random secret and turns
  authentication into a DoS amplifier.
- **Collector.** `bearertokenauth` cannot tell which tenant a token belongs to (ADR-0009); token → tenant mapping
  must happen in a component we own — the gateway.
- **Header hazard.** In-SDK dual export in JS, Python and Rust can send the tenant's APM credential to us (ADR-0009);
  a recognisable prefix and checksum let us reject foreign credentials without storing or logging them.

## Options considered
1. **Reuse Umami API keys.** Rejected: unscoped, non-expiring, full user rights.
2. **Signed JWTs (stateless).** Pros: no lookup. Cons: revocation needs a deny-list anyway; long-lived signed tokens
   in tenant config are hard to rotate; key compromise affects every token.
3. **Opaque random keys with prefix, id and checksum, hashed with a pepper (chosen).** Pros: scannable, offline
   typo/garbage rejection, revocation by row, no secret in the database. Cons: a lookup per request (cached), the
   pepper is one more managed secret.
4. **mTLS client certificates for ingest.** Pros: strong. Cons: most SDK env configurations and Cloudflare Workers
   destinations cannot present client certificates; high onboarding friction.
5. **Basic auth with htpasswd at the Collector.** Pros: stock component. Cons: file read at start-up only (reload per
   tenant), no per-token revocation without reload.

## Decision
- **Format** `scfa_<kind>_<id>_<secret><crc32>`: a public key id for indexed lookup, a **160-bit** secret from a
  CSPRNG, and a CRC32 over everything before it. Exact alphabet and lengths are fixed in `docs/contracts/`.
- **Storage:** `HMAC-SHA-256(pepper, secret)`, compared in constant time; the full key is **shown once** at
  creation, afterwards only a masked form. **Three peppers, one per kind (C-05, C-81):** `ing` (also held on edge
  nodes), `op` and `pub` (core only). The key that signs the edge snapshot is separate from all three. Peppers live in
  the secrets store (SOPS + age, ADR-0019), never in the database. **Pepper versions (C-81):** every stored key hash
  records which pepper version produced it, so a pepper can be rotated with overlap — new keys use the new version,
  existing keys keep verifying under the old one until they are re-issued.
- **Kinds:**

| Kind | Holder | Rights | Lifetime | Checked where | Other |
|---|---|---|---|---|---|
| `op` | downstream machine consumers; issued and revoked by an `operator_admin` with a fresh passkey assertion (C-09) | scopes `web:read`, `api:read`, `registry:read`; optional tenant restriction; reads only through the thresholded `op_*` functions (ADR-0013) | default expiry **90 days**, at most **365 days** (C-70); revocable | control plane on the core nodes, against the database on every request (cache ≤ 5 s) — revocation is effectively immediate (C-06) | default rate limit **600 requests/minute** (C-21); last use tracked; fully audited |
| `ing` | tenant OTLP exporters; issued by tenant `owner`/`admin` | write-only OTLP ingest for its tenant, optionally restricted to a list of `service.name` values; never read access | **no expiry by default** (tokens sit in server configuration); optional expiry; reminder after 12 months | gateway on every edge node, from the signed snapshot — revocation within 60 s (C-06) | **up to 5 active per tenant** (rotation needs two); last use shown to the tenant (C-21) |
| `pub` | anyone the tenant shares it with; created and revoked by tenant `owner` or `admin` (C-70) | read-only access to that tenant's `metrics_endpoint` (thresholded daily aggregates, never the trust score — C-47) | revocable | control plane | the endpoint is also readable with an `op` key, or publicly if the tenant switches public stats on (C-14, ADR-0032) |

- **No test-mode key kind** (C-70): testing uses a separate tenant.
- **Ingest-token service restriction (C-70):** the gateway passes the allowed service names with the tenant to the
  Collector, whose sanitise step drops and counts resources whose `service.name` is not allowed (ADR-0009).
- **`web:read` (C-72):** operator keys with this scope receive both verified and raw web figures (as defined by
  C-73). A removed tenant's site key answers `404` like any unknown key.
- Services are auto-registered on first sight up to the tenant's quota (default 20; L0 tenants 1 — C-21, C-19).
- `ing` tokens travel only in `Authorization: Bearer …`; keys in query strings are refused.
- **Snapshot (C-62).** Gateways pull the signed snapshot (token hashes, site registry, tenant state, limits) from the
  control plane every 30 s over per-node mutual TLS (C-60). Snapshots carry a sequence number and issue time; an edge
  node never accepts an older sequence. Revoked ingest tokens and suspended or removed tenants (ADR-0015) are
  therefore rejected at every edge node within **60 s**. If a node has had no fresh snapshot for 15 minutes it raises
  an alert and keeps serving from the last good snapshot (availability first): revocations do not reach that node
  until it reconnects — a stated residual risk.
- The gateway rejects a credential whose prefix or CRC is wrong before any lookup, and never logs the presented value.
- The web **site key is public** and is not a secret; abuse resistance for web ingest comes from origin binding and
  the anti-inflation layers (ADR-0008), never from secrecy.
- Umami's own API keys are internal only (ADR-0003): one per tenant for the view-only Umami user, stored in `scf`
  encrypted with a key held outside the database (C-40). That user's random password is stored the same way, because
  minting a new Umami key needs the user's own login; only the provisioning worker uses it, to rotate the key (C-85).
- **Handover (C-50, C-81).** All three peppers and the snapshot-signing key are handover items. They are handed over
  securely and **not** rotated at cut-over (rotation would invalidate every token); they are rotated afterwards with
  overlap through the pepper versions, by issuing new tokens.

## Consequences
- Positive: leaked keys are findable by scanners and by our own pre-commit rule; typos and foreign credentials are
  rejected offline; a database dump alone does not allow offline verification of secrets.
- Positive: ingest keeps working when the core is down, because the snapshot is kept on disk at each edge node.
- Positive: a compromised edge node exposes only the ingest-token pepper and ingest-token hashes; operator keys stay
  safe because their pepper never leaves the core (C-05). Secrets remain unrecoverable at 160 bits either way.
- Negative: the ingest-token pepper's protective value is lost for a compromised edge node; pepper rotation is
  possible through the recorded pepper version (C-81) but still means re-issuing tokens with overlap.
- Negative: storing the per-tenant Umami user's password (encrypted, C-85) means a database dump plus the outside
  encryption key yields view-only access to that tenant's Umami websites.
- Negative: worst-case 60 s during which a revoked ingest token still writes, and longer on an edge node cut off
  from the core (C-62); stated in docs, tested (
"revoke → 401 within 60 s"; "stale snapshot → alert at
  15 min").
- Negative: a 90-day default expiry will break `op` consumers who ignore reminders; expiry notices are needed. Ingest
  tokens without expiry rely on rotation reminders and tenant discipline instead.
- Negative: a `pub` key or public stats expose a tenant's thresholded aggregates to anyone who holds the link; the
  tenant decides, and the portal says so when the key is created.
- Must do: register the prefix with GitHub secret scanning once the production domain is fixed and list the
  partner endpoint as a handover item; publish the regex in `SECURITY.md`; audit `created`, `revoked`, `expired`,
  `rejected_bad_checksum` and `rate_limited` events.
- Revisit if: operators need per-consumer quotas beyond simple rate limits; a standard for OTLP credential rotation
  appears; GitHub changes its partner programme.
- **Unproven:** the snapshot propagation bound has not been measured; nothing here has been built.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Enrollment verification API keys: §2 sources (GitHub token format, secret-scanning
  partner programme, ASVS 5.0); §3.3 `service.name` claims; §3.7 format, storage, scopes, expiry, rate limits,
  revocation, rotation, ingest tokens, public site id.
- Umami authorisation API multitenancy: §6.1 Umami API keys.
- OTel collector pipeline: §3.2 `bearertokenauth`/`basicauth` limits; §3.3 options.
- OTel semconv SDK dual export: §3.4 header-merge hazard; §6 item 8.

## Open points
None outstanding. (Maximum `op` key lifetime, `pub` key roles and the absence of a test-mode kind are settled by C-70;
pepper versions and the third pepper by C-81; Umami credential custody by C-85.)
