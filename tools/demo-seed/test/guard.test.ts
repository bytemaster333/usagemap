// SPDX-License-Identifier: Apache-2.0
// The demo seed's guards: local stacks only, and an operator key that nobody can derive from the
// public demo phrase.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertLocalStack,
  isLocalStackLabels,
  isLoopbackOrigin,
  operatorSecret,
  SeedGuardError,
} from "../src/guard.ts";
import { DEFAULT_PHRASE } from "../src/plan.ts";
import { operatorKey } from "../src/sql.ts";

const DEV = {
  "com.docker.compose.project": "compose",
  "com.docker.compose.project.config_files":
    "/repo/infra/compose/compose.yaml,/repo/infra/compose/compose.dev.yaml",
};
const DEPLOYED = {
  "com.docker.compose.project": "compose",
  "com.docker.compose.project.config_files": "/opt/scf/compose.yaml,/opt/scf/compose.prod.yaml",
};

describe("local stack guard", () => {
  it("accepts only loopback portal origins", () => {
    for (const o of [
      "http://localhost:5173",
      "http://127.0.0.1:26562",
      "https://portal.localhost",
      "http://[::1]:8080",
    ])
      assert.equal(isLoopbackOrigin(o), true, o);
    for (const o of [
      "https://portal.example.org",
      "http://10.0.0.5:5173",
      "http://localhost.example.org",
      "ftp://localhost",
      "not a url",
    ])
      assert.equal(isLoopbackOrigin(o), false, o);
  });

  it("accepts a container of a stack started with the dev overlay, or labelled local", () => {
    assert.equal(isLocalStackLabels(DEV), true);
    assert.equal(isLocalStackLabels({ "scf.local-stack": "1" }), true);
    assert.equal(isLocalStackLabels(DEPLOYED), false);
    assert.equal(isLocalStackLabels({}), false);
    assert.equal(isLocalStackLabels(null), false);
  });

  it("refuses a deployed stack named `compose` even from a loopback portal (an SSH tunnel)", () => {
    assert.throws(
      () => assertLocalStack({ portal: "http://localhost:5173", labels: DEPLOYED }),
      SeedGuardError,
    );
    assert.throws(
      () => assertLocalStack({ portal: "https://portal.example.org", labels: DEV }),
      SeedGuardError,
    );
    assertLocalStack({ portal: "http://localhost:5173", labels: DEV });
    assertLocalStack({ portal: null, labels: { "scf.local-stack": "1" } });
  });
});

describe("demo operator key", () => {
  it("is never derived from the public phrase", () => {
    const random = operatorSecret(undefined, DEFAULT_PHRASE);
    assert.equal(random.generated, true);
    assert.ok(random.secret.length >= 32);
    assert.notEqual(operatorKey(random.secret).account, operatorKey(DEFAULT_PHRASE).account);
    assert.notEqual(operatorSecret(undefined, DEFAULT_PHRASE).secret, random.secret);
    assert.throws(() => operatorSecret(DEFAULT_PHRASE, DEFAULT_PHRASE), SeedGuardError);
    assert.throws(() => operatorSecret("short", DEFAULT_PHRASE), SeedGuardError);
    assert.deepEqual(operatorSecret("a private operator secret", DEFAULT_PHRASE), {
      secret: "a private operator secret",
      generated: false,
    });
  });

  it("sign.ts --operator refuses to sign without the operator secret", () => {
    const r = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "..", "sign.ts"), "--operator", "--account"],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /operator-secret/);
    const ok = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "..", "sign.ts"),
        "--operator",
        "--operator-secret",
        "a private operator secret",
        "--account",
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.equal(ok.status, 0);
    assert.equal(ok.stdout.trim(), operatorKey("a private operator secret").account);
  });

  it("seed.ts refuses a non-loopback portal before touching anything", () => {
    const r = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "..", "seed.ts"),
        "--reset",
        "--portal",
        "https://portal.example.org",
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /local stacks only/);
  });
});
