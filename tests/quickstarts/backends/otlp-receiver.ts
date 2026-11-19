// SPDX-License-Identifier: Apache-2.0
// api.dual-export, api.drop-traces backend examples: a local OTLP/HTTP test receiver that stands in for UsageMap's OTLP front door (and, as a
// second instance, for the tenant's own APM). It accepts what the SDKs send — protobuf (default) or JSON, optionally
// gzip — decodes the metrics into plain objects, and keeps each request's decompressed body so the suite can search
// it for canary strings. No dependency: the protobuf wire format is decoded here for the subset of
// opentelemetry-proto v1 the metrics service uses (field numbers from opentelemetry/proto/metrics/v1/metrics.proto,
// common/v1/common.proto, resource/v1/resource.proto).
//
// Like the gateway, the UsageMap stand-in answers a missing or wrong bearer token with 401 and `/v1/logs` with 404; it
// records header *names* only (plus whether the bearer matched), never logs a value.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

export type AttrValue = string | number | boolean | bigint | Uint8Array | AttrValue[] | Attrs;
export interface Attrs {
  [key: string]: AttrValue;
}

export interface Point {
  attributes: Attrs;
  startTimeUnixNano: bigint;
  timeUnixNano: bigint;
  /** histogram points */
  count?: number;
  sum?: number;
  bucketCounts?: number[];
  explicitBounds?: number[];
  /** number points */
  value?: number;
  /** exemplars: their filtered attributes (span attributes the SDK copied next to the measurement) */
  exemplars?: { filteredAttributes: Attrs; traceId: boolean }[];
}

export interface Metric {
  name: string;
  unit: string;
  kind: "gauge" | "sum" | "histogram" | "exponential_histogram" | "summary";
  /** 1 delta, 2 cumulative, 0 unspecified (gauges, summaries) */
  temporality: number;
  points: Point[];
}

export interface ScopeMetrics {
  scope: { name: string; version: string };
  metrics: Metric[];
}

export interface ResourceMetrics {
  resource: Attrs;
  scopeMetrics: ScopeMetrics[];
}

export interface Received {
  path: string;
  /** lower-case header names the request carried */
  headerNames: string[];
  /** whether `Authorization` was exactly `Bearer <expected token>` (always true without a token) */
  authorized: boolean;
  contentType: string;
  gzip: boolean;
  status: number;
  /** decompressed request body */
  body: Buffer;
  /** decoded metrics (only for `/v1/metrics` requests that decoded) */
  resourceMetrics: ResourceMetrics[];
  decodeError?: string;
}

// ---------------------------------------------------------------- protobuf wire format

interface Field {
  no: number;
  wire: number;
  /** varint (wire 0) */
  varint?: bigint;
  /** fixed64 (wire 1) / fixed32 (wire 5) raw bytes */
  fixed?: Buffer;
  /** length-delimited (wire 2) */
  bytes?: Buffer;
}

function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++] as number;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
    if (shift > 63n) throw new Error("varint too long");
  }
}

