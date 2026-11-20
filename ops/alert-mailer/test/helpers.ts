// SPDX-License-Identifier: Apache-2.0
// Shared by the alert-mailer tests: Alertmanager payloads (webhook version 4, as Alertmanager v0.35 sends them)
// carrying every kind of data that must never reach a mailbox, and a strict reader of the raw message.

import assert from "node:assert/strict";

export const TOKEN = "test-only-bearer-secret-0123456789abcdef";
// Secret-shaped test values are assembled at run time so that no seed, JWT or key-shaped literal is committed.
// None is a real credential.
const SEED = ["SB", "ZVMB74Z76QZ3ZOY7UTDFYKMEGKW5XFJEB6PFKBF4UYSSWHG4EDH7PY"].join("");
const ACCOUNT = ["GB", "RPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H"].join("");
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJl"].join(".");
const API_KEY = ["scfa", "live_9f8e7d6c5b4a"].join("_");
export const FROM = "alerts@usagemap.dev";
export const TO = "operations-lead@example.org";

/** Values that must not appear anywhere in a message (subject, headers or decoded body). */
export const FORBIDDEN = [
  "203.0.113.7",
  "198.51.100.4",
  "2001:db8::17",
  "visitor@example.com",
  ACCOUNT,
  SEED,
  API_KEY,
  JWT,
  "utm_source=newsletter",
  "session=abc123",
  "Mozilla/5.0 (X11; Linux x86_64)",
  "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f",
  TOKEN,
  "g0.expr=up",
  "alertmanager.internal",
];

export function firingNotification(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "4",
    groupKey: '{}/{severity="critical"}:{alertname="IngestBurnRate", severity="critical"}',
    truncatedAlerts: 0,
    status: "firing",
    receiver: "maintainers-critical",
    groupLabels: { alertname: "IngestBurnRate", severity: "critical" },
    commonLabels: { alertname: "IngestBurnRate", severity: "critical", team: "platform" },
    commonAnnotations: { runbook_url: "ops/runbooks/ingest-burn-rate.md" },
    externalURL: "http://alertmanager.internal:9093",
    alerts: [
      {
        status: "firing",
        labels: {
          alertname: "IngestBurnRate",
          severity: "critical",
          team: "platform",
          instance: "203.0.113.7:9100",
          node: "app-1",
          client_ip: "198.51.100.4",
          user_agent: "Mozilla/5.0 (X11; Linux x86_64)",
          wallet: ACCOUNT,
          digest: "4f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f",
        },
        annotations: {
          summary: "Ingest error budget burning 14x (1h) on app-1",
          description:
            "Seen from 2001:db8::17 for https://example.org/pricing?utm_source=newsletter#top; contact " +
            `visitor@example.com, seed ${SEED}, key ${API_KEY}, Bearer ${JWT}, ` +
            `cookie session=abc123 and the alert token ${TOKEN}`,
          runbook_url: "ops/runbooks/ingest-burn-rate.md",
        },
        startsAt: "2026-11-19T20:58:00.000Z",
        endsAt: "0001-01-01T00:00:00Z",
        generatorURL: "http://prometheus:9090/graph?g0.expr=up&g0.tab=1",
        fingerprint: "a1b2c3d4e5f60718",
      },
    ],
    ...overrides,
  };
}

export interface ParsedMessage {
  headers: Map<string, string>;
  headerLines: string[];
  body: string;
}

/** Parses and checks an RFC 5322 / MIME message as the alert mailer must produce it. */
export function parseMessage(raw: string): ParsedMessage {
  assert.match(raw, /^[\x20-\x7e\r\n]*$/, "message is 7-bit ASCII");
  assert.ok(!/(?<!\r)\n|\r(?!\n)/.test(raw), "every line ends in CRLF");
  const split = raw.indexOf("\r\n\r\n");
  assert.ok(split > 0, "header and body are separated by an empty line");
  const headerLines = raw.slice(0, split).split("\r\n");
  const headers = new Map<string, string>();
  let last = "";
  for (const line of headerLines) {
    assert.ok(line.length <= 998, "header line ≤ 998 characters (RFC 5322 §2.1.1)");
    if (/^[ \t]/.test(line)) {
      assert.ok(last, "continuation follows a header");
      headers.set(last, `${headers.get(last)} ${line.trim()}`);
      continue;
    }
    const m = /^([A-Za-z0-9-]+): (.*)$/.exec(line);
    assert.ok(m, `well-formed header line: ${line}`);
    const name = (m[1] ?? "").toLowerCase();
    assert.ok(!headers.has(name), `header ${name} appears once`);
    headers.set(name, m[2] ?? "");
    last = name;
  }
  for (const h of ["from", "to", "subject", "date", "message-id", "mime-version", "content-type"]) {
    assert.ok(headers.has(h), `header ${h} present`);
  }
  assert.equal(headers.get("mime-version"), "1.0");
  assert.equal(headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(headers.get("content-transfer-encoding"), "base64");
  assert.equal(headers.get("auto-submitted"), "auto-generated");
  assert.match(headers.get("message-id") ?? "", /^<[0-9a-f-]{36}@usagemap\.dev>$/);
  assert.ok(!Number.isNaN(Date.parse(headers.get("date") ?? "")), "Date parses");
  assert.match(
    headers.get("date") ?? "",
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/,
  );
  const bodyLines = raw
    .slice(split + 4)
    .replace(/\r\n$/, "")
    .split("\r\n");
  for (const l of bodyLines)
    assert.match(l, /^[A-Za-z0-9+/=]{1,76}$/, "base64 body line ≤ 76 characters");
  const body = Buffer.from(bodyLines.join(""), "base64").toString("utf8");
  return { headers, headerLines, body };
}

/** Decodes RFC 2047 B-encoded words (UTF-8) in a header value. */
export function decodeHeader(v: string): string {
  return v
    .replace(/\?= =\?UTF-8\?B\?/g, "?==?UTF-8?B?")
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/g, (_, b: string) =>
      Buffer.from(b, "base64").toString("utf8"),
    );
}

export function assertNoForbidden(text: string, where: string): void {
  for (const f of FORBIDDEN)
    assert.ok(!text.includes(f), `${where} must not contain ${JSON.stringify(f)}`);
}
