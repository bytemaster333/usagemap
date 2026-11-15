// SPDX-License-Identifier: Apache-2.0
// Reusable test stack: our Umami 3.5.0 image behind the REAL engine proxy with mutual TLS (wire-formats §c.5, §j).
//
//   // in a vitest globalSetup (the info is plain JSON, so it can go through `provide`):
//   const { info, stop } = await startEngineStack({ project: "scf-wsf", proxyPort: 56141, metricsPort: 56147 });
//   info.proxyUrl                   https://127.0.0.1:<proxyPort> (server certificate SAN 127.0.0.1 / localhost)
//   info.ca                         PEM of the per-run private CA
//   info.reader / .provisioner / .edge   { cert, key } client certificates; OU = role (reader | provisioner | edge),
//                                   CN = node name (core-a-control-plane | core-a-umami-reconcile | edge-a1)
//   info.provisionerUser / .provisionerPassword   the provisioning admin created by the bootstrap (B3)
//   stop()                          `down -v` (unless KEEP=1) and removes the PKI directory
//   // in a test file:
//   const t = engineTools(info);
//   t.client(role, timeoutMs?)      an adapter HttpClient with that role's certificate
//   await t.adminToken()            P1 session token of the provisioning admin
//   await t.sendEvent(websiteId, ev)   POST /api/send with the edge certificate exactly as §c.2 (status returned)
//
// Bootstrap B1–B5 runs through the proxy with the provisioner certificate (UmamiProvisioner.ensureBootstrap); the
// proxy's gate opens on the forwarded B5. Images: SCF_UMAMI_IMAGE / SCF_UMAMI_MIGRATE_IMAGE / SCF_ENGINE_PROXY_IMAGE
// (defaults: usagemap/umami:3.5.0-d3c62a8, usagemap/umami-migrate:3.5.0-d3c62a8, scf-wsf/engine-proxy:test — built from
// services/engine-proxy when missing). Needs docker compose and openssl. Throwaway keys only (mode 0644 so the
// proxy's uid can read them inside the container).

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpClient } from "../../src/http.ts";
import { UmamiProvisioner } from "../../src/provisioning.ts";

export type Role = "reader" | "provisioner" | "edge";

export interface CertPair {
  cert: string;
  key: string;
}

export interface EngineEvent {
  /** `v` (verified) or `s` (suspect). */
  tag: "v" | "s";
  /** Event time, ms since epoch (sent as Unix seconds, the gateway's receipt time). */
  ts: number;
  /** Surrogate inside 2001:db8::/32 (§c.3). */
  surrogate: string;
  url?: string;
  country?: string;
  referrer?: string;
  name?: string;
  hostname?: string;
  screen?: string;
  language?: string;
  userAgent?: string;
  /** `track` (identified, default) or `none` (twin website). */
  visit?: "track" | "none";
}

/** Plain-JSON description of a running stack. */
export interface EngineStackInfo {
  proxyUrl: string;
  ca: string;
  reader: CertPair;
  provisioner: CertPair;
  edge: CertPair;
  provisionerUser: string;
  provisionerPassword: string;
}

export interface EngineTools {
  client(role: Role, timeoutMs?: number): HttpClient;
  adminToken(): Promise<string>;
  sendEvent(websiteId: string, ev: EngineEvent): Promise<number>;
}

export interface EngineStackOptions {
  project: string;
  proxyPort: number;
  metricsPort: number;
  /** Skip the bootstrap (tests that exercise B1–B5 themselves). */
  skipBootstrap?: boolean;
}

const COMPOSE = join(import.meta.dirname, "engine-compose.yaml");
const PROXY_SRC = join(import.meta.dirname, "../../../../services/engine-proxy");
export const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function openssl(args: string[]): void {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}

