// SPDX-License-Identifier: Apache-2.0
// G1 smoke checks that need a caller inside the stack (the engine proxy and the control plane's internal API publish
// no port). Run by scripts/smoke.sh inside a throwaway Node container (uid 65532, the owner of the keys it uses) with
// the dev certificates mounted under /pki and the provisioning password at /run/prov_password. Node standard library
// only. Prints PASS/FAIL lines; exits 1 on any failure.
//
// Identities (infra/compose/scripts/dev-pki.sh): edge-a1 (edge), core-a-jobs (reader), core-a-umami-bootstrap
// (provisioner). Modes: all, cp-unreachable, cp-direct, after-restart, writer (metrics writer on `core`), otlp
// (on the private otlp network with the Collector, C-130), mint-ing, otlp-door and stellar-event (on `public`).

import { createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { crc32 } from "node:zlib";

const PROXY = { host: "engine-proxy", port: 8443 };
const CP_INTERNAL = { host: "control-plane", port: 8081 };
const EDGE = "edge-a1";
const READER = "core-a-jobs";
const PROV = "core-a-umami-bootstrap";
const ca = readFileSync("/pki/ca.pem");
const ident = (name) =>
  name ? { cert: readFileSync(`/pki/${name}.pem`), key: readFileSync(`/pki/${name}-key.pem`) } : {};
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
  if (!ok) failed++;
};

function call(identity, method, path, { body, headers = {}, target = PROXY } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(
      {
        ...target,
        method,
        path,
        ca,
        servername: target.host,
        timeout: 5000,
        ...ident(identity),
        minVersion: "TLSv1.3",
        headers: {
          ...(data
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      },
    );
    req.on("timeout", () =>
      req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
    );
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function plain(url, headers = {}) {
  return new Promise((resolve) => {
    const req = httpRequest(url, { headers, timeout: 5000 }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("timeout", () =>
      req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
    );
    req.on("error", (e) => resolve({ status: 0, error: e.code }));
    req.end();
  });
}

// tcp resolves to "connected" or the error code of a plain TCP connection attempt.
function tcp({ host, port }) {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 3000 });
    s.on("connect", () => {
      s.destroy();
      resolve("connected");
    });
    s.on("timeout", () => {
      s.destroy();
      resolve("ETIMEDOUT");
    });
    s.on("error", (e) => resolve(e.code || "error"));
  });
}

const surrogate = () => {
  const b = randomBytes(12);
  const groups = [];
  for (let i = 0; i < 12; i += 2) groups.push(((b[i] << 8) | b[i + 1]).toString(16));
  return `2001:db8:${groups.join(":")}`;
};
const send = (identity, website, sur, ts, extra = {}) =>
  call(identity, "POST", "/api/send", {
    body: {
      type: "event",
      payload: {
        website,
        hostname: "smoke.example.org",
        url: "/smoke",
        tag: "v",
        timestamp: ts,
        ...extra,
      },
    },
    headers: {
      "user-agent": UA,
      "x-scf-surrogate-ip": sur,
      "cf-ipcountry": "DE",
      "x-scf-visit": "track",
    },
  });

const mode = process.argv[2] ?? "all";