export function fields(buf: Buffer): Field[] {
  const out: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, p1] = readVarint(buf, pos);
    pos = p1;
    const no = Number(key >> 3n);
    const wire = Number(key & 7n);
    switch (wire) {
      case 0: {
        const [v, p2] = readVarint(buf, pos);
        pos = p2;
        out.push({ no, wire, varint: v });
        break;
      }
      case 1:
        if (pos + 8 > buf.length) throw new Error("truncated fixed64");
        out.push({ no, wire, fixed: buf.subarray(pos, pos + 8) });
        pos += 8;
        break;
      case 2: {
        const [len, p2] = readVarint(buf, pos);
        const end = p2 + Number(len);
        if (end > buf.length) throw new Error("truncated length-delimited field");
        out.push({ no, wire, bytes: buf.subarray(p2, end) });
        pos = end;
        break;
      }
      case 5:
        if (pos + 4 > buf.length) throw new Error("truncated fixed32");
        out.push({ no, wire, fixed: buf.subarray(pos, pos + 4) });
        pos += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wire}`);
    }
  }
  return out;
}

const str = (f: Field): string => (f.bytes ?? Buffer.alloc(0)).toString("utf8");
const u64 = (f: Field): bigint => (f.fixed ? f.fixed.readBigUInt64LE(0) : (f.varint ?? 0n));
const dbl = (f: Field): number => (f.fixed ? f.fixed.readDoubleLE(0) : 0);
const msg = (f: Field): Buffer => f.bytes ?? Buffer.alloc(0);

/** repeated fixed64/double: packed (wire 2) or not */
function repeated64(fs: Field[], no: number, as: "u64" | "double"): number[] {
  const out: number[] = [];
  for (const f of fs) {
    if (f.no !== no) continue;
    if (f.wire === 2 && f.bytes) {
      for (let i = 0; i + 8 <= f.bytes.length; i += 8)
        out.push(as === "double" ? f.bytes.readDoubleLE(i) : Number(f.bytes.readBigUInt64LE(i)));
    } else if (f.fixed) out.push(as === "double" ? dbl(f) : Number(u64(f)));
  }
  return out;
}

function anyValue(buf: Buffer): AttrValue {
  for (const f of fields(buf)) {
    switch (f.no) {
      case 1:
        return str(f);
      case 2:
        return f.varint !== 0n;
      case 3:
        return BigInt.asIntN(64, f.varint ?? 0n);
      case 4:
        return dbl(f);
      case 5:
        return fields(msg(f))
          .filter((x) => x.no === 1)
          .map((x) => anyValue(msg(x)));
      case 6:
        return keyValues(fields(msg(f)), 1);
      case 7:
        return new Uint8Array(msg(f));
    }
  }
  return "";
}

function keyValues(fs: Field[], no: number): Attrs {
  const out: Attrs = {};
  for (const f of fs) {
    if (f.no !== no) continue;
    let key = "";
    let value: AttrValue = "";
    for (const kv of fields(msg(f))) {
      if (kv.no === 1) key = str(kv);
      else if (kv.no === 2) value = anyValue(msg(kv));
    }
    out[key] = value;
  }
  return out;
}

/** Exemplar: 7 filtered_attributes, 5 trace_id (number and histogram points: field 5 / 8; exponential: 11). */
function exemplar(buf: Buffer): { filteredAttributes: Attrs; traceId: boolean } {
  const fs = fields(buf);
  return { filteredAttributes: keyValues(fs, 7), traceId: fs.some((f) => f.no === 5) };
}

function numberPoint(buf: Buffer): Point {
  const fs = fields(buf);
  const p: Point = { attributes: keyValues(fs, 7), startTimeUnixNano: 0n, timeUnixNano: 0n };
  for (const f of fs) {
    if (f.no === 2) p.startTimeUnixNano = u64(f);
    else if (f.no === 3) p.timeUnixNano = u64(f);
    else if (f.no === 4) p.value = dbl(f);
    else if (f.no === 6) p.value = Number(BigInt.asIntN(64, u64(f)));
    else if (f.no === 5 && f.wire === 2) {
      p.exemplars = p.exemplars ?? [];
      p.exemplars.push(exemplar(msg(f)));
    }
  }
  return p;
}

function histogramPoint(buf: Buffer, exponential: boolean): Point {
  const fs = fields(buf);
  const p: Point = {
    attributes: keyValues(fs, exponential ? 1 : 9),
    startTimeUnixNano: 0n,
    timeUnixNano: 0n,
  };
  for (const f of fs) {
    if (f.no === 2) p.startTimeUnixNano = u64(f);
    else if (f.no === 3) p.timeUnixNano = u64(f);
    else if (f.no === 4) p.count = Number(u64(f));
    else if (f.no === 5) p.sum = dbl(f);
    else if (f.no === (exponential ? 11 : 8) && f.wire === 2) {
      p.exemplars = p.exemplars ?? [];
      p.exemplars.push(exemplar(msg(f)));
    }
  }
  if (!exponential) {
    p.bucketCounts = repeated64(fs, 6, "u64");
    p.explicitBounds = repeated64(fs, 7, "double");
  }
  return p;
}

function metric(buf: Buffer): Metric {
  const m: Metric = { name: "", unit: "", kind: "gauge", temporality: 0, points: [] };
  for (const f of fields(buf)) {
    if (f.no === 1) m.name = str(f);
    else if (f.no === 3) m.unit = str(f);
    else if (f.no === 5 || f.no === 7 || f.no === 9 || f.no === 10 || f.no === 11) {
      m.kind = (
        {
          5: "gauge",
          7: "sum",
          9: "histogram",
          10: "exponential_histogram",
          11: "summary",
        } as const
      )[f.no];
      for (const d of fields(msg(f))) {
        if (d.no === 1) {
          if (m.kind === "gauge" || m.kind === "sum") m.points.push(numberPoint(msg(d)));
          else if (m.kind === "histogram") m.points.push(histogramPoint(msg(d), false));
          else if (m.kind === "exponential_histogram") m.points.push(histogramPoint(msg(d), true));
          else m.points.push(numberPoint(msg(d)));
        } else if (d.no === 2 && m.kind !== "gauge" && m.kind !== "summary")
          m.temporality = Number(d.varint ?? 0n);
      }
    }
  }
  return m;
}

/** Decodes an `ExportMetricsServiceRequest` (protobuf). */
export function decodeMetricsProto(buf: Buffer): ResourceMetrics[] {
  const out: ResourceMetrics[] = [];
  for (const rmf of fields(buf)) {
    if (rmf.no !== 1) continue;
    const rm: ResourceMetrics = { resource: {}, scopeMetrics: [] };
    for (const f of fields(msg(rmf))) {
      if (f.no === 1) rm.resource = keyValues(fields(msg(f)), 1);
      else if (f.no === 2) {
        const sm: ScopeMetrics = { scope: { name: "", version: "" }, metrics: [] };
        for (const g of fields(msg(f))) {
          if (g.no === 1)
            for (const s of fields(msg(g))) {
              if (s.no === 1) sm.scope.name = str(s);
              else if (s.no === 2) sm.scope.version = str(s);
            }
          else if (g.no === 2) sm.metrics.push(metric(msg(g)));
        }
        rm.scopeMetrics.push(sm);
      }
    }
    out.push(rm);
  }
  return out;
}

// ---------------------------------------------------------------- OTLP/JSON

type J = Record<string, unknown>;
const jArr = (v: unknown): J[] => (Array.isArray(v) ? (v as J[]) : []);
const jNum = (v: unknown): number => (v === undefined ? 0 : Number(v));

function jAny(v: J | undefined): AttrValue {
  if (!v) return "";
  if ("stringValue" in v) return String(v.stringValue);
  if ("boolValue" in v) return Boolean(v.boolValue);
  if ("intValue" in v) return BigInt(v.intValue as string);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("arrayValue" in v) return jArr((v.arrayValue as J).values).map(jAny);
  if ("kvlistValue" in v) return jAttrs((v.kvlistValue as J).values);
  return "";
}

function jAttrs(v: unknown): Attrs {
  const out: Attrs = {};
  for (const kv of jArr(v)) out[String(kv.key)] = jAny(kv.value as J);
  return out;
}

function jPoint(p: J): Point {
  const pt: Point = {
    attributes: jAttrs(p.attributes),
    startTimeUnixNano: BigInt((p.startTimeUnixNano as string) ?? 0),
    timeUnixNano: BigInt((p.timeUnixNano as string) ?? 0),
  };
  if ("count" in p) pt.count = jNum(p.count);
  if ("sum" in p) pt.sum = jNum(p.sum);
  if ("bucketCounts" in p) pt.bucketCounts = (p.bucketCounts as unknown[]).map(jNum);
  if ("explicitBounds" in p) pt.explicitBounds = (p.explicitBounds as unknown[]).map(jNum);
  if ("asDouble" in p) pt.value = jNum(p.asDouble);
  if ("asInt" in p) pt.value = jNum(p.asInt);
  return pt;
}

export function decodeMetricsJson(text: string): ResourceMetrics[] {
  const req = JSON.parse(text) as J;
  return jArr(req.resourceMetrics).map((rm) => ({
    resource: jAttrs((rm.resource as J | undefined)?.attributes),
    scopeMetrics: jArr(rm.scopeMetrics).map((sm) => ({
      scope: {
        name: String((sm.scope as J | undefined)?.name ?? ""),
        version: String((sm.scope as J | undefined)?.version ?? ""),
      },
      metrics: jArr(sm.metrics).map((m) => {
        const kinds = ["gauge", "sum", "histogram", "exponentialHistogram", "summary"] as const;
        const k = kinds.find((x) => x in m) ?? "gauge";
        const data = (m[k] as J) ?? {};
        return {
          name: String(m.name),
          unit: String(m.unit ?? ""),
          kind: k === "exponentialHistogram" ? "exponential_histogram" : k,
          temporality: jNum(data.aggregationTemporality),
          points: jArr(data.dataPoints).map(jPoint),
        } satisfies Metric;
      }),
    })),
  }));
}

// ---------------------------------------------------------------- server

export interface ReceiverOptions {
  /** when set, `Authorization: Bearer <token>` is required (401 otherwise), as at the gateway */
  token?: string;
  /** answer `/v1/logs` with 404, as UsageMap does */
  refuseLogs?: boolean;
  /** listen address; "0.0.0.0" when containers on the host network or a bridge must reach it */
  host?: string;
}

export interface Receiver {
  url: string;
  port: number;
  received: Received[];
  /** decoded metrics of every accepted `/v1/metrics` request */
  metrics(): ResourceMetrics[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function startReceiver(opts: ReceiverOptions = {}): Promise<Receiver> {
  const received: Received[] = [];
  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    const auth = req.headers.authorization;
    const authorized = opts.token === undefined || auth === `Bearer ${opts.token}`;
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0] as string;
    const gzip = String(req.headers["content-encoding"] ?? "").toLowerCase() === "gzip";
    let body: Buffer = Buffer.alloc(0);
    const r: Received = {
      path,
      headerNames: Object.keys(req.headers).sort(),
      authorized,
      contentType,
      gzip,
      status: 0,
      body,
      resourceMetrics: [],
    };
    const done = (status: number, payload: Buffer | string = "") => {
      r.status = status;
      received.push(r);
      res.writeHead(status, {
        "content-type":
          contentType === "application/json" ? "application/json" : "application/x-protobuf",
      });
      res.end(payload);
    };
    try {
      const raw = await readBody(req);
      body = gzip ? gunzipSync(raw) : raw;
      r.body = body;
    } catch (e) {
      r.decodeError = String(e);
      return done(400);
    }
    if (req.method !== "POST") return done(405);
    if (!authorized) return done(401);
    if (path === "/v1/logs" && opts.refuseLogs) return done(404);
    if (path === "/v1/metrics") {
      try {
        r.resourceMetrics =
          contentType === "application/json"
            ? decodeMetricsJson(body.toString("utf8"))
            : decodeMetricsProto(body);
      } catch (e) {
        r.decodeError = String(e);
        return done(400);
      }
    }
    // an empty Export*ServiceResponse: zero bytes in protobuf, `{}` in JSON
    done(200, contentType === "application/json" ? "{}" : "");
  });
  await new Promise<void>((resolve) => server.listen(0, opts.host ?? "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${opts.host && opts.host !== "0.0.0.0" ? opts.host : "127.0.0.1"}:${port}`,
    port,
    received,
    metrics: () =>
      received
        .filter((x) => x.path === "/v1/metrics" && x.status === 200)
        .flatMap((x) => x.resourceMetrics),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------- analysis

