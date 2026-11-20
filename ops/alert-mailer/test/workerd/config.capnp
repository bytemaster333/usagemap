# SPDX-License-Identifier: Apache-2.0
# workerd configuration of the alert-mailer tests: the two production modules unchanged, a send_email stand-in as a
# wrapped binding, the capture server as an external service. The test overrides both addresses on the command line
# (--socket-addr http=…, --external-addr capture=…). Every value here is a test value.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "mailer", worker = .mailer),
    (name = "capture", external = (address = "127.0.0.1:1", http = ())),
  ],
  sockets = [(name = "http", address = "127.0.0.1:1", http = (), service = "mailer")],
  extensions = [(modules = [
    (name = "cloudflare-internal:email", esModule = embed "cloudflare-internal-email.js", internal = true),
    (name = "scf-test:send-email", esModule = embed "fake-send-email.js", internal = true),
  ])],
);

const mailer :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "../../src/worker.js"),
    (name = "mailer.js", esModule = embed "../../src/mailer.js"),
  ],
  compatibilityDate = "2026-11-01",
  bindings = [
    (name = "MAIL", wrapped = (moduleName = "scf-test:send-email", innerBindings = [
      (name = "destination", text = "operations-lead@example.org"),
      (name = "routingDomain", text = "usagemap.dev"),
      (name = "capture", service = "capture"),
    ])),
    (name = "MAIL_FROM", text = "alerts@usagemap.dev"),
    (name = "MAIL_TO", text = "operations-lead@example.org"),
    (name = "ALERT_TOKEN", text = "test-only-bearer-secret-0123456789abcdef"),
  ],
);
