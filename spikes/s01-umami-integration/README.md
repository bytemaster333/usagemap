# S-01 — Umami 3.5.0 integration (surrogate IP, country, tag filter, visit continuity, provisioning)

**Result:** PARTIAL — everything the design needs works through Umami's own API (surrogate + country, no IP stored, `tag` filter incl. `v,s`, bot drop, provisioning, isolation), but the cache-token replay behaves differently from C-01/C-74: with a payload `timestamp` the token **never** ends a visit, so the 30-minute inactivity rule must be enforced by the engine proxy on event timestamps, and two contract details are wrong (P2 role, `endAt` inclusive).

Item verdicts: 1 PASS · 2 PASS · 3 PARTIAL (works, but the visit rule must move into the engine proxy) · 4 PASS · 5 PASS · 6 PASS (with a contract fix) · 7 PASS.

## Question

Does Umami v3.5.0, run unmodified behind our gateway/engine proxy, (1) accept a surrogate address via `CLIENT_IP_HEADER`, a country via `cf-ipcountry`, a gateway-set `timestamp` and `tag`, and store no IP; (2) filter stats by `tag`, including "tag in (v,s)"; (3) keep one visit across a clock-hour boundary when its cache token is replayed (C-01/C-74); (4) compute pageviews/visitors/visits/bounces/totaltime as C-73/C-75 assume; (5) drop bots with a recognisable answer (C-69); (6) support the provisioning sequence of wire-formats §j.2 with tenant isolation (C-03, C-85); (7) which `timestamp` values does it accept?

## Method (versions, commands, how to re-run: one command if possible)

- Umami `ghcr.io/umami-software/umami:3.5.0@sha256:b64f40400d77bcadd39cf5c62a1e368c99524ca442024f96e1133355a19a5dbc` (source read at tag v3.5.0, commit `d3c62a805beda8643cb468924dda38617fb4c286`, shallow clone in a temporary directory).
- PostgreSQL `postgres:18-alpine@sha256:9ba53c7d41ea093baf5c1ba635ba5434c4f979880527d49bb7d9237d3193085b` (18.6).
- `compose.yml`: service `umami` on `127.0.0.1:18100` with `CLIENT_IP_HEADER=x-scf-surrogate-ip`, `SALT_ROTATION=day`, `TZ=UTC`,
  `DISABLE_TELEMETRY=1`, `DISABLE_UPDATES=1`, `PRIVATE_MODE=1`, `APP_SECRET` = `openssl rand -hex 32` generated per run (never on disk);
  service `umami-nogeo` on `127.0.0.1:18101`, same DB and secret, plus `GEOLITE_DB_PATH=/nonexistent/GeoLite2-City.mmdb`, `SKIP_DB_MIGRATION=1`.
- **Re-run:** `./run.sh` (needs docker compose, curl, jq, node, openssl; `KEEP=1 ./run.sh` leaves the stack up). It provisions
  through the API, sends ~90 events with curl, queries PostgreSQL and the stats API, writes everything to `out/run.log`
  (JWTs, API keys, session tokens, team access codes redacted) and ends with `docker compose -p scf-s01 down -v`.
- All synthetic events are stamped on "yesterday" (UTC, `D`) so the run is independent of the time of day; day-boundary
  checks use today. Surrogates are all in `2001:db8::/32` or deliberately local; the only public address used is
  `8.8.8.8` (a public resolver, to prove the bundled GeoLite lookup is live).
- Code locations used: `src/app/api/send/route.ts`, `src/lib/collection-session.ts` (visit rule),
  `src/lib/params.ts` + `src/lib/constants.ts` (filter operators), `src/queries/sql/getWebsiteStats.ts`,
  `src/lib/api-key.ts`, `src/permissions/{website,team}.ts`, `src/app/api/{teams,users,websites,me/*}/route.ts`.

## Observations (raw facts, with excerpts of output)

Excerpts from `out/run.log` (UUIDs shortened to 8 chars by the SQL).

### 1. Surrogate + country

Send (the shape the engine proxy forwards; this exact request is in `run.sh` as `send`):

