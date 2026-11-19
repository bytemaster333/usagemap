# Tracker pin check (GitHub Action)

A pinned UsageMap `<script>` has an exact version, the release's SRI hash in `integrity` and `crossorigin`. A dependency
bot can bump the version in the URL but not the hash next to it, so the browser would refuse the file and nothing would be
counted. This GitHub Action checks every tracker tag in your repository and writes a **patch** that changes the URL and
the hash together. It uses no token and never pushes, commits or opens pull requests. `site/index.html` is a page
pinned to an older release; `workflow/usagemap-pins.yml` is the workflow. Guide: [Plain HTML](../../docs/onboarding/web-html.md)
and the action's [README](../../tools/pin-action/README.md).

## Run it

1. **Install:** copy `workflow/usagemap-pins.yml` to `.github/workflows/` in your repository and replace the three
   `<pinned sha>` placeholders and `<owner>/<repo>` (locally: nothing to install, Node 24 is enough).
2. **Set your hosts:** `hosts:` lists your deployment's ingest hosts (default `e1.usagemap.dev,e2.usagemap.dev`) and
   `path:` the directory to scan; no key or token is needed.
3. **Run:** open a pull request (or run it locally from the repository root:
   `tools/pin-action/run check examples/pin-action/site`) → `1 tag(s), 0 error(s), 1 warning(s)` and
   `usagemap-tracker-pins.patch` moving the tag to the newest release with its hash.

## The lines that add UsageMap

`workflow/usagemap-pins.yml`:

```yaml
      - id: pins
        uses: <owner>/<repo>/tools/pin-action@<pinned sha>
        with:
          path: site
          hosts: e1.usagemap.dev,e2.usagemap.dev
      - if: always() && steps.pins.outputs.patch-file != ''
        uses: actions/upload-artifact@<pinned sha>
        with: { name: usagemap-tracker-pins, path: "${{ steps.pins.outputs.patch-file }}" }
```

`site/index.html`:

```html
    <script defer src="https://e1.usagemap.dev/lib/1.0.0/standard.js" integrity="sha384-grGHJaIn1S7+QsKcbybsmEiu1LXgxcbaz4buMHrOZKdbGyYIStg+BbK8eJuYeX8K" crossorigin="anonymous" data-site="YOUR_22_CHAR_SITE_KEY"></script>
```

Errors (unknown or withdrawn version, missing or wrong hash, missing `crossorigin`, `http`, a query string) fail the
job; a correct pin of an older release only warns unless `fail-on-outdated: "true"`. To get a pull request, add your
own step that `git apply`s the patch.

## What you'll see in the portal

Nothing: the action runs in your CI and sends nothing to UsageMap. Its only network request is one GET of the public
release list (`https://app.usagemap.dev/v1/tracker/versions`). The portal's **Websites** page shows the same pinned
snippet for the newest release.

## Test it without the app

```sh
curl -sS https://app.usagemap.dev/v1/tracker/versions   # the release list the action reads (versions, hashes, withdrawn)
```

## Tested by

`tests/quickstarts/integrations/tools.spec.ts` (`pin-action`): runs `tools/pin-action/src/main.mjs` the way the runner
does (`INPUT_*`, `GITHUB_OUTPUT`) on `site/` against a local stand-in of `/v1/tracker/versions` built from the real
release manifests (`tracker/releases/*/manifest.json`), and checks: one GET without credentials, outputs `tags=1`,
`errors=0`, `warnings=1`, a patch that `git apply`s cleanly and moves the tag to the newest release's URL and hash,
and a clean second run after the patch. It also checks that the workflow's `with:` keys are inputs of
`tools/pin-action/action.yml`. **Not run:** GitHub Actions itself (the action's own self-test covers the runner
contract).
