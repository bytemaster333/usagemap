// SPDX-License-Identifier: Apache-2.0
// Stellar wire formats used by contract_verification (C-19) and audit anchoring (C-63). Vectors observed on the live
// networks on 2026-11-13: two contract creations on testnet (Horizon `address` + decimal `salt`; the derived ids had
// live instance entries in Stellar RPC), and the instance entry of the USDC Stellar asset contract on the public
// network (getLedgerEntries), whose `Admin` value is a contract address.

import { describe, expect, it } from "vitest";
import {
  contractIdFromAccount,
  contractInstanceKey,
  instanceAdmin,
  isAdminKey,
  parseSalt,
  readContractDataEntry,
  strkeyDecode,
  strkeyEncode,
  VERSION,
  XdrError,
} from "../../src/stellar/xdr.ts";

const USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const USDC_INSTANCE_XDR =
  "AAAABgAAAAAAAAABre/OWa7lKWj3YGHUlMJSW3Vln6QpamX0me8p5WR35JYAAAAUAAAAAQAAABMAAAABAAAAAQAAAAMAAAAPAAAACE1FVEFEQVRBAAAAEQAAAAEAAAADAAAADwAAAAdkZWNpbWFsAAAAAAMAAAAHAAAADwAAAARuYW1lAAAADgAAAD1VU0RDOkdBNVpTRUpZQjM3SlJDNUFWQ0lBNU1PUDRSSFRNMzM1WDJLR1gzSUhPSkFQUDVSRTM0SzRLWlZOAAAAAAAADwAAAAZzeW1ib2wAAAAAAA4AAAAEVVNEQwAAABAAAAABAAAAAQAAAA8AAAAFQWRtaW4AAAAAAAASAAAAAZ601+BSioJxdy1pbNxo0dqyC/TYoHAyo14PApmGrMUeAAAAEAAAAAEAAAABAAAADwAAAAlBc3NldEluZm8AAAAAAAAQAAAAAQAAAAIAAAAPAAAACUFscGhhTnVtNAAAAAAAABEAAAABAAAAAgAAAA8AAAAKYXNzZXRfY29kZQAAAAAADgAAAARVU0RDAAAADwAAAAZpc3N1ZXIAAAAAAA0AAAAgO5kROA7+mIugqJAOsc/kTzZvfb6Ua+0HckD39iTfFcU=";

describe("StrKey", () => {
  it("round-trips account and contract ids and rejects a bad checksum or version", () => {
    const g = "GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS";
    expect(strkeyEncode(strkeyDecode(g, VERSION.account), VERSION.account)).toBe(g);
    expect(strkeyEncode(strkeyDecode(USDC_SAC, VERSION.contract), VERSION.contract)).toBe(USDC_SAC);
    expect(() => strkeyDecode(g, VERSION.contract)).toThrow(XdrError);
    expect(() => strkeyDecode(`${g.slice(0, 55)}A`, VERSION.account)).toThrow(XdrError);
  });
});

describe("contract id derivation (CAP-46)", () => {
  it("reproduces contract ids created on testnet", () => {
    expect(
      contractIdFromAccount(
        "testnet",
        "GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS",
        parseSalt("54299234199597398130672687799742937315824404357648731123282684789142468745117"),
      ),
    ).toBe("CCPP2VNWZS2YXEXB2BTM2ANDDYNH6YOA6MG4K3JCRBVFKX5IT4ZCXGRN");
    expect(
      contractIdFromAccount(
        "testnet",
        "GDMUJEJCDSB7AGNYWXJA26M7TYWLMJADF3IQMDPQ2OM2C3MNJ3UINCOZ",
        parseSalt("75002006745336122536148315339645979910642204475256057545903007217993757648152"),
      ),
    ).toBe("CDUZNQ6NUFJDROTREQALPM5A7NPLYGEDOCNLQV3YYMYDDQ63KHB2C2XS");
  });
  it("depends on the network and rejects malformed salts", () => {
    const g = "GAEMG5TVLEIQYCY3XB4EJT742DIE3FQO53RSESSYJQUZIWZOJQIZATJS";
    const s = parseSalt("1");
    expect(contractIdFromAccount("public", g, s)).not.toBe(contractIdFromAccount("testnet", g, s));
    expect(parseSalt("ff".repeat(32))).toHaveLength(32);
    expect(() => parseSalt((1n << 256n).toString())).toThrow(XdrError);
    expect(() => parseSalt("0x12")).toThrow(XdrError);
  });
});

describe("contract instance entries", () => {
  it("encodes the instance ledger key and reads the USDC SAC instance (Admin is a contract, not an account)", () => {
    const key = Buffer.from(contractInstanceKey(USDC_SAC), "base64");
    expect(key.length).toBe(4 + 4 + 32 + 4 + 4);
    const v = readContractDataEntry(USDC_INSTANCE_XDR);
    expect(v.t).toBe("instance");
    if (v.t !== "instance") return;
    const keys = (v.storage ?? []).map(([k]) => k);
    expect(keys.filter(isAdminKey)).toHaveLength(1);
    const admin = (v.storage ?? []).find(([k]) => isAdminKey(k))?.[1];
    expect(admin).toMatchObject({ t: "address", kind: "contract" });
    expect(instanceAdmin(v)).toBeNull(); // only an ACCOUNT admin can be a tenant's verified account
  });
  it("refuses truncated or trailing input", () => {
    const b = Buffer.from(USDC_INSTANCE_XDR, "base64");
    expect(() => readContractDataEntry(b.subarray(0, b.length - 3).toString("base64"))).toThrow(
      XdrError,
    );
    expect(() =>
      readContractDataEntry(Buffer.concat([b, Buffer.alloc(4)]).toString("base64")),
    ).toThrow(XdrError);
  });
});