if (mode === "all") {
  // mTLS: no certificate -> handshake refused
  const anon = await call(null, "GET", "/api/heartbeat");
  check("engine proxy refuses a caller without a node certificate", anon.status === 0, anon.status);

  // bootstrap done: the seed admin is gone (B5 through the proxy as the provisioning identity)
  const b5 = await call(PROV, "POST", "/api/auth/login", {
    body: { username: "admin", password: "umami" },
  });
  check("seed admin admin/umami refused (B5 = 401)", b5.status === 401, b5.status);

  // provisioning admin works (P1) and can create a website (P7)
  const pw = readFileSync("/run/prov_password", "utf8").trim();
  const p1 = await call(PROV, "POST", "/api/auth/login", {
    body: { username: "scf-provisioner", password: pw },
  });
  const token = p1.status === 200 ? JSON.parse(p1.body).token : "";
  check("provisioning admin logs in (P1)", p1.status === 200 && !!token, p1.status);
  const website = randomUUID();
  const p7 = await call(PROV, "POST", "/api/websites", {
    body: { id: website, name: "smoke", domain: "smoke.example.org" },
    headers: { authorization: `Bearer ${token}` },
  });
  check("website created through the proxy (P7)", p7.status === 200, p7.status);

  // edge: event accepted, identifiers stripped, token replayed for the next event
  const sur = surrogate();
  const now = Math.floor(Date.now() / 1000);
  const e1 = await send(EDGE, website, sur, now - 600);
  check(
    "edge POST /api/send -> 200 {} (cache, sessionId, visitId stripped)",
    e1.status === 200 && e1.body === "{}",
    `${e1.status} ${e1.body}`,
  );
  const e2 = await send(EDGE, website, sur, now - 60);
  check("second event of the visit accepted", e2.status === 200, e2.status);
  const bad = await send(EDGE, website, sur, now, { ip: "198.51.100.1" });
  check("payload.ip refused with 400 (never forwarded)", bad.status === 400, bad.status);

  // reader: stats with the provisioning admin's session (any Umami bearer passes through the reader route)
  const end = Date.now();
  const stats = await call(
    READER,
    "GET",
    `/api/websites/${website}/stats?startAt=${end - 86400000}&endAt=${end}&timezone=UTC`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  let pv = -1,
    visits = -1;
  try {
    const s = JSON.parse(stats.body);
    pv = Number(s.pageviews?.value ?? s.pageviews);
    visits = Number(s.visits?.value ?? s.visits);
  } catch {}
  check(
    "reader GET stats -> 2 page views in 1 visit (token replayed)",
    stats.status === 200 && pv === 2 && visits === 1,
    `${stats.status} pv=${pv} visits=${visits}`,
  );

  // allow-lists and deny-list
  for (const [id, m, p, want] of [
    [EDGE, "POST", "/api/batch", 403],
    [EDGE, "GET", "/api/heartbeat", 403],
    [EDGE, "GET", `/api/websites/${website}/stats?startAt=1&endAt=2&timezone=UTC`, 403],
    [READER, "POST", "/api/send", 403],
    [READER, "GET", "/api/admin/websites", 403],
    [PROV, "GET", "/openapi.json", 403],
    [PROV, "POST", "/api/me/password", 403],
  ]) {
    const r = await call(id, m, p);
    check(`${id} ${m} ${p.split("?")[0]} -> ${want}`, r.status === want, r.status);
  }

  // internal edge API reaches the control plane with the edge's certificate identity
  const snap = await call(EDGE, "GET", "/internal/v1/edge/snapshot", {
    headers: { "x-scf-edge-node": "edge-b9" },
  });
  check(
    "edge GET /internal/v1/edge/snapshot through the proxy -> 200 (proxy -> control plane over mutual TLS)",
    snap.status === 200 && snap.body.includes("payload"),
    `${snap.status} ${snap.body.slice(0, 120)}`,
  );
  // The control plane checks node_id against the header the proxy sets from the certificate: a record that claims
  // another node is refused by the control plane (401), so the header crossed the mTLS hop as the edge's CN.
  const counters = await call(EDGE, "POST", "/internal/v1/edge/counters", {
    body: { node_id: "edge-b9" },
    headers: { "x-scf-edge-node": "edge-b9" },
  });
  check(
    "edge POST counters through the proxy reaches the control plane (refused there: 400/401/422, not 5xx)",
    [400, 401, 422].includes(counters.status),
    `${counters.status} ${counters.body?.slice(0, 120)}`,
  );
  if (snap.headers?.["content-type"]?.includes("json") && snap.body.includes('"node"')) {
    check(
      "control plane sees x-scf-edge-node = edge-a1 (spoofed value dropped)",
      JSON.parse(snap.body).node === "edge-a1",
      snap.body,
    );
  }

  // token purge endpoint (provisioning identity)
  const purge = await call(PROV, "DELETE", `/internal/v1/visit-tokens/websites/${website}`);
  check(
    "DELETE /internal/v1/visit-tokens/websites/{id} -> 204",
    purge.status === 204,
    purge.status,
  );

  // metrics (plain HTTP on the core network)
  const m = await plain("http://engine-proxy:9464/metrics");
  check(
    "metrics: gate open, tokens stored, a replay hit",
    m.status === 200 &&
      /scf_engine_proxy_bootstrap_gate_open 1/.test(m.body) &&
      /scf_engine_proxy_visit_lookup_hits_total [1-9]/.test(m.body),
    m.status,
  );
  check(
    "metrics contain no surrogate or website id",
    !m.body.includes("2001:db8") && !m.body.includes(website),
  );
}

// cp-unreachable: run on a network the control plane is NOT on (core): its internal port cannot even be reached.
if (mode === "cp-unreachable") {
  const r = await tcp(CP_INTERNAL);
  check(
    `control-plane:8081 unreachable from network ${process.argv[3] ?? "?"} (${r})`,
    r !== "connected",
    r,
  );
}

// cp-direct: run on a network the control plane IS on (public, data): only the engine proxy's client certificate is
// accepted, so an edge going around the proxy (with or without a certificate, with a forged node header) fails.
if (mode === "cp-direct") {
  const net = process.argv[3] ?? "?";
  const forged = { "x-scf-edge-node": EDGE };
  const viaEdgeCert = await call(EDGE, "GET", "/internal/v1/edge/snapshot", {
    target: CP_INTERNAL,
    headers: forged,
  });
  check(
    `[${net}] edge certificate straight to the internal API refused (handshake or 401)`,
    viaEdgeCert.status === 0 || viaEdgeCert.status === 401,
    `${viaEdgeCert.status} ${viaEdgeCert.error ?? ""}`,
  );
  const post = await call(EDGE, "POST", "/internal/v1/edge/counters", {
    target: CP_INTERNAL,
    headers: forged,
    body: { node_id: EDGE },
  });
  check(
    `[${net}] edge counters straight to the internal API refused`,
    post.status === 0 || post.status === 401,
    `${post.status} ${post.error ?? ""}`,
  );
  const anon = await call(null, "GET", "/internal/v1/edge/snapshot", {
    target: CP_INTERNAL,
    headers: forged,
  });
  check(
    `[${net}] no client certificate: internal API handshake refused`,
    anon.status === 0,
    `${anon.status} ${anon.error ?? ""}`,
  );
  const http = await plain("http://control-plane:8081/internal/v1/edge/snapshot", forged);
  check(
    `[${net}] plain HTTP to the internal API refused`,
    http.status === 0 || http.status >= 400,
    `${http.status} ${http.error ?? ""}`,
  );
}

if (mode === "after-restart") {
  const r = await plain("http://engine-proxy:9464/readyz");
  check("restarted engine proxy re-checked B5 by itself (readyz 200)", r.status === 200, r.status);
  const e = await send(EDGE, randomUUID(), surrogate(), Math.floor(Date.now() / 1000));
  // unknown website -> Umami 400 "Website not found": the gate is open and the event reached Umami
  check(
    "edge send after restart reaches Umami (not 503)",
    e.status === 400 && e.body.includes("Website not found"),
    `${e.status} ${e.body}`,
  );
}

// writer: run on `core`. The metrics writer answers to writers.mesh.local only with mutual TLS and only to OU edge.
if (mode === "writer") {
  const WRITER = { host: "writers.mesh.local", port: 4319 };
  const ready = await plain("http://metrics-writer:9464/readyz");
  check(
    "metrics writer readyz 200 (listener open: database reachable)",
    ready.status === 200,
    ready.status,
  );
  const empty = await call(EDGE, "POST", "/v1/metrics", {
    target: WRITER,
    headers: { "content-type": "application/x-protobuf", "content-length": 0 },
  });
  check(
    "edge certificate -> writers.mesh.local:4319 POST /v1/metrics (empty request) -> 200",
    empty.status === 200,
    `${empty.status} ${empty.error ?? ""}`,
  );
  const anon = await call(null, "POST", "/v1/metrics", { target: WRITER });
  check("writer refuses a caller without a node certificate", anon.status === 0, anon.status);
  const reader = await call(READER, "POST", "/v1/metrics", {
    target: WRITER,
    headers: { "content-type": "application/x-protobuf", "content-length": 0 },
  });
  check(
    "writer refuses a non-edge certificate (OU reader)",
    reader.status === 0 || reader.status === 403,
    `${reader.status} ${reader.error ?? ""}`,
  );
}

// One delta histogram (3 requests) of service NAME with canaries that must never reach the database.
function otlpBody(service, now) {
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: service } },
            { key: "host.name", value: { stringValue: "CANARY-HOST" } },
            { key: "scf.tenant.level", value: { intValue: "3" } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: "smoke" },
            metrics: [
              {
                name: "http.server.request.duration",
                unit: "s",
                histogram: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      startTimeUnixNano: String(now - 10_000_000_000n),
                      timeUnixNano: String(now),
                      count: "3",
                      sum: 0.3,
                      bucketCounts: ["1", "2", "0"],
                      explicitBounds: [0.05, 0.5],
                      attributes: [
                        { key: "http.route", value: { stringValue: "/smoke/{id}" } },
                        { key: "http.request.method", value: { stringValue: "GET" } },
                        { key: "http.response.status_code", value: { intValue: "200" } },
                        { key: "client.address", value: { stringValue: "203.0.113.9" } },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

function post(url, body, headers, tls = {}) {
  return new Promise((resolve) => {
    const req = (url.startsWith("https:") ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        timeout: 5000,
        ...tls,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode, body: b }));
      },
    );
    req.on("timeout", () =>
      req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
    );
    req.on("error", (e) => resolve({ status: 0, error: e.code }));
    req.end(body);
  });
}

