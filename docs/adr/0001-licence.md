# ADR-0001: Licence

- **Status:** Accepted
- **Date:** 2026-11-12
- **Capability IDs:** licence.osi-only, repo.single-monorepo, repo.monorepo-complete, repo.application-code, handover.independent-operator; design trade-off DV-03

## Context
UsageMap's design goals: all application and infrastructure code is released under an OSI-approved open-source
licence, and the entire solution (including infrastructure-as-code) lives in a single open-source monorepo that
contains everything an independent operator needs to take over stewardship, including transfer of repository
ownership. The licence therefore has to work for three audiences: anyone checking OSI status, tenants embedding our tracker in their own (often closed) front ends, and
an unknown future service operator who must be free to run, change and re-host the system.

What research established:
- **Base engine.** Umami is MIT throughout (`LICENSE`, "Copyright (c) 2022 Umami Software, Inc."; `package.json`
  `"license": "MIT"` at v3.5.0), no CLA; `@umami/api-client` and `@umami/mcp` are also MIT. GoatCounter uses EUPL-1.2 with a shortened "Compatible
  Licences" appendix (commit `8578e18`, 2020), while the appendix text itself says other changes "require the
  production of a new EUPL version" (`LICENSE:312-313`) — arguably not the OSI-approved text, with network copyleft
  via the EUPL "Communication" definition (`LICENSE:86-90`).
- **Traps in the ops tool chain**: Terraform ≥ 1.6.0, Nomad ≥ 1.7.0,
  Vault ≥ 1.15.0 and Consul ≥ 1.17.0 are BSL 1.1 (Licensor IBM); TimescaleDB 2.32.0 keeps continuous aggregates and
  compression under the Timescale License in `tsl/`; open-core `ee/` or `/proprietary` directories exist in SigNoz,
  Dokploy and others; Netdata's UI is NCUL1; WAL-G release binaries include GPL-3.0+ LZO code; Grafana, Loki and Tempo
  moved to AGPL-3.0. AGPL-3.0, GPL and LGPL are OSI-approved, so they are not excluded by that goal; the question is only
  whether their obligations reach our code.
- **AGPL reading** (LIKELY, needs counsel): the §13 source-offer duty is
  triggered when the program is *modified* and offered over a network. Unmodified Grafana with our dashboards as JSON
  configuration does not pull our files under AGPL. Playbooks are input data to `ansible-core` (GPL-3.0), not
  derivative works — a common reading, also flagged for counsel.
- **Tooling licences that look open but are not usable as-is**:
  `gitleaks-action` is under a proprietary EULA (the `gitleaks` binary is MIT); Semgrep registry rules are under a
  non-OSI rules licence.
- **Data is not code.** DB-IP IP-to-Country Lite is CC BY 4.0; sapics `user-country` and iptoasn are PDDL-1.0; MaxMind
  GeoLite2 (EULA of 12 Feb 2026) forbids disclosure without consent and requires destroying old copies within 30 days,
  so it cannot be committed or baked into public images; IP2Location LITE says "You are not permitted to redistribute". OSI approves no data licences (design trade-off DV-03).

## Options considered
1. **MIT for our code.** Pros: matches Umami, shortest text, universally accepted. Cons: no express patent grant; no
   `NOTICE` mechanism for carrying data-set attributions forward to downstream redistributors.
2. **Apache-2.0 for our code.** Pros: OSI-approved; express patent licence and patent-retaliation clause (relevant for
   a security-relevant tracker embedded in hundreds of sites); `NOTICE` file is the standard place for the DB-IP
   attribution that CC BY 4.0 requires; compatible with consuming MIT, BSD, ISC and MPL-2.0 code. Cons: longer; not
   compatible with GPL-2.0-only code, so such code cannot be linked into our binaries.