```bash
curl -s -X POST http://127.0.0.1:18100/api/send \
  -H 'content-type: application/json' \
  -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' \
  -H 'x-scf-surrogate-ip: 2001:db8:5c1f:9a2e:77d0:13ab:e4c2:b9f' \
  -H 'cf-ipcountry: DE' \
  -d '{"type":"event","payload":{"website":"5f0c1c2e-8a7b-4f8e-9d55-1c7e0d9b2a43","hostname":"app.example.org",
       "url":"/a","screen":"1536x864","language":"en","tag":"v","timestamp":1794387600}}'
# -> HTTP 200 {"cache":"<jwt>","sessionId":"<uuid>","visitId":"<uuid>"}
```

| Case (`cf-ipcountry: DE` unless noted) | HTTP | stored `session.country` | session |
|---|---|---|---|
| surrogate S1, Chrome/Win, 09:00 and 09:10 | 200 | DE | same session **and** same visit (same hour) |
| S1, 17:00 same day | 200 | DE | same session, new visit (other hour) |
| S2 (`FR`), same UA | 200 | FR | new session |
| S1 with another UA (Safari/iOS) | 200 | DE | new session |
| S1 + same UA, next UTC day | 200 | DE | new session (`SALT_ROTATION=day`) |
| fresh surrogate, `cf-ipcountry: XX` | 200 | `XX` (stored literally) | — |
| S1 again later with `cf-ipcountry: FR` | 200 | still DE | country is a **session** attribute fixed by the session's first event |
| `10.1.2.3`, `127.0.0.1`, `::1`, `fd00::1` | 200 | **NULL** | event stored |
| `fd12:3456::abcd` (compressed ULA), `100.64.1.1` (CGNAT) | 200 | DE | "non-local" for `is-localhost-ip` (fragile, see research §3.3) |
| `not-an-ip` | 200 | NULL | event stored |
| valid `2001:db8::77`, **no** country header, bundled GeoLite present | 200 | NULL | mmdb has no record for 2001:db8::/32 |
| `umami-nogeo` (mmdb missing): with `cf-ipcountry` | 200 | DE | mmdb never opened |
| `umami-nogeo`: valid surrogate, **no** country header | **500** `{"error":{"message":"Server error",…}}` | — | log: `ENOENT … stat '/nonexistent/GeoLite2-City.mmdb'` |
| `umami-nogeo`: local surrogate `10.9.9.9`, no country | 200 | NULL | local check short-circuits before the mmdb |
| payload `"ip":"2001:db8::9"` + header S1 + `cf-ipcountry: DE` | 200 | **NULL** | other session than S1: `payload.ip` overrides the header **and** disables provider headers |
| payload `"ip":"8.8.8.8"` + `cf-ipcountry: DE` | 200 | **US** | bundled GeoLite lookup on the payload IP |
| **no** `x-scf-surrogate-ip` at all, two requests DE/FR, same UA | 200 | — | **same session** for both (IP = undefined → everyone with that UA collapses) |

No IP anywhere — a `DO` block scanned every `text`/`varchar`/`json`/`jsonb` column of every table in `public`
for `2001:db8|10\.1\.2\.3|10\.9\.9\.9|127\.0\.0\.1|fd00:|fd12:|100\.64\.|8\.8\.8\.8|::1`:

```
NOTICE:  text/json columns scanned, total hits: 0
  pg_dump (schema+data) lines matching an IP pattern: 0
  container log lines matching an IP pattern: 0
```

(Paths are `/local/1…7`, so our own probe strings do not pollute the scan.) Region and city stay NULL because we never
send `cf-region-code` / `cf-ipcity`.

### 2. Tag filter (read with the tenant's API key, `Authorization: Bearer umami_…`)

Dataset on website M (day D, 12:00–12:40), see item 4 for its composition. `RANGE=startAt=<D 00:00 ms>&endAt=<D 23:59:59.999 ms>&timezone=UTC`.

| Query on `/api/websites/M/stats` | pageviews | visitors | visits | bounces | totaltime |
|---|---|---|---|---|---|
| unfiltered | 8 | 5 | 5 | 2 | 360 |
| `tag=v` (= `tag=eq.v`, = `tag=neq.s`, = `tag=c.v`) | 6 | 4 | 4 | 2 | 300 |
| `tag=s` | 2 | 2 | 2 | 2 | 0 |
| `tag=v,s` (= `tag=eq.v,s`) | 8 | 5 | 5 | 2 | 360 |
| `tag=x` | 0 | 0 | 0 | 0 | 0 |
| twin T unfiltered / `tag=v` | 3 / 2 | 3 / 2 | 3 / 2 | 3 / 2 | 0 / 0 |

