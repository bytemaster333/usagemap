// SPDX-License-Identifier: Apache-2.0
// The alert mailer in workerd (the open-source Workers runtime, pinned devDependency), offline: the two production
// modules unchanged, the send_email binding replaced by test/workerd/fake-send-email.js (which enforces the bound
// destination, the routing-domain sender and From/Message-ID like the runtime does), messages captured by a local
// HTTP server. Run: pnpm --filter @usagemap/alert-mailer test

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startCapture, startWorkerd } from "./harness.ts";
import {
  assertNoForbidden,
  decodeHeader,
  FROM,
  firingNotification,
  parseMessage,
  TO,
  TOKEN,
} from "./helpers.ts";

describe("alert mailer in workerd", () => {
  let capture: Awaited<ReturnType<typeof startCapture>>;
  let worker: Awaited<ReturnType<typeof startWorkerd>>;
  const send = (body: unknown, auth = `Bearer ${TOKEN}`) =>
    fetch(`${worker.url}/v1/alertmanager`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  before(async () => {
    capture = await startCapture();
    worker = await startWorkerd(capture.port);
  });
  after(() => {
    worker?.proc.kill();
    capture?.server.closeAllConnections();
    capture?.server.close();
  });

  test("one firing notification → exactly one well-formed message to the bound destination", async () => {
    capture.messages.length = 0;
    const res = await send(firingNotification());
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await res.json(), { result: "sent", messages: 1 });
    assert.equal(capture.messages.length, 1);
    const m = capture.messages[0];
    assert.ok(m);
    assert.equal(m.from, FROM);
    assert.equal(m.to, TO);
    const msg = parseMessage(m.raw);
    assert.equal(
      decodeHeader(msg.headers.get("subject") ?? ""),
      "[UsageMap FIRING:1] critical IngestBurnRate (maintainers-critical)",
    );
    assertNoForbidden(m.raw, "raw message");
    assertNoForbidden(msg.body, "decoded body");
  });

  test("a wrong secret sends nothing", async () => {
    capture.messages.length = 0;
    const res = await send(firingNotification(), "Bearer not-the-secret");
    assert.equal(res.status, 401);
    assert.equal(capture.messages.length, 0);
  });

  test("a refused send is a 502 with the runtime's code, and nothing is delivered", async () => {
    capture.messages.length = 0;
    capture.mode.unavailable = true;
    try {
      const res = await send(firingNotification());
      assert.equal(res.status, 502);
      assert.deepEqual(await res.json(), { result: "send_failed", code: "E_RATE_LIMIT_EXCEEDED" });
      assert.equal(capture.messages.length, 0);
    } finally {
      capture.mode.unavailable = false;
    }
  });

  test("the worker's log lines carry no address, label value or secret", () => {
    const out = worker.output();
    assert.match(out, /"event":"sent"/);
    assert.ok(!out.includes(TO));
    assertNoForbidden(out, "workerd output");
  });
});