// otlp TENANT: run on the private `otlp` network (C-130), playing the gateway (C-107, C-116): the Collector's health
// and one request with the gateway's x-scf-* metadata.
if (mode === "otlp") {
  const tenant = process.argv[3];
  const collector = "http://otlp-collector";
  const health = await plain(`${collector}:13133/`);
  check("Collector health_check 200 (on the otlp network)", health.status === 200, health.status);
  const now = BigInt(Date.now()) * 1_000_000n;
  const r = await post(`${collector}:4318/v1/metrics`, otlpBody("smoke-svc", now), {
    "x-scf-tenant-id": tenant,
    "x-scf-allowed-services": "*",
    "x-scf-received-at": String(now),
    "x-scf-tenant-level": "L1",
  });
  check(
    "Collector accepts OTLP/HTTP with the gateway's metadata (200)",
    r.status === 200,
    `${r.status} ${r.error ?? ""}`,
  );
}

// mint-ing: an ingest key in the wire-formats §k format, hashed with the dev pepper (/run/pepper, `1:<base64>`).
// Prints "<key> <token id> <last4> <hex hash>" for the caller to seed scf.ingest_tokens.
if (mode === "mint-ing") {
  const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const b62 = (n, w) => {
    let out = "";
    while (n > 0n) {
      out = B62[Number(n % 62n)] + out;
      n /= 62n;
    }
    return out.padStart(w, "0");
  };
  const id = b62(BigInt(`0x${randomBytes(9).toString("hex")}`), 12).slice(-12);
  const secret = b62(BigInt(`0x${randomBytes(20).toString("hex")}`), 27);
  const crc = b62(BigInt(crc32(Buffer.from(`scfa_ing_${id}_${secret}`, "ascii")) >>> 0), 6);
  const pepper = Buffer.from(readFileSync("/run/pepper", "utf8").trim().split(":")[1], "base64");
  const hash = createHmac("sha256", pepper).update(secret, "ascii").digest("hex");
  console.log(`scfa_ing_${id}_${secret}${crc} ${id} ${secret.slice(-4)} ${hash}`);
  process.exit(0);
}