Other endpoints, unfiltered vs `tag=v` (list metrics return `{x, y}`; **y = distinct sessions** for referrer/country/device/browser/os/path — `count(distinct session_id)` in `getPageviewMetrics.ts`/`getSessionMetrics.ts` — and **y = events** for `type=event`, `count(*)` in `getEventMetrics.ts`):

```
pageviews?unit=hour   {"pageviews":[{"x":"…T12:00:00Z","y":8}],"sessions":[{"x":"…T12:00:00Z","y":5}]}   vs  y 6 / 4
metrics type=country  [{"x":"DE","y":3},{"x":"FR","y":1},{"x":"US","y":1}]   vs  DE 2, FR 1, US 1
metrics type=device   laptop 4, mobile 1                                      vs  laptop 3, mobile 1
metrics type=browser  chrome 3, firefox 1, ios 1                              vs  chrome 3, ios 1
metrics type=os       Windows 10 3, Linux 1, iOS 1                            vs  Windows 10 3, iOS 1
metrics type=path     / 5, /pricing 2, /docs 1                                vs  / 4, /docs 1, /pricing 1
metrics type=referrer news.ycombinator.com 1                                  vs  same
metrics type=event    modal_opened 1, wallet_selected 1                       vs  same (both tagged v)
metrics/expanded type=country  [{"name":"DE","pageviews":"4","visitors":3,"visits":3,"bounces":2,"totaltime":"60"},…]
                     tag=v     [{"name":"DE","pageviews":"2","visitors":2,"visits":2,"bounces":2,"totaltime":"0"},…]
```

Note the types: `/stats` returns numbers; `/metrics/expanded` returns `pageviews` and sometimes `totaltime` as **strings**.

Range boundary: `startAt=endAt=<12:00:00.000>` returned the two 12:00:00 pageviews — **`endAt` is inclusive** (`created_at between {{startDate}} and {{endDate}}` in `getWebsiteStats.ts`).

Filter syntax (`src/lib/params.ts` `parseFilterValue`): value `"<op>.<value>"` with `op` ∈ `eq, neq, s, ns, c, dnc, re, nre, t, f, gt, lt, …`;
no prefix = `eq`. For `eq`/`neq` the value is split on `,` → SQL `IN` / `NOT IN`. A second filter on the same
column is `tag1=…` (suffix digits); `match=any|all` combines different filters.

### 3. Visit continuity and the cache token

Token payload (decoded, signature HS256 with key `sha512(APP_SECRET)`):
`{"websiteId":"5f0c…2a43","sessionId":"…","visitId":"…","iat":1794497710,"type":"cache"}` — **no `exp`**, and `iat`
is **not** refreshed by later events of the same visit (identical after the second event).

| Case (website L, Chrome/Win) | Result |
|---|---|
| A: no token, 10:55 and 11:05 | two visits (`4bcfa460`, `1ccfeab7`), same session |
| B: token replayed, 10:55 → 11:05 | one visit |
| B: same token chain → 13:30 (2 h 25 gap) | **still the same visit** |
| B: the *first* token replayed again for 23:59 | **still the same visit** (10:55–23:59 = one visit) |
| B': backlog out of order, 11:20 first, then 10:50 with that token | one visit |
| C: C2's token on another surrogate C3, same website | new session (own row created) and new visit — token not mis-applied |
| D: website L's token on website B | ignored (`websiteId` mismatch), new visit |
| E: token with a broken signature | ignored, hour-bucket visit, HTTP 200 |
| F: token across 00:00 UTC (23:55 → 00:05) | new session and new visit (daily salt → session drift) |
| G1: **no** `timestamp`, forged token with `visitId=R`, `iat` 1 min old | visit = R (token honoured) |
| G2: **no** `timestamp`, `iat` 31 min old | new hour-bucket visit; returned token has `iat` = now |
| G3: **with** `timestamp`, `iat` 24 h old | visit = R — no time limit on the timestamped path |
| H: token of a website deleted via `DELETE /api/websites/{id}` | without token: `400 Website not found.`; **with** token: `200`, event stored for the deleted website |

Code (`collection-session.ts` `resolveCollectionSession`), which the experiments confirm line by line:

