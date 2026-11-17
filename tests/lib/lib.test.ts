// SPDX-License-Identifier: Apache-2.0
// Unit tests of the harness itself: if the proof-of-work solver, the token parser, the privacy scanner or the
// statistics were wrong, every suite built on them would be wrong too.

import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asCanaries, newCanaries } from "./canaries.ts";
import { evidenceStem, renderMarkdown, stamp, writeEvidence } from "./evidence.ts";
import { parseToken, powPrefix, solvePow, tamperToken } from "./gateway-client.ts";
import { baseAllowList, scan, stellarAccountAllowList } from "./privacy-scan.ts";
import { percentile, summarise, Timeline } from "./stats.ts";
import { randomStrKey, TestWallet } from "./stellar.ts";

/** Builds a §b.1 token around a chosen secret counter (the MAC key is irrelevant to the solver). */
async function token(cost: number, max: number, secret: number): Promise<string> {
  const b = Buffer.alloc(92);
  b[0] = 1;
  b.writeUInt32BE(Math.floor(Date.now() / 3_600_000), 1);
  randomBytes(16).copy(b, 5);
  b.writeUIntBE(Date.now(), 21, 6);
  const nonce = randomBytes(16);
  nonce.copy(b, 27);
  b.writeUInt16BE(cost, 51);
  b.writeUInt16BE(max, 53);
  (await powPrefix(nonce, cost, secret)).copy(b, 55);
  createHmac("sha256", "k").update(b.subarray(0, 60)).digest().copy(b, 60);
  return b.toString("base64url");
}

describe("proof-of-work (wire-formats §b.2)", () => {
  it("matches the gateway's DK vector (nonce 00..0f, c = 7, cost 512)", async () => {
    const nonce = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
    expect((await powPrefix(nonce, 512, 7)).toString("hex")).toBe("99cf71e7");
  });

  it("parses the 92-byte token layout and solves it", async () => {
    const t = await token(512, 64, 41);
    expect(t).toMatch(/^[A-Za-z0-9_-]{123}$/);
    const f = parseToken(t);
    expect([f.ver, f.cost, f.max]).toEqual([1, 512, 64]);
    expect(await solvePow(t)).toBe(41);
  });

  it("a tampered token keeps its length and differs only in the MAC", () => {
    const t = "A".repeat(123);
    const x = tamperToken(t);
    expect(x).toHaveLength(123);
    expect(parseToken(x).mac.equals(parseToken(t).mac)).toBe(false);
    expect(parseToken(x).nonce.equals(parseToken(t).nonce)).toBe(true);
  });
});

describe("StrKeys and the SEP-53 test wallet", () => {
  it("produces checksum-valid StrKeys of each kind", () => {
    expect(randomStrKey("S")).toMatch(/^S[A-Z2-7]{55}$/);
    expect(randomStrKey("G")).toMatch(/^G[A-Z2-7]{55}$/);
    expect(new TestWallet().account).toMatch(/^G[A-Z2-7]{55}$/);
  });
});

