# S-02 — Our own hardened Umami v3.5.0 image (read-only, no egress, explicit migrations)

**Result:** PASS — Umami v3.5.0 built by us from commit `d3c62a8` (frozen lockfile, no unlocked `pnpm add`, no geo DB, digest-pinned base) runs on a read-only root filesystem with `cap_drop: [ALL]`, `no-new-privileges`, uid 1001, no internet egress and migrations as a separate one-shot container; `/api/send`, login, the admin API and the dashboard work, nothing leaves the engine network, and `./run.sh` proves it with 36/36 checks.

Two constraints found (both handled below, neither blocks the design): with no geo DB, **every `/api/send` must carry a non-empty `cf-ipcountry`** or Umami answers 500 for public surrogate addresses; and the Prisma 7 migration tool-chain is ~280 MB, so it ships as a **second image** (`umami-migrate`) instead of inside the engine image.

## Question

Can the project build Umami v3.5.0 (commit `d3c62a805beda8643cb468924dda38617fb4c286`) itself, reproducibly from the lockfile and without upstream's unpinned build inputs, and run it locked down as ADR-0003 / `docs/security/hardening.md` §5 require: read-only root filesystem (which tmpfs paths?), `cap_drop: [ALL]`, `no-new-privileges`, no egress (`internal: true`), `DISABLE_TELEMETRY`/`DISABLE_UPDATES`/`PRIVATE_MODE`, `SKIP_DB_MIGRATION=1` with migrations as an explicit step (which command?) — while `/api/send` with `x-scf-surrogate-ip` + `cf-ipcountry`, login and the admin API still work? Does anything call out or hang without egress; what would the dashboard request externally? How do the routes the engine proxy must block behave on this build? How is the seeded admin replaced at bootstrap?

## Method (versions, commands, how to re-run: one command if possible)

**Re-run:** `./run.sh` in this directory (`NO_CACHE=1 ./run.sh` for a cold build, `KEEP=1` to leave the stack up). It fetches the source by SHA into a temporary directory, verifies it, builds both images, starts the stack as Compose project `scf-s02` (only host port: `127.0.0.1:18200`), runs every check, writes evidence to `/tmp/usagemap-spikes/s02/out/`, and ends with `docker compose -p scf-s02 down -v` (images kept). Needs docker + buildx, curl, openssl, python3, node (mise), a Playwright Chromium in `~/.cache/ms-playwright` (or `CHROMIUM_PATH`).

Files:

