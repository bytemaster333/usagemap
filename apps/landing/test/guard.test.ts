// SPDX-License-Identifier: Apache-2.0
// The publication guard: what must never reach the public site is caught, and the harmless look-alikes that the
// repository's documents are full of (package@version, product versions, loopback and documentation addresses) are
// not.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardFindings, isHarmlessIpv4 } from "../src/guard.ts";

const page = (body: string) =>
  `<html><head><style>a{}</style></head><body><p>${body}</p></body></html>`;

describe("publication guard", () => {
  it("finds local paths, e-mail addresses, public IPv4 addresses and secret seeds", () => {
    const seed = `S${"A".repeat(55)}`;
    const f = guardFindings(
      "/x/",
      page(`copied /home/someone/.cache/x · mail jane.doe@company.com · from 8.8.8.8 · ${seed}`),
    );
    assert.equal(f.length, 4, f.join("\n"));
    assert.match(f.join("\n"), /local path/);
    assert.match(f.join("\n"), /e-mail address "jane\.doe@company\.com"/);
    assert.match(f.join("\n"), /public IPv4 address "8\.8\.8\.8"/);
    assert.match(f.join("\n"), /Stellar secret seed/);
  });

  it("lets harmless look-alikes through", () => {
    const f = guardFindings(
      "/x/",
      page(
        "tracker@1.1.0 react@19.3.1 curl@8.14.1-2 Chrome/142.0.0.0 127.0.0.1:5173 10.0.0.1 192.0.2.10 security@&lt;domain-a&gt; ops@example.org a@x.test",
      ),
    );
    assert.deepEqual(f, []);
  });

  it("knows which IPv4 ranges belong to nobody", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "198.51.100.7",
      "203.0.113.9",
      "0.0.0.0",
    ]) {
      assert.ok(isHarmlessIpv4(ip), ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "9.9.9.9"])
      assert.ok(!isHarmlessIpv4(ip), ip);
  });
});