```ts
const visitSalt = hash(startOfHour(createdAt).toUTCString());
const sessionId = uuid(sourceId, ip, userAgent, sessionSalt, distinctId ?? '');
const sessionDrift = !!cache?.sessionId && cache.sessionId !== sessionId;
let visitId = cache?.visitId || uuid(sessionId, visitSalt);
let iat = cache?.iat || now;
if (sessionDrift || (!historical && now - iat > 1800)) { visitId = uuid(sessionId, visitSalt); iat = now; }
// route.ts: historical = (payload.timestamp !== undefined)
```

### 4. Metrics semantics (website M, day D)

| Visit | Events (tag) | Expected | Observed in unfiltered `/stats` |
|---|---|---|---|
| V1 | pageview `/` 12:00 (v) | bounce, 0 s | counted as bounce |
| V2 | `/` 12:00, `/pricing` 12:02, `/docs` 12:05 (v), referrer HN, iOS | 3 pv, 300 s | totaltime includes 300 |
| V3 | `/` 12:10 (v) + custom `wallet_selected` 12:11 (v) | **not a bounce** (C-75), 0 s | not a bounce; contributes 0 s (custom event not in duration) |
| V4 | `/` 12:20 (s), "unknown" UA template | bounce | bounce |
| V5 | `/` 12:30 (v), `/pricing` 12:31 (s) | 2 pv, 60 s | totaltime includes 60 |
| V6 | custom `modal_opened` 12:40 only (v) | — | **not a visit and not a visitor** |

Unfiltered `/stats` = `pageviews 8, visitors 5, visits 5, bounces 2 (V1, V4), totaltime 360 (300 + 60)`; the SQL
(`getWebsiteStats.ts`) groups by `(session_id, visit_id)`, counts types ≠ 2,5 as pageviews, drops groups with 0 pageviews,
bounce = `c = 1 and no custom event`, totaltime = Σ(max − min `created_at` of **pageviews** per visit). With `tag=v`, V5
shrinks to one pageview and becomes a bounce while V4 disappears (bounces stays 2 by coincidence, totaltime drops to 300)
— the distortion C-73 forbids is real.

C-82 fallback SQL over `website_event` reproduces the API exactly (tag predicate: `s 2/2, v 6/4, all 8/5` pageviews/visitors;
30-min-gap sessionisation over M: `visitors 5, visits 5, bounces 2, totaltime 360`). On the item-3 visitors it differs from
Umami as expected: A (no token) Umami 2 visits vs gap-30 1 visit; B (token, gaps of 2 h+) Umami 1 visit vs gap-30 3 visits.

### 5. Bot drop

```
UA "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"  -> HTTP 200 {"beep":"boop"}
UA "curl/8.5.0"                                                                 -> HTTP 200 {"beep":"boop"}
UA "… HeadlessChrome/131.0.0.0 …"                                               -> HTTP 200 {"beep":"boop"}
browser UA + payload "userAgent":"Googlebot/2.1"                                -> HTTP 200 {"beep":"boop"}
website_event rows before=23 after=23
UA "Mozilla/5.0" and "Mozilla/5.0 (Unknown)"                                    -> HTTP 200 {"beep":"boop"}
```

The body is exactly `{"beep":"boop"}` (no `cache`); the bot check runs before any write. Synthetic UA templates
(wire-formats §c.3), all accepted and parsed as:

| Template | browser | os | device (screen) |
|---|---|---|---|
| Chrome 131 / Windows | `chrome` | `Windows 10` | `laptop` (1536x864) |
| Safari 18 / iPhone | **`ios`** | `iOS` | `mobile` (390x844) |
| "unknown" `Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/0.0` | **`firefox`** | **`Linux`** | `laptop` |
| Safari 18 / macOS | `safari` | `Mac OS` | `laptop` |
| Firefox 132 / Windows | `firefox` | `Windows 10` | `laptop` |
| Chrome 131 / Android (`Linux; Android 10; K`) | `chrome` | `Android OS` | `mobile` |
| Edge 131 / Windows | `edge-chromium` | `Windows 10` | `laptop` |

### 6. Provisioning and isolation (all against `http://127.0.0.1:18100`)

