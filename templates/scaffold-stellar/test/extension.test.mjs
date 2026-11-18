// SPDX-License-Identifier: Apache-2.0
// Drives the extension binary exactly as Scaffold does (Extensions page of the
// Scaffold Stellar docs, stellar-scaffold/cli @ 9edb742): `<bin> manifest`,
// then `<bin> post-deploy` with the flat JSON context on stdin; and a mock
// UsageMap API that records what (if anything) reaches it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isContractId, networkOf } from "../extension/lib.mjs";

const BIN = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "extension",
  "bin",
  "stellar-scaffold-usagemap",
);
// The contract id in the template's scaffold.yml (stellar-scaffold/ui @ 2a5c5f8).
const CONTRACT = "CAAXJETKPYAATU4HVVQUTE2FFBULNFGZNEOC3MS635U5K3GZLAY2HI4M";
const HASH = "a".repeat(64);
const TENANT = "0b7c6f3e-2a51-4c8e-9d4f-6a1e2b3c4d5e";
const KEY = `scfa_reg_AbCdEf123456_SECRETpart${"0".repeat(23)}`;
const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

let api;
let calls = [];
let reply = { status: 201, body: {} };
before(async () => {
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      res
        .writeHead(reply.status, { "content-type": "application/problem+json" })
        .end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
});
after(() => api.close());
const apiUrl = () => `http://127.0.0.1:${api.address().port}`;

function hook(name, ctx, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, name], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(ctx === undefined ? "" : JSON.stringify(ctx));
  });
}

// The documented post-deploy stdin, for a project at `root`.
function deployCtx(root, network, extra = {}) {
  const passphrase = {
    testnet: TESTNET,
    mainnet: MAINNET,
    local: "Standalone Network ; February 2017",
  }[network];
  return {
    config: { networks: ["testnet", "mainnet"], out: ".usagemap/contracts.json" },
    project_root: root,
    env: network,
    wasm_out_dir: join(root, "target/stellar", network),
    source_dirs: [join(root, "contracts/guess-the-number")],
    wasm_paths: {
      guess_the_number: join(root, "target/stellar", network, "guess_the_number.wasm"),
    },
    network: {
      rpc_url: "https://soroban-testnet.stellar.org",
      network_passphrase: passphrase,
      network_name: network,
    },
    contract_name: "guess_the_number",
    wasm_path: join(root, "target/stellar", network, "guess_the_number.wasm"),
    wasm_hash: HASH,
    contract_id: CONTRACT,
    ...extra,
  };
}
const project = () => mkdtempSync(join(tmpdir(), "scaffold-proj-"));
const regEnv = (extra = {}) => ({
  SCF_FOOTPRINT_KEY: KEY,
  USAGEMAP_TENANT_ID: TENANT,
  USAGEMAP_API_URL: apiUrl(),
  ...extra,
});

test("manifest lists only the handled hook", async () => {
  const r = await hook("manifest");
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    name: "usagemap",
    version: "0.1.0",
    hooks: ["post-deploy"],
  });
});

