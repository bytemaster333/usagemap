// SPDX-License-Identifier: Apache-2.0
// Drives the extension exactly as Scaffold does (docs/site/docs/extensions.md
// @ stellar-scaffold-cli-v0.0.34): `<bin> manifest`, then `<bin> post-deploy`
// with the flat JSON context on stdin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "stellar-scaffold-usagemap");
const CONTRACT = "CAAXJETKPYAATU4HVVQUTE2FFBULNFGZNEOC3MS635U5K3GZLAY2HI4M"; // from the template's scaffold.yml
const HASH = "a".repeat(64);

function hook(name, ctx) {
	return spawnSync(BIN, [name], { input: ctx === undefined ? "" : JSON.stringify(ctx), encoding: "utf8" });
}

// The documented post-deploy stdin, for a project at `root`.
function deployCtx(root, network, extra = {}) {
	return {
		config: { networks: ["testnet", "mainnet"], out: ".usagemap/contracts.json" },
		project_root: root,
		env: "development",
		wasm_out_dir: join(root, "target/stellar", network),
		source_dirs: [join(root, "contracts/hello_world")],
		wasm_paths: { hello_world: join(root, "target/stellar", network, "hello_world.wasm") },
		network: { rpc_url: "https://soroban-testnet.stellar.org", network_passphrase: "Test SDF Network ; September 2015", network_name: network },
		contract_name: "hello_world",
		wasm_path: join(root, "target/stellar", network, "hello_world.wasm"),
		wasm_hash: HASH,
		contract_id: CONTRACT,
		...extra,
	};
}

test("manifest lists only the handled hook", () => {
	const r = hook("manifest");
	assert.equal(r.status, 0);
	assert.deepEqual(JSON.parse(r.stdout), { name: "usagemap", version: "0.0.0-spike", hooks: ["post-deploy"] });
});

test("post-deploy on testnet records the contract; redeploy replaces, not duplicates", () => {
	const root = mkdtempSync(join(tmpdir(), "scaffold-proj-"));
	let r = hook("post-deploy", deployCtx(root, "testnet"));
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /recorded hello_world on testnet/);
	r = hook("post-deploy", deployCtx(root, "testnet"));
	assert.equal(r.status, 0, r.stderr);
	const file = JSON.parse(readFileSync(join(root, ".usagemap/contracts.json"), "utf8"));
	assert.deepEqual(file, {
		schema: "usagemap-contracts/1",
		contracts: [{ network: "testnet", contract: "hello_world", contract_id: CONTRACT, wasm_hash: HASH }],
	});
	// Only the project's own deployment facts are written: no RPC URL, passphrase, paths or accounts.
	const raw = readFileSync(join(root, ".usagemap/contracts.json"), "utf8");
	for (const leak of ["soroban-testnet", "September 2015", root, "wasm_path"]) assert.ok(!raw.includes(leak), leak);
});

test("local deployments are skipped by default", () => {
	const root = mkdtempSync(join(tmpdir(), "scaffold-proj-"));
	const r = hook("post-deploy", deployCtx(root, "local"));
	assert.equal(r.status, 0);
	assert.match(r.stdout, /skipped/);
	assert.ok(!existsSync(join(root, ".usagemap")));
});

test("refuses an output path outside the project and bad contract ids", () => {
	const root = mkdtempSync(join(tmpdir(), "scaffold-proj-"));
	let r = hook("post-deploy", deployCtx(root, "testnet", { config: { out: "../escape.json" } }));
	assert.equal(r.status, 1);
	assert.match(r.stderr, /inside the project/);
	r = hook("post-deploy", deployCtx(root, "testnet", { contract_id: `G${CONTRACT.slice(1)}` }));
	assert.equal(r.status, 0);
	assert.match(r.stdout, /skipped \(no valid contract id\)/);
});

test("unknown hook exits non-zero (Scaffold logs it and continues)", () => {
	assert.equal(hook("post-compile", {}).status, 2);
});
