// SPDX-License-Identifier: Apache-2.0
// stellar-scaffold-usagemap: a Scaffold Stellar extension (protocol: the
// "Extensions" page of the Scaffold Stellar docs, stellar-scaffold/cli @
// 9edb742). Scaffold runs `stellar-scaffold-usagemap manifest`, then
// `stellar-scaffold-usagemap post-deploy` once per deployed contract with one
// JSON object on stdin. A non-zero exit is logged by Scaffold and never aborts
// the build.
//
// post-deploy:
//   1. records the project's own contract (network, name, contract id, wasm
//      hash) in .usagemap/contracts.json;
//   2. registers it with UsageMap's Registered Footprint (status "claimed"
//      until the project proves ownership on the portal), but only when
//      extensions.usagemap.register is true (or USAGEMAP_REGISTER=1) AND a
//      footprint registration key is set (SCF_FOOTPRINT_KEY, or its alias
//      USAGEMAP_FOOTPRINT_KEY). Otherwise it is a dry run that prints the
//      request it would send. It never sends anything without the key.
//
// The key is a `scfa_reg_…` footprint registration key from the portal
// (Register your Stellar contracts → Registration keys): scope
// `footprint:register` only, one project, optionally one network. It can add
// `claimed` contracts and nothing else — it never verifies, removes or reads.
//
// It never reads identities, accounts or keys of the Stellar CLI, and it
// never sends the RPC URL, the network passphrase or any local path.
// Plain Node ≥ 18 ESM, no dependencies: it runs on the developer's machine.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const NAME = "usagemap";
export const VERSION = "0.1.0";
export const DEFAULT_API = "https://app.usagemap.dev";
export const FILE_SCHEMA = "usagemap-contracts/1";

