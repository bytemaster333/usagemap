// SPDX-License-Identifier: Apache-2.0
//
// usagemap-edge (spike): dependency-free middleware for fetch-handler runtimes
// (Cloudflare Workers, Vercel edge route handlers, Deno Deploy, Bun, Node ≥ 18)
// that emits the one metric UsageMap stores, `http.server.request.duration`, as
// OTLP/HTTP JSON with a route template instead of the raw path.
//
// Privacy: only the method, the route template (or a folded path), the status
// code and the duration leave the runtime. Never the query string, headers,
// IP address, User-Agent, cookies or bodies.
//
// Timing caveat (Cloudflare Workers): `Date.now()` does not advance while code
// runs, only across I/O, so the duration is the I/O-inclusive wall time (origin
// fetches, KV, D1 …); pure-CPU handlers measure as 0.

const BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"]);
const SCOPE = { name: "usagemap-edge", version: "0.0.0-spike" };

/**
 * Compile route templates such as "/sep24/transactions/:id" or "/files/*".
 * `:name` matches one segment; a trailing `*` matches the rest. The emitted
 * route uses OTel's `{name}` form.
 */
export function compileRoutes(routes = []) {
	return routes.map((tpl) => {
		if (typeof tpl !== "string" || !tpl.startsWith("/")) throw new TypeError(`route must start with "/": ${tpl}`);
		const parts = tpl.split("/").slice(1);
		let re = "^";
		const out = [];
		for (const [i, p] of parts.entries()) {
			if (p === "*" && i === parts.length - 1) {
				re += "(?:/.*)?";
				out.push("{rest}");
				break;
			}
			re += "/";
			if (p.startsWith(":")) {
				re += "[^/]+";
				out.push(`{${p.slice(1)}}`);
			} else {
				re += p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				out.push(p);
			}
		}
		re += "/?$";
		return { re: new RegExp(re), route: `/${out.join("/")}`.replace(/\/\{rest\}$/, "/*") };
	});
}

// Segment shapes folded when no template matches. The UsageMap Collector
// re-normalises every route (packages/pathnorm); this is the first line only.
const STRKEY = /^[GCMBPTLX][A-Z2-7]{55}(?:[A-Z2-7]{13})?$/; // account, contract, muxed, …
const SEED = /^S[A-Z2-7]{55}$/; // secret seed: never forwarded
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^(?:0x)?[0-9a-f]{16,}$/i;
const NUM = /^\d+$/;
const PLAIN = /^[A-Za-z][A-Za-z0-9._~-]{0,31}$/;

/** Fold one unmatched path into a template-like route. */
export function foldPath(pathname, maxSegments = 6) {
	const segs = pathname.split("/").filter(Boolean);
	const out = [];
	for (const s of segs.slice(0, maxSegments)) {
		let seg;
		try {
			seg = decodeURIComponent(s);
		} catch {
			seg = s;
		}
		if (SEED.test(seg)) out.push("{redacted}");
		else if (STRKEY.test(seg)) out.push(seg[0] === "C" ? "{contract}" : "{account}");
		else if (UUID.test(seg)) out.push("{uuid}");
		else if (HEX.test(seg)) out.push("{hash}");
		else if (NUM.test(seg)) out.push("{id}");
		else if (PLAIN.test(seg) && !/\d{4,}/.test(seg)) out.push(seg);
		else out.push("{value}");
	}
	if (segs.length > maxSegments) out.push("*");
	return `/${out.join("/")}`;
}

/**
 * Create a recorder. Options:
 *   endpoint      OTLP base URL, e.g. "https://e1.usagemap.dev" (/v1/metrics is appended)
 *   token         ingest token, sent as "Authorization: Bearer <token>"
 *   serviceName   OTel service.name (must be registered for the project)
 *   routes        route templates; unmatched paths are folded (or "{unknown}" with unmatched: "unknown")
 *   flushIntervalMs  delta window, default 10 000
 *   fetch         fetch implementation (default globalThis.fetch)
 *   now           clock in ms (default Date.now)
 */
