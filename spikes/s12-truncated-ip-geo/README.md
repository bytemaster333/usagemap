# S-12 — Country accuracy with truncated addresses
**Result:** PASS — truncating to IPv4 /24 or IPv6 /48 changes the country for 0.03–0.27 % of sampled addresses.
That is 15–100 times smaller than the 4–12 % on which DB-IP Lite and sapics `user-country` disagree with each other,
so truncation is not the accuracy problem; the choice of database is.

## Question
Country is resolved from the truncated address (ADR-0006: IPv4 /24, IPv6 /48). How often does the country of the
truncated address differ from the country of the full address, for DB-IP Lite Country (primary) and sapics
`user-country` (fallback)? How often do the two databases disagree? Which Go library reads the `.mmdb` files?

## Method (versions, commands, how to re-run: one command if possible)
Re-run: `spikes/s12-truncated-ip-geo/run.sh` (about 70 MB download, under a minute of CPU; `N=…` sets the sample
size, `DBIP_MONTH=YYYY-MM` the DB-IP release). Data files go to `$S12_WORK` (default:
`/tmp/usagemap-spikes/s12`). They are not committed.

**Databases (downloaded 2026-11-12):**

| | DB-IP IP to Country Lite | sapics ip-location-db `user-country` |
|---|---|---|
| URL | `https://download.db-ip.com/free/dbip-country-lite-2026-11.mmdb.gz` (no account) | `https://github.com/sapics/ip-location-db/releases/download/latest/user-country.mmdb` (+ `…/download/checksum/user-country.mmdb.sha256`) |
| Release / build | November 2026; mmdb `build_epoch` 1793501259 = 2026-11-01T02:47:39Z; `Last-Modified: Sun, 01 Nov 2026 07:41:36 GMT` | daily; asset updated 2026-11-12T03:35:11Z; `build_epoch` 1794454371 = 2026-11-12T03:32:51Z |
| Checksums | `.mmdb.gz` sha256 `75fe430010f6d38a8c4331c202bf0df6ce3221a6e6d823b9e5a6d951e4cf9758`; `.mmdb` sha256 `145ce5dfb812d8de28547e6289bb5c5f8b3df2f1dea21d324d5b575e0431311f`; `.mmdb` MD5 `5974b336a7409ec854f67eacd52c2061` and SHA1 `09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0` **match the values published on the download page** | sha256 `8d263ef7c6411a33ab073a411bc8a93f2d08f743b0607ea25eb43b94d3e69bff`, matches the publisher's `.sha256` file and the GitHub asset digest |
| Metadata | `database_type` `DBIP-Country-Lite`, IPv6 tree (v4+v6), 1,410,860 nodes, description "DB-IP.com - IP to Country"; download page: 732,796 records | `database_type` `Country (compat=GeoLite2-Country)`, IPv6 tree, 1,307,371 nodes |
| Licence | **CC BY 4.0.** Text on `db-ip.com/db/download/ip-to-country-lite`: "The free IP to Country Lite database by DB-IP is licensed under a Creative Commons Attribution 4.0 International License. You are free to use this IP to Country Lite database in your application, provided you give attribution to DB-IP.com for the data. In the case of a web application, you must include a link back to DB-IP.com on pages that display or use results from the database. You may do it by pasting the HTML code snippet below into your code: `<a href='https://db-ip.com'>IP Geolocation by DB-IP</a>`". The page also calls Lite "a subset … with reduced coverage and accuracy". | **ODC PDDL 1.0** (repository README table, `user-country` row → `opendatacommons.org/licenses/pddl/1-0/`); built from RIR delegations, BGP data and geofeeds |

