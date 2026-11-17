// SPDX-License-Identifier: Apache-2.0
// The small part of Stellar's wire formats the jobs need, without an SDK (standard library only):
//   - StrKey (SEP-23) for account ids (G…, version 6<<3), contract ids (C…, 2<<3) and secret seeds (S…, 18<<3);
//   - the contract-id derivation of CAP-46 (HashIDPreimage ENVELOPE_TYPE_CONTRACT_ID with CONTRACT_ID_PREIMAGE_FROM_ADDRESS);
//   - LedgerKey CONTRACT_DATA for a contract's instance entry (Stellar RPC getLedgerEntries);
//   - a reader for SCVal / LedgerEntryData (Stellar-contract.x, Stellar-ledger-entries.x, protocol 23) that walks a
//     contract instance's storage map — enough to find an `Admin` entry.
// Every decoder is bounded: unknown union arms and over-long lengths throw `XdrError`, never loop or allocate freely.

import { createHash } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const VERSION = { account: 6 << 3, seed: 18 << 3, contract: 2 << 3 } as const;

export class XdrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XdrError";
  }
}

export function crc16xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new XdrError("invalid base32");
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function base32Encode(b: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of b) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes a 56-character StrKey of the given version to its 32-byte payload; throws on any mismatch. */
export function strkeyDecode(s: string, version: number): Buffer {
  if (!/^[A-Z2-7]{56}$/.test(s)) throw new XdrError("not a strkey");
  const raw = base32Decode(s);
  if (raw.length !== 35 || raw[0] !== version) throw new XdrError("wrong strkey version");
  if (crc16xmodem(raw.subarray(0, 33)) !== raw.readUInt16LE(33))
    throw new XdrError("bad strkey checksum");
  return Buffer.from(raw.subarray(1, 33));
}

export function strkeyEncode(payload: Uint8Array, version: number): string {
  if (payload.length !== 32) throw new XdrError("payload must be 32 bytes");
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const crc = Buffer.alloc(2);
  crc.writeUInt16LE(crc16xmodem(body));
  return base32Encode(Buffer.concat([body, crc]));
}

export const NETWORK_PASSPHRASE = {
  public: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
} as const;

export function networkId(network: keyof typeof NETWORK_PASSPHRASE): Buffer {
  return createHash("sha256").update(NETWORK_PASSPHRASE[network], "utf8").digest();
}

const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};

/** Parses a 256-bit salt as Horizon prints it (decimal) or as 64 hex digits. */
export function parseSalt(s: string): Buffer {
  let n: bigint;
  if (/^[0-9]{1,78}$/.test(s)) n = BigInt(s);
  else if (/^[0-9a-f]{64}$/i.test(s)) n = BigInt(`0x${s}`);
  else throw new XdrError("salt is neither decimal nor 64 hex digits");
  if (n >= 1n << 256n) throw new XdrError("salt out of range");
  return Buffer.from(n.toString(16).padStart(64, "0"), "hex");
}

/**
 * CAP-46 contract id of a contract created by `deployer` (an account) with `salt`:
 * sha256(XDR HashIDPreimage{ENVELOPE_TYPE_CONTRACT_ID=8, networkID, CONTRACT_ID_PREIMAGE_FROM_ADDRESS=0,
 * SCAddress{SC_ADDRESS_TYPE_ACCOUNT=0, PublicKey{PUBLIC_KEY_TYPE_ED25519=0, key}}, salt}).
 */
export function contractIdFromAccount(
  network: keyof typeof NETWORK_PASSPHRASE,
  deployer: string,
  salt: Buffer,
): string {
  if (salt.length !== 32) throw new XdrError("salt must be 32 bytes");
  const pre = Buffer.concat([
    int32(8),
    networkId(network),
    int32(0),
    int32(0),
    int32(0),
    strkeyDecode(deployer, VERSION.account),
    salt,
  ]);
  return strkeyEncode(createHash("sha256").update(pre).digest(), VERSION.contract);
}

/** base64 XDR LedgerKey{CONTRACT_DATA=6, SCAddress{CONTRACT=1, id}, SCV_LEDGER_KEY_CONTRACT_INSTANCE=20, PERSISTENT=1}. */
export function contractInstanceKey(contractId: string): string {
  return Buffer.concat([
    int32(6),
    int32(1),
    strkeyDecode(contractId, VERSION.contract),
    int32(20),
    int32(1),
  ]).toString("base64");
}

// ------------------------------------------------------------------------------------------------- reader

export type ScVal =
  | { t: "bool"; v: boolean }
  | { t: "void" }
  | { t: "num"; v: bigint }
  | { t: "bytes"; v: Buffer }
  | { t: "string"; v: string }
  | { t: "symbol"; v: string }
  | { t: "vec"; v: ScVal[] | null }
  | { t: "map"; v: Array<[ScVal, ScVal]> | null }
  | { t: "address"; kind: "account" | "contract" | "other"; id: string | null }
  | { t: "instance"; storage: Array<[ScVal, ScVal]> | null }
  | { t: "other" };

const MAX_LEN = 1 << 20;
const MAX_DEPTH = 32;

