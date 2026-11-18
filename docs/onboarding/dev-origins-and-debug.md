# Dev origins and debug mode

Two tools for seeing your installation work before (and after) you deploy. Neither changes what is counted.

## Dev origins: test on `localhost` and previews

A **dev origin** is a host your site runs on while you develop: `localhost`, `127.0.0.1`, or your preview
deployments. Events from a dev origin are

- **accepted** (the tracker runs its full path: challenge, proof of work, send),
- **shown to you** in the portal's first-event panel (site → **Installation**) for 24 hours, newest 100, each with
  the verdict it *would* have had in production,
- **never counted**: no page view, visitor, custom or wallet event, quota, trust score, snapshot or public figure
  ever includes them, and they are never forwarded to the analytics engine.

Set them in the portal: site → **Settings** → **Dev origins** (at most 10). Each entry is one of:

| Entry | Matches |
|---|---|
| `localhost` or `127.0.0.1` | that host on any port, `http` or `https` |
| an exact host, e.g. `staging.example.org` | `https://staging.example.org` |
| a pattern with one `*` in the leftmost label, e.g. `myapp-*-myteam.vercel.app` | `https://myapp-git-main-myteam.vercel.app`, … (`*` never matches a dot) |

The portal refuses a pattern that would admit strangers: `*.vercel.app`, `*.netlify.app` or `*.pages.dev` directly
above a shared hosting suffix, or a `*` with fewer than three fixed characters around it on a host you have not
verified. A host that is both a declared production domain and a dev origin counts as production.

What is kept for each dev event: its kind, the event name, the normalised path, the time it arrived, and the
would-be verdict with its main reason. Never kept: any visitor identifier, IP address, User-Agent, referrer, country,
property value, or the origin host.

**Why a dev origin cannot inflate your numbers:** the challenge token a dev page receives is marked as a dev token
and is refused on production events; dev requests pay the same per-network rate limit and proof-of-work cost as
production; and a dev origin has its own small limit (120 events per minute per site).

## Tracker debug mode: why nothing was sent

Tracker 1.1.0 and later ship a separate debug module that explains, in the browser console and in a small panel on
the page, what the tracker sent and why it sent nothing. Start it **before** the tracker, in development only:

```ts
import { debug } from "@usagemap/tracker/debug";
import { init } from "@usagemap/tracker";

debug(); // returns a function that switches it off again
init({ site: "YOUR_22_CHAR_SITE_KEY" });
```

With a bundler that keeps it out of production builds, load it with a dynamic `import()` behind your development
flag (the [Next.js](web-nextjs.md) and [React](web-react-spa.md) pages show how). For a plain HTML page, copy
`dist/npm/debug.js` from the npm package next to your local test page ([plain HTML](web-html.md)). It never needs to be
deployed: the tracker itself stays silent and unchanged.

What it names, from what the browser itself can see:

| Reason | What it means | What to do |
|---|---|---|
| Global Privacy Control is on | the browser asks sites not to share data (Brave turns it on by default) | expected; test in a profile without GPC |
| Do Not Track is on | the browser's DNT setting is `1` | expected; test without DNT |
| opted out | this browser called `optOut()` earlier (`scf_optout` in local storage) | call `optIn()` or clear the site's storage |
| waiting for consent | consent-gated mode and no `grantConsent()` yet | call `grantConsent()` from your consent tool |
| the tracker never started | an ad blocker, the Content Security Policy or an `integrity` mismatch stopped the script | see [troubleshooting](troubleshooting.md) |
| a request was blocked | the CSP lacks `connect-src` for the ingest hosts, or an extension blocked it | add both ingest hosts to `connect-src` |
| the origin is not declared | the gateway sent no CORS headers for this page's origin | add the domain, or add it as a dev origin |
| `404`, `410`, `429` | unknown site key, withdrawn tracker version, rate limit or quota | see [troubleshooting](troubleshooting.md) |
| `class=…; reasons=…` | the server's verdict, when the answer carries the debug header (below) | the reason text says what to change |

It prints event kinds, names and paths, never the token, a query string, an identifier or a request header.

## Site debug mode: the server's verdict, for a limited time

The tracker cannot see what the server decided (a `202` answer looks the same whether the event was counted or not;
that is deliberate, so bots learn nothing). When you need the server's verdict for production traffic, turn on the
**site's** debug mode in the portal (site → **Installation** → **Debug mode**, 1 minute to 24 hours, admins only, recorded
in your audit log). While it is on, every answer to your site carries a header

```text
X-Scf-Debug: v=1; class=suspect; reasons=domain_unverified
```

and the tracker's debug module prints it. Classes: `verified`, `suspect`, `rejected`, `dropped`, `dev`, `challenge`.
It switches itself off at the end of the window. While it is on, anyone could read your site's verdicts, which is
why it is time-boxed and off by default.

Outside site debug mode, an answer to a dev origin carries only `X-Scf-Debug: v=1; class=dev; reasons=dev_origin`;
the would-be verdict is shown in the first-event panel, where only your team can see it.