describe("privacy scanner", () => {
  const c = newCanaries();
  const canaries = asCanaries(c);

  it("finds every canary and masks it in the report", () => {
    const text = `GET /p?scf_q=${c.queryValue} ua="${c.userAgent}" title=${c.pageTitle} ${c.seed} ${c.endUserAccount} ${c.jwt} ${c.email}`;
    const r = scan([{ source: "log:x", text }], canaries, baseAllowList());
    const labels = new Set(r.findings.filter((f) => f.kind === "canary").map((f) => f.label));
    expect(labels.size).toBe(canaries.length - 1); // the referrer path is not in this text
    for (const f of r.findings) {
      expect(f.masked).not.toContain(c.seed);
      expect(f.context).not.toContain(c.seed);
    }
  });

  it("flags address, User-Agent, seed, JWT, bearer, token and query-string shapes", () => {
    const text = [
      "client=203.0.113.9",
      "v6=2a02:1810:4d02:5b00:a1b2::1",
      "sur=2001:db8:0:1::5",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      randomStrKey("S"),
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "scfa_ing_0123456789abcdef_secret",
      "/checkout?coupon=SPRING",
    ].join("\n");
    const kinds = new Set(
      scan([{ source: "s", text }], [], baseAllowList()).findings.map((f) => f.kind),
    );
    for (const k of [
      "ipv4",
      "ipv6",
      "surrogate",
      "user_agent",
      "seed",
      "jwt",
      "bearer",
      "ingest_token",
      "query_string",
    ])
      expect(kinds, k).toContain(k);
  });

  it("does not flag versions, times, timestamps or allow-listed listen addresses", () => {
    const text =
      "version 1.2.3 at 2026-11-13T12:30:45.123Z; sum(x)::bigint, Chrome/131.0.0.0, 2::float8, (0)::double, 'UTC')::date; listening on 0.0.0.0:8080 and 127.0.0.1; pg 18.6; build 1.2.3.4.5";
    const r = scan([{ source: "log:x", text }], [], baseAllowList());
    expect(r.findings).toEqual([]);
    expect(r.allowedHits.map((h) => h.reason)).toHaveLength(2);
  });

  it("allows a G… account only as an exact verified-footprint or account-holder value in the scf dump", () => {
    const verified = randomStrKey("G");
    const holder = randomStrKey("G");
    const rejected = randomStrKey("G"); // a rejected footprint item: never allowed
    const claim = randomStrKey("G"); // an open claim (< 30 days): allowed while it is being proved (plan C1 #9)
    const endUser = randomStrKey("G");
    const allow = [
      ...baseAllowList(),
      ...stellarAccountAllowList({
        footprint: [verified],
        openClaims: [claim],
        accountHolders: [holder, verified],
        platform: [],
      }),
    ];
    const dump = `INSERT INTO scf.footprint_items VALUES ('${verified}', 'verified');\nINSERT INTO scf.footprint_items VALUES ('${rejected}', 'rejected');\nINSERT INTO scf.footprint_items VALUES ('${claim}', 'claimed');\n${holder} ${endUser}`;
    const r = scan([{ source: "pg_dump:scf", text: dump }], [], allow);
    expect(r.findings.map((f) => f.masked).sort()).toEqual(
      [rejected, endUser].map((g) => `${g.slice(0, 6)}…${g.slice(-2)}(56)`).sort(),
    );
    expect(r.allowedHits).toHaveLength(3);
    expect(r.allowedHits.map((h) => h.reason).join()).toMatch(
      /verified Registered Footprint.*open Registered Footprint claim.*account holder/,
    );
    // the same values outside the scf dump (a log, the umami dump) are findings
    expect(
      scan([{ source: "log:control-plane", text: `${verified} ${holder}` }], [], allow).findings,
    ).toHaveLength(2);
    expect(() =>
      stellarAccountAllowList({
        footprint: ["CABC"],
        openClaims: [],
        accountHolders: [],
        platform: [],
      }),
    ).toThrow(/not a G/);
  });

  it("rejects canaries too short to be meaningful", () => {
    expect(() => scan([{ source: "s", text: "x" }], [{ label: "x", value: "abc" }], [])).toThrow();
  });
});

describe("statistics", () => {
  it("nearest-rank percentiles", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(summarise([3, 1, 2])).toMatchObject({ count: 3, min: 1, p50: 2, max: 3, mean: 2 });
  });

  it("timeline reports failing seconds", () => {
    const t = new Timeline();
    t.add("202", t.start + 100);
    t.add("503", t.start + 1500);
    t.add("error", t.start + 2500);
    expect(t.failingSeconds()).toEqual([1, 2]);
    expect(t.totals()).toEqual({ "202": 1, "503": 1, error: 1 });
  });
});

