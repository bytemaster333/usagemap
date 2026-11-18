// SPDX-License-Identifier: Apache-2.0
// Scaffold Stellar extension (spike): `stellar-scaffold-usagemap` on PATH plus
// `extensions: { usagemap: {...} }` in scaffold.yml. Protocol (docs/site/docs/
// extensions.md @ stellar-scaffold-cli-v0.0.34): `manifest` prints the hooks;
// `<hook>` reads one JSON object on stdin. A non-zero exit is logged by
// Scaffold and never aborts the build.
//
// post-deploy: records the project's own contract (network, name, id, wasm
// hash) in a local file for registration with UsageMap (on-chain verification).
// No network calls in the spike; never reads accounts, identities or keys.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const NAME = "usagemap";
const VERSION = "0.0.0-spike";
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const WASM_HASH = /^[0-9a-f]{64}$/;
const NETWORK = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function readStdin() {
	return readFileSync(0, "utf8");
}

export function manifest() {
	return { name: NAME, version: VERSION, hooks: ["post-deploy"] };
}

/** Pure core of post-deploy: returns the new file contents, or null to skip. */
export function postDeploy(ctx, existing) {
	const cfg = ctx.config ?? {};
	const networks = Array.isArray(cfg.networks) ? cfg.networks : ["testnet", "mainnet"];
	const net = ctx.network?.network_name;
	if (typeof net !== "string" || !NETWORK.test(net)) return { skip: "no valid network name" };
	if (!networks.includes(net)) return { skip: `network ${net} not in extensions.usagemap.networks` };
	if (!CONTRACT_ID.test(ctx.contract_id ?? "")) return { skip: "no valid contract id" };
	const entry = {
		network: net,
		contract: String(ctx.contract_name ?? "").slice(0, 64),
		contract_id: ctx.contract_id,
		wasm_hash: WASM_HASH.test(ctx.wasm_hash ?? "") ? ctx.wasm_hash : undefined,
	};
	const list = Array.isArray(existing?.contracts) ? existing.contracts : [];
	const rest = list.filter((c) => !(c.network === entry.network && c.contract === entry.contract));
	return { file: { schema: "usagemap-contracts/1", contracts: [...rest, entry] }, entry };
}

function outPath(ctx) {
	const root = resolve(ctx.project_root ?? ".");
	const p = resolve(root, ctx.config?.out ?? ".usagemap/contracts.json");
	const rel = relative(root, p);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("extensions.usagemap.out must stay inside the project");
	return p;
}

export function main(argv) {
	const [hook] = argv;
	if (hook === "manifest") {
		process.stdout.write(`${JSON.stringify(manifest())}\n`);
		return 0;
	}
	if (hook !== "post-deploy") {
		process.stderr.write(`usagemap: unsupported hook ${hook}\n`);
		return 2;
	}
	const ctx = JSON.parse(readStdin());
	const p = outPath(ctx);
	let existing;
	try {
		existing = JSON.parse(readFileSync(p, "utf8"));
	} catch {
		existing = undefined;
	}
	const r = postDeploy(ctx, existing);
	if (!r.file) {
		process.stdout.write(`usagemap: skipped (${r.skip})\n`);
		return 0;
	}
	mkdirSync(dirname(p), { recursive: true });
	const tmp = join(dirname(p), `.contracts.${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(r.file, null, 2)}\n`);
	renameSync(tmp, p);
	process.stdout.write(
		`usagemap: recorded ${r.entry.contract} on ${r.entry.network} → ${relative(resolve(ctx.project_root ?? "."), p)}\n` +
			"usagemap: register it on the portal page \"Register your Stellar contracts\" so its on-chain usage can be verified.\n",
	);
	return 0;
}