| Step | Request | Response (status, fields) |
|---|---|---|
| Admin login (seeded) | `POST /api/auth/login {"username":"admin","password":"umami"}` | 200 `{token, user:{id:"41e2b680-648e-4b09-bcd7-3e2b10c06264", role:"admin", passwordChangeRequired:true}}` — the default password works over the API; "change required" is a UI modal only |
| Change admin password | `POST /api/me/password {"currentPassword":"umami","newPassword":"<≥8 chars>"}` (Bearer admin) | 200 `{id, username, role, createdAt, token}`; the **old token → 401**, old password → 401 `incorrect-username-password`, new login → `passwordChangeRequired:false` |
| P2 user | `POST /api/users {"username":"scf-t-aaaa","password":"<random>","role":"view-only"}` | 200 `{id, username, role}` |
| P3 team | `POST /api/teams {"name":"scf-t-aaaa"}` | 200 **array** `[ {id, name, accessCode:"team_…", …}, {teamId, userId:<admin>, role:"team-owner"} ]` — the admin becomes team owner |
| P4 member | `POST /api/teams/{teamId}/users {"userId":"…","role":"team-view-only"}` | 200 `{id, teamId, userId, role}` |
| P7 / P7t | `POST /api/websites {"id":"5f0c…2a41","name":"site-m","domain":"app.example.org","teamId":"…"}` | 200 `{id, name, domain, teamId, userId:null, …}`; reusing an id → 400 `ID already in use.` |
| P8 | `POST /api/websites/{id} {"name","domain"}` | 200 website |
| P12 | `GET /api/admin/websites?page=1&pageSize=10` | 200 `{data:[{id,…,team:{…accessCode…}}], count:4, page, pageSize}` |
| P5 tenant login | `POST /api/auth/login {"username":"scf-t-aaaa","password":"…"}` | 200 `{token, user:{role:"view-only", teams:[…]}}` |
| P6 API key | `POST /api/me/api-keys {"name":"scf-control-plane"}` (Bearer tenant session) | 200 `{id, name, keyPrefix:"umami_xxxxxxxx", createdAt, key:"umami_<32 chars>"}` (key shown once) |
| Read | `GET /api/websites/{M}/stats?startAt=…&endAt=…&timezone=UTC` with `Authorization: Bearer umami_…` | 200 |
| P10 | `DELETE /api/me/api-keys/{keyId}` (Bearer tenant session) | 200 `{"ok":true}`; the deleted key → 401 |
| Admin view of other users' keys | `GET /api/users/{id}/api-keys` | 404 (no such route; C-85 holds) |

Isolation with the tenant's API key (view-only user, team-view-only in team A):
`GET /api/websites/{B}/stats` → 401 · `GET /api/websites/{B}` → 401 · `GET /api/teams/{teamB}/websites` → 401 ·
`POST /api/websites` (with or without `teamId`, with key or with the session) → 401 · `POST /api/websites/{M}` → 401 ·
`DELETE /api/websites/{M}` → 401 · `POST /api/me/api-keys` with the key → 401 (blocked path) · `GET /api/admin/websites` → 401.

Counter-check with **global role `user`** + `team-view-only` (as written in wire-formats §j.2 P2):
`POST /api/websites {"name":"personal",…}` → **200** (a personal website is created) and `POST /api/teams` → **200**.

### 7. Timestamp bounds

| payload `timestamp` | HTTP | `created_at` |
|---|---|---|
| `0` | 200 | 1970-01-01 00:00:00 |
| `-1` | 400 `Too small: expected number to be >=0` | — |
| `1.5` | 400 `expected int` | — |
| `"1794460800"` (string) | 200 (coerced) | 2026-11-12 05:20:00 |
| now + 365 days | 200 | 2027-11-12 … |
| `2147483647` | 200 | 2038-01-19 03:14:07 |
| `2147483648` | 400 `Too big` | — |

No past or future plausibility check exists; `createdAt = timestamp * 1000`, and the day salt and the hour bucket are
derived from it.

## Answer to the question

1. **PASS.** `x-scf-surrogate-ip` (via `CLIENT_IP_HEADER`) + `cf-ipcountry` work; sessions are distinct per surrogate,
   per UA and per UTC day, identical for the same surrogate+UA within a day; no IP reaches any column, dump or log.
   Local surrogates store country NULL (event kept); no country header + missing mmdb = HTTP 500; with the shipped mmdb a
   `2001:db8::` surrogate without header gives NULL. `payload.ip` would replace our surrogate in the hash **and** switch
   the country to a GeoLite lookup of that IP — never send it. A missing surrogate header collapses visitors.