const PASSPHRASES = {
  "Test SDF Network ; September 2015": "testnet",
  "Public Global Stellar Network ; September 2015": "mainnet",
};
const NETWORK_NAMES = {
  testnet: "testnet",
  mainnet: "mainnet",
  public: "mainnet",
  pubnet: "mainnet",
};
const WASM_HASH = /^[0-9a-f]{64}$/;
const KEY = /^scfa_reg_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// --- strict StrKey check for contract ids (SEP-23: version byte 2<<3, CRC16-XModem) ---
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** True only for a strictly valid contract StrKey (C…, 56 characters, checksum ok). */
export function isContractId(s) {
  if (typeof s !== "string" || !/^C[A-Z2-7]{55}$/.test(s)) return false;
  const raw = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    acc = ((acc << 5) | B32.indexOf(ch)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      raw.push((acc >> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return false;
  if (raw.length !== 35 || raw[0] !== 2 << 3) return false;
  const crc = crc16(raw.slice(0, 33));
  return raw[33] === (crc & 0xff) && raw[34] === crc >> 8;
}

export function manifest() {
  return { name: NAME, version: VERSION, hooks: ["post-deploy"] };
}

/** The UsageMap network of a deployment: by passphrase first (custom networks that extend testnet share it), then by name. */
export function networkOf(ctx) {
  const pass = ctx?.network?.network_passphrase;
  if (typeof pass === "string" && Object.hasOwn(PASSPHRASES, pass)) return PASSPHRASES[pass];
  const name = ctx?.network?.network_name ?? ctx?.env;
  if (typeof name === "string" && Object.hasOwn(NETWORK_NAMES, name)) return NETWORK_NAMES[name];
  return undefined;
}

/**
 * Pure core of post-deploy. Returns { skip } or { file, entry }: the new
 * contents of the contracts file and the entry for this deployment.
 */
export function postDeploy(ctx, existing) {
  const cfg = ctx?.config ?? {};
  const networks = Array.isArray(cfg.networks) ? cfg.networks : ["testnet", "mainnet"];
  const network = networkOf(ctx);
  if (!network)
    return { skip: "not testnet or mainnet (local and custom networks are not registered)" };
  if (!networks.includes(network))
    return { skip: `${network} is not in extensions.usagemap.networks` };
  if (!isContractId(ctx.contract_id)) return { skip: "no valid contract id" };
  const contract =
    String(ctx.contract_name ?? "")
      .replace(/[^\w.-]/g, "")
      .slice(0, 64) || "contract";
  const entry = { network, contract, contract_id: ctx.contract_id };
  if (WASM_HASH.test(ctx.wasm_hash ?? "")) entry.wasm_hash = ctx.wasm_hash;
  const list = Array.isArray(existing?.contracts) ? existing.contracts : [];
  const rest = list.filter(
    (c) => !(c?.network === entry.network && c?.contract === entry.contract),
  );
  return { file: { schema: FILE_SCHEMA, contracts: [...rest, entry] }, entry };
}

/** The contracts file path, which must stay inside the project. */
export function outPath(ctx) {
  const root = resolve(ctx?.project_root ?? ".");
  const p = resolve(root, ctx?.config?.out ?? ".usagemap/contracts.json");
  const rel = relative(root, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("extensions.usagemap.out must be a file inside the project");
  }
  return p;
}

/** Registration settings from the extension config and the environment. Never logs the key. */
export function registration(cfg, env) {
  const register = cfg?.register === true || env.USAGEMAP_REGISTER === "1";
  const key = (env.SCF_FOOTPRINT_KEY ?? env.USAGEMAP_FOOTPRINT_KEY)?.trim() || undefined;
  const tenant = (env.USAGEMAP_TENANT_ID ?? cfg?.tenant_id)?.trim() || undefined;
  const api = (env.USAGEMAP_API_URL ?? cfg?.api_url ?? DEFAULT_API).replace(/\/+$/, "");
  const problems = [];
  if (key && !KEY.test(key))
    problems.push(
      "SCF_FOOTPRINT_KEY does not look like a footprint registration key (scfa_reg_…, from the portal)",
    );
  if (tenant && !UUID.test(tenant))
    problems.push("USAGEMAP_TENANT_ID must be the project's id (a UUID)");
  let url;
  try {
    url = new URL(api);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
      problems.push("USAGEMAP_API_URL must use https");
    }
    if (url.search || url.hash || url.username || url.password)
      problems.push("USAGEMAP_API_URL must be a plain base URL");
  } catch {
    problems.push("USAGEMAP_API_URL is not a URL");
  }
  return { register, key, tenant, api, problems };
}

/** The one request post-deploy may send (registerFootprintContract, docs/api/control-plane.openapi.yaml). */
export function footprintRequest(reg, entry) {
  return {
    method: "POST",
    url: `${reg.api}/v1/tenants/${reg.tenant ?? "<USAGEMAP_TENANT_ID>"}/footprint/register`,
    body: {
      kind: "contract",
      subject: entry.contract_id,
      network: entry.network,
      label: entry.contract,
    },
  };
}

function writeAtomic(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = join(dirname(p), `.contracts.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, p);
}

async function send(req, key, fetchImpl, timeoutMs) {
  const res = await fetchImpl(req.url, {
    method: req.method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(req.body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  let detail = "";
  try {
    const j = await res.json();
    const text = typeof j?.detail === "string" ? j.detail : j?.title;
    detail = typeof text === "string" ? text.replace(/[^\x20-\x7e]/g, "").slice(0, 200) : "";
  } catch {
    // not JSON
  }
  return { status: res.status, detail };
}

/**
 * Run one hook. io = { stdin: string, env, out(line), err(line), fetch }.
 * Returns the process exit code.
 */
export async function run(argv, io) {
  const [hook] = argv;
  if (hook === "manifest") {
    io.out(JSON.stringify(manifest()));
    return 0;
  }
  if (hook !== "post-deploy") {
    io.err(`usagemap: unsupported hook ${hook ?? "(none)"}`);
    return 2;
  }
  let ctx;
  try {
    ctx = JSON.parse(io.stdin);
  } catch {
    io.err("usagemap: post-deploy expects one JSON object on stdin");
    return 2;
  }
  const p = outPath(ctx);
  let existing;
  try {
    existing = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    existing = undefined;
  }
  const r = postDeploy(ctx, existing);
  if (!r.file) {
    io.out(`usagemap: skipped (${r.skip})`);
    return 0;
  }
  writeAtomic(p, r.file);
  const root = resolve(ctx.project_root ?? ".");
  io.out(`usagemap: recorded ${r.entry.contract} on ${r.entry.network} in ${relative(root, p)}`);

  const reg = registration(ctx.config, io.env);
  const req = footprintRequest(reg, r.entry);
  if (reg.problems.length > 0) {
    for (const m of reg.problems) io.err(`usagemap: ${m}`);
    return 1;
  }
  if (!reg.register || !reg.key || !reg.tenant) {
    const why = !reg.key
      ? "no SCF_FOOTPRINT_KEY"
      : !reg.tenant
        ? "no USAGEMAP_TENANT_ID"
        : "extensions.usagemap.register is not true";
    io.out(`usagemap: dry run (${why}); nothing was sent. It would send:`);
    io.out(`usagemap:   ${req.method} ${req.url}`);
    io.out(`usagemap:   ${JSON.stringify(req.body)}`);
    io.out('usagemap: or add it on the portal page "Register your Stellar contracts".');
    return 0;
  }
  let res;
  try {
    res = await send(req, reg.key, io.fetch ?? globalThis.fetch, 10_000);
  } catch (e) {
    io.err(
      `usagemap: registration failed (${e?.name === "TimeoutError" ? "timeout" : "network error"}); the contract is recorded locally`,
    );
    return 1;
  }
  switch (res.status) {
    case 201:
      io.out(
        `usagemap: registered ${r.entry.contract_id.slice(0, 6)}… as claimed; prove ownership on the portal to verify it`,
      );
      return 0;
    case 409:
      io.out("usagemap: already registered for this project");
      return 0;
    case 401:
      io.err(
        `usagemap: the key was refused (HTTP 401${res.detail ? `: ${res.detail}` : ""}); check SCF_FOOTPRINT_KEY (revoked or expired keys stop working)`,
      );
      return 1;
    case 403:
      io.err(
        `usagemap: the key may not register this contract (HTTP 403${res.detail ? `: ${res.detail}` : ""}); is the key bound to another network?`,
      );
      return 1;
    case 404:
      io.err(
        "usagemap: the key does not belong to USAGEMAP_TENANT_ID (HTTP 404); copy the project id shown next to the key on the portal",
      );
      return 1;
    case 429:
      io.err(
        "usagemap: rate limited (HTTP 429); the contract is recorded locally, deploy again later",
      );
      return 1;
    default:
      io.err(
        `usagemap: registration answered HTTP ${res.status}${res.detail ? `: ${res.detail}` : ""}`,
      );
      return 1;
  }
}
