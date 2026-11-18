# Plain HTML: the first 10 minutes

For static sites and server-rendered pages without a JavaScript bundler. You need a project in the portal (sign in,
create the project) and about ten minutes.

| Minute | Step |
|---|---|
| 0–2 | Add a website with its production domain, and `localhost` as a dev origin |
| 2–4 | Paste the snippet |
| 4–6 | Open the page locally with debug mode and watch the first events arrive as `dev` |
| 6–7 | Register your footprint (or say you have none) |
| 7–10 | Deploy, verify the domain, see the first *verified* page view |

**Tested:** the snippet below is the one in the example site of the repository (`examples/html`). The repository's
browser tests serve that site and check in a real browser that each page load is counted exactly once, that the
custom-event button sends one event, and that a deep link with a query string and a fragment is counted once, as its
path. A site generator or site builder only has to put the same tag into its pages: see
[static site generators](web-static-site-generators.md) and [site builders and CMSs](web-cms.md).

## 1. Add the website

Portal: **Add a website** → name and **production domain** (for example `www.example.org`). Then in the site's
settings add `localhost` under **Dev origins** ([what dev origins do](dev-origins-and-debug.md)). Events from a dev
origin are accepted and shown in the first-event panel, but never counted.

Pick the profile: `standard` (the default) or `strict` (sends nothing but the page path; for jurisdictions that read
the ePrivacy rules strictly). The portal's snippet matches the profile you chose.

## 2. Paste the snippet

Put it in the `<head>` of every page:

```html
<script
  src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
  integrity="sha384-9cCOUUPE6uUu1Hwc1k3dMe7p64S2BpjVx5u4FoYVgXXomF744QWb1rSVHZqK7MRu"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  defer
></script>
```

- Copy the real snippet from the portal (site → **Snippet**): it carries your site key and the current version's
  `integrity` hash. Each version is served at its own immutable URL; there is no `latest`.
- `integrity` and `crossorigin="anonymous"` are both required. If the hash does not match, the browser does not run
  the file: analytics stops, your page keeps working.
- If your site sends a Content Security Policy, allow
  `script-src https://ingest-a.example-analytics.org` and
  `connect-src https://ingest-a.example-analytics.org https://ingest-b.example-analytics.net`.

## 3. Test locally with debug mode

Serve the page from `http://localhost:<any port>` (for example `python3 -m http.server 8080`). The portal's
first-event panel (site → **Installation**) lists the page views from `localhost` as `dev`, with the verdict they
*would* have had, about a minute after they arrive.

To see in the browser why something was or was not sent, use the tracker's debug module (tracker 1.1.0 or later). It
is part of the npm package (`dist/npm/debug.js`; the package is not on the npm registry yet — until it is, take the
file from the repository's tracker build); copy that file next to your test page and load it **before** the
tracker, on your local copy only:

```html
<script type="module">
  import { debug } from "./debug.js"; // from @usagemap/tracker/dist/npm/debug.js
  debug();
</script>
```

The console and a small panel on the page then say what was sent and, if nothing was sent, why (Global Privacy
Control, Do Not Track, opt-out, consent pending, a blocked request, an origin that is not declared). Never deploy it.

**Testing in Brave?** Brave turns on Global Privacy Control by default, and the tracker sends nothing at all to a
browser with GPC on. That is intended. Debug mode tells you so; test in a browser profile without GPC to see events.

## 4. Register your footprint

Portal: **Footprint**. Add the Stellar contracts your project deployed, or tick "This project has no on-chain
footprint". See [footprint](footprint.md). This takes a minute and is what lets SCF operators read your on-chain usage next to
your web numbers.

## 5. Deploy and verify the domain

Deploy as usual. Then verify that the domain is yours (portal: site → **Domains**: a DNS TXT record, a file under
`/.well-known/`, or a meta tag). Until it is verified, events from it count as `suspect` (`domain_unverified`), not
`verified`.

Open the production page in a browser without GPC or an ad blocker. Within about a minute the Installation page shows
the first `verified` page view.

## 6. Custom events (optional)

```html
<button onclick="window.scf && window.scf.track('signup', { plan: 'free' })">Sign up</button>
```

Names: 1–50 characters `[A-Za-z0-9][A-Za-z0-9_.:-]*`; at most 10 properties with lower-case keys; values are short
strings, numbers or booleans. `track()` refuses (returns `false`, sends nothing) any value that looks like an e-mail
address, a token or a Stellar key. Do not use the [wallet event names](wallets.md) for custom events: a custom event
with such a name is still a custom event and is never counted as a wallet event.

## Next

- A dApp with a wallet button: [wallet adapters](wallets.md).
- Nothing arrives: [troubleshooting](troubleshooting.md).
- Consent banner or strict profile: [consent mode](../guides/quickstarts/web-consent-mode.md),
  [strict profile](../guides/quickstarts/web-strict-profile.md).
