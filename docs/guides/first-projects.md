# Onboarding the first projects

The operator's path for bringing the first projects of a new deployment onto UsageMap — for example three web projects
and one API project — about ten minutes each on the project's side, plus the operator's work before and after. The
operator's side runs from the command line `tools/usagemap-op/run` (Node standard library, no install) or from the
operator console in the portal; both use the same APIs.

## Before anything: the first SCF-operator account

Projects can sign up, enrol and measure without an operator: sign-up, the registry picker, the kit, domain proof and
ingest need no operator. What needs the first SCF-operator account:

| Needs the first operator | Why |
|---|---|
| Coverage status (`coverage`, `projects list` with status) | `/v1/operator/onboarding/coverage` is an operator route (audited) |
| Confirming a registry match the nightly job cannot make (`link`) | `PUT /v1/operator/tenants/{id}/registry-links/{registryProjectId}` (step-up) |
| The operator API key for `adoption-report` and the forge | keys are issued by an `operator_admin` (`/operator/api-keys`) |
| The global operator view | `/operator` in the portal |

Creating it is a deployment step, [`deploy-v1.md`](deploy-v1.md) §12: sign in once with your own wallet, a one-statement
database grant of `operator_admin` (the only grant that bypasses the API, by design), then two passkeys. Then issue a
key with `registry:read`, `web:read` and `api:read` (operator console → API keys), shown once; store it as a file
with mode 600.

## The two credentials of the CLI

| Option | Holds | Used for | How to get it |
|---|---|---|---|
| `--key-file FILE` (`USAGEMAP_OPERATOR_KEY_FILE`) | an SCF-operator API key `scfa_op_…` | `/op/v1/*`: registry, projects, metrics, `adoption-report` | operator console → API keys |
| `--session-file FILE` (`USAGEMAP_SESSION_FILE`) | the value of your portal cookie `__Host-scf_session` | `/v1/operator/*`: coverage, `link`, `remove` | sign in at `/signin` (wallet + passkey), browser developer tools → Storage/Application → Cookies → copy the value |

`/v1/operator/*` accepts no API key on purpose: operator actions are tied to a person who signed in with a passkey
(ADR-0014, C-09). An operator session expires after 30 minutes idle and 12 hours at most. `link` and `remove` also
need a passkey step-up in the last 10 minutes; the passkey assertion at sign-in counts as one. **Every passkey
assertion rotates the session cookie**, so copy the cookie right after signing in (or after any later step-up in the
portal) and run the write command within 10 minutes; an older copy answers `401`. Both files are read, kept in memory,
sent only in their own header and never printed; the CLI warns if a file is readable by others. Sign out in the portal when you are done:
that ends the session the file holds.

## Step 1 (operator, 1 minute per project): pick the projects and copy invite links

Find each project in the public SCF registry (synced nightly from Stellarlight and PG Atlas). No credential needed:

```sh
tools/usagemap-op/run invite --search "project name or domain"
```

```text
Soroban Hub                  sorobanhub.com           https://app.usagemap.dev/onboard?project=01a1f23a-107d-…
```

With an operator session, check that nobody has enrolled it yet and get the link from the coverage list itself, with
a short message to paste:

```sh
tools/usagemap-op/run projects list --status not_enrolled --session-file ./operator.session
tools/usagemap-op/run invite <registry-id> --message --session-file ./operator.session
```

**Nothing is sent.** UsageMap never contacts a project; you share the link through whatever channel you already use
with the project (SCF Discord, e-mail). For the API project, pick one whose backend runs Node.js, Go, Rust axum, Python
FastAPI or Next.js route handlers (the guides with tested examples, `docs/onboarding/api-*.md`).

## Step 2 (project, about 10 minutes): `/onboard` → claim → kit → test command → first event

The project follows [`docs/onboarding/scf-projects.md`](../onboarding/scf-projects.md); in short:

