// SPDX-License-Identifier: Apache-2.0
// Test stand-in for the runtime's internal email module (workerd delegates `cloudflare:email` to the embedder; the
// Workers runtime and Miniflare supply their own). The constructor checks what the Workers runtime checks before
// anything is sent: two addresses and a raw message.
class EmailMessage {
  constructor(from, to, raw) {
    if (typeof from !== "string" || typeof to !== "string")
      throw new TypeError("from and to must be strings");
    if (typeof raw !== "string" && !(raw instanceof ReadableStream))
      throw new TypeError("raw must be a string or stream");
    this.from = from;
    this.to = to;
    this.raw = raw;
  }
}
export default { EmailMessage };
