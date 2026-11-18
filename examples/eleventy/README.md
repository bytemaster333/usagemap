# Eleventy (static site generator)

An Eleventy site whose base layout carries the pinned tracker tag; the site key comes from the build environment through a global data file. Guide: [Static site generators](../../docs/onboarding/web-static-site-generators.md).

## Run it

1. **Install:** `pnpm -C examples install --frozen-lockfile --filter ./eleventy` (from the repository root).
2. **Set your key:** `export SCF_SITE=YOUR_22_CHAR_SITE_KEY` (portal: **Site → Snippet**; replace the placeholder ingest host in `src/_includes/base.njk` with the one from the snippet).
3. **Run:** `pnpm -C examples/eleventy dev`, open http://localhost:8080.

## The lines that add UsageMap

`src/_data/scf.js`:

```js
export default { site: process.env.SCF_SITE ?? "" };
```

`src/_includes/base.njk`:

```html
    <script
      src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
      integrity="sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu"
      crossorigin="anonymous"
      data-site="{{ scf.site }}"
      defer
    ></script>
```

## What you'll see in the portal

Portal → your website → **Integrations** → *Start live check*. Within seconds the first-event panel shows the
page view of `/` from `localhost` as `dev` (dev origins are never counted; add `localhost` under the site's
**Dev origins** first). Deployed on your declared domain, the status turns to **Live data seen** and the pages appear
in the dashboard.

## Test it without the app

```sh
curl -sS -i 'https://<INGEST_HOST>/v1/e' \
  -H 'Origin: http://localhost:5173' \
  -H 'Content-Type: text/plain;charset=UTF-8' \
  --data '{"v":1,"s":"YOUR_22_CHAR_SITE_KEY","p":"standard","tv":"1.1.0","e":[{"id":"usagemap-test-event-01","k":"pv","u":"/usagemap-test"}]}'
```

`HTTP 202`; the first-event panel lists the page view as *would be rejected (`challenge_missing`)*, which is expected:
curl does not solve the tracker's proof of work. It proves the site key, the edge and your dev origin are right
([how the website test works](../../docs/onboarding/integrations.md#how-the-website-test-works)).

## Tested by

`tests/quickstarts/frameworks/frameworks.spec.ts` builds this app in production mode, serves it with its own server and
drives it in Chromium against a mock of the ingest protocol: one page view per route (client-side navigations and the
back button included), the custom event `signup {plan: "free"}` exactly once, a deep link with a query string counted
once as its path, and no request to any other host. `tests/quickstarts/frameworks.test.ts` checks that the guide shows
this app's files and versions. Run: `QS_FRAMEWORKS=eleventy tests/quickstarts/frameworks/run.sh`.
