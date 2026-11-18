// SPDX-License-Identifier: Apache-2.0
// @ts-check
// The action as GitHub runs it (node src/main.mjs with INPUT_* variables, GITHUB_OUTPUT and GITHUB_STEP_SUMMARY
// files), against copies of the fixture repositories. The proposed patch is applied with `git apply` and the check
// re-run: it must then pass.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const main = join(here, "..", "src", "main.mjs");
const releasesFile = join(here, "..", "testdata", "releases.json");

const scratch = mkdtempSync(join(tmpdir(), "pin-action-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** @param {string} name */
function copyRepo(name) {
  const dir = mkdtempSync(join(scratch, `${name}-`));
  cpSync(join(here, "..", "testdata", "repos", name), dir, { recursive: true });
  return dir;
}

/**
 * @param {string} cwd
 * @param {Record<string, string>} inputs
 */
function runAction(cwd, inputs) {
  const out = join(cwd, "..", `${cwd.split("/").pop()}.out`);
  const summary = join(cwd, "..", `${cwd.split("/").pop()}.summary`);
  writeFileSync(out, "");
  writeFileSync(summary, "");
  /** @type {Record<string, string>} */
  const env = { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  const r = spawnSync(process.execPath, [main], { cwd, env, encoding: "utf8" });
  /** @type {Record<string, string>} */
  const outputs = {};
  for (const line of readFileSync(out, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    outputs,
    summary: readFileSync(summary, "utf8"),
  };
}

const offline = { "manifest-file": releasesFile, "manifest-url": "https://unreachable.invalid/x" };

test("a correctly pinned repository passes; excluded and foreign scripts are ignored", () => {
  const dir = copyRepo("good");
  const r = runAction(dir, { ...offline, exclude: "vendored,.git" });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(r.outputs.tags, "2");
  assert.equal(r.outputs.errors, "0");
  assert.equal(r.outputs["patch-file"], "");
  assert.ok(!existsSync(join(dir, "usagemap-tracker-pins.patch")));
  assert.match(r.summary, /\| `src\/Analytics.tsx:3` \| strict \| 1\.1\.0 \| ok \|/);
  // without the exclusion the vendored copy is scanned and fails
  const r2 = runAction(dir, offline);
  assert.equal(r2.code, 1);
  assert.match(r2.stdout, /::error file=vendored\/x\/index.html,line=1/);
});

test("an older release only warns, unless fail-on-outdated; the patch upgrades it", () => {
  const dir = copyRepo("outdated");
  const r = runAction(dir, offline);
  assert.equal(r.code, 0, r.stdout);
  assert.equal(r.outputs.warnings, "1");
  assert.match(
    r.stdout,
    /::warning file=index.html,line=2,col=1,title=UsageMap tracker outdated::1\.0\.0 is older/,
  );
  assert.equal(runAction(dir, { ...offline, "fail-on-outdated": "true" }).code, 1);
  const patch = readFileSync(join(dir, "usagemap-tracker-pins.patch"), "utf8");
  assert.match(patch, /^-<script src="https:\/\/e1.usagemap.dev\/lib\/1\.0\.0\/standard\.js"/m);
  assert.match(
    patch,
    /^\+<script src="https:\/\/e1.usagemap.dev\/lib\/1\.1\.0\/standard\.js" integrity="sha384-AYjF/m,
  );
  execFileSync("git", ["apply", "usagemap-tracker-pins.patch"], { cwd: dir });
  const after = runAction(dir, offline);
  assert.equal(after.code, 0);
  assert.equal(after.outputs.warnings, "0");
});

test("withdrawn, mismatched, unpinned and JSX tags fail; git apply of the patch fixes all of them", () => {
  const dir = copyRepo("broken");
  const r = runAction(dir, offline);
  assert.equal(r.code, 1);
  assert.equal(r.outputs.tags, "5");
  assert.equal(r.outputs.errors, "5");
  for (const re of [
    /::error file=pages\/withdrawn.html,line=2,col=3,title=UsageMap tracker withdrawn::/,
    /::error file=pages\/mismatch.html,line=2,col=3,title=UsageMap tracker integrity_mismatch%2C bad_crossorigin::/,
    /::error file=pages\/unpinned.html,line=1,col=7,title=UsageMap tracker missing_integrity%2C missing_crossorigin::/,
    /::error file=pages\/unpinned.html,line=2,col=1,title=UsageMap tracker unpinned_version/,
    /::error file=Layout.jsx,line=6,col=7,title=UsageMap tracker missing_integrity%2C missing_crossorigin%2C outdated::/,
  ]) {
    assert.match(r.stdout, re);
  }
  const patchPath = r.outputs["patch-file"] ?? "";
  assert.ok(patchPath.endsWith("usagemap-tracker-pins.patch"));
  execFileSync("git", ["apply", "--check", patchPath], { cwd: dir });
  execFileSync("git", ["apply", patchPath], { cwd: dir });
  const jsx = readFileSync(join(dir, "Layout.jsx"), "utf8");
  assert.match(
    jsx,
    /<Script src=\{"https:\/\/e1.usagemap.dev\/lib\/1\.1\.0\/strict\.js"\} integrity="sha384-ttV\+[^"]+" crossOrigin="anonymous" data-site=/,
  );
  assert.ok(
    !readFileSync(join(dir, "pages/unpinned.html"), "utf8").endsWith("\n"),
    "missing final newline kept",
  );
  const after = runAction(dir, offline);
  assert.equal(after.code, 0, after.stdout);
  assert.equal(after.outputs.errors, "0");
  assert.equal(after.outputs.warnings, "0");
});

test("manifest-url: one GET of the release list, no credentials, no redirects, https only", async () => {
  const body = readFileSync(releasesFile, "utf8");
  /** @type {string[]} */
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(
      `${req.method} ${req.url} auth=${req.headers.authorization ?? ""} cookie=${req.headers.cookie ?? ""}`,
    );
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/v1/tracker/versions" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (srv.address());
  try {
    const dir = copyRepo("outdated");
    const ok = await runAsync(dir, `http://127.0.0.1:${port}/v1/tracker/versions`);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /release list: http:\/\/127\.0\.0\.1:\d+\/v1\/tracker\/versions/);
    const redirected = await runAsync(dir, `http://127.0.0.1:${port}/redirect`);
    assert.equal(redirected.code, 2);
    assert.deepEqual(seen, [
      "GET /v1/tracker/versions auth= cookie=",
      "GET /redirect auth= cookie=",
    ]);
    const insecure = await runAsync(dir, "http://example.org/v1/tracker/versions");
    assert.equal(insecure.code, 2);
    assert.match(insecure.stdout, /manifest-url must use https/);
    assert.equal(seen.length, 2, "the refused URL was never requested");
  } finally {
    srv.close();
  }
});

/**
 * Runs the action without blocking the event loop.
 * @param {string} cwd
 * @param {string} url
 */
function runAsync(cwd, url) {
  const out = join(cwd, "..", "async.out");
  writeFileSync(out, "");
  /** @type {Promise<{ code: number | null, stdout: string, stderr: string }>} */
  const p = new Promise((resolve) => {
    const c = spawn(process.execPath, [main], {
      cwd,
      env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, "INPUT_MANIFEST-URL": url },
    });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => {
      stdout += d;
    });
    c.stderr.on("data", (d) => {
      stderr += d;
    });
    c.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  return p;
}
