// SPDX-License-Identifier: Apache-2.0
// Unit tests of the alert mailer's logic (src/mailer.js) in Node: request handling, the payload check, scrubbing and
// the raw message. test/workerd.test.ts runs the same modules in workerd; test/alertmanager-e2e.test.ts drives them
// from a real Alertmanager. Run: pnpm --filter @usagemap/alert-mailer test

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  authorised,
  bodyOf,
  buildMessage,
  encodeHeader,
  handle,
  isAddress,
  isSensitiveName,
  MAX_BODY_BYTES,
  MAX_LISTED_ALERTS,
  rfc5322Date,
  scrubValue,
  subjectOf,
  validateNotification,
} from "../src/mailer.js";
import {
  assertNoForbidden,
  decodeHeader,
  FROM,
  firingNotification,
  parseMessage,
  TO,
  TOKEN,
} from "./helpers.ts";

interface Sent {
  from: string;
  to: string;
  raw: string;
}

function harness(opts: { failWith?: unknown } = {}) {
  const sent: Sent[] = [];
  const logs: Record<string, string | number>[] = [];
  const env = {
    ALERT_TOKEN: TOKEN,
    MAIL_FROM: FROM,
    MAIL_TO: TO,
    MAIL: {
      async send(m: unknown) {
        if (opts.failWith) throw opts.failWith;
        sent.push(m as Sent);
        return { messageId: "x" };
      },
    },
  };
  const make = (from: string, to: string, raw: string) => ({ from, to, raw });
  const logger = { log: (e: Record<string, string | number>) => logs.push(e) };
  const call = (init: RequestInit & { path?: string; auth?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.auth !== null) headers.set("authorization", init.auth ?? `Bearer ${TOKEN}`);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const req = new Request(`https://mailer.test${init.path ?? "/v1/alertmanager"}`, {
      method: init.method ?? "POST",
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    return handle(req, env, make, logger);
  };
  return { sent, logs, env, call };
}

const post = (n: unknown) => ({ body: JSON.stringify(n) });

describe("request handling", () => {
  test("a firing notification becomes exactly one e-mail from the routing address to the destination", async () => {
    const h = harness();
    const res = await h.call(post(firingNotification()));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { result: "sent", messages: 1 });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]?.from, FROM);
    assert.equal(h.sent[0]?.to, TO);
    const msg = parseMessage(h.sent[0]?.raw ?? "");
    assert.equal(msg.headers.get("from"), `UsageMap alerts <${FROM}>`);
    assert.equal(msg.headers.get("to"), `<${TO}>`);
    assert.equal(
      msg.headers.get("subject"),
      "[UsageMap FIRING:1] critical IngestBurnRate (maintainers-critical)",
    );
    assert.match(msg.body, /Summary: +Ingest error budget burning 14x \(1h\) on app-1/);
    assert.match(msg.body, /Runbook: +ops\/runbooks\/ingest-burn-rate\.md/);
  });

  test("a resolved notification is one e-mail marked RESOLVED with its end time", async () => {
    const h = harness();
    const n = firingNotification({ status: "resolved" });
    const alerts = n.alerts as Record<string, unknown>[];
    Object.assign(alerts[0] ?? {}, { status: "resolved", endsAt: "2026-11-19T21:10:00.000Z" });
    const res = await h.call(post(n));
    assert.equal(res.status, 200);
    assert.equal(h.sent.length, 1);
    const msg = parseMessage(h.sent[0]?.raw ?? "");
    assert.match(
      msg.headers.get("subject") ?? "",
      /^\[UsageMap RESOLVED\] critical IngestBurnRate/,
    );
    assert.match(msg.body, /Ended: +2026-11-19T21:10:00\.000Z/);
  });

  test("no e-mail without the exact bearer secret", async () => {
    for (const auth of [
      null,
      "",
      "Bearer",
      `Bearer ${TOKEN}x`,
      `bearer ${TOKEN}`,
      `Basic ${TOKEN}`,
      "Bearer wrong",
    ]) {
      const h = harness();
      const res = await h.call({ ...post(firingNotification()), auth });
      assert.equal(res.status, 401, `auth ${JSON.stringify(auth)}`);
      assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="alert-mailer"');
      assert.equal(h.sent.length, 0);
    }
  });

  test("wrong path, method, media type, size and payload are refused without sending", async () => {
    const cases: Array<[Parameters<ReturnType<typeof harness>["call"]>[0], number, string]> = [
      [{ path: "/", ...post(firingNotification()) }, 404, "not_found"],
      [{ method: "GET" }, 405, "method_not_allowed"],
      [
        { ...post(firingNotification()), headers: { "content-type": "text/plain" } },
        415,
        "unsupported_media_type",
      ],
      [{ body: "x".repeat(MAX_BODY_BYTES + 1) }, 413, "payload_too_large"],
      [{ body: "{not json" }, 400, "invalid_json"],
      [post({ ...firingNotification(), version: "3" }), 400, "invalid_notification"],
      [post({ ...firingNotification(), alerts: [] }), 400, "invalid_notification"],
      [
        post({ ...firingNotification(), alerts: [{ status: "firing", labels: { a: 1 } }] }),
        400,
        "invalid_notification",
      ],
    ];
    for (const [init, status, result] of cases) {
      const h = harness();
      const res = await h.call(init);
      assert.equal(res.status, status, result);
      assert.equal(((await res.json()) as { result: string }).result, result);
      assert.equal(h.sent.length, 0);
    }
  });

  test("missing or weak configuration is a 500 that names the binding, never its value", async () => {
    for (const [key, value] of [
      ["ALERT_TOKEN", "short"],
      ["MAIL_FROM", "not an address"],
      ["MAIL_TO", "x@y\r\nBcc: z@w.example"],
      ["MAIL", undefined],
    ] as const) {
      const h = harness();
      (h.env as Record<string, unknown>)[key] = value;
      const res = await h.call(post(firingNotification()));
      assert.equal(res.status, 500);
      assert.deepEqual(h.logs, [{ event: "misconfigured", reason: key }]);
      assert.equal(h.sent.length, 0);
    }
  });

  test("a send failure is a 502 with the runtime's error code only (Alertmanager retries)", async () => {
    const err = Object.assign(new Error(`cannot send to ${TO}`), { code: "E_RATE_LIMIT_EXCEEDED" });
    const h = harness({ failWith: err });
    const res = await h.call(post(firingNotification()));
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { result: "send_failed", code: "E_RATE_LIMIT_EXCEEDED" });
    assert.ok(!text.includes(TO));
    assert.ok(!JSON.stringify(h.logs).includes(TO));
  });

  test("logs carry counts and the receiver only: no address, label value or secret", async () => {
    const h = harness();
    await h.call(post(firingNotification()));
    await h.call({ ...post(firingNotification()), auth: "Bearer wrong" });
    assert.deepEqual(h.logs, [
      { event: "sent", status: "firing", receiver: "maintainers-critical", alerts: 1 },
      { event: "unauthorised" },
    ]);
  });
});

