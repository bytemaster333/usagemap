// SPDX-License-Identifier: Apache-2.0
// The SSRF-safe domain verifier against a local fake DNS server and a local HTTPS server (data-model §8.4).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress } from "../../src/verify/address.ts";
import { DomainVerifier, metaContents } from "../../src/verify/verifier.ts";
import {
  FakeDns,
  FakeHttps,
  makeTestPki,
  PUBLIC_V4,
  PUBLIC_V6,
  type TestPki,
} from "../support/verify/fake-net.ts";

describe("address policy", () => {
  const refused = [
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "100.64.0.1",
    "100.127.255.254",
    "127.0.0.1",
    "127.8.8.8",
    "169.254.169.254",
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "::ffff:7f00:1",
    "::127.0.0.1",
    "fe80::1",
    "fec0::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2001:2::1",
    "2002:7f00:1::1",
    "2002:808:808::1",
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b::169.254.169.254",
    "64:ff9b:1::808:808",
    "3fff::1",
    "not-an-ip",
    "",
  ];
  const allowed = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.215.14",
    "172.32.0.1",
    "100.128.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001:80b::200e",
    "64:ff9b::808:808",
  ];
  it.each(refused)("refuses %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  it.each(allowed)("allows %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
});

describe("meta tag parser", () => {
  it("finds the tag in any attribute order and quoting", () => {
    expect(
      metaContents(
        `<html><head><META content='abc' NAME="scf-site-verification"><meta name=scf-site-verification content=def>` +
          `<meta name="other" content="x"></head></html>`,
      ),
    ).toEqual(["abc", "def"]);
    expect(metaContents("<p>scf-site-verification</p>")).toEqual([]);
  });
});