// otlp-door KEY: a tenant's OTLP/HTTP request through the gateway's front door (TLS, ingest token), run on `public`.
if (mode === "otlp-door") {
  const key = process.argv[3];
  const now = BigInt(Date.now()) * 1_000_000n;
  let r;
  for (let i = 0; i < 60; i++) {
    r = await post(
      "https://gateway:8443/v1/metrics",
      otlpBody("smoke-door", now),
      { authorization: `Bearer ${key}` },
      {
        ca,
        servername: "gateway",
      },
    );
    if (r.status === 200) break; // 401 until the token reaches the gateway through the signed snapshot
    await new Promise((res) => setTimeout(res, 1000));
  }
  check(
    "gateway OTLP front door accepts the ingest token (200)",
    r.status === 200,
    `${r.status} ${r.body ?? r.error ?? ""}`,
  );
  const bad = await post(
    "https://gateway:8443/v1/metrics",
    otlpBody("smoke-door", now),
    { authorization: "Bearer scfa_ing_000000000000_000000000000000000000000000000000" },
    { ca, servername: "gateway" },
  );
  check("gateway OTLP front door refuses a wrong token (401)", bad.status === 401, `${bad.status}`);
}

// stellar-event SITEKEY: one Stellar event schema v1 event (wire-formats §a.3.1) through the gateway the way
// the tracker sends it: challenge (/v1/c), proof of work (§b.2: PBKDF2-SHA-256 counter search, as the gateway's
// canary probe), then a batch with one `wl` event (/v1/e) from a declared origin. Run on `public`. The gateway
// counts it into the property rollup (counter record `props`, §d.3) and forwards wallet_connect to Umami.
if (mode === "stellar-event") {
  const site = process.argv[3];
  const origin = "https://site.test";
  const postText = (path, body) =>
    new Promise((resolve) => {
      const data = JSON.stringify(body);
      const req = httpsRequest(
        {
          host: "gateway",
          port: 8443,
          method: "POST",
          path,
          ca,
          servername: "gateway",
          timeout: 5000,
          headers: {
            "content-type": "text/plain;charset=UTF-8",
            "content-length": Buffer.byteLength(data),
            origin,
            referer: `${origin}/`,
            "user-agent": UA,
            accept: "*/*",
            "accept-language": "en-US,en;q=0.9",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "cross-site",
            "sec-fetch-dest": "empty",
          },
        },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => resolve({ status: res.statusCode, body: b }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.message }));
      req.end(data);
    });
  const solve = (token, pow) => {
    const raw = Buffer.from(token, "base64url");
    if (raw.length !== 92 || pow.alg !== "pbkdf2-sha256" || pow.cost * pow.max > 1 << 24)
      return undefined;
    const nonce = raw.subarray(27, 43);
    const pfx = Buffer.from(pow.pfx, "hex");
    const ctr = Buffer.alloc(4);
    for (let i = 0; i < pow.max; i++) {
      ctr.writeUInt32BE(i);
      const k = pbkdf2Sync(
        Buffer.concat([Buffer.from("scf-pow-v1"), nonce, ctr]),
        nonce,
        pow.cost,
        32,
        "sha256",
      );
      if (k.subarray(0, 4).equals(pfx)) return i;
    }
    return undefined;
  };
  let r = { status: 0 };
  for (let i = 0; i < 60 && r.status !== 202; i++) {
    const ch = await postText("/v1/c", { v: 1, s: site, p: "standard", tv: "1.0.0" });
    if (ch.status === 200) {
      const c = JSON.parse(ch.body);
      const ev = {
        v: 1,
        s: site,
        p: "standard",
        tv: "1.0.0",
        t: c.t,
        sg: { wd: 0, vis: "v", act: 1 },
        e: [
          {
            id: randomBytes(16).toString("base64url"),
            k: "wl",
            sv: 1,
            u: "/smoke/wallet",
            n: "wallet_connect",
            wt: "freighter",
            net: "testnet",
            ck: "new",
          },
        ],
      };
      const n = solve(c.t, c.pow ?? {});
      if (n !== undefined) ev.c = n;
      r = await postText("/v1/e", ev);
    } else r = ch;
    if (r.status !== 202) await new Promise((res) => setTimeout(res, 1000));
  }
  check(
    "gateway accepts a Stellar event schema v1 wallet_connect (202)",
    r.status === 202,
    `${r.status} ${r.body ?? r.error ?? ""}`.slice(0, 200),
  );
}

console.log(failed ? `smoke-client: ${failed} check(s) failed` : "smoke-client: all checks passed");
process.exit(failed ? 1 : 0);