class Reader {
  #b: Buffer;
  #o = 0;
  constructor(b: Buffer) {
    this.#b = b;
  }
  need(n: number): void {
    if (n < 0 || this.#o + n > this.#b.length) throw new XdrError("truncated xdr");
  }
  i32(): number {
    this.need(4);
    const v = this.#b.readInt32BE(this.#o);
    this.#o += 4;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.#b.readUInt32BE(this.#o);
    this.#o += 4;
    return v;
  }
  fixed(n: number): Buffer {
    this.need(n);
    const v = this.#b.subarray(this.#o, this.#o + n);
    this.#o += n;
    return Buffer.from(v);
  }
  opaque(): Buffer {
    const n = this.u32();
    if (n > MAX_LEN) throw new XdrError("xdr length too large");
    const v = this.fixed(n);
    this.fixed((4 - (n % 4)) % 4);
    return v;
  }
  bigFixed(n: number, signed: boolean): bigint {
    const b = this.fixed(n);
    let v = BigInt(`0x${b.toString("hex") || "0"}`);
    if (signed && b.length > 0 && ((b[0] as number) & 0x80) !== 0) v -= 1n << BigInt(n * 8);
    return v;
  }
  get done(): boolean {
    return this.#o === this.#b.length;
  }
}

function readAddress(r: Reader): ScVal {
  const type = r.i32();
  switch (type) {
    case 0: {
      if (r.i32() !== 0) throw new XdrError("unknown public key type");
      return { t: "address", kind: "account", id: strkeyEncode(r.fixed(32), VERSION.account) };
    }
    case 1:
      return { t: "address", kind: "contract", id: strkeyEncode(r.fixed(32), VERSION.contract) };
    case 2: // muxed account: uint64 id + ed25519
      r.fixed(8 + 32);
      return { t: "address", kind: "other", id: null };
    case 3: // claimable balance id: type + hash
      r.i32();
      r.fixed(32);
      return { t: "address", kind: "other", id: null };
    case 4: // liquidity pool id
      r.fixed(32);
      return { t: "address", kind: "other", id: null };
    default:
      throw new XdrError("unknown SCAddress type");
  }
}

function readMap(r: Reader, depth: number): Array<[ScVal, ScVal]> {
  const n = r.u32();
  if (n > 100_000) throw new XdrError("map too large");
  const out: Array<[ScVal, ScVal]> = [];
  for (let i = 0; i < n; i++) out.push([readScVal(r, depth + 1), readScVal(r, depth + 1)]);
  return out;
}

export function readScVal(r: Reader, depth = 0): ScVal {
  if (depth > MAX_DEPTH) throw new XdrError("xdr nesting too deep");
  const type = r.i32();
  switch (type) {
    case 0:
      return { t: "bool", v: r.i32() !== 0 };
    case 1:
      return { t: "void" };
    case 2: // SCError: type + code
      r.i32();
      r.i32();
      return { t: "other" };
    case 3:
      return { t: "num", v: BigInt(r.u32()) };
    case 4:
      return { t: "num", v: BigInt(r.i32()) };
    case 5:
    case 7:
    case 8:
      return { t: "num", v: r.bigFixed(8, false) };
    case 6:
      return { t: "num", v: r.bigFixed(8, true) };
    case 9:
      return { t: "num", v: r.bigFixed(16, false) };
    case 10:
      return { t: "num", v: r.bigFixed(16, true) };
    case 11:
      return { t: "num", v: r.bigFixed(32, false) };
    case 12:
      return { t: "num", v: r.bigFixed(32, true) };
    case 13:
      return { t: "bytes", v: r.opaque() };
    case 14:
      return { t: "string", v: r.opaque().toString("utf8") };
    case 15:
      return { t: "symbol", v: r.opaque().toString("latin1") };
    case 16: {
      if (r.i32() === 0) return { t: "vec", v: null };
      const n = r.u32();
      if (n > 100_000) throw new XdrError("vec too large");
      const v: ScVal[] = [];
      for (let i = 0; i < n; i++) v.push(readScVal(r, depth + 1));
      return { t: "vec", v };
    }
    case 17:
      return { t: "map", v: r.i32() === 0 ? null : readMap(r, depth) };
    case 18:
      return readAddress(r);
    case 19: {
      const exec = r.i32();
      if (exec === 0) r.fixed(32);
      else if (exec !== 1) throw new XdrError("unknown contract executable");
      return { t: "instance", storage: r.i32() === 0 ? null : readMap(r, depth) };
    }
    case 20:
      return { t: "void" };
    case 21:
      r.fixed(8);
      return { t: "other" };
    default:
      throw new XdrError("unknown SCVal type");
  }
}

/** Reads a LedgerEntryData of type CONTRACT_DATA and returns its value (the instance for an instance key). */
export function readContractDataEntry(b64: string): ScVal {
  const r = new Reader(Buffer.from(b64, "base64"));
  if (r.i32() !== 6) throw new XdrError("not a CONTRACT_DATA entry");
  if (r.i32() !== 0) throw new XdrError("unknown extension");
  readAddress(r);
  readScVal(r);
  r.i32(); // durability
  const val = readScVal(r);
  if (!r.done) throw new XdrError("trailing bytes");
  return val;
}

/** True for the usual spellings of an admin key: Symbol("Admin"|"admin"|"ADMIN") or Vec[Symbol(…)] (an enum variant). */
export function isAdminKey(k: ScVal): boolean {
  const sym = (v: ScVal) => v.t === "symbol" && v.v.toLowerCase() === "admin";
  if (sym(k)) return true;
  return k.t === "vec" && k.v !== null && k.v.length === 1 && sym(k.v[0] as ScVal);
}

/** The account admin stored in a contract instance's storage, if exactly one account is found under admin keys. */
export function instanceAdmin(v: ScVal): string | null {
  if (v.t !== "instance" || !v.storage) return null;
  const admins = v.storage
    .filter(([k, val]) => isAdminKey(k) && val.t === "address" && val.kind === "account")
    .map(([, val]) => (val as { id: string }).id);
  return admins.length === 1 ? (admins[0] as string) : null;
}

export { Reader as XdrReader };
