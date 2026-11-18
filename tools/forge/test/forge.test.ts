// SPDX-License-Identifier: Apache-2.0
// Unit tests of the forge tool (no network, no stack): StrKey encoding, the forged token's layout, the proof-of-work
// solver, the answer comparison and the CLI's argument checks. The end-to-end run against a real stack is
// test/stack-e2e.ts. Run: tools/forge/run selftest

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { cmpSemver } from "../forge.ts";
import { observable } from "../src/net.ts";
import {
  forgeToken,
  pageviewBatch,
  parseToken,
  powPrefix,
  siteRef,
  solvePow,
} from "../src/protocol.ts";
import { encode, throwawayKeys, VERSION } from "../src/strkey.ts";

const run = promisify(execFile);
const FORGE = join(import.meta.dirname, "..", "forge.ts");
const SITE = "Q4mZ8bS1pTn0aR7cLx2VwE";

describe("forge tool", () => {
  test("StrKey: the all-zero account id is the well-known GAAA…WHF; throwaway keys have the right shape", () => {
    assert.equal(encode(VERSION.account, new Uint8Array(32)), `G${"A".repeat(52)}WHF`);
    const k = throwawayKeys();
    assert.match(k.account, /^G[A-Z2-7]{55}$/);
    assert.match(k.seed, /^S[A-Z2-7]{55}$/);
  });

  test("forged token: 123 b64u chars, the public site reference, a made-up epoch and a self-consistent cheap proof", async () => {
    const now = Date.now();
    const f = await forgeToken(SITE, now);
    assert.match(f.token, /^[A-Za-z0-9_-]{123}$/);
    const t = parseToken(f.token);
    assert.equal(t.ver, 1);
    assert.ok(t.siteRef.equals(siteRef(SITE)));
    assert.equal(t.issuedMs, now);
    assert.ok(
      t.kep >= 1 && t.kep <= 100_000 && t.kep < Math.floor(now / 3_600_000) - 400_000,
      "never a live epoch",
    );
    assert.equal(t.prof, 0);
    assert.ok((await powPrefix(t.nonce, t.cost, f.c)).equals(t.pfx), "only the MAC is wrong");
    assert.equal(await solvePow(f.token), 0);
  });

  test("a page-view batch matches the protocol shape", () => {
    const b = JSON.parse(pageviewBatch({ site: SITE, tv: "1.1.0", path: "/forge/a/x" }));
    assert.deepEqual(Object.keys(b), ["v", "s", "p", "tv", "sg", "e"]);
    assert.match(b.e[0].id, /^[A-Za-z0-9_-]{22}$/);
  });

  test("answer comparison ignores transport headers only", () => {
    const a = observable({
      status: 202,
      body: "",
      headers: { date: "x", "Content-Length": "0", vary: "Origin" },
    });
    assert.deepEqual(a, { status: 202, body: "", headers: { vary: "Origin" } });
    assert.ok(cmpSemver("1.10.0", "1.9.9") > 0 && cmpSemver("1.0.0", "1.0.0") === 0);
  });

  test("CLI refuses a bad site key or origin with exit 2, before any network call", async () => {
    await assert.rejects(
      run(process.execPath, [FORGE, "--site", "short", "--origin", "https://x.example"]),
      (e: { code: number; stderr: string }) => e.code === 2 && /22-character/.test(e.stderr),
    );
    await assert.rejects(
      run(process.execPath, [FORGE, "--site", SITE, "--origin", "http://x.example/path"]),
      (e: { code: number }) => e.code === 2,
    );
    const h = await run(process.execPath, [FORGE, "--help"]);
    assert.match(h.stdout, /--operator-key-file/);
  });
});
