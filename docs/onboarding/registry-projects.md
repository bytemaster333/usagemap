# Projects in the Stellar registries: sign up from the list

UsageMap is open to any project built on Stellar, SCF-funded or not. If your project is listed in a public Stellar
project registry (the SCF awards list, Stellarlight or PG Atlas), you do not have to type anything in: pick it from the
list and get a ready-to-copy integration kit with your own keys filled in. Projects that are not listed create their
project themselves ([the steps every project goes through](README.md#the-steps-every-project-goes-through)). Most
projects are measuring within ten minutes.

> **If your service does not offer the picker yet.** The registry picker, the integration kit and the operator's
> coverage list come with the current release. On a deployment that runs an earlier build, **Find your project**
> is missing and `GET https://<portal-host>/public/v1/registry/projects?q=stellar` answers `404`; create your project
> yourself until it is updated ([the steps every project goes through](README.md#the-steps-every-project-goes-through)).

| Minute | Step |
|---|---|
| 0–1 | Sign in, open **Find your project** (portal: Your projects, or `/onboard`), search by name or website |
| 1–2 | Check the pre-filled details, choose what your site is built with, **Create project** |
| 2–4 | Verify your domain: one click for a DNS TXT record, a `/.well-known/` file or a meta tag, then **Check now** |
| 4–7 | Copy the snippet for your framework (or the plain script tag) into your site |
| 7–8 | Run the test command, open a page: the first event shows in the live panel |
| 8–10 | Optional: wallet adapter lines for your dApp, your contracts, an API service |

## 1. Find your project

The list comes from public registries of SCF-awarded projects (Stellarlight and PG Atlas), synchronised every night;
an SCF operator can add entries the registries miss. Search needs at least two characters and shows at most ten
projects at a time. Projects listed by both registries appear once.

Not listed? Create the project yourself under **Your projects**. Once your domain is verified, the nightly registry
match links it to its registry entry by itself if the registry lists that domain.

## 2. Check and create — claim, not grab

The form is pre-filled from the registry: name, a short name for links, your website's domain and the contracts the
registry lists for you. **Nothing pre-filled is trusted.** It only saves typing; trust comes from proofs:

1. **Your domain** — a DNS TXT record, a file under `/.well-known/` or a meta tag (works for every site, including
   WordPress, Webflow and Framer).
2. **Your Stellar account** — listed in `ACCOUNTS` of your domain's `stellar.toml` and a signed message (SEP-53, or
   SEP-10 for hardware wallets and multisig). No fee, no transaction.
3. **The registry match** — automatic once a domain the registry lists for you is verified; otherwise an SCF operator
   confirms it.

GitHub organisation membership is not a proof here: the registries' GitHub links are informational only.

If another project on the platform already proved control of the same website, the picker says **"already claimed —
dispute"**. If the project is yours, you can still enrol: verifying the same domain opens a dispute that an SCF
operator decides. Your data stays separate either way.

## 3. The integration kit

After **Create project** you land on the kit (`/t/<project>/onboard/kit`). Everything on it is personalised and has a
copy button:

- a **progress checklist** (project, website, domain declared and verified, first event, registry match; optional:
  Stellar account, contracts, API service);
- the **domain proof** with one click per method and a **Check now** button (we also check every few minutes);
- the **pinned script tag** with Subresource Integrity, and the **starter for your framework** — Next.js, Nuxt,
  SvelteKit, Astro, React single-page app, plain HTML, WordPress/Webflow/Framer, or something else. Where the
  registry's website shows the platform (for example a `*.vercel.app` or `*.webflow.io` host) the choice is
  pre-selected; otherwise you answer one question. Each starter names its guide in this folder;
- **wallet adapter lines** (Stellar Wallets Kit, Freighter, RPC submissions), recommended when the registry lists
  contracts or a dApp category — see [wallets](wallets.md);
- **test commands**: one `curl` that asks the web edge for a challenge with your site key (`200` = your site is live
  at the edge, `404 unknown_site` = not yet; page views themselves come from the tracker), and one that sends a single
  OpenTelemetry data point for your API service;
- the **contracts** the registry lists and whether you registered them ([footprint](footprint.md));
- **OpenTelemetry variables** for an API whose only backend is this platform; to keep your own APM as well, use the
  API set-up wizard ([dual export](api-dual-export.md));
- the **live first-event panel** ([dev origins and debug mode](dev-origins-and-debug.md)).

Ingest tokens are never shown on the kit. Create one on the tokens page; it is shown once.

## For SCF operators: coverage and invite links

The operator console has **Onboarding coverage**: every SCF-awarded registry project with its status — not enrolled,
enrolled (a project declared its domain), verified (domain proven or registry match confirmed), measuring (verified,
with data in the last 7 days) — and an **invite link** per project. The link opens the sign-up with that project
already selected. Copy it and share it however you like; the platform never contacts a project. Every view of the
coverage list is recorded in the audit log.
