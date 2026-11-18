# Web: npm package

**Status (docs.quickstarts-run): runs as a test fixture** — this guide's own code blocks are extracted and run as written (only the documented placeholders replaced) against the real stack by `tests/quickstarts/40-quickstarts.e2e.test.ts` (`make quickstarts`); `tests/quickstarts/extract.test.ts` fails when a block, placeholder, SRI hash or pinned version drifts. Also: Checked against `tracker/README.md`, `tracker/src/npm.ts`, `tracker/package.json` (exports
`.`, `./strict`, `./wallets-kit`) and the React Router SPA fixture in `tracker/e2e/fixtures.spec.ts`.

Bundling the tracker into your own JavaScript removes the third-party script entirely; only the requests to the two
ingest hosts remain. This is the strongest delivery mode (ADR-0004).

## 1. Install, pinned exactly

```sh
pnpm add --save-exact @usagemap/tracker@1.2.0
```

## 2. Start it once on the client

```ts
import { init } from "@usagemap/tracker";          // standard profile
// import { init } from "@usagemap/tracker/strict"; // strict profile — must match the site's profile

const scf = init({ site: "YOUR_22_CHAR_SITE_KEY" });     // add consent: "required" for consent-gated mode
scf?.track("signup", { plan: "free" });                  // optional custom event
```

- `init()` returns `undefined` during server-side rendering (no `window`), so it is safe in shared code.
- Calling it again — React StrictMode, hot reload, or a script tag on the same page — returns the running instance;
  nothing is counted twice (fixture: `init()` inside a StrictMode effect, i.e. called twice).
- Page views are sent on load and on History-API navigations that change the path; hydration, `replace` to the same
  path, query-only and fragment-only changes do not count.
- Import the entry that matches your site's profile. If they differ, the gateway strips the fields the site's profile
  does not allow and counts `profile_field_stripped`.

## 3. Content Security Policy

Only `connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.

## 4. Upgrading

Bump the exact version. The wire protocol `v1` is backward compatible, so old versions keep working (ADR-0004).

Since 1.1.0, `@usagemap/tracker/wallets-kit` exports the Stellar Wallets Kit adapter (`attachWalletsKit`, and
`attachWalletsKitV1` for kit ≤ 1.9.5; ADR-0029, C-136) and `@usagemap/tracker/wallets`, `/passkey` and `/debug`
the other wallet adapters and the debug module; see `tracker/README.md` "Stellar wallet events". In 1.0.0 these entries
do not exist.