export function createRecorder(opts) {
	const {
		endpoint,
		token,
		serviceName,
		routes = [],
		unmatched = "fold",
		flushIntervalMs = 10_000,
		fetch: doFetch = globalThis.fetch,
		now = Date.now,
	} = opts ?? {};
	if (!endpoint || !token || !serviceName) throw new TypeError("endpoint, token and serviceName are required");
	const compiled = compileRoutes(routes);
	const url = `${endpoint.replace(/\/+$/, "")}/v1/metrics`;
	let series = new Map();
	let windowStart = now();
	let lastFlush = windowStart;
	const stats = { exported: 0, failed: 0 };

	function routeFor(pathname) {
		for (const c of compiled) if (c.re.test(pathname)) return c.route;
		return unmatched === "unknown" ? undefined : foldPath(pathname);
	}

	function record(method, pathname, status, seconds) {
		const m = METHODS.has(method) ? method : "_OTHER";
		const route = routeFor(pathname);
		const key = `${m} ${route ?? ""} ${status}`;
		let s = series.get(key);
		if (!s) {
			s = { method: m, route, status, count: 0, sum: 0, min: Infinity, max: 0, buckets: new Array(BOUNDS.length + 1).fill(0) };
			series.set(key, s);
		}
		const v = Math.max(0, seconds);
		s.count++;
		s.sum += v;
		s.min = Math.min(s.min, v);
		s.max = Math.max(s.max, v);
		let i = 0;
		while (i < BOUNDS.length && v > BOUNDS[i]) i++;
		s.buckets[i]++;
	}

	function due() {
		return series.size > 0 && now() - lastFlush >= flushIntervalMs;
	}

	/** Build the OTLP/JSON body of the current window and start a new one. */
	function drain() {
		if (series.size === 0) return null;
		const t = now();
		const start = BigInt(windowStart) * 1_000_000n;
		const end = BigInt(t) * 1_000_000n;
		const points = [...series.values()].map((s) => {
			const attributes = [{ key: "http.request.method", value: { stringValue: s.method } }];
			if (s.route) attributes.push({ key: "http.route", value: { stringValue: s.route } });
			attributes.push({ key: "http.response.status_code", value: { intValue: String(s.status) } });
			return {
				attributes,
				startTimeUnixNano: String(start),
				timeUnixNano: String(end),
				count: String(s.count),
				sum: s.sum,
				min: s.min,
				max: s.max,
				bucketCounts: s.buckets.map(String),
				explicitBounds: BOUNDS,
			};
		});
		series = new Map();
		windowStart = t;
		lastFlush = t;
		return {
			resourceMetrics: [
				{
					resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
					scopeMetrics: [
						{
							scope: SCOPE,
							metrics: [
								{
									name: "http.server.request.duration",
									unit: "s",
									histogram: { aggregationTemporality: 1, dataPoints: points }, // 1 = DELTA
								},
							],
						},
					],
				},
			],
		};
	}

	/** Export the current window; never throws (analytics must not break the app). */
	async function flush() {
		const body = drain();
		if (!body) return;
		try {
			const res = await doFetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify(body),
			});
			if (res.ok) stats.exported++;
			else stats.failed++;
		} catch {
			stats.failed++;
		}
	}

	return { record, due, drain, flush, stats, routeFor };
}

/**
 * Wrap a fetch handler: `export default withUsageMap({ fetch(req, env, ctx) {…} }, opts)`.
 * opts may be a function of `env` so the token comes from a Worker secret.
 * For runtimes without `ctx.waitUntil` (Vercel: `waitUntil` from
 * `@vercel/functions`), pass `opts.waitUntil`.
 */
export function withUsageMap(handler, opts) {
	let rec;
	const fetchFn = typeof handler === "function" ? handler : handler.fetch.bind(handler);
	const wrapped = async (request, env, ctx) => {
		const o = typeof opts === "function" ? opts(env) : opts;
		rec ??= createRecorder(o);
		const waitUntil = o.waitUntil ?? ctx?.waitUntil?.bind(ctx);
		const t0 = (o.now ?? Date.now)();
		const { pathname } = new URL(request.url);
		let status = 500;
		try {
			const res = await fetchFn(request, env, ctx);
			status = res.status;
			return res;
		} finally {
			rec.record(request.method, pathname, status, ((o.now ?? Date.now)() - t0) / 1000);
			if (rec.due()) {
				const p = rec.flush();
				if (waitUntil) waitUntil(p);
			}
		}
	};
	return typeof handler === "function" ? wrapped : { ...handler, fetch: wrapped };
}
