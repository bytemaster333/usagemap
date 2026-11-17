// SPDX-License-Identifier: Apache-2.0
// Registry sources read at most MAX_REGISTRY_BODY bytes of an answer and stop reading as soon as it is exceeded:
// an endless or huge body never sits in memory.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readBodyCapped, StellarlightSource } from "../../src/registry/sources.ts";

let server: Server;
let base = "";
let sentEndless = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/endless")) {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      const pump = () => {
        while (res.write(chunk)) {
          sentEndless += chunk.length;
          if (sentEndless > 512 * 1024 * 1024) return res.end(); // safety stop for a broken client
        }
        res.once("drain", pump);
      };
      res.on("close", () => {});
      pump();
      return;
    }
    if (req.url?.startsWith("/declared")) {
      res.writeHead(200, { "content-type": "application/json", "content-length": "999999999" });
      res.write("{");
      return; // never sends the rest
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("readBodyCapped", () => {
  it("reads a small body", async () => {
    expect(await readBodyCapped(await fetch(`${base}/ok`), 1024)).toBe('{"ok":true}');
  });

  it("refuses a declared Content-Length above the bound without reading", async () => {
    await expect(readBodyCapped(await fetch(`${base}/declared`), 1024)).rejects.toThrow(
      /too large/,
    );
  });

  it("stops an endless body shortly after the bound", async () => {
    const cap = 4 * 1024 * 1024;
    await expect(readBodyCapped(await fetch(`${base}/endless`), cap)).rejects.toThrow(/too large/);
    // the client stopped reading: the server could only push about the bound plus socket buffers
    await new Promise((r) => setTimeout(r, 100));
    expect(sentEndless).toBeLessThan(cap + 64 * 1024 * 1024);
  });

  it("a registry source fails cleanly on an oversized answer", async () => {
    const src = new StellarlightSource(`${base}/endless`, { timeoutMs: 20_000 });
    await expect(src.fetchAll(new AbortController().signal)).rejects.toThrow(/too large/);
  });
});
