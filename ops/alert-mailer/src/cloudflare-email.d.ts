// SPDX-License-Identifier: Apache-2.0
// The one Workers runtime module the alert mailer imports (types only; provided by the Workers runtime, and in the
// tests by test/workerd/cloudflare-internal-email.js).
declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string | ReadableStream);
    readonly from: string;
    readonly to: string;
  }
}
