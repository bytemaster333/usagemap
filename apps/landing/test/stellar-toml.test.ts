// SPDX-License-Identifier: Apache-2.0
// /.well-known/stellar.toml (SEP-1): the TOML subset parser, the StrKey check and the SEP-1 rules, and the published
// file itself — it parses (here and, when Python 3.11+ is on the machine, with Python's tomllib, to the same value),
// has the SEP-1 fields, is served unchanged and stays under SEP-1's 100 KB.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { STELLAR_TOML_FILE } from "../build.ts";
import { REPO_ROOT } from "../src/config.ts";
import { checkStellarToml, isStrKey, SEP1_MAX_BYTES } from "../src/sep1.ts";
import { parseToml } from "../src/toml.ts";
import { buildFor } from "./helpers.ts";

// The account that sends usagemap.dev's daily testnet seal (public, confirmed on the ledger), and the account of
// the Stellar documentation's examples.
const SEAL = "GA5KH6OZTG6LVLVYWOE4XYTZKEDYSYBATLGLFLERCGWFNP7WS3I3K7JY";
const DOCS_EXAMPLE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const CONTRACT = "CAZKSRY3QBYAYBRUTP6JNSZIZ32CQXJXGFLKLCOFKV6CP2BD5EURHPZ3";

const VALID = `# usagemap.dev
VERSION = "2.7.0"
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
ACCOUNTS = [
  "${SEAL}", # the seal account
  "${DOCS_EXAMPLE}",
]
SIGNING_KEY = '${SEAL}'

[DOCUMENTATION]
ORG_NAME = "UsageMap"
ORG_URL = "https://usagemap.dev"
ORG_DESCRIPTION = "Privacy-first web and API analytics \\u2014 for Stellar ecosystem projects"

[[PRINCIPALS]]
name = "Operator"

[[PRINCIPALS]]
name = "Second"
`;

describe("TOML subset parser", () => {
  it("reads strings, escapes, arrays over lines, tables and arrays of tables", () => {
    const d = parseToml(VALID);
    assert.equal(d.VERSION, "2.7.0");
    assert.deepEqual(d.ACCOUNTS, [SEAL, DOCS_EXAMPLE]);
    assert.equal(d.SIGNING_KEY, SEAL);
    assert.deepEqual(d.DOCUMENTATION, {
      ORG_NAME: "UsageMap",
      ORG_URL: "https://usagemap.dev",
      ORG_DESCRIPTION: "Privacy-first web and API analytics — for Stellar ecosystem projects",
    });
    assert.deepEqual(d.PRINCIPALS, [{ name: "Operator" }, { name: "Second" }]);
    assert.deepEqual(parseToml('a = 1\nb = -2_000\nc = 1.5e3\nd = true\ne = [ ]\n"q k" = "x"'), {
      a: 1,
      b: -2000,
      c: 1500,
      d: true,
      e: [],
      "q k": "x",
    });
  });

  it("refuses what is outside the subset or not TOML, naming the line", () => {
    for (const [src, re] of [
      ['a = "x"\na = "y"', /line 2: duplicate key a/],
      ["[T]\n[T]", /defined twice/],
      ["a = {b = 1}", /inline tables/],
      ['a = """x"""', /multi-line/],
      ["a.b = 1", /dotted keys/],
      ["a = 1979-05-27", /unsupported value/],
      ['a = "x" b', /after a value/],
      ['a = "x', /unterminated string/],
      ['a = "\\q"', /bad escape/],
      ["a = [1, 2", /expected|unterminated|value/],
      ["a = 012", /unsupported value/],
      ["= 1", /expected a key/],
      ["[[T]]\n[T]", /defined twice/],
    ] as const) {
      assert.throws(() => parseToml(src), re, src);
    }
  });
});

describe("StrKey check", () => {
  it("accepts real account and contract keys and refuses corrupted ones", () => {
    assert.ok(isStrKey(SEAL, "G"));
    assert.ok(isStrKey(DOCS_EXAMPLE, "G"));
    assert.ok(isStrKey(CONTRACT, "C"));
    assert.ok(!isStrKey(CONTRACT, "G"));
    assert.ok(!isStrKey(SEAL.replace(/.$/, "A"), "G"), "checksum");
    assert.ok(!isStrKey(`${SEAL.slice(0, 10)}B${SEAL.slice(11)}`, "G"), "one character changed");
    assert.ok(!isStrKey(SEAL.slice(1), "G"));
    assert.ok(!isStrKey(`S${SEAL.slice(1)}`, "G"));
  });
});

