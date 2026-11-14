# vendor/umami — our build of the pinned base engine

Umami **v3.5.0**, commit `d3c62a805beda8643cb468924dda38617fb4c286` (ADR-0002), run **unmodified** and never reachable
from the internet (ADR-0003). This directory holds everything needed to build it ourselves; the upstream source is not
copied into the repository. The recipe is the one proved in spike S-02 (`spikes/s02-umami-hardened-image/README.md`,
C-104).

| File | Purpose |
|---|---|
| `UPSTREAM` | The pin: repository, tag, full commit SHA (verified with `git ls-remote` on 2026-11-12), image names and tag. |
| `Dockerfile` | Multi-stage build → two images, `usagemap/umami` (target `app`) and `usagemap/umami-migrate` (target `migrate`). |
| `build/copy-closure.mjs` | Copies the locked dependency closure of `prisma` + `dotenv` out of the frozen install into the migrate image (replaces upstream's unlocked `pnpm add`). |
| `patches/` | The patch queue — **empty** (see `patches/README.md`). |
| `scripts/verify-pin.sh` | Docker-free check: upstream tag → pinned commit; Dockerfile and Compose agree with `UPSTREAM`. |
| `test/hardening-check.sh` | Re-runs every S-02 check against our built images (40 checks). |

## Build

```sh
docker buildx build --target app     -t usagemap/umami:3.5.0-d3c62a8         vendor/umami
docker buildx build --target migrate -t usagemap/umami-migrate:3.5.0-d3c62a8 vendor/umami
# or simply: docker compose -f infra/compose/compose.yaml build umami umami-migrate
```

Supply-chain properties (`docs/security/supply-chain.md` §6.1):

- **Source by commit, checksum-verified.** The `source` stage is
  `ADD --checksum=<UMAMI_COMMIT> https://github.com/umami-software/umami.git#<UMAMI_COMMIT>`: BuildKit fetches the
  commit and refuses the build unless the fetched commit is exactly the pin (git verifies every object hash on the way;
  tested: a one-character change of the checksum fails the build). The Dockerfile frontend is pinned by digest
  (`docker/dockerfile:1.20`; 1.18 or newer is needed for checksums on git sources).
- Base image `node:22.23.4-alpine` pinned by digest (multi-arch index); pnpm 12.3.4 from the npm tarball for the
  platform being built (`@pnpm/exe.linux-x64-musl` or `@pnpm/exe.linux-arm64-musl`, one `ADD --checksum=sha256:` stage
  per architecture selected by BuildKit's `TARGETARCH`; each SHA-256 belongs to the tarball whose SHA-512 is the
  registry's `dist.integrity`); pnpm exists only in build stages.
- `pnpm install --frozen-lockfile` with `strictDepBuilds: true`; the lockfile's own `allowBuilds` (`@prisma/engines`,
  `prisma`) is the reviewed list of install scripts.
- `SKIP_BUILD_GEO=1` and a build-time assertion that no `geo/` exists: **no geo database**, so every `/api/send` must
  carry a non-empty `cf-ipcountry` (the engine proxy sets `XX` when it is missing, C-99).
- Runtime images contain no npm, npx, yarn, corepack, pnpm, curl or added apk packages; app files are root-owned and
  read-only for the runtime user (uid 1001); `CMD ["node","server.js"]`, so neither upstream's `check-db.js`
  (migrations) nor `update-tracker.js` (rewrites `script.js`) ever runs.
- Hardening defaults are baked into the app image and set again by Compose: `DISABLE_TELEMETRY=1`,
  `DISABLE_UPDATES=1`, `PRIVATE_MODE=1`, `SKIP_DB_MIGRATION=1` (guard, C-40), `SALT_ROTATION=day`, `TZ=UTC`,
  `CLIENT_IP_HEADER=x-scf-surrogate-ip`. Never set: `CLOUD_MODE`, `SKIP_LOCATION_HEADERS`, `TRUSTED_PROXIES`,
  `DISABLE_BOT_CHECK`, `ENABLE_CLIENT_SALT`, `GEOLITE_DB_PATH`, `MCP_ENABLED`, `COLLECT_API_ENDPOINT`,
  `TRACKER_SCRIPT_NAME`, `TRACKER_SCRIPT_URL` (`docs/contracts/wire-formats.md` §j).
- Known limits (unchanged from S-02): the image is not bit-for-bit reproducible (timestamps); Prisma's `schema-engine`
  binary is downloaded by `@prisma/engines`' postinstall during the build, verified only by Prisma's own `.sha256`
  (open point SC-09).

Sizes (2026-11-12): `usagemap/umami` 87 MB compressed (378 MB on disk), `usagemap/umami-migrate` 132 MB; upstream's image is
312 MB.

## Runtime (set by `infra/compose/compose.yaml`)

`read_only: true`, tmpfs `/tmp` (16 MB) and `/app/.next/cache` (64 MB, uid 1001), `cap_drop: [ALL]`,
`no-new-privileges`, uid 1001, one `internal: true` network shared only with PostgreSQL and the engine proxy, no
published port. `umami` starts only after the one-shot `umami-migrate` (`prisma migrate deploy` as `umami_app`) has
completed; the `scf_ro` views are dropped before and recreated after it (`umami-views-drop`, `umami-views`,
data-model §16.3). `APP_SECRET` must be identical on every Umami instance (C-112(11)).

## Tests

```sh
vendor/umami/scripts/verify-pin.sh                  # no Docker; seconds
vendor/umami/test/hardening-check.sh                # builds, then 40 checks (NO_BUILD=1 to reuse images)
PW_DIR=<dir with node_modules/playwright> vendor/umami/test/hardening-check.sh   # + the dashboard check
```

`hardening-check.sh` uses Compose project `scf-umami-test` (override with `PROJECT=`) and `127.0.0.1:56122`
(`UMAMI_TEST_PORT=`) for a test-only forwarder; it removes its containers and volumes at the end. Result on 2026-11-12:
**40 passed, 0 failed** — pin and tag, image contents, read-only/no-capability runtime, internal network, migrations
only in the one-shot, `/api/send` with surrogate and country headers (and the documented 500 without a country),
blocked-route behaviour, tracker bytes identical to upstream's, dashboard with no external request, the seed-admin
bootstrap, clean logs, zero packets leaving the engine subnet, and failing outbound attempts.

## Upgrading the pin

1. Check the new release's advisories and changelog; update `UPSTREAM` (tag, commit, `IMAGE_TAG`) and the two `ARG`
   defaults in `Dockerfile`; adjust the pnpm pin if upstream's `packageManager` changed.
2. Run `scripts/verify-pin.sh`, `test/hardening-check.sh`, the engine-proxy integration test
   (`services/engine-proxy/integration/run.sh`) and the adapter contract tests (`packages/umami-adapter`).
3. Re-check the engine proxy's route lists (`services/engine-proxy/internal/policy`) against the new release's
   `src/app/**/route.ts` — new routes are refused by default, but the deny-list must name new side doors.
4. Deploy with the upgrade procedure: `umami-views-drop` → `umami-migrate` → `umami-views` → view contract test.