describe("evidence writer", () => {
  it("writes JSON and Markdown with outcome counts", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsl-ev-"));
    try {
      const out = writeEvidence(
        dir,
        {
          layer: "x",
          name: "y",
          title: "T",
          summary: "S",
          checks: [
            { name: "a", outcome: "pass", ids: ["test.automated-suite"] },
            { name: "b|c", outcome: "not_run", detail: "requires: gateway" },
          ],
        },
        new Date("2026-11-13T09:05:01.123Z"),
        { commit: "abcdef012345", dirty: false },
      );
      expect(out.md).toBe(join(dir, "x", "y-20261113T090501Z-abcdef012345.md"));
      expect(out.json).toBe(join(dir, "x", "y-20261113T090501Z-abcdef012345.json"));
      const md = readFileSync(out.md, "utf8");
      expect(md).toContain("1 passed, 0 failed, 1 not run");
      expect(md).toContain("b\\|c");
      expect(JSON.parse(readFileSync(out.json, "utf8")).checks).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(
      renderMarkdown({ layer: "l", name: "n", title: "T", summary: "", checks: [] }, new Date(0), {
        commit: "c",
        dirty: "no",
        node: "v",
        os: "o",
        runner: "r",
      }),
    ).toContain("1970-01-01T00:00:00.000Z");
  });

  it("names files append-only with timestamp and commit, marks dirty trees, never overwrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsl-ev-"));
    const ev = { layer: "l", name: "web-ingest", title: "T", summary: "S", checks: [] };
    const at = new Date("2026-11-13T23:59:59.999Z");
    try {
      expect(stamp(at)).toBe("20261113T235959Z");
      expect(evidenceStem("web-ingest", at, { commit: "unknown", dirty: true })).toBe(
        "web-ingest-20261113T235959Z-nocommit-dirty",
      );
      expect(() => evidenceStem("../x", at, { commit: "abc1234", dirty: false })).toThrow();
      const dirty = writeEvidence(dir, ev, at, { commit: "abc1234def56", dirty: true });
      expect(dirty.md.endsWith("web-ingest-20261113T235959Z-abc1234def56-dirty.md")).toBe(true);
      const j = JSON.parse(readFileSync(dirty.json, "utf8"));
      expect(j.dirty).toBe(true);
      expect(j.commit).toBe("abc1234def56");
      expect(readFileSync(dirty.md, "utf8")).toContain("Dirty tree");
      // the same run name, instant and tree again: refused (EEXIST), the first file is untouched
      const before = readFileSync(dirty.md, "utf8");
      expect(() => writeEvidence(dir, ev, at, { commit: "abc1234def56", dirty: true })).toThrow(
        /EEXIST/,
      );
      expect(readFileSync(dirty.md, "utf8")).toBe(before);
      // a clean run one second later is a new pair of files next to the old ones
      const clean = writeEvidence(dir, ev, new Date(at.getTime() + 1000), {
        commit: "abc1234def56",
        dirty: false,
      });
      expect(readFileSync(clean.md, "utf8")).not.toContain("Dirty tree");
      expect(readdirSync(join(dir, "l")).sort()).toEqual([
        "web-ingest-20261113T235959Z-abc1234def56-dirty.json",
        "web-ingest-20261113T235959Z-abc1234def56-dirty.md",
        "web-ingest-20261114T000000Z-abc1234def56.json",
        "web-ingest-20261114T000000Z-abc1234def56.md",
      ]);
      // strict mode: a dirty tree is refused outright
      process.env.SCF_EVIDENCE_REQUIRE_CLEAN = "1";
      try {
        expect(() =>
          writeEvidence(dir, ev, new Date(at.getTime() + 5000), { commit: "abc1234", dirty: true }),
        ).toThrow(/uncommitted/);
      } finally {
        delete process.env.SCF_EVIDENCE_REQUIRE_CLEAN;
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
