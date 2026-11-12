# ADR-0006: IP handling and geo source

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** bot.ip-multiplicity, metric.country, privacy.gdpr-no-consent, privacy.minimal-erasure-scope, privacy.strategy-docs, licence.osi-only; design trade-off DV-03

## Context
UsageMap reports geographic distribution at country level, is GDPR-compliant without opt-in, minimises who can
exercise erasure and documents its privacy strategy; dropping the last octet of IP addresses before geolocation is a
recognised acceptable approach. All code is OSI-licensed (data licences are design trade-off DV-03). The
anti-inflation layers (ADR-0008) also need a coarse network class for each request.

What research established:
- **Law.** Dynamic IPs are personal data for a website provider with legal means to identify (CJEU C-582/14 *Breyer*,
  LIKELY, not re-read). EDPB Guidelines 2/2023 v2.0 paras 54–55: IP-based tracking is within ePrivacy Art. 5(3)
  unless the IP is used solely for transmission (fn 28). CNIL's self-assessment criteria (July 2025): "L'IP si elle
  est utilisée, permet la localisation à l'échelle de la ville puis est pseudonymisée en enlevant au moins le dernier
  octet"; the Garante requires masking at least the fourth octet for third parties. Truncating *before* geolocation is stricter than the CNIL text.
- **Umami's geo path.** Its build downloads **GeoLite2-City** (50,055,606 bytes in the 3.5.0 image) from the
  third-party `GitSquared/node-geolite2-redist` `master` branch, unpinned. With a non-local surrogate in
  `CLIENT_IP_HEADER` and a non-empty `cf-ipcountry`, the mmdb is never opened; with no country header and no mmdb,
  `/api/send` returns 500.
- **Geo databases**:

| Database | Licence | Access | Cadence / IPv6 | Agreement with GeoLite2 (IPv4 ranges, 14 Jun 2026, maintainer-measured) | Usable as bundled default |
|---|---|---|---|---|---|
| DB-IP IP-to-Country Lite | CC BY 4.0, attribution | no account (`download.db-ip.com/free/…`) | monthly; 369,798 of 732,796 ranges IPv6 | 94.49 % | yes |
| sapics `user-country` | PDDL-1.0, no attribution | GitHub release + `.sha256` | daily; IPv4+IPv6 | 97.49 % | yes (single maintainer, restructured 2026) |
| MaxMind GeoLite2 (EULA 12 Feb 2026) | CC BY-SA 4.0 + contract: no disclosure without consent, destroy old copies within 30 days, key-gated | account + key | — | reference | **no** |
| IPinfo Lite | CC BY-SA 4.0 | token required (HTTP 401 without) | daily | — | weak (token, share-alike) |
| IP2Location LITE | page says CC BY-SA, data licence says "not permitted to redistribute" | sign-up | fortnightly | — | **no** |
| RIR delegation files (ipverse, CC0) | CC0-1.0 | public | daily | 78.5 % (iptoasn-country, similar provenance) | last resort only |

- **CDN country headers** would put a third-party (often US) processor in front of every visitor IP.
- **Network class data**: iptoasn.com is PDDL 1.0, updated
  hourly; cloud ranges (AWS `ip-ranges.json`, GCP `cloud.json`, Oracle, DigitalOcean, Cloudflare, Fastly, Azure
  service tags) are published without an explicit licence; Apple's Private Relay egress list
  (`mask-api.icloud.com/egress-ip-ranges.csv`, 285,174 rows on 2026-11-12) identifies real users who must never be
  penalised for multiplicity; PeeringDB and `jhassine/server-ip-addresses` must not be vendored.

## Options considered
1. **Let Umami resolve geo from the full IP with its bundled GeoLite2-City.** Pros: no work. Cons: Umami would see
   real IPs; city and region stored; GeoLite2 EULA breached by a public image after 30 days; unpinned download.
2. **CDN-provided country header.** Pros: accurate, free. Cons: a third-party processor sees every IP; conflicts with
   EU-only residency (ADR-0017) and with "no CDN in front of ingest".
3. **Resolve at the gateway from the full IP, then discard.** Pros: best accuracy. Cons: the full address is used for
   a lookup that can be done on a truncated one; weaker privacy story.
4. **Resolve at the gateway from the truncated IP with an openly licensed database, then discard** (chosen). Pros:
   no IP ever reaches Umami or disk; matches and exceeds the CNIL criterion; DB-IP's ranges are almost always ≥ /24, so
   loss of accuracy is expected to be small. Cons: accuracy loss is not measured; DB-IP Lite is less accurate than
   commercial data; one attribution duty.
