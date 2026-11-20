// SPDX-License-Identifier: Apache-2.0
// Test stand-in for the `send_email` binding, configured like production (destination_address): it refuses a
// recipient other than the bound destination (E_RECIPIENT_NOT_ALLOWED), a sender off the routing domain
// (E_SENDER_NOT_VERIFIED) and a raw message without From or Message-ID (E_FIELD_MISSING), then hands the message
// to the test's capture server instead of a mail server. A 503 from the capture server becomes
// E_RATE_LIMIT_EXCEEDED, so the tests can exercise the failure path.
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export default function makeBinding(env) {
  return {
    async send(message) {
      if (!message || typeof message.from !== "string" || typeof message.to !== "string") {
        throw new TypeError("send() expects an EmailMessage");
      }
      if (message.to !== env.destination)
        throw fail("E_RECIPIENT_NOT_ALLOWED", "recipient not allowed");
      if (!message.from.endsWith(`@${env.routingDomain}`))
        throw fail("E_SENDER_NOT_VERIFIED", "sender not verified");
      const raw =
        typeof message.raw === "string" ? message.raw : await new Response(message.raw).text();
      const head = raw.split("\r\n\r\n", 1)[0] ?? "";
      if (!/^From: /im.test(head) || !/^Message-ID: <[^>]+>$/im.test(head)) {
        throw fail("E_FIELD_MISSING", "raw message needs From and Message-ID");
      }
      const res = await env.capture.fetch("http://capture/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: message.from, to: message.to, raw }),
      });
      if (res.status === 503) throw fail("E_RATE_LIMIT_EXCEEDED", "rate limited");
      if (!res.ok) throw new Error(`capture server answered ${res.status}`);
      return { messageId: "test" };
    },
  };
}