**Sample (no personal data).** Every address is generated at random; no log or address of a real person is used.
Source of ranges: iptoasn `https://iptoasn.com/data/ip2asn-combined.tsv.gz` (PDDL, `Last-Modified` 2026-11-01,
sha256 `1634a0e449f3ee11088bba85493447a51007b44dff3ac18328f1f2d9127c0a9e`), keeping only routed ranges (AS ≠ 0):
459,655 IPv4 ranges (3,133,671,387 addresses) and 119,798 IPv6 ranges. Three samples of 1,000,000 addresses each,
PCG seed 20261112:
1. `ipv4_range_weighted`: pick a routed IPv4 range uniformly, then an address uniformly inside it (over-represents
   small ranges, where boundaries are dense — a pessimistic view);
2. `ipv4_address_weighted`: pick an address uniformly from all routed IPv4 space (dominated by large blocks);
3. `ipv6_range_weighted`: as 1, for IPv6.

Truncation zeroes the host bits (`netip.Addr.Prefix(24|48)`). Both the full and the truncated address are looked
up in both databases (`main.go`, Go 1.27.4, `github.com/oschwald/maxminddb-golang/v2` v2.9.0, decoding only
`country.iso_code`). Neither sampling scheme is traffic-weighted; real visitor traffic is concentrated in eyeball
ISP ranges, which are typically large and homogeneous.

## Observations (raw facts, with excerpts of output)
`results/summary.md` (n = 1,000,000 per sample; 95 % sampling error ≤ ±0.01 percentage points on the truncation
rates, ≤ ±0.07 on the disagreement rates):

| sample | database | no country (full) | no country (truncated) | **country changed by truncation** | full known → truncated unknown |
|---|---|---|---|---|---|
| IPv4 range-weighted | DB-IP Lite | 0.00 % | 0.00 % | **0.17 %** (1,694) | 0 |
| IPv4 range-weighted | user-country | 0.09 % | 0.09 % | **0.10 %** (984) | 0 |
| IPv4 address-weighted | DB-IP Lite | 0.00 % | 0.00 % | **0.10 %** (1,042) | 0 |
| IPv4 address-weighted | user-country | 0.02 % | 0.02 % | **0.03 %** (252) | 0 |
| IPv6 range-weighted | DB-IP Lite | 0.00 % (12) | 0.00 % | **0.27 %** (2,709) | 0 |
| IPv6 range-weighted | user-country | 0.10 % | 0.10 % | **0.25 %** (2,546) | 0 |

| sample | **DB-IP vs user-country disagree**, full address (both known) | truncated address (both known) | full, counting "unknown" as a value | truncated, same |
|---|---|---|---|---|
| IPv4 range-weighted | **8.79 %** | 8.64 % | 8.87 % | 8.72 % |
| IPv4 address-weighted | **4.34 %** | 4.27 % | 4.35 % | 4.29 % |
| IPv6 range-weighted | **11.66 %** | 11.37 % | 11.75 % | 11.46 % |

Most frequent DB-IP changes caused by truncation (full → truncated):
IPv4 address-weighted `CA→US 166, US→CA 115, GB→US 46, ES→FR 21, US→JP 21, PL→FR 20, MX→US 17`;
IPv6 `IN→US 173, MX→US 77, GL→US 40, RU→JP 40, RU→US 39, CA→US 36, US→NL 36`. The changes are mostly between
neighbouring countries or towards the US (the country of many multinational carriers and cloud providers).
Truncation never turned a known country into "unknown" in either database.

## Answer to the question
- **Truncation error:** with DB-IP Lite the country of the /24 (IPv4) differs from the full address for 0.10 %
  (address-weighted) to 0.17 % (range-weighted) of addresses; for the /48 (IPv6) 0.27 %. With `user-country`:
  0.03–0.10 % (IPv4) and 0.25 % (IPv6). The plan's fallback "consider /25 if large" is not needed.
- **Database disagreement:** DB-IP Lite and `user-country` give different countries for 4.3 % (IPv4,
  address-weighted), 8.8 % (IPv4, range-weighted) and 11.7 % (IPv6) of addresses, before or after truncation.
  This spike has no ground truth, so it cannot say which one is right.
