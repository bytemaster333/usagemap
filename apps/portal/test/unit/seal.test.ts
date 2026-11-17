// SPDX-License-Identifier: Apache-2.0
// The browser verifier of the daily seal (src/lib/seal.ts) against the contract's known-answer vectors
// (docs/contracts/vectors/seal-v1.json, wire-formats §m.2, C-137): leaf encodings byte for byte, the RFC 6962
// reference roots, RFC 9162 roots and inclusion paths for 2–9 leaves at every index, and the three-day chain with its
// head paths, snapshot proofs and testnet-reset segment change. Plus tampering, the transaction lookup's outcomes and
// the SEP-54 ledger-file key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditLeafData,
  type ChainCheck,
  chainLeafData,
  checkChain,
  checkSealProof,
  compareSealHistory,
  dayRootFromPublicData,
  fetchSealHistory,
  fromHex,
  type HistoryTx,
  headPathLength,
  leafHash,
  ledgerFileKey,
  loadAllSealDays,
  lookupSealTransaction,
  merkleRoot,
  rootFromInclusion,
  rootToMemoBase64,
  type SealDayView,
  type SealProofView,
  snapshotLeafData,
  toHex,
} from "../../src/lib/seal.ts";

interface Vectors {
  rfc6962_reference_roots: { leaf_inputs_hex: string[]; root: string }[];
  encodings: {
    chain: { network: string; day: string; prev_root: string; data: string; leaf_hash: string };
    chain_first_day: {
      network: string;
      day: string;
      prev_root: string;
      data: string;
      leaf_hash: string;
    };
    audit: { day: string; audit_anchor_sha256: string; data: string; leaf_hash: string };
    snapshot: {
      salt: string;
      snapshot_id: string;
      snapshot_sha256: string;
      data: string;
      leaf_hash: string;
    };
  };
  trees: {
    leaf_count: number;
    leaf_data_ascii: string[];
    leaf_hashes: string[];
    root: string;
    proofs: { leaf_index: number; audit_path: string[] }[];
  }[];
  chain: {
    network: "testnet";
    day: string;
    segment: number;
    prev_root: string;
    audit_anchor_sha256: string;
    chain_leaf_hash: string;
    audit_leaf_hash: string;
    leaf_count: number;
    head_path: string[];
    root: string;
    proofs: {
      snapshot_id: string;
      snapshot_sha256: string;
      salt: string;
      leaf_index: number;
      leaf_hash: string;
      audit_path: string[];
    }[];
  }[];
}

const V = JSON.parse(
  readFileSync(join(__dirname, "../../../../docs/contracts/vectors/seal-v1.json"), "utf8"),
) as Vectors;

const enc = (s: string) => new TextEncoder().encode(s);

describe("seal-v1.json: leaf encodings", () => {
  it("chain leaf, also for the first day of a chain", async () => {
    for (const c of [V.encodings.chain, V.encodings.chain_first_day]) {
      const data = chainLeafData(c.network, c.day, fromHex(c.prev_root));
      expect(toHex(data)).toBe(c.data);
      expect(toHex(await leafHash(data))).toBe(c.leaf_hash);
    }
  });
  it("audit leaf", async () => {
    const a = V.encodings.audit;
    const data = auditLeafData(a.day, fromHex(a.audit_anchor_sha256));
    expect(toHex(data)).toBe(a.data);
    expect(toHex(await leafHash(data))).toBe(a.leaf_hash);
  });
  it("snapshot leaf (UUID in RFC 9562 byte order)", async () => {
    const s = V.encodings.snapshot;
    const data = snapshotLeafData(fromHex(s.salt), s.snapshot_id, fromHex(s.snapshot_sha256));
    expect(toHex(data)).toBe(s.data);
    expect(toHex(await leafHash(data))).toBe(s.leaf_hash);
  });
});