| Minute | Step |
|---|---|
| 0–1 | Open the invite link, sign in with a Stellar wallet (SEP-53 message signing, no fee, an unfunded account works). The project is pre-selected. |
| 1–2 | Check the pre-filled form (name, domain, contracts as *claimed*), choose the framework, **Create project**. "Already claimed — dispute" means another tenant proved the same domain; enrolling still works and an operator decides. |
| 2–4 | Verify the domain on the kit page: DNS TXT, a `/.well-known/` file or a meta tag, then **Check now**. |
| 4–7 | Paste the pinned script tag (Subresource Integrity) or the framework starter from the kit into the site. |
| 7–8 | Run the kit's **test command**: `200` with a JSON challenge = the site key is live at the edge. Open a page; the **first-event panel** shows it arrive. |
| 8–10 | Optional: wallet adapter lines (dApps), contracts ([footprint](../onboarding/footprint.md)). |

For the **API project**, in addition: the API set-up wizard (`/t/<project>/setup/api`) registers the service and
creates an ingest token (shown once), then the kit's OTLP test command sends one request-duration data point to
`https://e1.usagemap.dev/v1/metrics` (`200` = accepted, `401` = token wrong, `403` = project pending or suspended).
Real traffic follows once the backend runs with the OpenTelemetry variables from the kit.

## Step 3 (operator): the registry match

A project counts as SCF-awarded in the adoption report only through a **registry link**. The nightly registry job
confirms it by itself when the registry lists the domain the project verified. Otherwise (registry without a website,
a different domain) confirm it yourself, after checking that the tenant is the project (its verified domain, Stellar
account or contracts). The portal has no screen for this decision yet; the CLI calls the audited API
(`PUT /v1/operator/tenants/{id}/registry-links/{registryProjectId}`; step-up: a fresh portal sign-in in the last 10
minutes, see above):

```sh
tools/usagemap-op/run link <tenant-id|slug> <registry-id> --confirm          # dry run: shows the current link state
tools/usagemap-op/run link <tenant-id|slug> <registry-id> --confirm --yes    # decides; --reject to refuse a match
```

`projects show <registry-id>` then shows the linked project and its level.

## Step 4 (operator): verify coverage

```sh
tools/usagemap-op/run coverage --list --session-file ./operator.session
```

```text
SCF-awarded registry projects: …  (measuring = verified with data in the last 7 days)
  not_enrolled   …
  enrolled       …     a tenant declared the domain or has a registry link
  verified       …     domain proven or registry match confirmed
  measuring      …     verified, with page views or API data in the last 7 days
```

A project is onboarded when it reaches `measuring`. With only a key,
`coverage` prints an approximation from registry links and says so.

## Step 5 (operator): the adoption report

```sh
tools/usagemap-op/run adoption-report --key-file ./operator.key \
  --operator-view-url https://app.usagemap.dev/operator --out ./adoption
```

This runs `tools/adoption-report` (same options): per project, the first and last day with verified page views and
with API requests, active days and counts (counts below the floor of 10 printed as "< 10"), and whether the adoption thresholds (three web projects and one API project) are met (exit 0) or not (exit 1). It
never prints the key. The Markdown and JSON it writes are a dated record of adoption, best kept next to a link to the
live operator view.

## Other operator commands

| Command | What it does |
|---|---|
| `projects show <registry-id>` | registry rows, onboarding status, tenant counts, linked projects, invite link |
| `remove <tenant-id\|slug> --reason TEXT [--yes]` | removes a tenant that is not part of the ecosystem (dry run without `--yes`; `operator_admin`, step-up; reversible for 30 days by restoration in the console) |
| `enrol-on-behalf` | there is no API to enrol a project for someone else, by design: trust comes from proofs only the project can make. The command prints the supported path and exits 3 |
| `verify-migration <fp-a> <fp-b>` | compares two handover fingerprints (`tests/handover/fingerprint.sh`): identical = same data and schema; otherwise names each table, sequence, schema part or role that differs (exit 1) |

Tests: `tools/usagemap-op/run selftest` (mock server, no network); `LIVE=1 tools/usagemap-op/run selftest` adds a dry
run against the live host's public endpoints only (registry search, invite link opens the portal, the coverage route
refuses an anonymous caller).

## What this kit does not do

- It does not contact projects or send invitations, and it does not create accounts for them.
- It cannot make a project measured: the project has to prove its domain and install the snippet or OpenTelemetry
  variables itself. Which projects to ask first is the operator's decision.
- The operator session is copied from a browser by hand. A device-flow sign-in for the CLI does not exist.