test("post-deploy records the contract; a redeploy replaces it; the file holds only public deployment facts", async () => {
  const root = project();
  let r = await hook("post-deploy", deployCtx(root, "testnet"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /recorded guess_the_number on testnet in \.usagemap\/contracts\.json/);
  r = await hook("post-deploy", deployCtx(root, "mainnet"));
  r = await hook("post-deploy", deployCtx(root, "testnet"));
  assert.equal(r.status, 0, r.stderr);
  const raw = readFileSync(join(root, ".usagemap/contracts.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), {
    schema: "usagemap-contracts/1",
    contracts: [
      { network: "mainnet", contract: "guess_the_number", contract_id: CONTRACT, wasm_hash: HASH },
      { network: "testnet", contract: "guess_the_number", contract_id: CONTRACT, wasm_hash: HASH },
    ],
  });
  for (const leak of ["soroban-testnet", "September 2015", root, "wasm_path", "target/stellar"]) {
    assert.ok(!raw.includes(leak), leak);
  }
});

test("without a key it is a dry run: nothing is sent, the request is shown", async () => {
  calls = [];
  const root = project();
  const ctx = deployCtx(root, "testnet", { config: { register: true } });
  const r = await hook("post-deploy", ctx, {
    USAGEMAP_API_URL: apiUrl(),
    USAGEMAP_TENANT_ID: TENANT,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run \(no SCF_FOOTPRINT_KEY\); nothing was sent/);
  assert.match(r.stdout, new RegExp(`POST ${apiUrl()}/v1/tenants/${TENANT}/footprint/register`));
  assert.match(r.stdout, /"kind":"contract","subject":"CAAXJ/);
  assert.equal(calls.length, 0);
});

test("with a key but without register: true it is still a dry run, and the key is never printed", async () => {
  calls = [];
  const r = await hook("post-deploy", deployCtx(project(), "testnet"), regEnv());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run \(extensions\.usagemap\.register is not true\)/);
  assert.equal(calls.length, 0);
  assert.ok(!(r.stdout + r.stderr).includes("SECRETpart"));
});

test("register: true + key: sends exactly one footprint claim with the contract only", async () => {
  calls = [];
  reply = { status: 201, body: {} };
  const ctx = deployCtx(project(), "testnet", { config: { register: true } });
  const r = await hook("post-deploy", ctx, regEnv());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /registered CAAXJE… as claimed/);
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.method, "POST");
  assert.equal(c.url, `/v1/tenants/${TENANT}/footprint/register`);
  assert.equal(c.headers.authorization, `Bearer ${KEY}`);
  assert.equal(c.headers["content-type"], "application/json");
  assert.equal(c.headers.cookie, undefined);
  assert.deepEqual(JSON.parse(c.body), {
    kind: "contract",
    subject: CONTRACT,
    network: "testnet",
    label: "guess_the_number",
  });
  assert.ok(!(r.stdout + r.stderr).includes("SECRETpart"));
});

