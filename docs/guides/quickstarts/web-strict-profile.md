# Web: strict profile

**Status (docs.quickstarts-run): checked against the code and the tracker's end-to-end fixtures.** Checked against `tracker/README.md` (profiles table, privacy behaviour, build checks),
`tracker/e2e/privacy.spec.ts` (property reads instrumented: `strict` reads only the visitor's choices and the
visibility state), `services/control-plane/src/domain/sites.ts` (default `visitor_id`), register C-33, C-53.

## What strict changes

| | `standard` | `strict` |
|---|---|---|
| page path | yes | yes |
| referrer host, screen-width class, primary language | yes | **no** |
| client signal booleans (webdriver, visibility at send, user activation) | yes | **no** — and their absence is never a reason for `suspect` (C-33) |
| Wallets Kit presence flag | yes | **no** |
| challenge + proof-of-work (so traffic can be `verified`) | yes | yes |
| visitor identifier | `on` by default | **`off` by default** (C-53); a tenant can turn it on deliberately |
| gzip size (1.1.0) | 2,854 B | 2,493 B |

Besides the path, `strict` reads only what it needs to honour the visitor's choices and to send on page hide: the
GPC/DNT flags, the opt-out flag and the page's visibility state. The build fails if `strict` contains any client-signal,
referrer, screen, language or Wallets Kit read (`tracker/scripts/check-output.ts`).

## Set the site to strict

When creating the site in the portal choose profile **strict** (or `updateSite` with `tracker_profile: "strict"`).
The gateway enforces the site's profile: fields the profile does not allow are discarded and counted
(`profile_field_stripped`) (C-37).

## Embed the strict build

```html
<script
  src="https://ingest-a.example-analytics.org/lib/1.2.0/strict.js"
  integrity="sha384-7Me6KspzAO7mUrsBqZriNmfNQJjj3yY1rYsACRveyWKFan6CBJtl763gwtKaEETu"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  defer
></script>
```

or `import { init } from "@usagemap/tracker/strict";`. Take the hash from the portal snippet for your release.

## What your dashboard will show

With the default `visitor_id = off`, every event goes to the site's twin engine website without an identifier: you
get **page views, country, device, browser and OS**, but **no unique visitors, visits, bounce rate or duration**
(C-73). No referrer breakdown exists for strict sites. See `docs/metrics/definitions.md` §2.3.

Statements about Germany in `docs/privacy/jurisdictions.md` assume `strict` with no identifier (C-53); for `strict`
Germany is "contested" and Belgium "not assessed" (C-41). Combine with [consent mode](web-consent-mode.md) where opt-in
is required.
