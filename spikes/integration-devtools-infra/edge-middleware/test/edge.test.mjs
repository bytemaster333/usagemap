// SPDX-License-Identifier: Apache-2.0
// Runs the Workers-style module under Node 24 with a small runtime shim
// (global Request/Response/fetch are Node's; `ctx.waitUntil` and `env` are
// faked), exports to a local OTLP receiver, then feeds what arrived through the
// real UsageMap sanitise step (the stellar-scf spike binary).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import worker from "../example-worker.mjs";
import { compileRoutes, createRecorder, foldPath } from "../usagemap-edge.mjs";

const SDF_EXAMPLE_ACCOUNT = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
const SEED_SHAPED = `S${"A".repeat(55)}`;

let server;
let base;
const received = [];

before(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => {
			body += c;
		});
		req.on("end", () => {
			received.push({ path: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body });
			res.writeHead(200, { "content-type": "application/json" }).end("{}");
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("route templates and folding", () => {
	const [r] = compileRoutes(["/sep24/transactions/:id"]);
	assert.equal(r.route, "/sep24/transactions/{id}");
	assert.ok(r.re.test("/sep24/transactions/abc-123"));
	assert.ok(!r.re.test("/sep24/transactions/abc/extra"));
	assert.equal(compileRoutes(["/files/*"])[0].route, "/files/*");
	assert.equal(foldPath(`/accounts/${SDF_EXAMPLE_ACCOUNT}/payments`), "/accounts/{account}/payments");
	assert.equal(foldPath(`/keys/${SEED_SHAPED}`), "/keys/{redacted}");
	assert.equal(foldPath("/tx/3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889"), "/tx/{hash}");
	assert.equal(foldPath("/orders/12345"), "/orders/{id}");
	assert.equal(foldPath("/a/b/c/d/e/f/g/h"), "/a/b/c/d/e/f/*");
	assert.equal(foldPath("/u/john.doe%40example.com"), "/u/{value}");
});

test("worker shim: wraps the handler, exports OTLP JSON after the window via waitUntil", async () => {
	let clock = 1_794_499_200_000; // 2026-11-12T16:00:00Z
	const env = { USAGEMAP_ENDPOINT: base, USAGEMAP_TOKEN: "scfa_ing_test", FLUSH_MS: 10_000, CLOCK: () => clock };
	const pending = [];
	const ctx = { waitUntil: (p) => pending.push(p) };
	const hdrs = { "user-agent": "Mozilla/5.0 canary-ua", "cf-connecting-ip": "203.0.113.9", cookie: "s=canary" };
	const call = async (method, path, advanceMs) => {
		const req = new Request(`https://anchor.example${path}`, { method, headers: hdrs });
		const p = worker.fetch(req, env, ctx);
		clock += advanceMs; // the shim's clock moves "during I/O"
		try {
			return await p;
		} catch {
			return null;
		}
	};
	assert.equal((await call("GET", "/.well-known/stellar.toml", 3)).status, 200);
	await call("POST", "/auth?client_domain=wallet.example", 40);
	await call("GET", "/sep24/transactions/7f8a2c1e?lang=en&token=canary-token", 120);
	await call("GET", "/sep24/transactions/0b1c", 80);
	await call("GET", `/accounts/${SDF_EXAMPLE_ACCOUNT}`, 5);
	assert.equal(await call("GET", "/boom", 2_000), null, "handler error is rethrown");
	assert.equal(pending.length, 0, "no export before the window elapses");
	clock += 10_000;
	await call("GET", "/auth", 10);
	assert.equal(pending.length, 1, "one export scheduled via ctx.waitUntil");
	await Promise.all(pending);

	assert.equal(received.length, 1);
	const [r] = received;
	assert.equal(r.path, "/v1/metrics");
	assert.equal(r.auth, "Bearer scfa_ing_test");
	assert.equal(r.type, "application/json");
	for (const leak of ["canary", "203.0.113.9", "Mozilla", "client_domain", "lang=", SDF_EXAMPLE_ACCOUNT, "7f8a2c1e"]) {
		assert.ok(!r.body.includes(leak), `export leaks ${leak}`);
	}
	const body = JSON.parse(r.body);
	const pts = body.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints;
	const byKey = Object.fromEntries(
		pts.map((p) => [
			p.attributes.map((a) => a.value.stringValue ?? a.value.intValue).join(" "),
			Number(p.count),
		]),
	);
	assert.deepEqual(byKey, {
		"GET /.well-known/stellar.toml 200": 1,
		"POST /auth 200": 1,
		"GET /auth 200": 1,
		"GET /sep24/transactions/{id} 200": 2,
		"GET /accounts/{account} 404": 1,
		"GET /boom 500": 1,
	});
	writeFileSync(join(outDir, "edge-export.json"), r.body);
});

test("exporter failure never breaks the app", async () => {
	const rec = createRecorder({
		endpoint: "http://127.0.0.1:1",
		token: "t",
		serviceName: "s",
		fetch: () => Promise.reject(new Error("down")),
		flushIntervalMs: 0,
	});
	rec.record("GET", "/", 200, 0.01);
	await rec.flush();
	assert.equal(rec.stats.failed, 1);
});

const outDir = mkdtempSync(join(tmpdir(), "usagemap-edge-"));

// Cross-check with the real sanitise step: the export must pass with nothing
// dropped. Needs the spike binary: STELLAR_SCF_BIN=/path/to/stellar-scf.
test("export passes the real scfsanitize step (stellar scf check)", { skip: !process.env.STELLAR_SCF_BIN }, () => {
	const out = execFileSync(
		process.env.STELLAR_SCF_BIN,
		["check", "-f", join(outDir, "edge-export.json"), "--services", "anchor-edge", "--json", "--fail-on-drop"],
		{ encoding: "utf8" },
	);
	const rep = JSON.parse(out);
	assert.equal(rep.input_items, 6);
	assert.equal(rep.kept_items, 6);
	assert.deepEqual(rep.dropped, []);
	const routes = rep.kept.map((k) => k.route).sort();
	assert.deepEqual(routes, [
		"/.well-known/stellar.toml",
		"/accounts/{account}",
		"/auth",
		"/auth",
		"/boom",
		"/sep24/transactions/{id}",
	]);
	console.log(out);
});
