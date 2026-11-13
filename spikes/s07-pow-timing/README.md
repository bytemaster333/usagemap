# S-07 — Proof-of-work timing (emulated slow CPUs, no real phones)
**Result:** PARTIAL. The contract default `cost=512, max=1024` solves with a median of 288 ms (Chromium) and 314 ms
(WebKit) on a CPU cut to 1/6 of one desktop core. That is within the 500 ms target, and the solver is 644 B gzip.
All of this is an **emulation on a desktop CPU, not a measurement on a real phone**, and DevTools CPU throttling
turned out not to slow the solver at all.

## Question
How long does the §b.2 proof-of-work take on a low-end phone at candidate difficulties? Which default keeps the
median ≤ 500 ms (C-35, ADR-0008 L3)? How big is the solver (C-32 budgets ~1 kB for it)?

## Method (versions, commands, how to re-run: one command if possible)
Re-run: `spikes/s07-pow-timing/run.sh` (about 45 min; Docker; `N=` samples per cell, default 25). It runs under
Docker project `scf-s07` with **no published ports**: the page is served on `127.0.0.1:18807` inside the
container. The script removes its containers at the end and keeps the image.

- **Solver** `src/solver.js`, implementing `docs/contracts/wire-formats.md` §b.1/§b.2 exactly: `nonce` = token
  bytes 27..43 (b64u-decoded), `password(c) = "scf-pow-v1" ‖ nonce ‖ uint32be(c)`, `salt = nonce`, WebCrypto
  `PBKDF2`/`SHA-256` with `iterations = cost`, and c = 0, 1, … is tried until the first 4 bytes equal `pfx`. It
  derives 32 bits instead of 256. The first 4 bytes of PBKDF2 block T1 are identical either way and the work is
  the same. It runs in a **Web Worker created from a Blob URL**. `P` is the number of `deriveBits` calls kept in
  flight (1 or 4). `src/loader.js` is the tracker-side wrapper (create the worker, post, terminate).
- **Challenge issuing** in `bench.mjs` with Node `crypto.pbkdf2Sync`, as the gateway would do it. The secret
  counter c\* is stratified over [0, max): `floor((k+0.5)/N·max)`, shuffled. This gives a uniform c\* distribution
  with low sampling noise. Every answer is checked against Node's PBKDF2; all were correct.
- **Timing**: `performance.now()` from `new Worker()` until the answer arrives, so worker start-up is included.
  Each cell has one warm-up that is not recorded. The "main" mode runs the same source on the page thread.
- **Browsers**: Playwright 1.65.0 in `mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb5460…e73dbe` (Node
  26.13.1): **Chromium 158.0.8127.18** and **WebKit 27.2**. The host WebKit lacked system libraries, which is why
  everything runs in the image. Host CPU: Intel Core Ultra 5 225 ×8, Linux 6.12.
- **Emulations:**
  1. **DevTools** `Emulation.setCPUThrottlingRate` 1×/4×/6× on the page's CDP session (Chromium only; WebKit has no
     equivalent). This is what the plan asked for.
  2. **cgroup CPU quota** (`docker compose … cpus:`): 1.0, 0.25 and 0.1667 CPU, labelled "quota 1×/4×/6×". This
     limits every thread of every browser process, including the WebCrypto threads. It applies to both engines.
- **Controls** for each emulation: a fixed JS integer loop (2·10⁸ iterations) on the main thread and in a worker,
  and a fixed 1024-attempt × 512-iteration PBKDF2 run in a worker. They show which threads the emulation reaches.
- **Size**: `build.mjs` minifies with esbuild 0.28.2 (`target es2017`), then gzip -9 and brotli 11.

## Observations (raw facts, with excerpts of output)
**1. DevTools CPU throttling does not reach Web Workers or WebCrypto.** Controls from `results/devtools-chromium.json`:

| DevTools rate | JS loop, main thread | JS loop, worker | 1024 × PBKDF2(512) in worker |
|---|---|---|---|
| 1× | 1658 ms | 1852 ms | 198 ms |
| 4× | 6029 ms | 1719 ms | 105 ms |
| 6× | 6716 ms | 1675 ms | 142 ms |

Sending the command to the worker target directly over CDP returns
`{"code":-32000,"message":"Operation is only supported for pages, not workers"}` (Chromium 158). So the worker
solver at "6×" is as fast as at 1×: median 81.7 ms vs 81.4 ms for 512×1024. Only main-thread mode slows down,
non-linearly and noisily: 42.7 ms → 209 ms. **DevTools throttling is not a valid emulation for this solver.** The
evidence that counts comes from the cgroup quota, whose controls scale on every thread:

