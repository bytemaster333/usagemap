# UsageMap tracker pin check (GitHub Action)

Tracker scripts must be pinned. A UsageMap `<script>` is pinned to an exact version
(`/lib/<semver>/<profile>.js`), with the release's SRI hash in `integrity` and with `crossorigin="anonymous"`;
without `crossorigin` the browser cannot check the hash.

A dependency bot can bump the version in a URL, but it cannot rewrite the `integrity` attribute next to it. So a bumped tag
keeps the old hash, the browser refuses the file, and nothing is counted.

This action checks every tracker tag in a repository and writes a **patch** that changes the URL and the hash
together. It never pushes, commits or opens pull requests, and it uses no token. Its only network request is one
GET of the public release list.

```yaml
# .github/workflows/usagemap-pins.yml
on: [pull_request, workflow_dispatch]
permissions: { contents: read }
jobs:
  pins:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned sha>
      - id: pins
        uses: <owner>/<repo>/tools/pin-action@<pinned sha>
        # with:
        #   hosts: e1.usagemap.dev,e2.usagemap.dev        # your deployment's ingest hosts
        #   manifest-url: https://app.usagemap.dev/v1/tracker/versions
        #   upgrade: "true"            # proposals move to the newest release
        #   fail-on-outdated: "false"  # an older but correct pin only warns
      - if: always() && steps.pins.outputs.patch-file != ''
        uses: actions/upload-artifact@<pinned sha>
        with: { name: usagemap-tracker-pins, path: "${{ steps.pins.outputs.patch-file }}" }
```

To get a pull request instead of an artifact, add your own step after this one: `git apply` the patch, then use the
PR tool you already trust. This action leaves that step to you.

## What it checks

It scans every text file with a markup or script extension under `path`. Directories named in `exclude`
(default `node_modules,.git`) are skipped, and so are symbolic links.

It looks at every `<script …>` and `<Script …>` tag (JSX and the Next.js component included) whose `src` is on one of
`hosts`.

| Code | Severity | Meaning |
|---|---|---|
| `unpinned_version` | error | The path is not an exact version (for example `/lib/latest/…`). |
| `unknown_version` | error | The version is not in the release list. |
| `withdrawn` | error | The release was withdrawn: its files answer `410`, so the tracker does not run. |
| `unknown_profile` | error | The version has no such profile. |
| `missing_integrity` | error | There is no SRI hash. |
| `integrity_mismatch` | error | The hash is not the release's: the browser refuses the file. |
| `missing_crossorigin` | error | Without `crossorigin` the browser cannot check the hash. A bare `crossorigin` attribute is accepted. |
| `bad_crossorigin` | error | `use-credentials` sends cookies to the ingest host. |
| `insecure_src` | error | The `src` is not `https`. |
| `src_query` | error | The `src` has a query string or fragment. |
| `outdated` | warning | A correct pin of an older release. It is an error only with `fail-on-outdated: "true"`. |
| `templated` | warning | The `src` is built by a template (`${…}`, `{{…}}`, `<%…%>`), so it is reported but never rewritten. |

Errors become annotations on the file and line, and the job summary gets one table row per tag.

The patch is in `git apply` format. It changes only the `src` and `integrity` values and inserts `integrity` and
`crossorigin` where they are missing. Quotes, other attributes, line endings and a missing final newline are kept.

With `upgrade: "true"` (the default), a proposal moves the tag to the newest active release. With `"false"`, a tag
on an active release whose attributes are wrong keeps its version.

| Output | Value |
|---|---|
| `tags` | number of tracker tags found |
| `errors` | number of tags with an error |
| `warnings` | number of tags with a warning |
| `patch-file` | path of the patch; empty when nothing should change |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | ok, or warnings only |
| 1 | at least one error, or an outdated pin with `fail-on-outdated` |
| 2 | the release list could not be read |

## Release list

`manifest-url` accepts the portal's `/v1/tracker/versions`, which carries the `withdrawn` status, or an ingest host's
`/lib/manifest.json`. It must be `https` (`http` only for `localhost`). Redirects and credentials are refused.

`manifest-file` reads the same formats from the checkout, or a single `tracker/releases/<v>/manifest.json`. Then no
request is made at all.

## Run locally and test

```sh
tools/pin-action/run check path/to/site    # live release list; INPUT_* variables as in action.yml
env 'INPUT_MANIFEST-FILE=releases.json' tools/pin-action/run check .   # offline (a hyphenated name needs env)
tools/pin-action/run selftest              # unit tests + the action run against testdata/repos (no network)
node_modules/.bin/tsc -p tools/pin-action/tsconfig.json   # type check (JS with @ts-check)
```

The self-test runs `src/main.mjs` the way the runner does (`INPUT_*`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`)
against three fixture repositories. Each must give the expected annotations and outputs, and its patch must
`git apply` cleanly. After the patch the check must pass: this covers a withdrawn release, a wrong hash, a missing
hash, a `latest` path, single quotes, a missing final newline and a Next.js `<Script>`.

A local HTTP server confirms three things:

- exactly one GET is made;
- no credentials are sent;
- a redirect fails the run, and a non-https URL is never requested.

## Limits

- The action does not see a script injected at run time (`document.createElement("script")`) or a URL assembled in
  code. The npm package is pinned by your lockfile and is not checked here.
- `runs.using: node24` needs an Actions runner with the Node 24 runtime (current hosted runners have it). The code is
  plain ES modules and also runs on Node 20 or later, for example from a composite step:
  `node tools/pin-action/src/main.mjs`.
- A Marketplace listing needs a public repository with `action.yml` at its root. From this monorepo it is used by
  path: `uses: <owner>/<repo>/tools/pin-action@<sha>`.