3. **AGPL-3.0 (or MPL-2.0) for our code.** Pros: network copyleft would oblige any future service operator or fork to publish
   modifications. Cons: tenants bundling the npm tracker into closed front ends would face copyleft questions they
   cannot easily answer (MPL's file-level scope is milder but still a review burden); many Stellar projects are
   commercial; the goal is adoption and a smooth handover, not control. Copyleft also adds little, since the monorepo
   is public anyway.
4. **No licence policy for dependencies, review case by case.** Pros: no tooling work. Cons: the traps above (BSL, TSL,
   `ee/` code, proprietary build actions) are easy to pull in by accident and hard to remove later; nobody can
   verify licence.osi-only from a policy that is not enforced.

## Decision
- **Our code, IaC and documentation are Apache-2.0.** The repository root carries `LICENSE` (Apache-2.0 text) and
  `NOTICE`; every source file we author carries an SPDX header (`SPDX-License-Identifier: Apache-2.0`).
- **Umami (MIT) is consumed unmodified** (ADR-0003). Its MIT licence and copyright notice are reproduced in `NOTICE`
  and travel with the images we build.
- **Dependency allow-list, checked on review of every dependency change** (ADR-0023). The authoritative list is the one in
  `docs/security/supply-chain.md` (register C-40); it consists of MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0,
  MPL-2.0, PostgreSQL, Unlicense, 0BSD, Zlib. GPL, AGPL and LGPL are allowed **only for separately run, unmodified tools**
  (examples: Ansible, Grafana, HAProxy) and are **never linked into our code**.
- **Excluded:** BSL/BUSL, the Timescale License, SSPL, Elastic-2.0 (ELv2), and any "open-core" `ee/`, `tsl/` or
  `/proprietary` code even where the rest of the project is OSI-licensed.
- **Data sets are not code.** DB-IP Lite (CC BY 4.0), sapics `user-country` (PDDL, the country fallback) and
  iptoasn (PDDL) are used with attribution and recorded in `NOTICE` (design trade-off DV-03; sapics added by C-40). The
  cloud-provider, Apple Private Relay, Tor-exit and VPN range lists carry no explicit licence; they are **not baked
  into published images and not committed**: an updater on each edge node fetches them weekly from the publishers'
  URLs, logs their checksums and keeps them in a local volume (C-38). The geo databases (CC BY 4.0, PDDL) are the
  only data sets included in an image.
  Details of which data sets are used and how they are refreshed are in ADR-0006.

## Consequences
Positive:
- licence.osi-only becomes checkable: anyone can read `LICENSE` and the SPDX headers.
- A future service operator inherits no licence obligations beyond attribution; tenants can bundle the tracker into closed
  code without copyleft review.
- The `NOTICE` file gives the CC BY 4.0 attribution a durable home for anyone who redistributes our images.

Negative / costs:
- The allow-list must be implemented for three ecosystems (pnpm, Go modules, container SBOMs) and kept current.
  Packages under licences not on the list (for example MIT-0, CC0-1.0, BlueOak-1.0.0, Python-2.0, which the supply-chain
  research proposed to allow) will fail the gate and need a decision each time.
- Apache-2.0 code cannot absorb GPL-2.0-only code; any such component has to stay a separate process.
- Writing custom Ansible modules that import GPL `module_utils` would make those files GPL-3.0; we avoid custom modules.
- Licence status of third-party build tools and scanners must be checked like code.

What we must now do: add `LICENSE`, `NOTICE` and the SPDX header check; encode the allow-list once and apply it on
review; keep a short `docs/security/licensing.md` explaining the AGPL/GPL separate-process
posture for counsel.

Revisit if: the operator community states a preference for a copyleft licence; a required dependency is available only under a licence
outside the list; counsel disagrees with the separate-process reading for Grafana or Ansible.

## Research basis
Source-level research behind this decision (notes kept outside the repository):
- Umami authorisation API multitenancy: Umami MIT since 2020-08-17 (`ebad54ab`), no CLA.
- Goatcounter deep dive: modified EUPL-1.2, network copyleft, bundled GeoLite2.
- Ops license audit: tool licences, BSL/TSL/`ee/` traps, AGPL note.
- Supply chain security: scanner and tool licences, proposed licence gate.
- GeoIP database licensing: data-set licences, data allow-list idea.

## Open points
1. **Open: the allow-list has no enumerated home yet.** C-40 makes the list in `docs/security/supply-chain.md`
   authoritative, but that document (§5, "Licences") only says "allow-list of OSI licences" and refers
 back to this
   ADR; it also does not say whether build-only (dev) dependencies are in scope of the gate, or whether the
   extra licences (MIT-0, CC0-1.0, BlueOak-1.0.0, Python-2.0) are admitted. Until it does, the list in the Decision
   above applies. Closed by enumerating the list (and the dev-dependency scope) in
   `docs/security/supply-chain.md`.
2. **Open: SPDX exception for third-party text in `docs/`.** Data-set attributions and quoted third-party text (for
   example regulator guidance in the privacy pack) keep their own terms, so the SPDX header check needs an exception
   mechanism for such files. Closed when the header check is specified; the licensing posture of quoted
   material is for counsel.