| quota | JS loop main / worker (Chromium) | PBKDF2 control (Chromium) | JS loop main / worker (WebKit) | PBKDF2 control (WebKit) |
|---|---|---|---|---|
| 1× (1.0 CPU) | 1367 / 1614 ms | 102 ms | 2190 / 2181 ms | 183 ms |
| 4× (0.25 CPU) | 4776 / 4483 ms | 375 ms | 4204 / 3932 ms | 702 ms |
| 6× (0.1667 CPU) | 6822 / 6903 ms | 496 ms | 5828 / 6304 ms | 695 ms |

At "6×" the effective slowdown against one unconstrained core is 4.3–5×, not exactly 6×, because the CFS quota
lets the browser use bursts. The measured PBKDF2 rate at quota 6× is about 1.06 M iterations/s (Chromium) and
0.75 M/s (WebKit). That is at or below the research's guess of 1–3 M HMAC-iterations/s for a low-end Android core,
so the 6× quota is a reasonable, if anything pessimistic, proxy.

**2. Solve time, worker mode, `P=1` unless stated** (`results/quota*-{chromium,webkit}.json`, n = 25 per cell;
median / p95 in ms):

| cost × max (expected iterations) | Chr 1× | Chr 4× | **Chr 6×** | WK 1× | WK 4× | **WK 6×** |
|---|---|---|---|---|---|---|
| 256 × 512 (2¹⁶) | 36 / 62 | 79 / 147 | 117 / 205 | 52 / 82 | 99 / 181 | 117 / 207 |
| 256 × 1024 (2¹⁷) | 52 / 94 | 118 / 206 | 192 / 298 | 81 / 126 | 179 / 291 | 285 / 400 |
| 512 × 512 (2¹⁷) | 52 / 81 | 108 / 181 | 178 / 292 | 65 / 124 | 105 / 235 | 202 / 309 |
| **512 × 1024 (2¹⁸) — contract default** | 71 / 123 | 163 / 284 | **288 / 418** | 114 / 260 | 225 / 403 | **314 / 608** |
| 512 × 1024, P=4 | 69 / 100 | 196 / 290 | 286 / 413 | 105 / 270 | 203 / 415 | 304 / 580 |
| 1024 × 512 (2¹⁸) | 61 / 108 | 193 / 268 | 219 / 394 | 121 / 224 | 207 / 396 | 303 / 498 |
| 2048 × 256 (2¹⁸) | 56 / 104 | 126 / 246 | 213 / 309 | 93 / 185 | 199 / 356 | 296 / 575 |
| 1024 × 1024 (2¹⁹) | 105 / 247 | 289 / 470 | 408 / 687 | 174 / 381 | 392 / 615 | 586 / 996 |
| 512 × 2048, P=4 (2¹⁹, adaptive 2×) | 106 / 204 | 296 / 506 | 493 / 801 | 134 / 256 | 411 / 767 | 613 / 1098 |
| 512 × 4096, P=4 (adaptive 4×) | 176 / 308 | 593 / 1089 | 822 / 1548 | 262 / 504 | 783 / 1474 | 1199 / 2377 |
| 512 × 8192, P=4 (adaptive 8×) | 385 / 644 | 1097 / 2013 | 1618 / 2965 | 471 / 1067 | 1488 / 3044 | 2296 / 4261 |

(Main-thread mode and every cell with min/p90/max are in `results/summary.md`.)
- Worker start-up plus per-call overhead is visible. At the same expected work, `128×1024` costs as much as
  `512×512`, and at small `cost` the overhead dominates. With `P=4`, deriveBits calls overlap: no gain under a
  1-CPU quota, small gains unthrottled.
- Main-thread mode is as fast as worker mode or slightly faster. deriveBits is asynchronous either way and keeps the
  page responsive. A CSP that forbids `blob:` workers can therefore fall back to the main thread.
- An earlier run directly on the host (Chromium, DevTools only; `results/devtools-chromium-host-firstrun.json`)
  showed the same pattern: worker times did not change from 1× to 6×.

**3. Size** (`results/size.json`):

| unit | raw | gzip -9 | brotli 11 |
|---|---|---|---|
| solver (worker body) | 784 B | 522 B | 457 B |
| solver + loader (Blob worker wrapper) | 1024 B | **644 B** | 569 B |

