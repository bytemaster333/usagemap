// SPDX-License-Identifier: Apache-2.0
// The seal transaction (wire-formats §m.2): exact XDR layout of one BUMP_SEQUENCE(bumpTo 0) operation with
// MEMO_HASH(root) and 5-minute time bounds, a valid Ed25519 signature over sha256(networkId ‖ ENVELOPE_TYPE_TX ‖ tx),
// the transaction hash Horizon reports, the submission decision table, and the seal configuration (testnet default,
// mainnet only with approval, the key only from a file). Plus the optional live check on Stellar testnet
// (SCF_SEAL_LIVE=1): fund a throwaway key through friendbot, submit one seal and read it back.

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.ts";
import { submissionAction } from "../../src/seal/daily-seal.ts";
import { HorizonSealLedger } from "../../src/seal/horizon.ts";
import {
  decodeSealEnvelope,
  keypairFromSeed,
  networkIdOf,
  sealTransaction,
  signEnvelope,
  transactionHash,
} from "../../src/stellar/tx.ts";
import { strkeyEncode, VERSION } from "../../src/stellar/xdr.ts";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

describe("seal transaction", () => {
  const kp = keypairFromSeed(strkeyEncode(randomBytes(32), VERSION.seed));
  const root = createHash("sha256").update("root").digest();
  const tx = sealTransaction({
    source: kp.publicKey,
    sequence: 4243n,
    fee: 100,
    memoHash: root,
    minTime: 0n,
    maxTime: 1_800_000_000n,
  });

  it("encodes BUMP_SEQUENCE(0) with MEMO_HASH and time bounds, byte for byte", () => {
    const want = Buffer.concat([
      Buffer.from("00000000", "hex"), // KEY_TYPE_ED25519
      kp.publicKey,
      Buffer.from("00000064", "hex"), // fee 100
      Buffer.from("0000000000001093", "hex"), // seq 4243
      Buffer.from("00000001", "hex"), // PRECOND_TIME
      Buffer.from("0000000000000000", "hex"),
      Buffer.from("000000006b49d200", "hex"), // 1,800,000,000
      Buffer.from("00000003", "hex"), // MEMO_HASH
      root,
      Buffer.from("00000001", "hex"), // one op
      Buffer.from("00000000", "hex"), // no op source
      Buffer.from("0000000b", "hex"), // BUMP_SEQUENCE
      Buffer.from("0000000000000000", "hex"), // bumpTo 0
      Buffer.from("00000000", "hex"), // ext
    ]);
    expect(tx.equals(want)).toBe(true);
  });

  it("signs over sha256(networkId ‖ ENVELOPE_TYPE_TX ‖ tx) and decodes strictly", () => {
    const id = networkIdOf(TESTNET);
    expect(id.toString("hex")).toBe(createHash("sha256").update(TESTNET).digest("hex"));
    const env = signEnvelope(id, tx, kp);
    const d = decodeSealEnvelope(env);
    expect(d).toMatchObject({
      source: kp.account,
      fee: 100,
      sequence: 4243n,
      bumpTo: 0n,
      maxTime: 1_800_000_000n,
    });
    expect(d.memoHash.equals(root)).toBe(true);
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), kp.publicKey]),
      format: "der",
      type: "spki",
    });
    expect(verify(null, transactionHash(id, tx), key, d.signature)).toBe(true);
    // Signed for another network: the signature does not verify on testnet.
    const other = decodeSealEnvelope(
      signEnvelope(networkIdOf("Public Global Stellar Network ; September 2015"), tx, kp),
    );
    expect(verify(null, transactionHash(id, tx), key, other.signature)).toBe(false);
    expect(() => decodeSealEnvelope(Buffer.from("garbage").toString("base64"))).toThrow();
  });

  it("refuses wrong sizes and fees", () => {
    expect(() =>
      sealTransaction({
        source: kp.publicKey,
        sequence: 1n,
        fee: 99,
        memoHash: root,
        minTime: 0n,
        maxTime: 1n,
      }),
    ).toThrow();
    expect(() =>
      sealTransaction({
        source: kp.publicKey,
        sequence: 1n,
        fee: 100,
        memoHash: Buffer.alloc(31),
        minTime: 0n,
        maxTime: 1n,
      }),
    ).toThrow();
  });
});