describe("message", () => {
  const fixed = {
    from: FROM,
    to: TO,
    now: new Date("2026-11-19T21:00:05Z"),
    messageId: "0b4c9f3e-6a43-4c55-9d0e-2a1f3b4c5d6e@usagemap.dev",
  };

  test("is a well-formed RFC 5322 message whose decoded body is the text body", () => {
    const n = validateNotification(firingNotification());
    assert.ok(typeof n !== "string");
    const raw = buildMessage(n, fixed);
    const msg = parseMessage(raw);
    assert.equal(msg.headers.get("date"), "Thu, 19 Nov 2026 21:00:05 +0000");
    assert.equal(msg.headers.get("message-id"), `<${fixed.messageId}>`);
    assert.equal(msg.body, bodyOf(n));
    assert.deepEqual(
      msg.headerLines.map((l) => l.split(":")[0]),
      [
        "From",
        "To",
        "Subject",
        "Date",
        "Message-ID",
        "MIME-Version",
        "Content-Type",
        "Content-Transfer-Encoding",
        "Auto-Submitted",
        "X-Auto-Response-Suppress",
      ],
    );
  });

  test("carries no personal data, secret, query string or internal URL", () => {
    const n = validateNotification(firingNotification());
    assert.ok(typeof n !== "string");
    const raw = buildMessage(n, fixed);
    const msg = parseMessage(raw);
    assertNoForbidden(raw, "raw message");
    assertNoForbidden(msg.body, "decoded body");
    assertNoForbidden(decodeHeader(msg.headers.get("subject") ?? ""), "subject");
    assert.match(msg.body, /instance=\[ip\]:9100/);
    assert.match(msg.body, /client_ip=\[redacted\]/);
    assert.match(msg.body, /user_agent=\[redacted\]/);
    assert.match(msg.body, /wallet=\[redacted\]/);
    assert.match(msg.body, /digest=\[redacted\]/);
    assert.match(msg.body, /https:\/\/example\.org\/pricing contact/);
    assert.match(
      msg.body,
      /contact \[email\], seed \[stellar-key\], key \[api-key\], Bearer \[token\]/,
    );
  });

  test("lists at most MAX_LISTED_ALERTS alerts and counts the rest, including Alertmanager's truncation", () => {
    const one = (firingNotification().alerts as unknown[])[0];
    const n = validateNotification(
      firingNotification({ alerts: Array(MAX_LISTED_ALERTS + 3).fill(one), truncatedAlerts: 4 }),
    );
    assert.ok(typeof n !== "string");
    const body = bodyOf(n);
    assert.equal(body.match(/^\[\d+\] FIRING/gm)?.length, MAX_LISTED_ALERTS);
    assert.match(body, /… and 7 more alert\(s\)/);
    assert.equal(
      subjectOf(n),
      `[UsageMap FIRING:${MAX_LISTED_ALERTS + 3}] critical IngestBurnRate (maintainers-critical)`,
    );
    parseMessage(buildMessage(n, fixed));
  });

  test("a non-ASCII subject is RFC 2047 encoded in words of at most 75 characters", () => {
    const n = validateNotification(
      firingNotification({
        commonLabels: { alertname: "Überlast — 東京 ✓".repeat(4), severity: "warning" },
      }),
    );
    assert.ok(typeof n !== "string");
    const msg = parseMessage(buildMessage(n, fixed));
    const subject = msg.headerLines.filter(
      (l, i, all) =>
        l.startsWith("Subject:") ||
        (i > 0 && /^ /.test(l) && all.slice(0, i).some((x) => x.startsWith("Subject:"))),
    );
    for (const word of subject.join(" ").match(/=\?UTF-8\?B\?[^?]*\?=/g) ?? [])
      assert.ok(word.length <= 75);
    assert.equal(decodeHeader(msg.headers.get("subject") ?? ""), subjectOf(n));
    assert.equal(encodeHeader("plain ascii"), "plain ascii");
  });

  test("header injection through labels is impossible (control characters become spaces)", () => {
    const n = validateNotification(
      firingNotification({
        commonLabels: { alertname: "X\r\nBcc: victim@example.net", severity: "critical" },
      }),
    );
    assert.ok(typeof n !== "string");
    const msg = parseMessage(buildMessage(n, fixed));
    assert.ok(!msg.headers.has("bcc"));
    assert.equal(
      msg.headers.get("subject"),
      "[UsageMap FIRING:1] critical X Bcc: [email] (maintainers-critical)",
    );
  });

  test("refuses addresses that could inject headers", () => {
    const n = validateNotification(firingNotification());
    assert.ok(typeof n !== "string");
    assert.throws(
      () => buildMessage(n, { ...fixed, to: "a@b.example\r\nBcc: c@d.example" }),
      TypeError,
    );
    assert.throws(() => buildMessage(n, { ...fixed, from: "Name <a@b.example>" }), TypeError);
  });
});

