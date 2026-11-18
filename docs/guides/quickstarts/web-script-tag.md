# Web: script tag with SRI

**Status (docs.quickstarts-run): runs as a test fixture** — this guide's own code blocks are extracted and run as written (only the documented placeholders replaced) against the real stack by `tests/quickstarts/40-quickstarts.e2e.test.ts` (`make quickstarts`); `tests/quickstarts/extract.test.ts` fails when a block, placeholder, SRI hash or pinned version drifts. Also: Checked against `tracker/README.md`, `tracker/src/classic.ts`, `tracker/dist/1.1.0/manifest.json`
and the e2e specs `tracker/e2e/smoke.spec.ts` and `fixtures.spec.ts` (static fixture).

## 1. Copy the snippet

Take it from the portal (**site → Snippet → HTML (script tag)**): it has your site key, the file for your site's
profile and the matching hash. It looks like this (tracker 1.1.0, `standard` profile, placeholder host):

```html
<script
  src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
  integrity="sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  defer
></script>
```

Put it in the `<head>` of every page. The hash above belongs to the current build with placeholder hosts; the
authoritative value for a release is in its `manifest.json` (`files[].integrity`) and in the portal's snippet.

## 2. Rules

- `integrity` **and** `crossorigin="anonymous"` are both required; without `crossorigin` the browser cannot check the
  hash. If the hash does not match, the browser does not run the file: analytics stops, your page keeps working
  (e2e "SRI mismatch runs nothing").
- `data-site` is the only required attribute; `data-consent="required"` is the only optional one. Nothing else is
  configurable and no configuration is ever fetched.
- The URL is immutable: `/lib/<semver>/<profile>.js`. There is no `latest`. To upgrade, change the version **and**
  the hash.
- Content Security Policy: `script-src https://ingest-a.example-analytics.org` (or a nonce on the tag) and
  `connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`. It runs under
  `require-trusted-types-for 'script'`.

## 3. Custom events

```html
<button onclick="window.scf && window.scf.track('signup', { plan: 'free' })">Sign up</button>
```

Calls made before the script has loaded can be queued: put `window.scf = window.scf || [];` before the tag and push
`["track", "signup", { plan: "free" }]`; the tracker replays the queue in order when it starts
(`createTracker` in `tracker/src/core.ts`).

`track(name, props)` rules: name 1–50 characters `[A-Za-z0-9][A-Za-z0-9_.:-]*`; at most 10 property keys
`[a-z][a-z0-9_]{0,31}`; values are strings ≤ 100 characters, finite numbers with |n| ≤ 10¹⁵, or booleans. Anything that
looks like an e-mail address, a JWT or a run of ≥ 32 base64/hex characters (every Stellar address and key, and hashes)
is refused (`track` returns `false`) — never put identifiers in events. The gateway applies the same guard again.

A visit that contains any custom event is never a bounce (C-75), so do not fire events automatically on page load.

## 4. Verify

Open your page in a browser profile without Global Privacy Control, Do Not Track or an ad-blocker, then check
**site → Installation** in the portal (see the onboarding guide, step 6).