2. **PASS.** `tag=v` filters correctly on `/stats`, `/pageviews`, `/metrics` (all seven types) and `/metrics/expanded`;
   `tag=v,s` (or `tag=eq.v,s`) is "tag in (v,s)"; `tag=neq.s` also works.
3. **PARTIAL.** Replaying the token keeps one visit across the hour boundary. But Umami's real rule in 3.5.0 is:
   *no token* → visit = (session, UTC clock hour of `timestamp`); *valid token for the same website and the same computed
   session* → the token's visit, **for ever** when `timestamp` is present (our case), or for 30 min from the visit's
   **start** (not inactivity) when it is absent. The token carries `websiteId, sessionId, visitId, iat`; it has no expiry;
   it is bound to the website (checked) and to the session (a mismatch starts a new visit); it bypasses the
   website-exists check. So the 30-minute inactivity rule exists only if the engine proxy enforces it.
4. **PASS.** Pageviews = events of type 1; visitors = sessions with ≥ 1 pageview; visits = (session, visit) groups with
   ≥ 1 pageview; bounce = exactly one pageview and no custom event (C-75 confirmed); totaltime = Σ per visit of
   last − first **pageview** (custom events do not extend it; single-pageview visits add 0). Custom-event-only visits
   are invisible in visits/visitors.
5. **PASS.** Bot → `HTTP 200` body exactly `{"beep":"boop"}`, nothing stored.
6. **PASS** with a contract fix: the full P1–P12 sequence works as documented below; the view-only user is isolated
   and cannot create websites — but only if its global role is `view-only` (role `user` can create personal websites and teams).
7. **PASS.** Any integer 0 … 2147483647 (also numeric strings) is accepted, past or future.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)

**Confirmed:** ADR-0006/0007 surrogate in `2001:db8::/32` via header; C-02/C-73 twin website; C-03/C-73 tags `v`/`s`
and the `tag=v` read rule; C-73's ban on filtered visit metrics (V5 shows the distortion); C-75; C-69 bot handling
(`{"beep":"boop"}`); C-85 (password kept, key minted by the user's own session; no admin route for other users' keys);
C-12/C-93: the C-82 **tag** fallback is not needed — no third role reads the `umami` database.

**Must change:**

1. **C-01 / C-74 / wire-formats §c.5 (visit rule).** Replace "a visit lasts until 30 minutes of inactivity" by: with
   `timestamp` present, Umami keeps the token's visit indefinitely; the **engine proxy is the visit-inactivity rule**.
   The proxy stores per (website, surrogate) `{token, last_ts}` and adds `x-umami-cache` only if
   `|payload.timestamp − last_ts| ≤ 1800`; then `last_ts := max(last_ts, payload.timestamp)`. Wall-clock TTL (30 min
   after last use) and the 500 k LRU stay as memory bounds only. Without this, a spool backlog delivered in a burst
   merges events hours apart into one visit (case B: 10:55–23:59 became one visit). Spool delay itself does not change
   visits because `timestamp` = receipt time (hour bucket and day salt come from it).
2. **wire-formats §c.5 step 3:** strip `cache`, **`sessionId` and `visitId`** from the response to the edge (they are
   pseudonymous identifiers). Return `{}` for stored and `{"beep":"boop"}` unchanged, so §c.6 still works.
3. **wire-formats §c.5 / §j.2 P9:** when a website is deleted (P9) or a site is removed, the proxy must drop all its
   cache-token entries — a valid token lets events into a deleted website (case H).
4. **wire-formats §j.2 P2:** `role: "view-only"` instead of `"user"`. P3: the response is an array; read `[0].id`.
   The admin is `team-owner` of every tenant team (fine; note it in ADR-0013). Team `accessCode`s are returned by P3
   and P12 — never log them (`/api/teams/join` is already on the never-called list).
5. **wire-formats §j.3 / C-86:** Umami's `endAt` is **inclusive**; the adapter sends `endAt = ourExclusiveEnd − 1` (ms).
   `/metrics/expanded` numbers may be JSON strings — parse number-or-string. List metrics' `y` = visitors (sessions)
   for referrer/country/device/browser/os/path and events for `type=event`; use `/metrics/expanded` where page views per row are needed. "Unique visitors" = sessions with ≥ 1 pageview (state this in the metric definitions).