describe("seal submission decisions", () => {
  const row = (o: Partial<Parameters<typeof submissionAction>[0]>) => ({
    status: "built" as const,
    tx_hash: null,
    submitted_expired: true,
    built_expired: false,
    ...o,
  });
  it("submits built days, looks up submitted ones, fails a day after 24 hours", () => {
    expect(submissionAction(row({}), "testnet")).toBe("submit");
    expect(
      submissionAction(row({ status: "submitted", tx_hash: Buffer.alloc(32) }), "testnet"),
    ).toBe("lookup");
    expect(submissionAction(row({ built_expired: true }), "testnet")).toBe("fail");
    expect(
      submissionAction(row({ built_expired: true, tx_hash: Buffer.alloc(32) }), "testnet"),
    ).toBe("lookup");
    expect(submissionAction(row({ status: "confirmed" }), "testnet")).toBe("skip");
    expect(submissionAction(row({ status: "network_reset" }), "testnet")).toBe("skip");
  });
  it("leaves a failed testnet day failed, resubmits a failed mainnet day", () => {
    expect(submissionAction(row({ status: "failed" }), "testnet")).toBe("skip");
    expect(submissionAction(row({ status: "failed" }), "mainnet")).toBe("submit");
    expect(submissionAction(row({ status: "failed", tx_hash: Buffer.alloc(32) }), "mainnet")).toBe(
      "lookup",
    );
  });
});

