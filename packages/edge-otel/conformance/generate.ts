// SPDX-License-Identifier: Apache-2.0
// Prints, on stdout, what the edge middleware produces, for conformance_test.go
// to check against the Go implementations (packages/pathnorm and the
// Collector's scfsanitize processor):
//   routes: the edge route for every corpus input plus generated paths,
//   export: one OTLP/JSON body from a Workers-style run with canary requests.
// Output goes only to the pipe: derived test seeds are never written to a file.
// Run: node conformance/generate.ts   (Node ≥ 22.18 strips the types)
import { normalize } from "../src/pathnorm.ts";
import { encodeStrKey } from "../src/strkey.ts";
import { withUsageMap } from "../src/wrap.ts";
import { ACCOUNT, CANARY_HEADERS, CONTRACT } from "../test/helpers.ts";
import { loadVectors } from "../test/vectors.ts";

type Mode = "path" | "route";
const routes: { mode: Mode; input: string; edge: string }[] = [];

for (const v of [...loadVectors("vectors.json"), ...loadVectors("vectors_extra.json")]) {
  if (v.mode === "web_relaxed") continue;
  const mode: Mode = v.mode === "route" ? "route" : "path";
  routes.push({ mode, input: v.input, edge: normalize(v.input, mode) });
}

// Generated paths: a deterministic mix of segment shapes, so the two
// implementations are compared well beyond the corpus.
let seed = 0x5ca1ab1e;
const rnd = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0x1_0000_0000;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
const bytes = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 256));
const hex = (n: number) =>
  bytes(n)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const segment = (): string =>
  pick([
    () => pick(["accounts", "data", "v1", "sep-24", "api", "tx", "orders", "static", "x402"]),
    () => encodeStrKey(pick(["G", "C", "M", "T", "X", "L"] as const), bytes(pick([32, 40]))),
    () => encodeStrKey("B", [0, ...bytes(32)]),
    () => encodeStrKey("G", bytes(32)).toLowerCase(),
    () => `${encodeStrKey("G", bytes(32)).slice(0, 55)}A`,
    () => `USDC:${encodeStrKey("G", bytes(32))}`,
    () => hex(32),
    () => hex(pick([4, 6, 8, 20])),
    () => `0x${hex(4)}`,
    () => String(Math.floor(rnd() * 1e9)),
    () => `${Math.floor(rnd() * 1e6)}-${Math.floor(rnd() * 100)}`,
    () => "2026-11-19T10:00:00Z",
    () => `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`,
    () => `user${Math.floor(rnd() * 1e5)}@example.com`,
    () => "alice*example.com",
    () => "+49 30 1234567",
    () => "203.0.113.9",
    () => "2001:db8::1",
    () => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.${hex(8)}`,
    () => `sk_live_${hex(8)}`,
    () => `app.${hex(5)}.js`,
    () => "logo.PNG",
    () => "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    () => Buffer.from(bytes(30)).toString("base64url"),
    () => "café",
    () => "%E2%82%AC",
    () => "%ff%fe",
    () => "%2e%2e",
    () => "..",
    () => ".",
    () => "a;jsessionid=canary",
    () => "x%2Fy",
    () => "[id]",
    () => ":id",
    () => "{id}",
    () => "*",
    () => "{unknown}",
    () => "%00",
    () => "a b",
    () => "　x",
    () => "v1.2.3",
    () => "my-post-12345",
    () => "AbCdEfGhIjKlMnOpQr",
    () => "x".repeat(70),
    () => "",
  ])();
for (let i = 0; i < 3000; i++) {
  const n = 1 + Math.floor(rnd() * 15);
  let p = Array.from({ length: n }, segment).join("/");
  p = rnd() < 0.9 ? `/${p}` : p;
  if (rnd() < 0.2) p += "?cursor=now&token=canary";
  if (rnd() < 0.05) p = `https://anchor.example${p.startsWith("/") ? "" : "/"}${p}`;
  if (rnd() < 0.05) p = `POST ${p.startsWith("/") ? p : `/${p}`}`;
  const mode: Mode = rnd() < 0.5 ? "path" : "route";
  routes.push({ mode, input: p, edge: normalize(p, mode) });
}

// One export from a Workers-style run.
let clock = 1_794_499_200_000;
let exported = "";
const worker = withUsageMap(
  {
    async fetch(request: Request, _env: unknown, _ctx: unknown) {
      const { pathname } = new URL(request.url);
      if (pathname === "/boom") throw new Error("upstream failed");
      if (pathname.startsWith("/accounts/")) return new Response("no", { status: 404 });
      return new Response("ok");
    },
  },
  {
    endpoint: "https://ingest.invalid",
    token: "scfa_ing_conformance",
    serviceName: "anchor-edge",
    routes: ["/.well-known/stellar.toml", "/auth", "/sep24/transactions/:id", "/files/*"],
    now: () => clock,
    fetch: async (_url, init) => {
      exported = String(init?.body);
      return new Response("{}");
    },
  },
);
const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
const paths: [string, string][] = [
  ["GET", "/.well-known/stellar.toml"],
  ["POST", "/auth?client_domain=wallet.example"],
  ["GET", "/sep24/transactions/7f8a2c1e?lang=en&token=canary-token"],
  ["GET", "/sep24/transactions/0b1c"],
  ["GET", `/accounts/${ACCOUNT}`],
  ["GET", `/contracts/${CONTRACT}/u/alice@example.com`],
  ["GET", "/files/a/b/c.png"],
  ["BREW", "/coffee"],
  ["GET", "/boom"],
];
for (const [method, path] of paths) {
  const p = worker.fetch(
    new Request(`https://anchor.example${path}`, { method, headers: CANARY_HEADERS }),
    {},
    ctx,
  );
  clock += 25;
  await p.catch(() => undefined);
}
clock += 10_000;
await worker.fetch(new Request("https://anchor.example/auth"), {}, ctx);
await Promise.all(waits);
if (!exported) throw new Error("no export captured");

process.stdout.write(JSON.stringify({ routes, export: exported }));
