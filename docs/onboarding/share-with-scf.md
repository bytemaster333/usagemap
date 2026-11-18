# Paste this URL into SCF

SCF's own processes already have places for "where can we see your usage". Today many projects put a slide deck or a
document there. Put a link to measured numbers instead: no one at SCF has to install anything to read it.

Replace `your-project` with your project's slug (portal: **Settings**) and `https://portal.example.invalid` with the
portal's address.

**The one link to paste: your Evidence Link.** In *Traction snapshots*, pick the purpose (Build tranche, Growth Hack
campaign — whole weeks, Monday to Monday — Public Goods quarter, or custom), confirm the publication notice and create.
Copy the **evidence link** (`https://portal.example.invalid/evidence/<snapshot id>`) into the SCF form's analytics field
or your tranche report, and the pasteable text below it into the description. The page is public and read-only: the
funnel from web visitors to wallet connects and signatures with on-chain calls beside it, API usage, confidence and its
reasons, the Growth Hack or Public Goods figures, your position in your SCF round and category (only when at least five
projects can be compared), and a Verify link that checks the signature in the reader's browser. It is a measurement by
UsageMap, not an endorsement by SCF or SDF.

## The URLs

| Where | What to paste | Needs |
|---|---|---|
| SCF project record: the **analytics** field | `https://portal.example.invalid/p/your-project` | public stats on |
| Public Goods: `metrics_endpoint` in your project page | `https://portal.example.invalid/public/v1/projects/your-project/metrics.json` | public stats on |
| An application, tranche report or SCF form (the Evidence Link) | `https://portal.example.invalid/evidence/<snapshot id>` and the pasteable text below it | a traction snapshot (purpose chosen when created) |
| An application or tranche report (Build, Growth Hack, Public Goods renewal) | the snapshot's pasteable text, which ends with its verify link `https://portal.example.invalid/verify?snapshot=<snapshot id>` | a traction snapshot |
| Anyone who wants every snapshot you ever issued | `https://portal.example.invalid/public/v1/projects/your-project/snapshots` | nothing (always public once you issue a snapshot) |

Turn on public stats in the portal: **Sharing** → **Public stats**. Without it the project page and `metrics.json`
answer `404` to anyone without a key (they never reveal whether a project exists).

### The SCF `analytics` field

Your project page shows the last 30 complete UTC days of verified and raw page views and visitors, API requests with
their label ("self-attested telemetry") and assurance level, and links to the metric definitions. The SCF project
record copies this field into the public grants data that other ecosystem tools read, so the link travels with your
project.

### `metrics_endpoint` for Public Goods

`metrics.json` is a JSON document (`"schema": "scf-analytics/metrics-endpoint/1"`): the trailing 30 complete UTC days,
web figures verified and raw with a daily series, API figures with their assurance level and a daily series, and a link
to the definitions. It is rebuilt hourly and served with an `ETag`. The Public Goods instructions describe
`metrics_endpoint` for work that does not land in a git repository; projects whose usage already shows through their
packages and repositories may not need it. It does no harm either way.

### A snapshot for an application or an SCF Build tranche

Portal: **Traction snapshots** → **Create**. Choose the preset that matches what you are reporting:

| Preset | Use it for |
|---|---|
| SCF Build tranche | the dates of the SCF Build tranche you report on |
| before Growth Hack campaign / during Growth Hack campaign | the campaign baseline and the campaign itself |
| Public Goods renewal quarter | exactly one calendar quarter |
| custom period | anything else (labelled as custom) |

A snapshot is signed by the platform and, if you opted in, sealed on Stellar testnet the next day. It contains a
plain-text block. Paste that text into the form; readers can read it without leaving the application, and its last
line carries the verify link and the link to the list of all your snapshots. The text says, as it must:
*"Verified" means passed our bot checks, not endorsed by SCF or SDF.*

**Every snapshot you issue is listed publicly**, in order, with no gaps. Issuing ten windows and showing the best one
is visible to every reader. Issue the window your report needs.

## What not to write

Describe a measurement, never an endorsement. Write "measured by <platform>", "verified page views (passed the
platform's bot checks)", "self-attested API telemetry". Never write or imply that SCF or SDF verified, approved or
endorsed your numbers or your project. The [methodology](../methodology/scf-methodology-1.0.0.md#wording) explains
what each label means.