function makePki(dir: string): void {
  const p = (n: string) => join(dir, n);
  const key = (n: string) =>
    openssl(["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", p(n)]);
  key("ca-key.pem");
  openssl([
    "req",
    "-x509",
    "-new",
    "-key",
    p("ca-key.pem"),
    "-sha256",
    "-days",
    "2",
    "-subj",
    "/O=SCF test/CN=SCF test node CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-out",
    p("ca.pem"),
  ]);
  const issue = (name: string, subj: string, ext: string) => {
    key(`${name}-key.pem`);
    openssl(["req", "-new", "-key", p(`${name}-key.pem`), "-subj", subj, "-out", p(`${name}.csr`)]);
    writeFileSync(
      p(`${name}.ext`),
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n${ext}\n`,
    );
    openssl([
      "x509",
      "-req",
      "-in",
      p(`${name}.csr`),
      "-CA",
      p("ca.pem"),
      "-CAkey",
      p("ca-key.pem"),
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-days",
      "2",
      "-sha256",
      "-extfile",
      p(`${name}.ext`),
      "-out",
      p(`${name}.pem`),
    ]);
  };
  issue(
    "engine-proxy",
    "/CN=engine-proxy",
    "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:engine-proxy,DNS:localhost,IP:127.0.0.1",
  );
  issue("reader", "/OU=reader/CN=core-a-control-plane", "extendedKeyUsage=clientAuth");
  issue("provisioner", "/OU=provisioner/CN=core-a-umami-reconcile", "extendedKeyUsage=clientAuth");
  issue("edge", "/OU=edge/CN=edge-a1", "extendedKeyUsage=clientAuth");
  chmodSync(dir, 0o755);
  for (const n of ["ca", "engine-proxy", "reader", "provisioner", "edge"]) {
    chmodSync(p(`${n}.pem`), 0o644);
    if (n !== "ca") chmodSync(p(`${n}-key.pem`), 0o644);
  }
  rmSync(p("ca-key.pem"));
}

function imageExists(image: string): boolean {
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startEngineStack(
  opts: EngineStackOptions,
): Promise<{ info: EngineStackInfo; stop: () => Promise<void> }> {
  const proxyImage = process.env.SCF_ENGINE_PROXY_IMAGE ?? "scf-wsf/engine-proxy:test";
  if (!imageExists(proxyImage)) {
    execFileSync("docker", ["build", "-q", "-t", proxyImage, PROXY_SRC], { stdio: "inherit" });
  }
  const dir = mkdtempSync(join(tmpdir(), "scf-eng-pki-"));
  makePki(dir);
  const env = {
    ...process.env,
    ENG_PG_PASSWORD: randomBytes(16).toString("hex"),
    ENG_APP_SECRET: randomBytes(32).toString("hex"),
    ENG_PKI_DIR: dir,
    ENG_PROXY_PORT: String(opts.proxyPort),
    ENG_METRICS_PORT: String(opts.metricsPort),
    ENG_PROXY_IMAGE: proxyImage,
    ...(process.env.SCF_UMAMI_IMAGE ? { ENG_UMAMI_IMAGE: process.env.SCF_UMAMI_IMAGE } : {}),
    ...(process.env.SCF_UMAMI_MIGRATE_IMAGE
      ? { ENG_UMAMI_MIGRATE_IMAGE: process.env.SCF_UMAMI_MIGRATE_IMAGE }
      : {}),
  };
  const dc = (args: string[]) =>
    execFileSync("docker", ["compose", "-p", opts.project, "-f", COMPOSE, ...args], {
      stdio: ["ignore", "ignore", "inherit"],
      env,
    });
  dc(["down", "-v", "--remove-orphans"]);
  try {
    dc(["up", "-d", "--wait", "--wait-timeout", "150", "umami"]);
  } catch {
    // A slow first start under load: one restart of the engine before giving up.
    dc(["restart", "umami"]);
    dc(["up", "-d", "--wait", "--wait-timeout", "150", "umami"]);
  }
  dc(["up", "-d", "engine-proxy"]);

  const read = (n: string) => readFileSync(join(dir, n), "utf8");
  const pair = (n: string): CertPair => ({ cert: read(`${n}.pem`), key: read(`${n}-key.pem`) });
  const info: EngineStackInfo = {
    proxyUrl: `https://127.0.0.1:${opts.proxyPort}`,
    ca: read("ca.pem"),
    reader: pair("reader"),
    provisioner: pair("provisioner"),
    edge: pair("edge"),
    provisionerUser: "scf-provisioner",
    provisionerPassword: randomBytes(24).toString("base64url"),
  };
  const stop = async () => {
    if (process.env.KEEP !== "1") dc(["down", "-v", "--remove-orphans"]);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const tools = engineTools(info);
    // The proxy answers the provisioner (heartbeat) while its gate is still closed.
    const prov = tools.client("provisioner");
    for (let i = 0; ; i++) {
      try {
        const r = await prov.call({
          method: "GET",
          path: "/api/heartbeat",
          template: "/api/heartbeat",
        });
        if (r.status === 200) break;
      } catch {
        // not listening yet
      }
      if (i > 120) throw new Error("engine proxy did not become ready");
      await sleep(500);
    }
    if (!opts.skipBootstrap) {
      await new UmamiProvisioner(prov).ensureBootstrap({
        seedInterimPassword: randomBytes(18).toString("base64url"),
        provisioningUsername: info.provisionerUser,
        provisioningPassword: info.provisionerPassword,
      });
      await waitForGate(tools);
    }
  } catch (err) {
    await stop();
    throw err;
  }
  return { info, stop };
}

/** Waits until a non-provisioning caller gets through (the proxy's gate opened on B5). */
export async function waitForGate(tools: EngineTools): Promise<void> {
  const rd = tools.client("reader");
  for (let i = 0; ; i++) {
    const r = await rd.call({ method: "GET", path: "/api/heartbeat", template: "/api/heartbeat" });
    if (r.status === 200) return;
    if (i > 80) throw new Error("engine proxy gate did not open after B5");
    await sleep(250);
  }
}

export function engineTools(info: EngineStackInfo): EngineTools {
  const client = (role: Role, timeoutMs = 15_000) =>
    new HttpClient({ baseUrl: info.proxyUrl, tls: { ...info[role], ca: info.ca }, timeoutMs });
  const sendEvent = (websiteId: string, ev: EngineEvent): Promise<number> =>
    new Promise((resolve, reject) => {
      const body = Buffer.from(
        JSON.stringify({
          type: "event",
          payload: {
            website: websiteId,
            hostname: ev.hostname ?? "app.example.org",
            url: ev.url ?? "/",
            ...(ev.referrer ? { referrer: ev.referrer } : {}),
            screen: ev.screen ?? "1536x864",
            language: ev.language ?? "en",
            ...(ev.name ? { name: ev.name } : {}),
            tag: ev.tag,
            timestamp: Math.floor(ev.ts / 1000),
          },
        }),
      );
      const req = request(
        `${info.proxyUrl}/api/send`,
        {
          method: "POST",
          cert: info.edge.cert,
          key: info.edge.key,
          ca: info.ca,
          agent: false,
          headers: {
            "content-type": "application/json",
            "content-length": String(body.length),
            "user-agent": ev.userAgent ?? CHROME_WIN,
            "x-scf-surrogate-ip": ev.surrogate,
            "cf-ipcountry": ev.country ?? "DE",
            "x-scf-visit": ev.visit ?? "track",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  return {
    client,
    sendEvent,
    async adminToken() {
      const t = await new UmamiProvisioner(client("provisioner")).login(
        info.provisionerUser,
        info.provisionerPassword,
      );
      if (!t) throw new Error("provisioning admin cannot log in");
      return t;
    },
  };
}
