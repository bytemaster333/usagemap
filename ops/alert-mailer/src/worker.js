// SPDX-License-Identifier: Apache-2.0
// @ts-check
// Cloudflare Worker entry of the alert mailer (runbook ops/runbooks/alert-email.md). Alertmanager posts each
// notification to POST /v1/alertmanager with a bearer secret; the worker sends exactly one e-mail through its
// `send_email` binding to the operations lead's verified Email Routing destination address. Configuration comes
// from bindings set at deploy time (ops/scripts/cloudflare-email-setup.sh), never from this repository:
//   MAIL         send_email binding, restricted to the destination address (destination_address)
//   MAIL_FROM    plain text, alerts@usagemap.dev (a routing address of the zone)
//   MAIL_TO      secret text, the destination address
//   ALERT_TOKEN  secret text, the bearer secret Alertmanager presents (credentials_file on the host)
import { EmailMessage } from "cloudflare:email";
import { handle } from "./mailer.js";

export default {
  /**
   * @param {Request} request
   * @param {import("./mailer.js").Env} env
   */
  fetch(request, env) {
    return handle(request, env, (from, to, raw) => new EmailMessage(from, to, raw));
  },
};
