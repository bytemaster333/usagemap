# ADR-0025: Implementation languages

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capabilities:** repo.application-code, licence.osi-only, repo.single-monorepo, repo.monorepo-complete, api.dual-export, api.drop-traces, api.attribute-allowlist, api.attr-route, pathnorm.default-ruleset, capacity.1m-requests-day, bot.js-execution-proof, tracker.no-remote-updates,
  handover.independent-operator, ops.rebuild-from-repo

## Context
The system has two very different halves. The **ingest path** (gateway, OpenTelemetry Collector components, writer,
path normaliser) must be small, fast to start, safe under hostile input, run with no human in the loop (ADR-0031), and
plug into the OpenTelemetry Collector. The **product half** (tracker, portal, control plane, jobs) is CRUD, auth,
dashboards and scheduled work, and must be easy for a community-appointed service operator to maintain after handover.

What research established:
- The Collector is a Go program and custom distributions are built with `ocb` (`cmd/builder`, v0.165.0). Our
  `scfsanitize` processor, any in-house replacement for the alpha `signal_to_metrics` connector (~200 lines, ADR-0009)
  and any auth extension must be Go against the Collector's module APIs. Core cadence is biweekly, so a pinned build
  falls behind ~26 releases a year.
- The gateway must terminate TLS itself and drain by closing its listener. Research also
  wanted it to compute a JA4 TLS fingerprint; JA4 is
  removed from the first release (C-77), so this no longer shapes the language choice.
- The tracker must be browser JavaScript; the PoW solver uses `crypto.subtle.deriveBits` (PBKDF2), Baseline since
  Jan 2020.
- The auth stack chosen in ADR-0014 is TypeScript-native: `arctic`, `@simplewebauthn/server`, `@stellar/stellar-sdk`.
  Umami itself is TypeScript (Next.js, Prisma) and is consumed unmodified (ADR-0003).
- Load is small: 1M requests/day ≈ 11.6 req/s; the limiter is series cardinality, not language speed
.
- The evidence behind two Go components was produced in other languages: the path-normalisation reference model
  (451/451 vectors, 50k fuzz) ran in Python and Node, and
  the 23 RLS behaviour tests ran on PGlite.

## Options considered
1. **Go for the ingest path, TypeScript for the rest (chosen).**
   Pros: each half uses the language its key dependency forces (Collector → Go; browser, Umami, auth libraries →
   TypeScript); Go gives one static binary per ingest service with a strong standard library for TLS, HTTP/2 and
   gRPC. Cons: two toolchains and two dependency ecosystems to secure (pnpm and Go modules, ADR-0023); a steward needs
   both skills; contracts between the halves (signed snapshot, OTLP hand-off) cross a language boundary.
2. **TypeScript everywhere, including the gateway; Collector used stock with no custom components.**
   Pros: one language and one toolchain; easiest handover. Cons: sanitising and path normalisation would have to run
   after the Collector's on-disk queue, so raw paths would touch disk; Node TLS
   gives no practical access to the raw ClientHello (which would matter if a TLS fingerprint is added later, C-77); a
   long-lived Node process is a larger attack surface on the
   only internet-facing component.
3. **Go everywhere, including portal backend and jobs.**
   Pros: one backend language; single static binaries. Cons: the tracker and portal are still TypeScript, so two
   languages remain; the WebAuthn, OAuth and Stellar-auth libraries chosen in ADR-0014 would be replaced by Go
   equivalents not evaluated by research; no shared types with the portal.
4. **Rust for the gateway and writer.**
   Pros: memory safety without a garbage collector; small binaries. Cons: cannot host Collector components (Go only);
   a third language; smaller pool of community stewards; no performance need at ~12 req/s.
5. **Python for jobs and on-chain correlation.**
   Pros: data-science ergonomics; the path-normaliser reference model already exists in Python. Cons: a third runtime
   to pin, patch and hand over; nothing in the jobs needs it.

