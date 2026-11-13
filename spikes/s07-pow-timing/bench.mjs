// SPDX-License-Identifier: Apache-2.0
// S-07 bench: solve-time distributions of the §b.2 solver under DevTools CPU throttling.
// usage: node bench.mjs <chromium|webkit> [n=25] [rates=1,4,6] [mode=worker]
import { chromium, webkit } from "playwright";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { pbkdf2Sync, randomBytes, createHash } from "node:crypto";

const dir = new URL(".", import.meta.url).pathname;
const [browserName = "chromium", nArg = "25", ratesArg = "1,4,6", modesArg = "worker"] = process.argv.slice(2);
const N = +nArg, RATES = ratesArg.split(",").map(Number), MODES = modesArg.split(",");
const PORT = 18807;
// [cost, max, P] — P = deriveBits calls in flight
const SETTINGS = (process.env.SETTINGS || "128x1024x1,256x512x1,256x1024x1,512x512x1,512x1024x1,1024x512x1,1024x1024x1,2048x256x1,512x1024x4,512x2048x4,256x1024x4,1024x1024x4")
  .split(",").map((s) => s.split("x").map(Number));

// ---- challenge issuing, as the gateway would (§b.1/§b.2); MAC is irrelevant for timing and left zero.
function pw(nonce, c) { const b = Buffer.alloc(30); b.write("scf-pow-v1"); nonce.copy(b, 10); b.writeUInt32BE(c, 26); return b; }
function dk(nonce, c, cost) { return pbkdf2Sync(pw(nonce, c), nonce, cost, 32, "sha256"); }
function challenge(cost, max, cstar) {
  const tok = Buffer.alloc(92), nonce = randomBytes(16);
  tok[0] = 1; tok.writeUInt32BE(Math.floor(Date.now() / 3.6e6), 1);
  createHash("sha256").update("site").digest().copy(tok, 5, 0, 16);
  tok.writeUIntBE(Date.now(), 21, 6); nonce.copy(tok, 27);
  tok.writeUInt16BE(cost, 51); tok.writeUInt16BE(max, 53);
  const pfx = dk(nonce, cstar, cost).subarray(0, 4);
  pfx.copy(tok, 55);
  return { t: tok.toString("base64url"), cost, max, pfx: pfx.toString("hex"), cstar, nonce };
}

// ---- static server for the page and the built solver
const server = createServer((req, res) => {
  const p = req.url === "/" ? "page/index.html" : req.url.slice(1);
  if (!/^(page\/index\.html|build\/solver\.min\.js)$/.test(p)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" }).end(readFileSync(dir + p));
}).listen(PORT, "127.0.0.1");

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const r1 = (x) => Math.round(x * 10) / 10;

const bt = browserName === "webkit" ? webkit : chromium;
const browser = await bt.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.evaluate(() => init());
const ua = await page.evaluate(() => navigator.userAgent);
const cdp = browserName === "chromium" ? await page.context().newCDPSession(page) : null;
const out = { browser: browserName, version: browser.version(), ua, host_cpu: process.env.HOST_CPU || "", n_per_cell: N, runs: [], controls: [] };
console.error(`${browserName} ${browser.version()}`);

for (const rate of RATES) {
  if (rate !== 1 && !cdp) continue;
  if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  // controls: does throttling reach the main thread, the worker thread, and WebCrypto?
  const LOOPN = 2e8;
  const cm = await page.evaluate((n) => loopMain(n), LOOPN);
  const cw = await page.evaluate((n) => loopWorker(n), LOOPN);
  const ch = challenge(512, 1024, 1023); // fixed worst case = 1024 attempts
  const cc = await page.evaluate((c) => solveWorker(c.t, c.cost, c.max, c.pfx, 1), ch);
  out.controls.push({ rate, js_loop_main_ms: r1(cm), js_loop_worker_ms: r1(cw), pbkdf2_512x1024_worker_ms: r1(cc.ms) });
  console.error(`rate ${rate}x controls: loop main ${r1(cm)} ms, loop worker ${r1(cw)} ms, 1024 attempts x 512 = ${r1(cc.ms)} ms`);
  for (const mode of MODES) {
    for (const [cost, max, P] of SETTINGS) {
      // warm-up (JIT, worker spin-up path); not recorded
      await page.evaluate(([c, p, mo]) => (mo === "main" ? solveMain : solveWorker)("A".repeat(123), c, 2, "zzzzzzzz", p), [cost, P, mode]);
      const ms = [];
      for (let i = 0; i < N; i++) {
        // stratified secret counters: c* = floor((i + 0.5) / N * max), shuffled, so the sample covers U[0, max)
        const cstar = Math.floor(((i * 7919) % N + 0.5) / N * max);
        const c = challenge(cost, max, cstar);
        const r = await page.evaluate(([c, mode, P]) => (mode === "main" ? solveMain : solveWorker)(c.t, c.cost, c.max, c.pfx, P), [c, mode, P]);
        if (r.c !== cstar && !dk(c.nonce, r.c, cost).subarray(0, 4).equals(Buffer.from(c.pfx, "hex"))) throw new Error(`wrong answer ${r.c} for ${cstar}`);
        ms.push(r.ms);
      }
      const row = { rate, mode, cost, max, P, expected_iterations: (cost * max) / 2, median_ms: r1(q(ms, 0.5)), p90_ms: r1(q(ms, 0.9)), p95_ms: r1(q(ms, 0.95)), max_ms: r1(Math.max(...ms)), min_ms: r1(Math.min(...ms)), samples_ms: ms.map(r1) };
      out.runs.push(row);
      console.error(`rate ${rate}x ${mode} cost=${cost} max=${max} P=${P}: median ${row.median_ms} p90 ${row.p90_ms} p95 ${row.p95_ms} max ${row.max_ms} ms`);
    }
  }
}
if (cdp) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
await browser.close();
server.close();
mkdirSync(dir + "results", { recursive: true });
const file = `${dir}results/${process.env.OUT || browserName + "-" + MODES.join("+")}.json`;
writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.error(`wrote ${file}`);