test("USAGEMAP_REGISTER=1 also opts in; 409 is success, 401 and 422 are errors Scaffold logs", async () => {
  const ctx = deployCtx(project(), "mainnet");
  reply = { status: 409, body: { title: "Conflict" } };
  let r = await hook("post-deploy", ctx, regEnv({ USAGEMAP_REGISTER: "1" }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /already registered/);
  reply = { status: 401, body: {} };
  r = await hook("post-deploy", ctx, regEnv({ USAGEMAP_REGISTER: "1" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /key was refused \(HTTP 401\)/);
  reply = { status: 422, body: { title: "Only contracts can be declared yet" } };
  r = await hook("post-deploy", ctx, regEnv({ USAGEMAP_REGISTER: "1" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /HTTP 422: Only contracts can be declared yet/);
  assert.ok(
    existsSync(join(ctx.project_root, ".usagemap/contracts.json")),
    "still recorded locally",
  );
});

test("a network failure is reported, the contract stays recorded", async () => {
  const ctx = deployCtx(project(), "testnet", { config: { register: true } });
  const r = await hook("post-deploy", ctx, regEnv({ USAGEMAP_API_URL: "http://127.0.0.1:1" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /registration failed \(network error\)/);
});

test("refuses unsafe settings before sending", async () => {
  calls = [];
  const ctx = deployCtx(project(), "testnet", { config: { register: true } });
  let r = await hook("post-deploy", ctx, regEnv({ USAGEMAP_API_URL: "http://app.usagemap.dev" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must use https/);
  r = await hook("post-deploy", ctx, regEnv({ SCF_FOOTPRINT_KEY: "not-a-key" }));
  assert.match(r.stderr, /does not look like a footprint registration key/);
  // an ingest token or share key is not a registration key (it would be refused anyway)
  r = await hook(
    "post-deploy",
    ctx,
    regEnv({ SCF_FOOTPRINT_KEY: `scfa_ing_AbCdEf123456_${"0".repeat(33)}` }),
  );
  assert.match(r.stderr, /does not look like a footprint registration key/);
  r = await hook("post-deploy", ctx, regEnv({ USAGEMAP_TENANT_ID: "../../x" }));
  assert.match(r.stderr, /must be the project's id/);
  assert.equal(calls.length, 0);
});

test("local and custom networks are skipped; a testnet-derived network counts as testnet", async () => {
  const root = project();
  let r = await hook("post-deploy", deployCtx(root, "local"));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skipped/);
  assert.ok(!existsSync(join(root, ".usagemap")));
  const dev = deployCtx(root, "testnet");
  dev.network.network_name = "testnet-dev";
  dev.env = "testnet-dev";
  r = await hook("post-deploy", dev);
  assert.match(r.stdout, /recorded guess_the_number on testnet/);
  assert.equal(networkOf({ env: "futurenet" }), undefined);
  assert.equal(networkOf({ network: { network_name: "public" } }), "mainnet");
});

test("refuses an output path outside the project; ignores ids that are not valid contract StrKeys", async () => {
  const root = project();
  let r = await hook(
    "post-deploy",
    deployCtx(root, "testnet", { config: { out: "../escape.json" } }),
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /inside the project/);
  r = await hook(
    "post-deploy",
    deployCtx(root, "testnet", { contract_id: `G${CONTRACT.slice(1)}` }),
  );
  assert.match(r.stdout, /skipped \(no valid contract id\)/);
  const badCrc = `${CONTRACT.slice(0, -1)}${CONTRACT.endsWith("M") ? "A" : "M"}`;
  assert.equal(isContractId(badCrc), false);
  assert.equal(isContractId(CONTRACT), true);
  r = await hook("post-deploy", deployCtx(root, "testnet", { contract_id: null }));
  assert.match(r.stdout, /skipped \(no valid contract id\)/);
});

test("unknown hooks and bad stdin exit non-zero (Scaffold logs it and continues)", async () => {
  assert.equal((await hook("post-compile", {})).status, 2);
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, "post-deploy"], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.on("close", (status) => resolve({ status }));
    child.stdin.end("not json");
  });
  assert.equal(r.status, 2);
});

test("USAGEMAP_FOOTPRINT_KEY is accepted as an alias; SCF_FOOTPRINT_KEY wins when both are set", async () => {
  calls = [];
  reply = { status: 201, body: {} };
  const ctx = deployCtx(project(), "testnet", { config: { register: true } });
  const alias = regEnv({ USAGEMAP_FOOTPRINT_KEY: KEY });
  delete alias.SCF_FOOTPRINT_KEY;
  let r = await hook("post-deploy", ctx, alias);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls.at(-1).headers.authorization, `Bearer ${KEY}`);
  const other = `scfa_reg_ZyXwVu987654_${"1".repeat(33)}`;
  r = await hook("post-deploy", ctx, regEnv({ USAGEMAP_FOOTPRINT_KEY: other }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls.at(-1).headers.authorization, `Bearer ${KEY}`);
  assert.ok(!(r.stdout + r.stderr).includes("SECRETpart"));
});

test("explains a key bound to another network (403), another project (404) and rate limiting (429)", async () => {
  const ctx = deployCtx(project(), "mainnet", { config: { register: true } });
  reply = {
    status: 403,
    body: { title: "Forbidden", detail: "this key registers testnet contracts only" },
  };
  let r = await hook("post-deploy", ctx, regEnv());
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /HTTP 403: this key registers testnet contracts only\); is the key bound to another network/,
  );
  reply = { status: 404, body: { title: "Not found" } };
  r = await hook("post-deploy", ctx, regEnv());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not belong to USAGEMAP_TENANT_ID \(HTTP 404\)/);
  reply = { status: 429, body: {} };
  r = await hook("post-deploy", ctx, regEnv());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rate limited \(HTTP 429\)/);
  assert.ok(!(r.stdout + r.stderr).includes("SECRETpart"));
});