describe("seal configuration", () => {
  const base = {
    SCF_JOBS_DATABASE_URL: "postgres://scf_jobs@pgbouncer:6432/scf",
    SCF_UMAMI_RO_URL: "postgres://scf_umami_ro@pgbouncer:6432/umami",
    SCF_UMAMI_MAINT_URL: "postgres://scf_umami_maint@pgbouncer:6432/umami",
  };
  it("defaults to testnet with friendbot and needs the anchor directory", () => {
    const c = loadConfig({
      ...base,
      SCF_SEAL_HORIZON_URL: "https://horizon-testnet.stellar.org",
      SCF_AUDIT_ANCHOR_DIR: "/var/lib/scf/evidence",
    });
    expect(c.enabled).toContain("daily_seal");
    expect(c.seal).toMatchObject({
      network: "testnet",
      passphrase: TESTNET,
      friendbotUrl: "https://friendbot.stellar.org",
      secretSeed: null,
      dailyAt: { hour: 0, minute: 30 },
      feeStroops: 100,
    });
    expect(loadConfig({ ...base, SCF_SEAL_HORIZON_URL: "https://h" }).disabled).toContainEqual({
      job: "daily_seal",
      missing: "SCF_AUDIT_ANCHOR_DIR",
    });
    expect(loadConfig(base).disabled).toContainEqual({
      job: "daily_seal",
      missing: "SCF_SEAL_HORIZON_URL",
    });
  });
  it("reads the key only from a file, and refuses mainnet without approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "seal-cfg-"));
    try {
      const seed = strkeyEncode(randomBytes(32), VERSION.seed);
      writeFileSync(join(dir, "seed"), `${seed}\n`);
      const env = {
        ...base,
        SCF_SEAL_HORIZON_URL: "https://horizon.stellar.org",
        SCF_AUDIT_ANCHOR_DIR: "/x",
        SCF_SEAL_SECRET_FILE: join(dir, "seed"),
      };
      expect(loadConfig(env).seal?.secretSeed).toBe(seed);
      expect(() => loadConfig({ ...env, SCF_SEAL_NETWORK: "mainnet" })).toThrow(/APPROVED/);
      const m = loadConfig({ ...env, SCF_SEAL_NETWORK: "mainnet", SCF_SEAL_MAINNET_APPROVED: "1" });
      expect(m.seal).toMatchObject({ network: "mainnet", friendbotUrl: null });
      expect(() =>
        loadConfig({
          ...env,
          SCF_SEAL_NETWORK: "mainnet",
          SCF_SEAL_MAINNET_APPROVED: "1",
          SCF_SEAL_FRIENDBOT_URL: "https://friendbot.stellar.org",
        }),
      ).toThrow(ConfigError);
      writeFileSync(join(dir, "bad"), "GABC");
      expect(() => loadConfig({ ...env, SCF_SEAL_SECRET_FILE: join(dir, "bad") })).toThrow(
        /secret seed/,
      );
      expect(() => loadConfig({ ...env, SCF_SEAL_NETWORK: "futurenet" })).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("derives the network from the passphrase: no mainnet without approval, no mismatch, https only", () => {
    const env = {
      ...base,
      SCF_SEAL_HORIZON_URL: "https://horizon.stellar.org",
      SCF_AUDIT_ANCHOR_DIR: "/x",
    };
    // the bypass: network left at its default (testnet) with the mainnet passphrase
    expect(() => loadConfig({ ...env, SCF_SEAL_NETWORK_PASSPHRASE: MAINNET })).toThrow(/APPROVED/);
    expect(() =>
      loadConfig({ ...env, SCF_SEAL_NETWORK: "testnet", SCF_SEAL_NETWORK_PASSPHRASE: MAINNET }),
    ).toThrow(/does not match/);
    expect(() =>
      loadConfig({
        ...env,
        SCF_SEAL_NETWORK: "mainnet",
        SCF_SEAL_MAINNET_APPROVED: "1",
        SCF_SEAL_NETWORK_PASSPHRASE: TESTNET,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      loadConfig({ ...env, SCF_SEAL_NETWORK_PASSPHRASE: "Standalone Network ; February 2017" }),
    ).toThrow(ConfigError);
    // approved and consistent: mainnet, derived from the passphrase alone
    const m = loadConfig({
      ...env,
      SCF_SEAL_NETWORK_PASSPHRASE: MAINNET,
      SCF_SEAL_MAINNET_APPROVED: "1",
    });
    expect(m.seal).toMatchObject({ network: "mainnet", passphrase: MAINNET, friendbotUrl: null });
    expect(loadConfig({ ...env, SCF_SEAL_NETWORK_PASSPHRASE: TESTNET }).seal?.network).toBe(
      "testnet",
    );
    // https only (a man in the middle could forge "confirmed" answers or a reset)
    for (const k of ["SCF_SEAL_HORIZON_URL", "SCF_SEAL_FRIENDBOT_URL", "SCF_SEAL_RPC_URL"])
      expect(() => loadConfig({ ...env, [k]: "http://horizon.example" }), k).toThrow(/https/);
  });
  it("no longer reads the manage_data anchor settings (C-136) but names them", () => {
    const c = loadConfig({
      ...base,
      SCF_AUDIT_ANCHOR_DIR: "/x",
      SCF_AUDIT_ANCHOR_STELLAR_SECRET: "not even a seed",
    });
    expect(c.ignored).toEqual(["SCF_AUDIT_ANCHOR_STELLAR_SECRET"]);
    expect(c.enabled).toContain("audit_anchor");
  });
});

// Optional live check on Stellar testnet (no tenant data; a throwaway key funded by friendbot).
describe.skipIf(process.env.SCF_SEAL_LIVE !== "1")("live testnet seal (SCF_SEAL_LIVE=1)", () => {
  it("funds a throwaway key, submits one seal and reads memo and source back", async () => {
    const horizonUrl = process.env.SCF_SEAL_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
    const friendbotUrl = process.env.SCF_SEAL_FRIENDBOT_URL ?? "https://friendbot.stellar.org";
    const ledger = new HorizonSealLedger({ horizonUrl, friendbotUrl, timeoutMs: 60_000 });
    const kp = keypairFromSeed(strkeyEncode(randomBytes(32), VERSION.seed));
    const root = await ledger.root();
    expect(root.passphrase).toBe(TESTNET);
    expect(await ledger.fund(kp.account)).toBe("funded");
    const acct = await ledger.account(kp.account);
    if (!acct) throw new Error("not funded");
    const memo = createHash("sha256").update(`scf-seal live check ${Date.now()}`).digest();
    const tx = sealTransaction({
      source: kp.publicKey,
      sequence: acct.sequence + 1n,
      fee: 100,
      memoHash: memo,
      minTime: 0n,
      maxTime: BigInt(Math.floor(Date.now() / 1000) + 300),
    });
    const id = networkIdOf(TESTNET);
    const r = await ledger.submit(signEnvelope(id, tx, kp));
    expect(r.kind).toBe("confirmed");
    const found = await ledger.transaction(transactionHash(id, tx).toString("hex"));
    expect(found).toMatchObject({
      successful: true,
      memoHashHex: memo.toString("hex"),
      sourceAccount: kp.account,
    });
    // BUMP_SEQUENCE(0) changed nothing but the sequence consumed by the transaction itself.
    expect((await ledger.account(kp.account))?.sequence).toBe(acct.sequence + 1n);
  }, 180_000);
});