## Decision
- **Go** for everything on the ingest path: `services/gateway`, `collector` (custom `ocb` distribution and our
  components), `services/metrics-writer`, `packages/pathnorm`, and **`services/engine-proxy`** (C-74), the small
  service on each core node in front of Umami that terminates the per-node mutual TLS, applies the per-caller path
  allow-lists and holds Umami's cache tokens in memory. One static binary per service, built reproducibly and
  signed per ADR-0023.
- **Go, outside the ingest path: `services/onchain-reader`** (C-42), the rebuildable fallback reader of public
  ledger files for on-chain correlation (ADR-0028). It is a small Go command because ledger decoding uses the Go
  Stellar SDK; it is started by the TypeScript jobs scheduler like any other scheduled job and has no listener.
- **TypeScript** for `tracker` (single classic script + ESM package), `apps/portal`, `services/control-plane`
  (Node, Fastify) and `services/jobs`. One pnpm workspace and one toolchain. Types shared between control plane and
  portal are **generated from the OpenAPI 3.1 document** (`docs/api/`), never hand-copied.
- **Plain SQL migrations** for database `scf`, applied by **dbmate** (C-48; licence and version verified when it is
  added) connecting as `scf_migrator` (ADR-0013). Umami's own Prisma migrations remain Umami's, run only against
  database `umami`, and run as an explicit one-shot deploy step because the engine containers start with
  `SKIP_DB_MIGRATION=1` (ADR-0003, C-40).
- **Tool versions pinned in `mise.toml`** (Go, Node, pnpm and any CLI the build or tests use); every machine uses the
  same file.

- Contracts that cross the Go/TypeScript boundary (signed snapshot pulled by the gateway, OTLP hand-off, verdict and
  reason codes) are specified in `docs/contracts/` with shared test vectors that both sides run.

## Consequences
Positive:
- The sanitiser and normaliser run inside our Collector build ahead of the persistent queue, so nothing unsanitised
  reaches disk (ADR-0009, ADR-0012).
- The internet-facing components are small static Go binaries with no interpreter; the product half reuses the
  TypeScript libraries ADR-0014 selected and shares generated types with the portal.

Negative and what we must do:
- Two ecosystems to keep patched within 24 h (ADR-0031): `govulncheck` and the Go checksum database on one side, pnpm
  policies on the other (ADR-0023). The handover plan must name both skills.
- Logic that exists twice must be tested against one corpus: the tracker's client-side guard (refuses values shaped
  like e-mails, StrKeys, JWTs; ADR-0004) is TypeScript while `pathnorm` is Go. The relevant subset of the 451-vector
  corpus runs against both.
- The challenge/PoW wire format (ALTCHA-v2-style, ADR-0008) is solved in TypeScript and verified in Go; shared vectors
  are required. The gateway (Go) applies the same upstream `isbot` list that Umami uses, at the version pinned by
  the Umami release we run, to the raw User-Agent (C-36); a parity test asserts that the Go matcher gives the same
  verdict as Umami's function over a User-Agent corpus, so the two cannot drift silently (ADR-0026).
- `services/onchain-reader` adds the Go Stellar SDK to the Go dependency set; it is covered by the same
  `govulncheck` and checksum-database gates as the ingest binaries.
- Go Collector modules at 0.x change biweekly; upgrades are routine work, covered by canary tests (ADR-0009).

Revisit if: the Collector gains a supported PostgreSQL exporter and no custom Go components remain; or a future
steward cannot staff Go, in which case option 2 would be reconsidered with the privacy cost stated.

Unproven:
- The Go port of the normaliser has not yet passed the 451 vectors (evidence is from the Python/Node model).
- **S-04** (Collector distribution build, `signal_to_metrics` expressions, persistent-queue fsync) and **S-05**
  (histogram SQL) are not executed; **S-03** must re-run the 23 RLS behaviour tests on real PostgreSQL 18 rather than PGlite.

## Open points
None outstanding. (The on-chain fallback reader's language is settled by C-42; the migration tool by C-48.)