6. **wire-formats §c.3:** contract-test the template table against the observed parse results above: the "unknown"
   template is reported as **firefox / Linux** (pick a different marker or document it); iOS Safari appears as browser
   `ios`; bare `Mozilla/5.0` is a bot for `isbot`, so it can never be a fallback template.
7. **ADR-0006 / gateway:** always send `cf-ipcountry` (`XX` when unknown; stored literally) — with an image without
   mmdb, a missing header is an HTTP 500, which the forwarder would retry for 72 h. Country is fixed per session by the
   first event; that is consistent with ADR-0007 (surrogate per day).
8. **Development plan S-01 row:** "keep one visit across clock hours" — holds only with change 1.

## Values the implementation must use (env vars, headers, config keys, flags, limits)

- Umami env: `CLIENT_IP_HEADER=x-scf-surrogate-ip`, `SALT_ROTATION=day`, `TZ=UTC` (day salt and hour bucket use local
  time), `DISABLE_TELEMETRY=1`, `DISABLE_UPDATES=1`, `PRIVATE_MODE=1`, `APP_SECRET` = 32 random bytes hex, stable for the
  life of the deployment (rotating it changes every session id and invalidates every cache token). Do **not** set
  `CLOUD_MODE`, `SKIP_LOCATION_HEADERS`, `TRUSTED_PROXIES`, `DISABLE_BOT_CHECK`, `ENABLE_CLIENT_SALT`.
- `POST /api/send` headers: `content-type: application/json`, `User-Agent: <template>`,
  `x-scf-surrogate-ip: 2001:db8:<6 groups>` (always present), `cf-ipcountry: <ISO-2 | XX>` (always present),
  `x-umami-cache: <token>` (engine proxy only, rule of change 1). Body: `{"type":"event","payload":{website, hostname,
  url, referrer?, screen?, language?, name?, data?, tag:"v"|"s", timestamp:<int unix s>}}`. Never `ip`, `userAgent`, `id`, `salt`.
- Responses: stored = `200 {"cache","sessionId","visitId"}`; bot = `200 {"beep":"boop"}`; unknown website =
  `400 {"error":{"message":"Website not found.",…}}`; schema error = `400`; missing mmdb without country = `500`.
- Visit window in the engine proxy: 1800 s on event timestamps; entries also dropped at 00:00 UTC and on website deletion.
- Reads: `Authorization: Bearer umami_<32>`; params `startAt`, `endAt` (ms, inclusive → pass end − 1), `timezone=UTC`,
  verified = `tag=v`, raw = no tag param (equivalently `tag=v,s`); `unit=hour|day|month`; `limit≤500`.
- Provisioning: admin user id `41e2b680-648e-4b09-bcd7-3e2b10c06264`, username `admin`, seeded password `umami` —
  change it first with `POST /api/me/password {"currentPassword":"umami","newPassword":…}` (min 8 chars), keep the
  returned `token`. Tenant user: `role:"view-only"`; team role `team-view-only`.
- Fallback SQL (only if ever needed): pageviews `count(*) filter (where event_type=1)`, visitors
  `count(distinct session_id) filter (where event_type=1)`, with `tag` predicate; 30-min-gap sessionisation as in `run.sh`.

## Open issues

- Token decision on timestamps vs. out-of-order backlog: change 1 uses `|Δ| ≤ 1800`; a visit interleaved with a long
  backlog could still split once. Acceptable; measure in the e2e soak.
- The C-74 consistent-hash failover still splits a visit once; unchanged.
- ULA/CGNAT "non-local" behaviour is a dependency quirk (`is-localhost-ip@3.0.1`); our surrogates never use those ranges.
  Turn items 1, 3, 5 of `run.sh` into the contract tests of wire-formats §j (they run against the pinned image).
- `PRIVATE_MODE` browser-side behaviour (research §7) was not tested here (no UI session) — belongs to S-02.
- `GeoLite2-City.mmdb` is inside the official image (licensing, research §3.5); with change 7 it is never consulted, so
  S-02's own image can drop it — then the "always send `cf-ipcountry`" rule becomes mandatory.