export const DURATION_METRICS = ["http.server.request.duration", "http.server.duration"];

/** Attribute keys that must never leave a tenant's process towards UsageMap (privacy invariants, CONTRIBUTING.md). */
export const FORBIDDEN_KEY = [
  /^client\.address$/,
  /^client\.port$/,
  /^network\.peer\.address$/,
  /^net\.sock\.peer\.addr$/,
  /^net\.peer\.ip$/,
  /^http\.client_ip$/,
  /^user_agent\.original$/,
  /^http\.user_agent$/,
  /^url\.query$/,
  /^url\.full$/,
  /^http\.url$/,
  /^http\.target$/,
  /^http\.request\.header\./,
  /^http\.response\.header\./,
  /^enduser\./,
];

export interface RouteStatus {
  route: string;
  status: number;
  count: number;
  sum: number;
}

/**
 * Requests per (route, status) of the HTTP server duration histogram, over every export: cumulative streams count
 * their last point (per resource instance and attribute set), delta streams are summed.
 */
export function requestsByRouteStatus(rms: ResourceMetrics[]): RouteStatus[] {
  const cumulative = new Map<
    string,
    { t: bigint; count: number; sum: number; route: string; status: number }
  >();
  const delta = new Map<string, RouteStatus>();
  for (const rm of rms) {
    const inst = JSON.stringify([rm.resource["service.name"], rm.resource["service.instance.id"]]);
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics) {
        if (!DURATION_METRICS.includes(m.name) || m.kind !== "histogram") continue;
        for (const p of m.points) {
          const route = String(p.attributes["http.route"] ?? "");
          const status = Number(
            p.attributes["http.response.status_code"] ?? p.attributes["http.status_code"] ?? 0,
          );
          const key = `${inst}|${m.name}|${route}|${status}|${JSON.stringify(
            Object.entries(p.attributes)
              .sort()
              .map(([k, v]) => [k, String(v)]),
          )}`;
          const sum = (p.sum ?? 0) * (m.unit === "ms" ? 0.001 : 1);
          if (m.temporality === 1) {
            const d = delta.get(key) ?? { route, status, count: 0, sum: 0 };
            d.count += p.count ?? 0;
            d.sum += sum;
            delta.set(key, d);
          } else {
            const prev = cumulative.get(key);
            if (!prev || p.timeUnixNano >= prev.t)
              cumulative.set(key, { t: p.timeUnixNano, count: p.count ?? 0, sum, route, status });
          }
        }
      }
  }
  const total = new Map<string, RouteStatus>();
  for (const v of [...cumulative.values(), ...delta.values()]) {
    const k = `${v.route}|${v.status}`;
    const t = total.get(k) ?? { route: v.route, status: v.status, count: 0, sum: 0 };
    t.count += v.count;
    t.sum += v.sum;
    total.set(k, t);
  }
  return [...total.values()].sort((a, b) => a.route.localeCompare(b.route) || a.status - b.status);
}

/** Every attribute key present anywhere in the exports: resource, data point, exemplar (filtered attributes). */
export function attributeKeys(rms: ResourceMetrics[]): {
  resource: Set<string>;
  point: Set<string>;
  exemplar: Set<string>;
} {
  const resource = new Set<string>();
  const point = new Set<string>();
  const exemplar = new Set<string>();
  for (const rm of rms) {
    for (const k of Object.keys(rm.resource)) resource.add(k);
    for (const sm of rm.scopeMetrics)
      for (const m of sm.metrics)
        for (const p of m.points) {
          for (const k of Object.keys(p.attributes)) point.add(k);
          for (const e of p.exemplars ?? [])
            for (const k of Object.keys(e.filteredAttributes)) exemplar.add(k);
        }
  }
  return { resource, point, exemplar };
}

export function metricNames(rms: ResourceMetrics[]): Set<string> {
  return new Set(
    rms.flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics.map((m) => m.name))),
  );
}