describe("DomainVerifier", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
  let dns: FakeDns;
  let https: FakeHttps;
  let pki: TestPki;
  const dialed: string[] = [];
  let v: DomainVerifier;

  const verifier = (o: { timeoutMs?: number } = {}) =>
    new DomainVerifier({
      dnsServers: [dns.server],
      ca: pki.ca,
      timeoutMs: o.timeoutMs ?? 3000,
      dial: (address) => {
        dialed.push(address);
        return { host: "127.0.0.1", port: https.port };
      },
    });

  beforeAll(async () => {
    pki = makeTestPki(["good.example", "other.example"]);
    dns = new FakeDns();
    await dns.start();
    https = new FakeHttps(pki, ["good.example", "other.example"]);
    await https.start();
    v = verifier();
    dns.records.set("good.example", { a: [PUBLIC_V4], aaaa: [PUBLIC_V6] });
    dns.records.set("_scf-verify.good.example", {
      txt: [["v=spf1 -all"], ["scf-verify=", TOKEN]],
    });
    https.routes.set("good.example", (p) =>
      p === "/.well-known/scf-verify.txt"
        ? { status: 200, body: `${TOKEN}\n` }
        : p === "/"
          ? {
              status: 200,
              headers: { "content-type": "text/html" },
              body: `<!doctype html><head><meta name="scf-site-verification" content="${TOKEN}"></head>`,
            }
          : { status: 404 },
    );
  });
  afterAll(async () => {
    await https.stop();
    await dns.stop();
    pki.cleanup();
  });

  it("verifies by DNS TXT (chunked strings joined)", async () => {
    expect(await v.verify("dns_txt", "good.example", TOKEN)).toBe("OK");
    expect(await v.verify("dns_txt", "good.example", "X".repeat(22))).toBe("TOKEN_MISMATCH");
  });

  it("reports NXDOMAIN, missing TXT and SERVFAIL", async () => {
    expect(await v.verify("dns_txt", "missing.example", TOKEN)).toBe("DNS_NXDOMAIN");
    dns.records.set("_scf-verify.notxt.example", { a: [PUBLIC_V4] });
    expect(await v.verify("dns_txt", "notxt.example", TOKEN)).toBe("DNS_NO_TXT");
    dns.records.set("_scf-verify.broken.example", "SERVFAIL");
    expect(await v.verify("dns_txt", "broken.example", TOKEN)).toBe("DNS_SERVFAIL");
  });

  it("verifies by well-known file and by meta tag, connecting to the resolved address with SNI of the host", async () => {
    dialed.length = 0;
    expect(await v.verify("well_known", "good.example", TOKEN)).toBe("OK");
    expect(await v.verify("meta_tag", "good.example", TOKEN)).toBe("OK");
    expect(dialed[0]).toBe(PUBLIC_V4);
    expect(https.hosts.at(-1)).toBe("good.example");
    expect(await v.verify("well_known", "good.example", "Y".repeat(22))).toBe("TOKEN_MISMATCH");
  });

  it("meta tag absent → META_NOT_FOUND; non-200 → HTTP_STATUS", async () => {
    dns.records.set("plain.example", { a: [PUBLIC_V4] });
    https.routes.set("plain.example", () => ({ status: 200, body: "<html></html>" }));
    const p = makeTestPki(["plain.example"]);
    // The fake server has no certificate for plain.example: use one whose CA covers it.
    const local = new FakeHttps(p, ["plain.example"]);
    await local.start();
    local.routes.set("plain.example", (path) =>
      path === "/" ? { status: 200, body: "<html><meta name=x></html>" } : { status: 500 },
    );
    const lv = new DomainVerifier({
      dnsServers: [dns.server],
      ca: p.ca,
      dial: () => ({ host: "127.0.0.1", port: local.port }),
    });
    expect(await lv.verify("meta_tag", "plain.example", TOKEN)).toBe("META_NOT_FOUND");
    expect(await lv.verify("well_known", "plain.example", TOKEN)).toBe("HTTP_STATUS");
    await local.stop();
    p.cleanup();
  });

  it("never follows a redirect", async () => {
    dns.records.set("other.example", { a: [PUBLIC_V4] });
    https.routes.set("other.example", () => ({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    }));
    expect(await v.verify("well_known", "other.example", TOKEN)).toBe("HTTP_REDIRECT_REFUSED");
    expect(await v.verify("meta_tag", "other.example", TOKEN)).toBe("HTTP_REDIRECT_REFUSED");
  });

  it.each([
    ["127.0.0.1", "a"],
    ["10.1.2.3", "a"],
    ["169.254.169.254", "a"],
    ["::1", "aaaa"],
    ["::ffff:127.0.0.1", "aaaa"],
    ["fd00:ec2::254", "aaaa"],
  ] as const)("refuses a host resolving to %s without connecting", async (ip, kind) => {
    dialed.length = 0;
    // One private address among public ones is enough to refuse (no DNS-rebinding choice for the attacker).
    dns.records.set(
      "evil.example",
      kind === "a" ? { a: [PUBLIC_V4, ip] } : { a: [PUBLIC_V4], aaaa: [ip] },
    );
    expect(await v.verify("well_known", "evil.example", TOKEN)).toBe("PRIVATE_ADDRESS_REFUSED");
    expect(await v.verify("meta_tag", "evil.example", TOKEN)).toBe("PRIVATE_ADDRESS_REFUSED");
    expect(dialed).toEqual([]);
  });

  it("refuses a literal address as host, and loopback by default without a dial hook", async () => {
    expect(await v.verify("well_known", "127.0.0.1", TOKEN)).toBe("PRIVATE_ADDRESS_REFUSED");
    dns.records.set("loop.example", { a: ["127.0.0.1"] });
    const prod = new DomainVerifier({ dnsServers: [dns.server] });
    expect(await prod.verify("well_known", "loop.example", TOKEN)).toBe("PRIVATE_ADDRESS_REFUSED");
  });

  it("caps the body at 64 KiB", async () => {
    dns.records.set("good.example", { a: [PUBLIC_V4] });
    https.routes.set("good.example", () => ({ status: 200, body: "x".repeat(70 * 1024) }));
    expect(await v.verify("well_known", "good.example", TOKEN)).toBe("TOO_LARGE");
    https.routes.set("good.example", () => ({
      status: 200,
      headers: { "content-type": "text/html", "transfer-encoding": "chunked" },
      body: "y".repeat(65 * 1024),
    }));
    expect(await v.verify("meta_tag", "good.example", TOKEN)).toBe("TOO_LARGE");
  });

  it("times out on a server that never answers and on a DNS server that never answers", async () => {
    https.routes.set("good.example", () => "hang");
    const t0 = Date.now();
    expect(await verifier({ timeoutMs: 400 }).verify("well_known", "good.example", TOKEN)).toBe(
      "TIMEOUT",
    );
    expect(Date.now() - t0).toBeLessThan(2000);
    dns.records.set("_scf-verify.silent.example", "DROP");
    expect(await verifier({ timeoutMs: 400 }).verify("dns_txt", "silent.example", TOKEN)).toBe(
      "TIMEOUT",
    );
  });

  it("a certificate for another name or from an unknown CA is a TLS error", async () => {
    dns.records.set("mismatch.example", { a: [PUBLIC_V4] });
    https.routes.set("mismatch.example", () => ({ status: 200, body: TOKEN }));
    expect(await v.verify("well_known", "mismatch.example", TOKEN)).toBe("TLS_ERROR");
    const noCa = new DomainVerifier({
      dnsServers: [dns.server],
      dial: () => ({ host: "127.0.0.1", port: https.port }),
    });
    https.routes.set("good.example", () => ({ status: 200, body: TOKEN }));
    expect(await noCa.verify("well_known", "good.example", TOKEN)).toBe("TLS_ERROR");
  });
});