describe("SEP-1 rules", () => {
  it("passes a complete file", () => {
    assert.deepEqual(checkStellarToml(VALID, "usagemap.dev").problems, []);
  });

  it("passes the control plane's generated form (ORG_DBA, an extension table SEP-1 clients ignore)", () => {
    const generated = `# stellar.toml (SEP-1) — generated
VERSION = "2.7.0"
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
# The daily-seal account(s) on Stellar testnet: one MEMO_HASH transaction per UTC day.
ACCOUNTS = ["${SEAL}"]

[DOCUMENTATION]
ORG_DBA = "UsageMap"
ORG_URL = "https://usagemap.dev"
ORG_DESCRIPTION = "Privacy-first \\"web\\" analytics"

# Extension (not part of SEP-1; SEP-1 clients ignore it): how to verify a UsageMap number.
[USAGEMAP_VERIFY]
SNAPSHOT_SIGNING_KEYS = ["${DOCS_EXAMPLE}"]
SNAPSHOT_SIGNING_KIDS = []
SEAL_DURABLE = false
`;
    const r = checkStellarToml(generated, "usagemap.dev");
    assert.deepEqual(r.problems, []);
    assert.equal(
      ((r.doc?.DOCUMENTATION ?? {}) as { ORG_DESCRIPTION: string }).ORG_DESCRIPTION,
      'Privacy-first "web" analytics',
    );
    assert.deepEqual(
      ((r.doc?.USAGEMAP_VERIFY ?? {}) as { SNAPSHOT_SIGNING_KIDS: unknown }).SNAPSHOT_SIGNING_KIDS,
      [],
    );
    assert.match(
      checkStellarToml(
        generated.replace('ORG_DBA = "UsageMap"\n', ""),
        "usagemap.dev",
      ).problems.join(),
      /ORG_NAME or ORG_DBA/,
    );
  });

  it("names each problem", () => {
    const bad = VALID.replace('VERSION = "2.7.0"', "VERSION = 2")
      .replace("Test SDF Network", "Some Network")
      .replace(`"${DOCS_EXAMPLE}",`, `"${DOCS_EXAMPLE.replace(/.$/, "A")}",`)
      .replace('ORG_URL = "https://usagemap.dev"', 'ORG_URL = "https://elsewhere.example"')
      .replace("[[PRINCIPALS]]", 'HORIZON_URL = "http://h.example"\n[[PRINCIPALS]]');
    const p = checkStellarToml(bad, "usagemap.dev").problems.join("\n");
    assert.match(p, /VERSION/);
    assert.match(p, /NETWORK_PASSPHRASE/);
    assert.match(p, /ACCOUNTS: .* is not a G… key/);
    assert.match(p, /ORG_URL must be on usagemap\.dev/);
    assert.deepEqual(checkStellarToml("x = ", "usagemap.dev").problems.length, 1);
    assert.match(
      checkStellarToml(`VERSION="2.7.0"\n#${"x".repeat(SEP1_MAX_BYTES)}`, "usagemap.dev")
        .problems[0] ?? "",
      /100 KB/,
    );
    assert.match(
      checkStellarToml(
        'VERSION = "2.7.0"\nNETWORK_PASSPHRASE = "Test SDF Network ; September 2015"',
        "usagemap.dev",
      ).problems.join(),
      /\[DOCUMENTATION\] is missing/,
    );
  });
});

const file = join(REPO_ROOT, STELLAR_TOML_FILE);

describe("the published stellar.toml", () => {
  it("exists in the site's content", () => {
    assert.ok(existsSync(file), `${STELLAR_TOML_FILE} is missing`);
  });

  it("is a valid SEP-1 file, served unchanged at /.well-known/stellar.toml", {
    skip: !existsSync(file),
  }, () => {
    const src = readFileSync(file, "utf8");
    const r = checkStellarToml(src, "usagemap.dev");
    assert.deepEqual(r.problems, []);
    const d = r.doc ?? {};
    assert.ok(
      Array.isArray(d.ACCOUNTS) && d.ACCOUNTS.length > 0,
      "ACCOUNTS lists the project's accounts",
    );
    const served = buildFor().files.find(([path]) => path === ".well-known/stellar.toml");
    assert.equal(served?.[1], src);
  });

  it("parses to the same value with Python's tomllib", {
    skip: !existsSync(file) || spawnSync("python3", ["-c", "import tomllib"]).status !== 0,
  }, () => {
    const py = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(py.status, 0, py.stderr);
    assert.deepEqual(JSON.parse(py.stdout), parseToml(readFileSync(file, "utf8")));
  });
});
