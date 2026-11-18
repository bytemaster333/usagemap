# Check UsageMap yourself in 13 minutes

For anyone who wants to check UsageMap's claims instead of reading them. Four steps, each with commands you can paste
into a terminal (`curl`, `openssl` and a POSIX shell; nothing to install). Everything here works against a public
deployment; the examples use `usagemap.dev`.

**Steps marked [live] need the public deployment** at `usagemap.dev` (its status is at
<https://status.usagemap.dev>). Steps 1 and 3 (without the counters) work for anyone. Step 2, the counters of step 3
and step 4 need a sign-in to a project (your own, or a demo project the operator gives you access to) or an
SCF-operator key.

| Time | Step | What it proves | Needs |
|---|---|---|---|
| 1 min | [Open the site, verify the tracker hash](#1-the-tracker-is-exactly-the-file-its-hash-says-1-minute) | The script on every measured site is a fixed, public file; nobody can swap it | [live] |
| 5 min | [Sign in, see the dashboards](#2-see-the-dashboards-5-minutes) | Verified and raw usage side by side, with the reasons for the gap | [live], a sign-in to a project |
| 5 min | [Forge traffic and watch it fail](#3-forge-traffic-and-watch-it-fail-5-minutes) | Server-side posts, forged tokens and skipped proofs never count as verified, and the answer never tells the sender | [live] |
| 2 min | [Isolation self-check](#4-isolation-self-check-2-minutes) | One project cannot read another's numbers, and cannot even learn that the other exists | [live] |

Set these once in your shell. The public page of this guide shows the values of the deployment in a box at the top;
the site key is the public key of the usagemap.dev site itself, which measures its own landing page.

```sh
UM_INGEST=https://e1.usagemap.dev            # web ingest host (the tracker also uses e2.usagemap.dev)
UM_ORIGIN=https://usagemap.dev                # a declared domain of the site
UM_SITE=YOUR_22_CHAR_SITE_KEY                 # the site's public key (see the box above on usagemap.dev)
UM_TV=1.1.0                                   # tracker version the site pins
UM_UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
um_id() { head -c 16 /dev/urandom | base64 | tr '+/' '-_' | cut -c1-22; }   # a random event id
```

## 1. The tracker is exactly the file its hash says (1 minute)

[live] Open <https://usagemap.dev>. The page is measured by UsageMap itself: view its source and find the one
`<script>` tag. It loads a versioned file (`/lib/<version>/strict.js`; there is no "latest" URL) with an `integrity`
attribute. A browser refuses to run the file if a single byte differs from that hash.

Recompute the hash yourself and compare it with the `integrity` value in the page source (after `sha384-`):

```sh
curl -s "$UM_INGEST/lib/$UM_TV/strict.js" | openssl dgst -sha384 -binary | openssl base64 -A; echo
```

Every version this deployment has served stays served unchanged, with its size and hashes in one manifest (the manifest lists every version the host has served):

```sh
curl -s "$UM_INGEST/lib/manifest.json"
```

What this shows: whoever controls the ingest host can at worst stop the script from loading; they cannot make a
site run different code. A project upgrades only by changing the version and the hash on purpose. What it does not
show: **which source commit produced the file.** SRI pins the bytes, not their provenance; provenance comes from the
manifest's `build.commit` and `build.container_digest` and the release signature, where the deployment sets them.
Reproducing the hash from source is possible with the repository's reproducible-build check
(`pnpm --filter @usagemap/tracker run verify-reproducible`).

## 2. See the dashboards (5 minutes)

[live] Sign in at <https://app.usagemap.dev> (by Stellar wallet message signing or GitHub; a passkey is an added
second factor, mandatory for SCF operators; there are no passwords). Use your own project, or a read-only membership
of a demo project whose traffic is synthetic and labelled DEMO. An SCF-operator account gives the global view.

1. **A project's web dashboard.** Page views, unique visitors, referrers, session duration, bounce rate, countries,
   devices and browsers — each figure shown as **verified** (passed the bot checks) and **raw** (everything not
   rejected). The gap between the two is the point: it is the traffic the gateway judged suspect.
2. **Installation page** of a site. The counters behind that gap: verified, suspect and rejected events, each with
   its reason code. Every code is explained in the [reason-code reference](../contracts/wire-formats.md).
3. **API dashboard** of a service. Requests, error rate and p50/p95/p99 latency per normalised route
   (`/accounts/{id}`), labelled *self-attested telemetry*: the project's own servers report these numbers.
4. **SCF operator console** (operator account only). Every project side by side with the same definitions, trust
   signals and the reasons behind them; per-project aggregates only, rounded, never event-level data.

What this shows: the numbers anyone reads are defined the same way for every project, and the share of traffic
that did not pass the checks is never hidden.

## 3. Forge traffic and watch it fail (5 minutes)

[live] Each command below sends a page view the way an inflating script would. The gateway answers **every**
well-formed attempt with `202` and an empty body — exactly what a real visitor's browser gets — so a forger cannot
tell from the answer whether anything counted. The outcome is recorded as a verdict with reason codes (closed list:
[reason codes](../contracts/wire-formats.md)) that the site's owner sees on the Installation page and SCF operators see in the
operator metrics API.

**a) A naive server-side post** (no challenge, no proof of work):

```sh
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "$UM_INGEST/v1/e" \
  -H 'Content-Type: text/plain;charset=UTF-8' -H "Origin: $UM_ORIGIN" \
  --data "{\"v\":1,\"s\":\"$UM_SITE\",\"p\":\"strict\",\"tv\":\"$UM_TV\",\"e\":[{\"id\":\"$(um_id)\",\"k\":\"pv\",\"u\":\"/forge-a\"}]}"
```

Answer: `202 0`. Recorded as **rejected** (`challenge_missing`; also `ua_bot`, because curl names itself). Never in
raw or verified figures.

**b) A forged challenge token**, with a browser's User-Agent:

```sh
T=$(head -c 92 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_')
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "$UM_INGEST/v1/e" -A "$UM_UA" \
  -H 'Content-Type: text/plain;charset=UTF-8' -H "Origin: $UM_ORIGIN" \
  --data "{\"v\":1,\"s\":\"$UM_SITE\",\"p\":\"strict\",\"tv\":\"$UM_TV\",\"t\":\"$T\",\"c\":1,\"e\":[{\"id\":\"$(um_id)\",\"k\":\"pv\",\"u\":\"/forge-b\"}]}"
```

Answer: `202 0`. Recorded as **rejected** (`challenge_invalid`: the token's signature is checked with a key that
exists only in the gateways' memory).

**c) A real challenge, but no proof of work.** A script can ask for a genuine challenge; it then has to pay for a
proof of work before its events can count as verified:

```sh
T=$(curl -s "$UM_INGEST/v1/c" -A "$UM_UA" -H 'Content-Type: text/plain;charset=UTF-8' -H "Origin: $UM_ORIGIN" \
  --data "{\"v\":1,\"s\":\"$UM_SITE\",\"p\":\"strict\",\"tv\":\"$UM_TV\"}" | sed -E 's/.*"t":"([^"]+)".*/\1/')
# without a proof:
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "$UM_INGEST/v1/e" -A "$UM_UA" \
  -H 'Content-Type: text/plain;charset=UTF-8' -H "Origin: $UM_ORIGIN" \
  --data "{\"v\":1,\"s\":\"$UM_SITE\",\"p\":\"strict\",\"tv\":\"$UM_TV\",\"t\":\"$T\",\"e\":[{\"id\":\"$(um_id)\",\"k\":\"pv\",\"u\":\"/forge-c\"}]}"
# with a made-up proof:
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' "$UM_INGEST/v1/e" -A "$UM_UA" \
  -H 'Content-Type: text/plain;charset=UTF-8' -H "Origin: $UM_ORIGIN" \
  --data "{\"v\":1,\"s\":\"$UM_SITE\",\"p\":\"strict\",\"tv\":\"$UM_TV\",\"t\":\"$T\",\"c\":1,\"e\":[{\"id\":\"$(um_id)\",\"k\":\"pv\",\"u\":\"/forge-c2\"}]}"
```

Answers: `202 0` both times. The first is **suspect** (`proof_missing`, and `transport_mismatch`: curl's TLS stack is
not Chrome's, whatever the User-Agent says): it appears in **raw**, never in **verified**. The second is **rejected**
(`proof_invalid`).

**d) A real visit.** Open <https://usagemap.dev> in your browser. Your visit is **verified**: the browser fetched a
challenge, solved the proof of work and sent the page path — nothing else (the site uses the `strict` profile).

**e) The answers are identical.** Steps a–c and your real visit all got `202` with an empty body. Only an unknown
site key is different, and it says nothing about any event:

```sh
curl -s -w ' %{http_code}\n' "$UM_INGEST/v1/e" -H 'Content-Type: text/plain;charset=UTF-8' \
  --data "{\"v\":1,\"s\":\"NoSuchSiteKey000000000\",\"p\":\"strict\",\"tv\":\"$UM_TV\",\"e\":[{\"id\":\"$(um_id)\",\"k\":\"pv\",\"u\":\"/\"}]}"
```

Answer: `{"error":"unknown_site"} 404`.

**Seeing the counters.** With an SCF-operator key (`scfa_op_…`, scope `web:read`, issued by the deployment's
operator) and the project's id, the verdict and reason counters arrive about a minute later:

```sh
curl -s -H "Authorization: Bearer $(cat scf-operator-key.txt)" \
  "https://app.usagemap.dev/op/v1/web/verdicts?start=$(date -u +%Y-%m-%d)T00:00:00Z&end=TOMORROW_UTC_DATET00:00:00Z&project_ids=PROJECT_ID"
```

(`end` is exclusive: put tomorrow's UTC date in place of `TOMORROW_UTC_DATE`.) The repository's
`tools/forge/forge.ts` runs the same steps plus a replayed proof of work and a real headless browser visit, and
reads the counters back automatically.

**Honest limit.** A determined forger can drive a real browser, which costs a proof of work per challenge and still
has to pass the rate, multiplicity and transport checks. That is why the figures say "verified (passed our bot
checks)", not "genuine users". The [methodology](../methodology/scf-methodology-1.0.0.md) says what the checks stop,
what they detect and what they cannot do.

## 4. Isolation self-check (2 minutes)

[live] Tenant isolation is enforced in the database (row-level security on every tenant table) and again in the API.
Two checks anyone with a project can do:

1. **In the portal**, open one of your projects and copy its address (`…/t/<project-id>/…`). Replace the project id
   with any other UUID — one you made up, or another demo project you are not a member of. Both answers are the same
   "not found": you cannot read another project's data, and you cannot learn whether it exists.
2. **With a share key.** A project can create a read-only share key (`scfa_pub_…`) for its own public metrics
   document. Use your demo project's share key to ask for another project's document:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat share-key.txt)" \
  https://app.usagemap.dev/public/v1/projects/ANOTHER_PROJECT_SLUG/metrics.json
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(cat share-key.txt)" \
  https://app.usagemap.dev/public/v1/projects/no-such-project-at-all/metrics.json
```

Both answer `404`, the same as for a project that does not exist. Your own slug answers `200`.

The database-level matrix (every tenant table, every role, both directions) is in the repository: run
`make test-db` and the isolation suite under `tests/`.

## Where to go next

- [Capabilities](../capabilities.md): what UsageMap does, where each capability is implemented and which test proves it.
- [Reason codes](../contracts/wire-formats.md): every verdict and reason code.
- [Privacy at a glance](../privacy/strategy.md) and the [data inventory](../privacy/data-inventory.md).
- [Threat model at a glance](../threat-model.md).
- [Self-hosting](self-hosting.md), the [roadmap](../roadmap.md) and the [changelog](../../CHANGELOG.md).