5. **Time-zone-derived country** (Simple Analytics' method). Pros: no IP use at all. Cons: needs a JS read the
   `strict` profile forbids; coarse and wrong for travellers; does not give the ASN class ADR-0008 needs.

## Decision
- **The full IP exists only in gateway memory for the duration of one request.** Within that request it is used
  twice before it is discarded: the visitor surrogate is computed from the **full** IP (and raw User-Agent) first
  (ADR-0007, register C-34), then the address is truncated for the geo and network-class lookups.
- **Country** is resolved from the truncated address (**IPv4 /24, IPv6 /48**) using **DB-IP Lite Country
  (CC BY 4.0)**, with **sapics `user-country` (PDDL)** as fallback.
- **ASN class** — eyeball / mobile / datacenter / privacy relay — from **iptoasn** plus the published cloud-provider
  and **Apple Private Relay** ranges, with `tor` and `vpn` as additional classes. `tor` and `vpn`, like `datacenter`,
  lower the multiplicity thresholds; only `datacenter` alone yields `suspect` (C-38, ADR-0008).
- The geo database files (CC BY 4.0 and PDDL, redistributable with attribution) are **fetched at image build by
  pinned checksum**, included in the edge image and **refreshed monthly by an automated PR**; edge images are rebuilt
  monthly for them (C-38).
- The cloud-provider, Apple Private Relay, Tor-exit and VPN **range lists** have no clear redistribution licence, so
  they are **not put into published images and not committed** (C-38). A small **range-list updater** on each edge
  node fetches them weekly from the publishers' URLs (allow-listed egress, C-10), logs their checksums and keeps them
  in a local volume that the gateway reads; the gateway starts with empty lists if none are present. Earlier drafts
  built these lists into the edge images; that is replaced.
- **Country exclusion:** a per-site `exclude_countries` list; events geolocated to those countries are dropped at the
  gateway and only counted. This is the only measure offered for jurisdictions where the obstacle is data
  localisation (Russia), and we say so (C-58).
- **No identifier by country:** the per-site `visitor_id` setting (`on`, `off` or `off_in: [countries]`) uses the
  country resolved here to decide whether an event gets a visitor surrogate; events without one go to the site's twin
  Umami website and count as page views, country and device only (C-02, C-73, ADR-0007).
- **Nothing finer than country is stored.** Region and city headers are never sent to Umami (only `cf-ipcountry`,
  ADR-0005).
- **No IP is written to any log, spool, queue or database.**
- DB-IP attribution goes in `NOTICE` together with the sapics `user-country` entry (ADR-0001, C-40) and next to
  every country view in the portal (DB-IP asks web apps to
  link back on pages that display results).

## Consequences
Positive:
- metric.country is met with country only; privacy.minimal-erasure-scope is helped because no stored record contains an address.
- Umami's GeoLite2 download and its EULA duties disappear from our artifacts (`SKIP_BUILD_GEO=1`, ADR-0003).
- The geo database is pinned by checksum, so a refresh is a reviewed, reproducible change. Published images
  redistribute only data sets whose licences allow it; the unlicensed range lists never leave the node that fetched
  them.

Negative / limits:
- Country accuracy is bounded by DB-IP Lite (≈ 94.5 % range-level agreement with GeoLite2, not traffic-weighted) and
  by truncation; both effects are unmeasured. Spike **S-12** measures truncated-vs-full disagreement and the result
  is stated in the metric definitions (C-38).
- A weekly fetch means up to a week of staleness for cloud and relay ranges, which change more often than country
  data; new Private Relay egress addresses may be classed as ordinary eyeball networks until the next fetch. The
  range lists are reproducible only through their logged checksums, not from git, and two edge nodes may briefly hold
  different versions. A node that has never fetched them runs with empty lists: no `datacenter`, relay, `tor` or `vpn`
  class, so fewer `suspect` verdicts and no Private Relay carve-out until the first fetch succeeds.
- The updater is one more component with internet egress on every edge node (C-10).
- Country decides three things now — the stored country, `exclude_countries` and `visitor_id = off_in` — so a
  geolocation error can also drop an event or withhold its identifier wrongly.
- The "mobile" class has no open, licensed data source named in research; it will be heuristic (for example by AS
  name) and must be documented as such.
- "No IP in any log" covers our code and our reverse proxies; operating-system and kernel facilities (connection
  tracking, firewall logs) must be configured not to log either, which is an ops task (ADR-0022).
- Visitors behind one /24 share a country lookup input; that is intended.

Must now do: the range-list updater and its egress allow-list entries; S-12 (truncation accuracy); the S-01 spike confirms that a `2001:db8::/32` surrogate plus `cf-ipcountry` yields the country in
Umami and that the mmdb is never opened; add the checksum manifest and refresh job; add a test that greps spool,
logs and database dumps for fixture IPs (step G of the Umami geo-header spike).

Revisit if: S-12 shows material country errors (consider /25 truncation); DB-IP changes its licence or stops
free downloads; regulators require truncation beyond /24.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- GeoIP database licensing: database licences, accuracy, recommendation.
- Umami IP geo header integration: Umami geo path, spike steps.
- Privacy EU UK law: Art. 5(3), CNIL and Garante IP criteria.
- Bot detection anti inflation: ASN and network-class data sources and licences.
- SLA availability engineering: no CDN in front of ingest.

## Open points
1. **Open: VPN range source.** C-38 names Tor-exit and VPN lists among those the updater fetches, but research names
   no open VPN range source; like "mobile", `vpn` may have to be
   heuristic and documented as such, and the publishers' terms for the Tor-exit list need checking. Closed by naming
   the sources before the updater is built, with their terms reviewed by counsel.

(Redistribution of the range lists is settled by C-38: they are fetched on the node and never put into published
images.)