## Answer to the question
- **Recommended default: `pow_cost = 512`, `pow_max = 1024`** (expected 2¹⁸ PBKDF2 iterations, as in the
  contract). Under the 6× CPU-quota emulation its median is **288 ms (Chromium) / 314 ms (WebKit)**, well under 500
  ms. p95 is 418 / 608 ms and the worst sample 0.7 s, because c\* is uniform: the worst case is twice the median.
  `1024 × 1024` (2¹⁹, the research's original W) breaks the target on WebKit (median 586 ms), and so does the
  adaptive 2× step for WebKit (613 ms). So 2¹⁸ is the largest power of two that meets the target in both engines.
- **Solver size: 644 B gzip** standalone, including the worker wrapper (522 B for the worker body alone), inside
  C-32's ~1 kB allowance. Inside the tracker bundle the marginal gzip cost will be lower.
- **This is an emulation**: a desktop x86 CPU limited by a cgroup quota, running desktop Chromium and WebKit on
  Linux. It is not a low-end Android phone (big.LITTLE ARM cores, thermal throttling, Chrome Android's WebCrypto
  build), and it is not iOS Safari. DevTools CPU throttling, the usual "low-end phone" proxy, does not apply to this
  code at all. The real-device measurement (proof-of-work
  timing on real phones) is still open.

## Consequences for the design (which ADR / clarification / contract section is confirmed or must change, and exactly how)
- **wire-formats.md §b.2 confirmed as specified and implementable:** the example `cost 512 / max 1024` and
  "expected work ≈ 2¹⁸" are the recommended defaults. Note in §b.2 that dkLen 32 vs 4 bytes is equivalent for the
  solver, and that `cost` should not go below 256, because worker and call overhead then dominate.
- **C-35** (target ≤ 500 ms) is met *in emulation* at the default. The adaptive multiplier (§b.2) can push the time
  over 500 ms: 2× gives 0.5–0.6 s, 8× gives 1.6–2.3 s median at 6×. That is acceptable only because it applies to
  suspicious `(site, net)` pairs. C-35's hidden-page rule (`proof_missing` → `suspect`) will fire more often there.
  Say so in the published thresholds.
- **ADR-0008 L3 / research §3.2.3:** replace "W ≈ 2¹⁹" with **2¹⁸**. The research's cost estimates (cents per
  million solves on a GPU) halve accordingly. That does not change the conclusion that PoW is metering, not a
  barrier.
- **C-32 confirmed**: the solver plus wrapper takes 644 B of the 2.5 kB `strict` budget.
- **Tracker (ADR-0004):** worker from a `blob:` URL is the primary path. Fall back to running the same code on the
  main thread if `new Worker` throws (CSP `worker-src`/`script-src` without `blob:`); it costs no responsiveness
  because deriveBits is asynchronous. Keep `P = 1`: no measured benefit, more memory.
- **Test strategy (ADR-0026):** CI timing tests must use a CPU quota (cgroup/`docker --cpus`), never DevTools
  throttling, or they measure nothing.

## Values the implementation must use (env vars, headers, config keys, flags, limits)
- `pow_cost = 512`, `pow_max = 1024` (snapshot settings, §b.1 `cost`/`max`); adaptive multiplier ∈ {1, 2, 4, 8}
  unchanged. Lower bound for `pow_cost` in config validation: 256.
- Solver constants: prefix `"scf-pow-v1"`, nonce = token[27..43], counter uint32 big-endian at password offset 26,
  `deriveBits(…, 32)` compared to `pfx` (8 hex chars), answer `c` (integer), `-1`/absent if not found.
- Worker: `new Worker(URL.createObjectURL(new Blob([src])))`, terminated after the answer; one solve per page load.
- Size gate: the solver + loader ≤ 700 B gzip -9 (measured 644 B) as a sub-budget of C-32.
- `pow_latency` buckets (§b.2 timing signal) should resolve 50–5000 ms. Emulated real solves span about 20 ms
  (desktop) to 3 s (8× on a slow CPU).

## Open issues
- **No real-device data.** Measure on a ~US$100 Android phone (Chrome) and an older iPhone (Safari) before T1 with
  `page/index.html` (`solveWorker(...)` from the console or remote debugging); accept if the median for 512×1024
  is ≤ 500 ms. If it is not, lower `pow_max` to 512 (2¹⁷: 178–285 ms at quota 6×).
- WebKit here is Playwright's Linux WebKit, not Safari on iOS; JavaScriptCore and CommonCrypto differ.
- Worker start-up cost on phones (tens of ms) is unmeasured; it is included in these numbers only for desktop
  engines.
- cgroup quota is bursty (100 ms CFS periods), so short solves get somewhat better treatment than a uniformly slow
  core would give them.