describe("helpers", () => {
  test("scrubValue keeps ordinary operational text", () => {
    for (const keep of [
      "ops/runbooks/end-of-window-no-successor.md",
      "app-1",
      "2026-11-19T20:58:00.000Z",
      "p99 latency 1.2 s over 10:30:00",
      "maintainers-critical",
      "sha-less image tag v0.35.0",
    ]) {
      assert.equal(scrubValue(keep), keep);
    }
  });

  test("scrubValue removes each sensitive kind", () => {
    assert.equal(scrubValue("from 10.0.0.12 and fe80::1"), "from [ip] and [ip]");
    assert.equal(scrubValue("https://a.example/p?q=1"), "https://a.example/p");
    assert.equal(scrubValue("x".repeat(600)).length, 512);
  });

  test("isSensitiveName", () => {
    for (const s of [
      "client_ip",
      "user_agent",
      "userAgent",
      "UserAgent",
      "api_token",
      "email",
      "wallet",
      "seed",
      "page_title",
      "query_string",
      "session_id",
    ]) {
      assert.ok(isSensitiveName(s), s);
    }
    for (const s of [
      "alertname",
      "instance",
      "severity",
      "team",
      "node",
      "operator_ref",
      "hostname",
      "integration",
      "monitor_id",
      "kind",
      "description",
    ]) {
      assert.ok(!isSensitiveName(s), s);
    }
  });

  test("isAddress", () => {
    assert.ok(isAddress("alerts@usagemap.dev"));
    for (const bad of ["", "a@b", "a b@c.dev", "<a@b.dev>", "a@b.dev\r\n", "a@-b.dev"])
      assert.ok(!isAddress(bad), bad);
  });

  test("authorised compares the whole secret", async () => {
    assert.ok(await authorised(`Bearer ${TOKEN}`, TOKEN));
    assert.ok(!(await authorised(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)));
    assert.ok(!(await authorised(null, TOKEN)));
    assert.ok(!(await authorised("Bearer ", "")));
  });

  test("rfc5322Date", () => {
    assert.equal(rfc5322Date(new Date("2026-01-02T03:04:05Z")), "Fri, 02 Jan 2026 03:04:05 +0000");
  });
});