| File | Purpose |
|---|---|
| `Dockerfile` | Our build. Stages `pnpm` → `deps` → `builder` → `runtime` → targets **`app`** (default) and **`migrate`**. Build context = Umami source at the pinned SHA; named context `scf` = `./build`. |
| `build/copy-closure.mjs` | Copies the locked dependency closure of `prisma` + `dotenv` out of the frozen pnpm install (replaces upstream's unlocked `pnpm add`). |
| `compose.yaml` | PostgreSQL 18 + `umami-migrate` (one-shot) + `umami` on an `internal: true` network; test-only `front` (TCP forwarder to the host) and `netcap` (tcpdump in Umami's network namespace). |
| `db-init/10-umami.sh` | Creates role `umami_app` owning database `umami` (C-12). |
| `ui-check.mjs` | Headless Chromium: logs in, opens dashboard/website/settings pages, records and **aborts** every non-Umami request. |
| `run.sh` | The whole proof. |
| `build/netcap.Dockerfile` | Test-only tcpdump sidecar image. |

Versions and pins:

- Source: `git fetch --depth 1 origin d3c62a805beda8643cb468924dda38617fb4c286`; checks: `HEAD` = pin, the commit object re-hashes to the pin (`git cat-file commit HEAD | git hash-object -t commit --stdin`), work tree clean, `git ls-remote` shows upstream tag `v3.5.0` (lightweight) → same SHA. Tree hash recorded in `out/source.txt`.
- Base: `node:22.23.4-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202` (same Node line upstream uses).
- pnpm: `@pnpm/exe.linux-x64-musl@12.3.4` tarball (the native binary pnpm 12 itself would fetch), sha512 `44f9a4ec…ba39afeb` checked with `sha512sum -c` (matches the npm registry integrity `sha512-RPmk7Jb/…`). Upstream instead runs `npm install -g pnpm@12.3.4`.
- PostgreSQL: `postgres:18.6-alpine@sha256:9ba53c7d41ea093baf5c1ba635ba5434c4f979880527d49bb7d9237d3193085b`.
- Docker 29.7.2, buildx 0.36.1, Compose 5.5.0; Playwright 1.64.0 (in a temporary directory, not in the repo) with chrome-headless-shell build 1254.
- Upstream comparison: `ghcr.io/umami-software/umami:3.5.0@sha256:b64f40400d77bcadd39cf5c62a1e368c99524ca442024f96e1133355a19a5dbc`, and upstream's own `Dockerfile` built from the same checkout.

What upstream's `Dockerfile` does at this commit, and what ours does instead:

| Upstream (line) | Why it is there | Ours |
|---|---|---|
| `ARG NODE_IMAGE_VERSION="22.23.4-alpine"` (1) | base | same version, **pinned by digest** |
| `npm install -g pnpm@${PNPM_VERSION}` (17, 28, 64) | package manager | checksum-verified pnpm binary, only in build stages; **not in the runtime image** |
| `printf 'strictDepBuilds: false\n' >> pnpm-workspace.yaml` (20) | relaxes pnpm's build-script gate | **removed**; `pnpm install --frozen-lockfile` passes with the lockfile's own `allowBuilds` (only `@prisma/engines` postinstall and `prisma` preinstall run) |
| `pnpm add npm-run-all dotenv chalk semver prisma@7.10.0 @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0` in the runner, after rewriting `pnpm-workspace.yaml`, **no lockfile** (73–80) | runtime deps of `scripts/start-docker.sh`: `check-db.js` (dotenv, chalk, `@prisma/adapter-pg`, `@prisma/client`) and its `prisma migrate deploy` (prisma CLI + `@prisma/engines`); `npm-run-all`/`semver` are left-overs of the old `start:docker` script | **removed.** The app image runs `node server.js` directly (Next standalone output already contains what the server imports). The migration tool-chain (`prisma` + `dotenv`, 138 packages incl. `@prisma/engines` with `schema-engine-linux-musl-openssl-3.0.x`) is copied from the frozen install by `build/copy-closure.mjs` into the separate `migrate` image. |
| `apk add curl libc6-compat` (runner) | healthcheck, glibc shim | none (healthcheck uses `node -e fetch(...)`; nothing needed glibc) |
| `pnpm build:docker` with `SKIP_BUILD_GEO` unset → `scripts/build-geo.js` downloads `GitSquared/node-geolite2-redist/master` | GeoLite2 in image | `SKIP_BUILD_GEO=1`, and the build step fails if `geo/` exists |
| `COPY --chown=nextjs:nodejs public` + `CMD sh scripts/start-docker.sh` → `check-db.js` (migrates unless `SKIP_DB_MIGRATION`) and `update-tracker.js` (rewrites `public/script.js` if `COLLECT_API_ENDPOINT`) | start-up side effects | all app files **root-owned, not writable by uid 1001**; `CMD ["node","server.js"]`, so neither script runs |
| npm removed, yarn/corepack kept | — | npm, npx, corepack, yarn, yarnpkg removed |

## Observations (raw facts, with excerpts of output)

**Build** (`out/build-*.log`, `out/sizes.txt`):

```
deps:   ✓ Lockfile passes supply-chain policies (1180 entries in 7.6s)
        Lockfile is up to date, resolution step is skipped      Packages: +1047
        .../@prisma/engines postinstall: Done    .../prisma preinstall: Done
builder: SKIP_BUILD_GEO is set. Skipping geo setup.
         copied 138 locked packages for: prisma dotenv
```

| Image | Uncompressed (`docker images`) | Content (compressed layers) |
|---|---|---|
| `scf-s02/umami-app:3.5.0-d3c62a8` (id `760675c4cca6`) | **378 MB** | **86.9 MB** |
| `scf-s02/umami-migrate:3.5.0-d3c62a8` (id `b6122f691f12`) | 603 MB | 132 MB |
| upstream `ghcr.io/umami-software/umami:3.5.0` | 1.32 GB | 312 MB |
| upstream `Dockerfile`, built here from the same checkout | 1.31 GB | 312 MB |

App image layers: base 177 MB, `.next/standalone` 100 MB, static 6 MB, public 7 MB. Migrate closure: `@prisma/studio-core` 43 MB, `prisma` 41 MB, `effect` 34 MB, `typescript` 24 MB, `@electric-sql/pglite` 24 MB, `@prisma/engines` 23 MB, `@prisma/dev` 19 MB … (280 MB total) — Prisma 7's CLI, not anything we add. Upstream ships all of it (plus the 50 MB GeoLite2 DB) in the engine image.

Build times, cold (`--no-cache`), on a shared 7-core host while other spikes were running: app target **124 s** on the first, quieter build; **239 s** (app) and 277 s (migrate, a second full cold build) in the `NO_CACHE=1` run; upstream's Dockerfile **192 s** in the same conditions. Warm rebuild of both targets: 3 s + 2 s. The two targets share all build stages, so building them in one invocation (`docker buildx bake` or app then migrate with cache) costs one build. Timings are indicative only.

The tracker that this build serves is byte-identical to upstream's image: `/script.js` sha384 `Ts03XUTV1nsmqXjhMgA3LGXKFnW1NLMAzbKGEaaDFUy7wUETechGFTNIXF7rAuqP` in both (9,297 bytes).

**Runtime lock-down** (`./run.sh`, run 3, 36/36):

```
PASS  migration one-shot exited 0            (27 migrations, then "No pending migrations to apply." on re-run)
PASS  umami healthy
PASS  umami: read-only rootfs, cap_drop ALL, no-new-privileges, uid 1001
PASS  engine network is internal
PASS  umami attached only to the engine network
PASS  no startup migration / tracker rewrite in umami log
```

Umami's whole log for a full run is 14 lines: the Next.js banner plus one `ENOENT … /app/geo/GeoLite2-City.mmdb` stack (from the deliberate no-country send below). No `EROFS`, DNS, timeout or unhandled-rejection lines.

**Read-only root and tmpfs.** First run had *no tmpfs at all*: migrations, start-up, `/api/send`, login, admin API and the full dashboard worked. The only write attempt was the Next image optimiser on `GET /_next/image?...` → still answered 200 but logged `⨯ Failed to write image to cache … mkdir '/app/.next/cache'` and an `unhandledRejection`. With the tmpfs below, the only file written during a whole run was `/app/.next/cache/images/…` (from that one probe); `/tmp` stayed empty. The migrate container also ran with a read-only root (with a 16 MB `/tmp`).

**`/api/send`** with `CLIENT_IP_HEADER=x-scf-surrogate-ip` (surrogates from 203.0.113.0/24 and 10/8, documentation/private ranges):

```
x-scf-surrogate-ip: 203.0.113.7 + cf-ipcountry: DE        -> 200   stored country DE, tag v
x-scf-surrogate-ip: 203.0.113.9 + cf-ipcountry: XX        -> 200   stored country XX
x-scf-surrogate-ip: 203.0.113.8, no cf-ipcountry          -> 500   ENOENT /app/geo/GeoLite2-City.mmdb
x-scf-surrogate-ip: 10.1.2.3,    no cf-ipcountry          -> 200   stored country NULL
stats  {"pageviews":4,"visitors":4,"visits":4,"bounces":4,...}   metrics?type=country [DE,NL,XX]
```

Cause (`src/lib/detect.ts` `getLocation`): a local/invalid IP returns no location; otherwise the first provider header wins (`cf-ipcountry` is in the list); only if none is present does it open the MaxMind file — which `SKIP_BUILD_GEO` removed.

**Login / admin API:** `POST /api/auth/login` with `admin`/`umami` → 200 + token (`passwordChangeRequired: true` in `/api/auth/verify`; the API is *not* blocked by it — only the UI shows a modal); `POST /api/websites` → 200; `GET /api/admin/users` → 200.

**Egress.** Packet capture inside Umami's network namespace (sidecar started right after Umami, stopped before the deliberate probe) over start-up, all API calls, route probes, the dashboard session and bootstrap:

```
DNS questions asked by umami:   6 A? postgres.   6 AAAA? postgres.
TCP SYNs by destination:        > 127.0.0.1:3000 (healthcheck)  > <engine>.2:5432 (postgres)  > <engine>.4:3000 (front)
IP packets to/from anything outside the engine subnet and loopback: 0
```

So the server makes **no outbound attempt at all**, and nothing fails or waits for lack of egress. A deliberate probe from inside the container shows what *would* happen: `api.umami.is` and `i.umami.is` → `EAI_AGAIN` after ~5 s, `icons.duckduckgo.com` → no answer within the 10 s timeout, `1.1.1.1` → `ENETUNREACH` after 13 ms. Name lookups do not fail fast on an internal network, so any future server-side outbound call would show up as multi-second latency, not an immediate error.

**Dashboard in headless Chromium** (login → `/` → `/websites/:id` → `/websites` → `/settings/websites` → `/settings/profile`, ~90 same-origin requests incl. `/telemetry.js` which returns `/* telemetry disabled */`), with one event carrying referrer `https://www.example.org/page` so favicons would render:

| Flags on the `umami` container | External URLs the browser requested |
|---|---|
| `DISABLE_TELEMETRY=1 DISABLE_UPDATES=1 PRIVATE_MODE=1` | **none** |
| only `PRIVATE_MODE=1` | **none** |
| none of the three | `https://api.umami.is/v1/updates?v=3.5.0` (×4), `https://i.umami.is/a.png?v=3.5.0` (×4), `https://icons.duckduckgo.com/ip3/s02.example.ico` (×3), `https://icons.duckduckgo.com/ip3/example.org.ico` (×1) |

This confirms in practice what the research only had from the docs: `PRIVATE_MODE` suppresses the DuckDuckGo favicon fetches (`src/components/common/Favicon.tsx:12`), as well as the update check and the telemetry pixel. All three calls are made by the **viewer's browser**, never by the server.

**Routes on this build** (unauthenticated unless noted, through the test forwarder, `out/routes.txt`):

| Route | Observed | Meaning |
|---|---|---|
| `POST /api/batch` | **200** `{"size":1,"processed":1,…,"cache":…}` | live, unauthenticated, writes events |
| `POST /api/record` | 400 (schema error on our dummy body) | live, unauthenticated session-replay ingest |
| `GET /q/<slug>` | 404 JSON | live link-tracking route (404 only because the slug does not exist) |
| `GET /p/<slug>` | 404 JSON | live pixel route (same) |
| `GET`/`POST /mcp` | 404, empty body | off: `src/app/mcp/route.ts:44` requires `MCP_ENABLED=1` |
| `GET /share/<slug>` | **200 HTML** (page shell) | live UI page; data comes from `/api/share/*` |
| `GET /api/share/<slug>` | 404 JSON | live (no share exists) |
| `POST /api/teams/join` | 401; with an admin token + unknown code: 404 `team-not-found` | live for any signed-in user |
| `GET /script.js` | 200, 9,297 B, unmodified | upstream tracker |
| `GET /recorder.js` | 200, 190,757 B | session recorder |
| `GET /telemetry.js` | 200 `/* telemetry disabled */` | inert with the flags |
| `GET /openapi.json` | 200, 1.5 MB | full API description |
| `GET /_next/image?url=…` | 200 image | image optimiser (the only writer to `.next/cache`) |
| `GET /login`, `POST /api/auth/login` | 200 HTML / 401 | live |
| `GET /api/heartbeat` | 200 `{"ok":true}` | health |
| `GET /api/config` | 404 | removed in v3.5 (as the research said) |

**Bootstrap of the seed admin** (seed user id `41e2b680-648e-4b09-bcd7-3e2b10c06264`, fixed in `prisma/migrations/01_init/migration.sql:199`, so identical on every install):

```
POST /api/auth/login        {"username":"admin","password":"umami"}                → 200 {token: T}
POST /api/me/password       Authorization: Bearer T
                            {"currentPassword":"umami","newPassword":"<random>"}   → 200 {token: T2, ...}
POST /api/auth/login        admin/umami                                            → 401
GET  /api/me                Bearer T (old token)                                   → 401  (tokens are bound to the password hash)
POST /api/users             Bearer T2 {"username":"scf-provisioner","password":"<random>","role":"admin"} → 200 {id}
POST /api/auth/login        scf-provisioner                                        → 200 {token: T3}
DELETE /api/users/41e2b680-648e-4b09-bcd7-3e2b10c06264   Bearer T3                 → 200
POST /api/auth/login        admin/<changed password>                               → 401
```

(`newPassword` must be ≥ 8 characters; an admin cannot delete itself — `You cannot delete yourself.` — hence the second admin does it.)

## Answer to the question

Yes. The recipe in this directory builds Umami v3.5.0 from the pinned SHA with a digest-pinned base, a checksum-verified pnpm, `--frozen-lockfile` without upstream's `strictDepBuilds: false`, no unlocked install anywhere, and no geo download. The result is 3.6× smaller than upstream's image (86.9 MB vs 312 MB compressed), serves the same tracker bytes, and runs with a read-only root, no capabilities, `no-new-privileges`, uid 1001 and no route out. With the hardening flags the server makes no outbound connection and the dashboard requests no external URL. Migrations run as `prisma migrate deploy` in a separate one-shot container from a separate image. The seed admin can be changed and deleted entirely through the API before anything else touches Umami.

Upstream's unlocked `pnpm add` (Dockerfile:78) only existed to give `start-docker.sh` its scripts' dependencies (`check-db.js`, `prisma migrate deploy`). Once migrations are an explicit step and the tracker is not rewritten, the engine image needs none of it. The migration image gets the same packages from the lockfile instead.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)

- **ADR-0003 Decision / Hardening — confirmed**, with one addition: "We build the image ourselves … `SKIP_BUILD_GEO=1`" now also requires that **the gateway always sends a non-empty `cf-ipcountry`** (an ISO code, or `XX` when unknown). Without it Umami 500s on every event whose surrogate is a public-looking address. Add this to ADR-0005's forwarded-header list and to `docs/contracts/wire-formats.md` as a MUST, with a contract test.
- **ADR-0003 / supply-chain.md §6.1 — refine "our build":** two images from one Dockerfile, `umami` (engine) and `umami-migrate` (deploy step), both signed, attested and SBOM'd. `vendor/umami/` holds `Dockerfile`, `copy-closure.mjs`, the SHA and the pnpm/Node pins. Replace "`strictDepBuilds: true` with a reviewed `allowBuilds`" with "upstream's `strictDepBuilds: false` override is dropped; the lockfile's own `allowBuilds` is the reviewed list (today it allows `@prisma/engines` and `prisma`)".
- **C-40 — confirmed and made exact:** the migration step is `prisma migrate deploy` run as `umami_app` (C-12) from the `umami-migrate` image, as a Compose one-shot that `umami` waits for (`service_completed_successfully`). It is idempotent ("No pending migrations to apply."). `SKIP_DB_MIGRATION=1` is kept on the app container as a guard, but our image never runs `check-db.js` at all.
- **hardening.md §5.5 — resolve "subject to spike S-02":** read-only root with tmpfs `/tmp` and `/app/.next/cache` (values below). Neither is required by any route on our allow-lists. Also: app files root-owned and not writable by uid 1001, no npm/yarn/corepack/pnpm/curl in the image.
- **hardening.md §5.2 — confirmed:** `PRIVATE_MODE` alone suppresses all three browser-side calls. Keep all three flags as defence in depth.
- **hardening.md §5.3 never-allow list — confirmed** for every route tested. Add `/api/record` explicitly alongside `/api/websites/*/recorder` (it is a separate unauthenticated ingest route). `/api/share*` already covers `/api/share/<slug>`. `/telemetry.js` and `/api/scripts/telemetry` are inert with the flags but stay blocked.
- **hardening.md §5.4 — confirmed:** "create the provisioning admin, then delete the seed admin" works through the API exactly as shown. The bootstrap check "admin/umami no longer logs in" is `POST /api/auth/login` → 401.
- **C-10 — confirmed for the engine:** zero outbound packets. Note for the egress-alert design: an outbound attempt from inside an `internal` network shows up as a DNS question to the embedded resolver (and ~5–10 s latency), not as a dropped packet.

## Values the implementation must use (env vars, headers, config keys, flags, limits)

**Images** (built from `vendor/umami/Dockerfile`; build context = Umami source at `d3c62a805beda8643cb468924dda38617fb4c286`, verified as in `run.sh` §1):
`docker buildx build -f Dockerfile --build-context scf=<vendor/umami/build> --target app|migrate <src>`

**`umami` (engine) container**

| Setting | Value |
|---|---|
| `read_only` | `true` |
| `tmpfs` | `/tmp:size=16m,mode=1777` and `/app/.next/cache:size=64m,uid=1001,gid=1001,mode=0700` |
| `cap_drop` / `security_opt` | `[ALL]` / `["no-new-privileges:true"]` |
| user | `1001:1001` (baked in) |
| networks | one network with `internal: true` (Umami + PostgreSQL + the engine proxy's inner side); nothing else |
| `pids_limit` / memory | 256 / 1 GiB used here (not measured further) |
| command | image default `node server.js` (do **not** use upstream's `scripts/start-docker.sh`) |
| healthcheck | baked in: `node -e fetch('http://127.0.0.1:3000/api/heartbeat')` |
| `DATABASE_URL` | `postgresql://umami_app:<secret>@<pg>:5432/umami` |
| `APP_SECRET` | ≥ 32 random bytes (64 hex used here) |
| `DISABLE_TELEMETRY` / `DISABLE_UPDATES` / `PRIVATE_MODE` | `1` / `1` / `1` |
| `SKIP_DB_MIGRATION` | `1` (guard; not read by our CMD) |
| `CLIENT_IP_HEADER` | `x-scf-surrogate-ip` |
| `SALT_ROTATION` / `TZ` | `day` / `UTC` |
| unset | `MCP_ENABLED`, `COLLECT_API_ENDPOINT`, `TRACKER_SCRIPT_NAME`, `TRACKER_SCRIPT_URL`, `CLOUD_MODE`, `GEOLITE_DB_PATH`, `SKIP_LOCATION_HEADERS`, `DISABLE_BOT_CHECK` |
| baked into the image | `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED=1`, `HOSTNAME=0.0.0.0`, `PORT=3000` |

**Headers on every `POST /api/send`** (from the engine proxy / forwarder): `x-scf-surrogate-ip: <surrogate>` and **`cf-ipcountry: <ISO-3166 alpha-2 or XX>` — always present and non-empty**. Plus a non-bot `user-agent` (Umami's `isbot` check stays on).

**`umami-migrate` (one-shot deploy step)**

| Setting | Value |
|---|---|
| command | `node node_modules/prisma/build/index.js migrate deploy` (image `ENTRYPOINT` + `CMD ["migrate","deploy"]`), working dir `/opt/umami-migrate` |
| env | `DATABASE_URL` (as `umami_app`, the schema owner), `CHECKPOINT_DISABLE=1` (Prisma CLI update-check/telemetry; also baked in), `PRISMA_HIDE_UPDATE_MESSAGE=1` |
| hardening | same as the engine: `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, uid 1001, tmpfs `/tmp:size=16m`, internal network only |
| ordering | `umami.depends_on.umami-migrate.condition: service_completed_successfully`; exit code ≠ 0 stops the deploy |

**Engine proxy: never forward** (in addition to hardening.md §5.3's list): `POST /api/batch`, `POST /api/record`, `/api/websites/*/recorder`, `/q/*`, `/p/*`, `/mcp`, `/share/*`, `/api/share*`, `POST /api/teams/join`, `/script.js`, `/recorder.js`, `/telemetry.js`, `/api/scripts/*`, `/openapi.json`, `/_next/image`, `/login`, `/api/auth/*` (except for the provisioning identity, which needs `/api/auth/login`), `/api/2fa/*`, `/api/me/password` (provisioning identity only, bootstrap). Edge forwarders: `POST /api/send` only. Health: `GET /api/heartbeat`.

**Bootstrap (once, before the engine proxy allows any other caller):**
1. `POST /api/auth/login {"username":"admin","password":"umami"}` → token T.
2. `POST /api/me/password {"currentPassword":"umami","newPassword":"<≥8 chars, random>"}` (Bearer T) → token T2.
3. `POST /api/users {"username":"<provisioning admin>","password":"<random>","role":"admin"}` (Bearer T2); log in as it → T3.
4. `DELETE /api/users/41e2b680-648e-4b09-bcd7-3e2b10c06264` (Bearer T3) → 200.
5. Assert `POST /api/auth/login` with `admin`/`umami` → 401.

## Open issues

- **Bit-for-bit reproducibility not claimed or tested** (consistent with supply-chain.md §2.2). Two cold builds produced different image IDs. Inputs are pinned, but outputs carry timestamps.
- **`@prisma/engines` postinstall downloads `schema-engine`** from Prisma's binary server during `pnpm install` (version fixed by the lockfile's `@prisma/engines-version`; Prisma checks it against a `.sha256` from the same server). This is the one build-time download not pinned by our own checksum. To pin it, vendor the binary and set `PRISMA_SCHEMA_ENGINE_BINARY`. Not tested here.
- **The pnpm default for `strictDepBuilds` was not proven by a negative test.** We only observed that the frozen install passes without upstream's `false` override, and that only the two allow-listed scripts ran. The image build can add `strictDepBuilds: true` explicitly to the build-time `pnpm-workspace.yaml` copy to make it independent of pnpm's default.
- **Alpine packages:** the runtime image installs none. The base image's own Alpine packages are fixed by its digest; the digest must be bumped (Node 22 is EOL 2027-04-30).
- **Build timings are noisy**: other spikes were running on the host.
- **`public/script.js` and `recorder.js` are still in the image** (served unmodified; blocked at the engine proxy). Deleting them from the image is possible but would diverge from upstream's file set. Not done.
- `DISABLE_UI` / `DISABLE_LOGIN` (proposed in hardening.md §5.2) were not tested here, because the dashboard check needed the UI. They are cosmetic per ADR-0003 anyway.
- PostgreSQL ran with Docker's default capabilities (only `no-new-privileges`). Hardening the database container is outside this spike.
- The `front` forwarder and the `netcap` sidecar are test-only. Both containers share the engine network, so the production equivalent of `front` is the engine proxy.
- Removed after use: the comparison image `scf-s02/upstream-dockerfile:3.5.0`. Kept: `scf-s02/umami-app:3.5.0-d3c62a8`, `scf-s02/umami-migrate:3.5.0-d3c62a8`, `scf-s02/netcap`.