describe("seal-v1.json: RFC 9162 trees", () => {
  it("reproduces the RFC 6962 reference roots", async () => {
    for (const r of V.rfc6962_reference_roots) {
      const leaves = await Promise.all(r.leaf_inputs_hex.map((h) => leafHash(fromHex(h))));
      expect(toHex(await merkleRoot(leaves))).toBe(r.root);
    }
  });
  it("roots and every inclusion path of 2–9 leaves", async () => {
    expect(V.trees.map((t) => t.leaf_count)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    for (const t of V.trees) {
      const leaves = await Promise.all(t.leaf_data_ascii.map((d) => leafHash(enc(d))));
      expect(leaves.map(toHex)).toEqual(t.leaf_hashes);
      expect(toHex(await merkleRoot(leaves))).toBe(t.root);
      for (const p of t.proofs) {
        const r = await rootFromInclusion(
          p.leaf_index,
          t.leaf_count,
          leaves[p.leaf_index] as Uint8Array,
          p.audit_path.map(fromHex),
        );
        expect(r && toHex(r)).toBe(t.root);
      }
    }
  });
  it("refuses a proof of the wrong shape or for another leaf", async () => {
    const t = V.trees[5] as Vectors["trees"][number]; // 7 leaves
    const p = t.proofs[3] as { leaf_index: number; audit_path: string[] };
    const leaves = await Promise.all(t.leaf_data_ascii.map((d) => leafHash(enc(d))));
    expect(
      await rootFromInclusion(7, 7, leaves[3] as Uint8Array, p.audit_path.map(fromHex)),
    ).toBeNull();
    expect(
      await rootFromInclusion(
        3,
        7,
        leaves[3] as Uint8Array,
        [...p.audit_path, p.audit_path[0] as string].map(fromHex),
      ),
    ).toBeNull();
    const wrong = await rootFromInclusion(3, 7, leaves[4] as Uint8Array, p.audit_path.map(fromHex));
    expect(wrong && toHex(wrong)).not.toBe(t.root);
  });
});

const proofOf = (
  d: Vectors["chain"][number],
  p: Vectors["chain"][number]["proofs"][number],
): SealProofView => ({
  network: { name: "testnet", durable: false, notice: null },
  snapshot_id: p.snapshot_id,
  snapshot_sha256: p.snapshot_sha256,
  day: d.day,
  segment: d.segment,
  leaf_index: p.leaf_index,
  leaf_count: d.leaf_count,
  salt: p.salt,
  leaf_hash: p.leaf_hash,
  audit_path: p.audit_path,
  head_path: d.head_path,
  root: d.root,
  prev_root: d.prev_root,
  audit_anchor_sha256: d.audit_anchor_sha256,
  status: "confirmed",
});

const dayOf = (
  d: Vectors["chain"][number],
  status: SealDayView["status"] = "confirmed",
): SealDayView => ({
  day: d.day,
  network: { name: d.network },
  segment: d.segment,
  prev_root: d.prev_root,
  root: d.root,
  audit_anchor_sha256: d.audit_anchor_sha256,
  leaf_count: d.leaf_count,
  head_path: d.head_path,
  status,
  tx_hash: null,
  ledger: null,
});

describe("seal-v1.json: the three-day chain", () => {
  it("recomputes every day's root from public data alone (head path, every sibling on the right)", async () => {
    for (const d of V.chain) {
      expect(d.head_path.length).toBe(headPathLength(d.leaf_count));
      expect(toHex(await dayRootFromPublicData({ ...d }))).toBe(d.root);
    }
  });
  it("accepts every snapshot proof: hash, salted leaf, inclusion path and head path", async () => {
    let n = 0;
    for (const d of V.chain)
      for (const p of d.proofs) {
        const c = await checkSealProof(proofOf(d, p), p.snapshot_sha256);
        expect(c).toEqual({
          snapshotHash: true,
          leaf: true,
          inclusion: true,
          head: true,
          ok: true,
        });
        n++;
      }
    expect(n).toBe(5);
  });
  it("refuses a snapshot that changed, a changed salt, a changed path or a changed previous root", async () => {
    const d = V.chain[2] as Vectors["chain"][number];
    const p = d.proofs[1] as Vectors["chain"][number]["proofs"][number];
    const flip = (h: string) => `${h.slice(0, -1)}${h.endsWith("0") ? "1" : "0"}`;
    expect((await checkSealProof(proofOf(d, p), flip(p.snapshot_sha256))).ok).toBe(false);
    expect(
      (await checkSealProof({ ...proofOf(d, p), salt: flip(p.salt) }, p.snapshot_sha256)).leaf,
    ).toBe(false);
    const path = [...p.audit_path];
    path[0] = flip(path[0] as string);
    expect(
      (await checkSealProof({ ...proofOf(d, p), audit_path: path }, p.snapshot_sha256)).inclusion,
    ).toBe(false);
    expect(
      (await checkSealProof({ ...proofOf(d, p), prev_root: flip(d.prev_root) }, p.snapshot_sha256))
        .head,
    ).toBe(false);
    expect((await checkSealProof({ ...proofOf(d, p), salt: "zz" }, p.snapshot_sha256)).ok).toBe(
      false,
    );
  });
  it("walks the chain: links, a segment break after the testnet reset, the anchoring day", async () => {
    const days = [
      dayOf(V.chain[0] as never, "network_reset"),
      dayOf(V.chain[1] as never, "network_reset"),
      dayOf(V.chain[2] as never),
    ];
    const c: ChainCheck = await checkChain(days);
    expect(c.ok).toBe(true);
    expect(c.days.map((d) => d.segmentBreak)).toEqual([false, false, true]);
    expect(c.anchoredBy?.day).toBe("2026-11-16");
    // a rewritten earlier day breaks the link of the next day
    const tampered = [...days];
    tampered[1] = { ...(days[1] as SealDayView), root: "00".repeat(32) };
    const t = await checkChain(tampered);
    expect(t.ok).toBe(false);
    expect(t.days[1]?.rootOk).toBe(false);
    expect(t.days[2]?.linkOk).toBe(false);
    expect(t.anchoredBy).toBeNull();
    // a missing day is not contiguous
    const gap = await checkChain([days[0] as SealDayView, days[2] as SealDayView]);
    expect(gap.days[1]?.contiguous).toBe(false);
  });
});

describe("ledgerFileKey (SEP-54)", () => {
  it("matches the object keys of the public stores", () => {
    // AWS pubnet: 1 ledger per batch, 64000 batches per partition; Galexie starts at ledger 2
    expect(ledgerFileKey(2, 1, 64000)).toBe("FFFFFFFF--0-63999/FFFFFFFD--2.xdr.zst");
    // Lightsail mainnet: 8 ledgers per batch
    expect(ledgerFileKey(5, 8, 64000)).toBe("FFFFFFFF--0-511999/FFFFFFFF--0-7.xdr.zst");
    expect(ledgerFileKey(64000, 1, 64000)).toBe("FFFF05FF--64000-127999/FFFF05FF--64000.xdr.zst");
    expect(() => ledgerFileKey(1, 0, 1)).toThrow();
  });
});

describe("lookupSealTransaction (step 4)", () => {
  const expectTx = {
    tx_hash: "ab".repeat(32),
    source_account: "GSEAL",
    root: "11".repeat(32),
    ledger: 1200,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const horizon = "https://horizon-testnet.stellar.org";
  it("a matching transaction", async () => {
    const calls: string[] = [];
    const f = (async (u: string) => {
      calls.push(String(u));
      return json(200, {
        successful: true,
        source_account: "GSEAL",
        memo_type: "hash",
        memo: rootToMemoBase64(expectTx.root),
        ledger: 1200,
      });
    }) as unknown as typeof fetch;
    expect(await lookupSealTransaction(horizon, expectTx, f)).toEqual({
      kind: "match",
      ledger: 1200,
    });
    expect(calls).toEqual([`${horizon}/transactions/${expectTx.tx_hash}`]);
  });
  it("a transaction with another memo, source or result", async () => {
    const f = (async () =>
      json(200, {
        successful: false,
        source_account: "GOTHER",
        memo_type: "text",
        memo: "x",
        ledger: 9,
      })) as unknown as typeof fetch;
    const r = await lookupSealTransaction(horizon, expectTx, f);
    expect(r.kind).toBe("mismatch");
    expect(r.kind === "mismatch" && r.problems).toHaveLength(4);
  });
  it("404 below the endpoint's oldest ledger is 'outside history', above it 'not found'", async () => {
    const at = (elder: number) =>
      (async (u: string) =>
        String(u).endsWith("/")
          ? json(200, { history_elder_ledger: elder })
          : json(404, { status: 404 })) as unknown as typeof fetch;
    expect(await lookupSealTransaction(horizon, expectTx, at(5000))).toEqual({
      kind: "outside_history",
      elderLedger: 5000,
    });
    expect(await lookupSealTransaction(horizon, expectTx, at(2))).toEqual({ kind: "not_found" });
  });
  it("contacts only the allow-listed Horizon origins; reports a network failure", async () => {
    const never = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    expect(await lookupSealTransaction("https://horizon.example.org", expectTx, never)).toEqual({
      kind: "not_allowed",
      origin: "https://horizon.example.org",
    });
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect((await lookupSealTransaction(horizon, expectTx, down)).kind).toBe("unreachable");
  });
});

describe("CSP and the verifier agree on the Horizon origins", () => {
  it("connect-src lists exactly the origins lookupSealTransaction may contact", async () => {
    const { cspDirectives, SEAL_HORIZON_ORIGINS } = await import("../../server/headers.ts");
    const { HORIZON_ORIGINS } = await import("../../src/lib/seal.ts");
    expect([...SEAL_HORIZON_ORIGINS]).toEqual([...HORIZON_ORIGINS]);
    for (const s of ["http", "https"] as const)
      expect(cspDirectives(s)).toContain(`connect-src 'self' ${HORIZON_ORIGINS.join(" ")}`);
  });
});

describe("the whole seal history against the ledger (plan C1 #10)", () => {
  const G = `G${"A".repeat(55)}`;
  const confirmed = (d: Vectors["chain"][number], i: number): SealDayView => ({
    ...dayOf(d),
    tx_hash: `${i}`.repeat(64).slice(0, 64),
    ledger: 1000 + i,
    source_account: G,
  });
  const days = () => (V.chain as Vectors["chain"]).map(confirmed);
  const ledgerOf = (ds: readonly SealDayView[]): Map<string, HistoryTx[]> =>
    new Map([
      [
        G,
        ds.map((d) => ({
          hash: d.tx_hash as string,
          successful: true,
          source_account: G,
          memo_hash_hex: d.root,
          ledger: d.ledger as number,
        })),
      ],
    ]);

  it("an untouched history matches", async () => {
    const r = await compareSealHistory(days(), ledgerOf(days()), 1);
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ ok: true, daysChecked: 3, transactions: 3, accounts: 1 });
  });

  it("a past root rewritten together with the rest of the chain: the chain still checks, the ledger does not", async () => {
    const ledger = ledgerOf(days()); // what was sealed on the ledger at the time
    const rewritten = days();
    // Day 2 is rebuilt with another audit anchor, its root recomputed, and day 3 re-linked and recomputed: every
    // published day recomputes and links, so the chain walk alone cannot see it.
    const d2 = rewritten[1] as SealDayView;
    d2.audit_anchor_sha256 = "ee".repeat(32);
    d2.root = toHex(await dayRootFromPublicData({ ...d2, network: d2.network.name }));
    const d3 = rewritten[2] as SealDayView;
    d3.prev_root = d2.root;
    d3.root = toHex(await dayRootFromPublicData({ ...d3, network: d3.network.name }));
    expect((await checkChain(rewritten.map((d) => ({ ...d, status: "confirmed" })))).ok).toBe(true);
    const r = await compareSealHistory(rewritten, ledger, 1);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        { problem: "memo_mismatch", day: d2.day, tx_hash: d2.tx_hash },
        { problem: "memo_mismatch", day: d3.day, tx_hash: d3.tx_hash },
      ]),
    );
  });

  it("a deleted day, a missing transaction, another ledger, an order swap and reset days", async () => {
    const ds = days();
    const ledger = ledgerOf(ds);
    // a day deleted from the published history: its seal transaction matches no published root
    expect((await compareSealHistory(ds.slice(1), ledger, 1)).problems).toContainEqual({
      problem: "unknown_seal_tx",
      day: null,
      tx_hash: ds[0]?.tx_hash,
    });
    // a confirmed day whose transaction is not on the ledger — unless older than the endpoint's history
    const shorter = new Map([[G, (ledger.get(G) ?? []).slice(0, 2)]]);
    expect((await compareSealHistory(ds, shorter, 1)).problems).toContainEqual({
      problem: "confirmed_tx_missing",
      day: ds[2]?.day,
      tx_hash: ds[2]?.tx_hash,
    });
    const old = await compareSealHistory(ds, shorter, 5000);
    expect(old.ok).toBe(true);
    expect(old.notCheckable).toBe(1);
    // another ledger
    const moved = ds.map((d, i) => (i === 1 ? { ...d, ledger: 9999 } : d));
    expect((await compareSealHistory(moved, ledger, 1)).problems).toContainEqual({
      problem: "ledger_mismatch",
      day: ds[1]?.day,
      tx_hash: ds[1]?.tx_hash,
    });
    // seal transactions out of day order on the ledger
    const swapped = new Map([
      [G, (ledger.get(G) ?? []).map((t, i) => ({ ...t, ledger: i === 0 ? 2000 : t.ledger }))],
    ]);
    expect(
      (
        await compareSealHistory(
          ds.map((d, i) => (i === 0 ? { ...d, ledger: 2000 } : d)),
          swapped,
          1,
        )
      ).problems.map((p) => p.problem),
    ).toContain("out_of_order");
    // reset testnet days are not checkable, not problems
    const reset = ds.map((d, i) => (i < 2 ? { ...d, status: "network_reset" as const } : d));
    const rr = await compareSealHistory(reset, ledger, 1);
    expect(rr.notCheckable).toBe(2);
  });

  it("fetchSealHistory reads every page of an allow-listed Horizon, ascending, and refuses another host", async () => {
    const horizon = "https://horizon-testnet.stellar.org";
    const calls: string[] = [];
    const rec = (i: number) => ({
      hash: `h${i}`,
      successful: true,
      source_account: G,
      memo_type: i % 2 ? "hash" : "text",
      memo: i % 2 ? btoa(String.fromCharCode(...new Array(32).fill(i % 256))) : "x",
      ledger: i,
    });
    const f = (async (u: string) => {
      calls.push(String(u));
      const url = new URL(String(u));
      if (url.pathname === "/")
        return new Response(JSON.stringify({ history_elder_ledger: 7 }), { status: 200 });
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const n = cursor === 0 ? 200 : 3;
      return new Response(
        JSON.stringify({
          _embedded: { records: Array.from({ length: n }, (_, k) => rec(cursor + k)) },
          _links: { next: { href: `${horizon}/accounts/${G}/transactions?cursor=${cursor + n}` } },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const { history, elderLedger } = await fetchSealHistory(horizon, [G, G, "not-an-account"], f);
    expect(elderLedger).toBe(7);
    expect(history.get(G)).toHaveLength(203);
    expect(history.get(G)?.[1]?.memo_hash_hex).toBe("01".repeat(32));
    expect(history.get(G)?.[0]?.memo_hash_hex).toBeNull();
    expect(calls[1]).toBe(
      `${horizon}/accounts/${G}/transactions?order=asc&limit=200&include_failed=false`,
    );
    expect(calls).toHaveLength(3);
    await expect(fetchSealHistory("https://evil.example", [G], f)).rejects.toThrow(
      /not an allowed/,
    );
    const offHost = (async (u: string) =>
      String(u).endsWith("/")
        ? new Response("{}", { status: 200 })
        : new Response(
            JSON.stringify({
              _embedded: { records: Array.from({ length: 200 }, (_, k) => rec(k)) },
              _links: { next: { href: "https://evil.example/next" } },
            }),
            { status: 200 },
          )) as unknown as typeof fetch;
    await expect(fetchSealHistory(horizon, [G], offHost)).rejects.toThrow(/another host/);
  });

  it("loadAllSealDays walks 400-day windows back until one is empty or the floor is reached", async () => {
    const windows: string[] = [];
    const now = Date.parse("2026-11-18T12:00:00Z");
    const all = await loadAllSealDays(async (start, end) => {
      windows.push(`${start}/${end}`);
      return windows.length === 1
        ? [{ ...days()[0], day: "2026-11-01" } as SealDayView]
        : windows.length === 2
          ? [{ ...days()[0], day: "2025-11-01" } as SealDayView]
          : [];
    }, now);
    expect(windows[0]).toBe("2025-10-15T00:00:00Z/2026-11-19T00:00:00Z");
    // the second window reaches SEAL_HISTORY_FLOOR (2025-01-01): no third request
    expect(windows).toEqual([
      "2025-10-15T00:00:00Z/2026-11-19T00:00:00Z",
      "2025-01-01T00:00:00Z/2025-10-15T00:00:00Z",
    ]);
    expect(all.map((d) => d.day)).toEqual(["2025-11-01", "2026-11-01"]);
  });
});