- **Library:** `github.com/oschwald/maxminddb-golang/v2` **v2.9.0** (tag 2026-10-31, commit `3359e15e`), **ISC
  licence** (read from the module's `LICENSE`), `net/netip` API: `maxminddb.Open(path)` →
  `r.Lookup(netip.Addr).Decode(&struct{Country struct{ISOCode string \`maxminddb:"iso_code"\`} \`maxminddb:"country"\`})`.
  It reads both files unchanged (same GeoIP2-style `country.iso_code` layout). Its only dependency is
  `golang.org/x/sys` v0.49.0. The higher-level `github.com/oschwald/geoip2-golang/v2` (v2.5.0, ISC) is not needed
  for country only.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)
- **ADR-0006 confirmed:** /24 and /48 truncation before lookup costs ≤ 0.3 % country accuracy. Keep it.
- **ADR-0006 "DB-IP Lite primary, `user-country` as fallback" must be made precise:** DB-IP returned a country for
  100 % of IPv4 and 99.999 % of IPv6 samples, so a *per-lookup* fallback would almost never fire. And because the
  two databases disagree on 4–12 % of addresses, mixing them per lookup, or switching between them, would move
  country shares by several percentage points. The fallback should therefore be a **whole-database switch** (if a
  DB-IP release cannot be fetched or its terms change), recorded with the date in the data-sources page, never a
  per-lookup mix.
- The metric definitions (C-38 / the data-sources page) should state: "Country is derived from the address
  truncated to /24 (IPv4) or /48 (IPv6) using DB-IP IP to Country Lite (CC BY 4.0). Truncation changes the country
  for about 0.1–0.3 % of addresses; country databases themselves disagree with each other for about 4–12 % of
  addresses, mostly between neighbouring countries."
- The optional "run both and record the daily disagreement rate" in the research (§4 item 2) is cheap
  (two lookups per event) and gives a live quality metric; it would show the same 4–12 % baseline.

## Values the implementation must use (env vars, headers, config keys, flags, limits)
- Truncation: IPv4 prefix length 24, IPv6 prefix length 48, applied with `netip.Addr.Prefix` before lookup.
- Geo DB source: `https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz`, pinned by sha256 in the
  geo manifest; 2026-11: `.gz` sha256 `75fe430010f6d38a8c4331c202bf0df6ce3221a6e6d823b9e5a6d951e4cf9758`, `.mmdb`
  sha256 `145ce5dfb812d8de28547e6289bb5c5f8b3df2f1dea21d324d5b575e0431311f` (cross-check DB-IP's published SHA1
  `09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0`). Check `database_type == "DBIP-Country-Lite"` at load.
- Fallback source (whole-database switch only): `user-country.mmdb` from the sapics `latest` release, verified
  against its `.sha256` asset; `database_type` `Country (compat=GeoLite2-Country)`.
- Go module: `github.com/oschwald/maxminddb-golang/v2 v2.9.0` (ISC); go.sum
  `h1:YpIl3WoA9oIuNvqNaO/aD1N/7Ci2wOqoKH5GWo53H5Y=`.
- Attribution (CC BY 4.0): `<a href='https://db-ip.com'>IP Geolocation by DB-IP</a>` on every page that shows
  country results, plus NOTICE/README.
- Empty `iso_code` → country "unknown" (DB-IP has essentially none; do not fall back per lookup).

## Open issues
- No ground truth: the spike measures consistency, not correctness. Which database is closer to reality for our
  audience is unknown; sapics' own comparison against GeoLite2 (user-country 97.49 %, dbip-country 94.49 % agreement,
  research §3.3) hints `user-country` may be closer, but GeoLite2 is not ground truth either.
- The samples are range- or address-weighted, not traffic-weighted; the error for real visitors may differ
  (probably lower for IPv4, since eyeball ranges are large).
- `user-country` is published under a moving `latest` tag; a reproducible build must copy and pin a specific daily
  file.
