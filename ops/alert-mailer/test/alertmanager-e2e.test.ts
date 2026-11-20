// SPDX-License-Identifier: Apache-2.0
// End to end, offline: the compose_stack role renders the Alertmanager configuration (pinned Ansible tool image,
// the release's route tree, the e-mail route to the alert mailer), the pinned Alertmanager runs it, a firing alert
// is posted to Alertmanager's API, and the alert mailer in workerd turns the notification into exactly one
// well-formed e-mail with no personal data or secret in it. Needs Docker; skipped unless SCF_ALERT_MAILER_E2E=1.
// Run: pnpm --filter @usagemap/alert-mailer test:e2e   (containers scf-alertmailer-e2e-*, removed at the end)

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Captured, freePort, startCapture, startWorkerd } from "./harness.ts";
import {
  assertNoForbidden,
  decodeHeader,
  FROM,
  firingNotification,
  parseMessage,
  TO,
  TOKEN,
} from "./helpers.ts";

const ENABLED = process.env.SCF_ALERT_MAILER_E2E === "1";
const REPO = resolve(import.meta.dirname, "..", "..", "..");
const TOOLS_IMAGE = "usagemap/ansible-tools:2.22.0";
// The image the monitoring overlay runs (infra/compose/compose.monitoring.yaml).
const AM_IMAGE =
  "prom/alertmanager:v0.35.0@sha256:e638797febd034838eca8b98cdbd46f951e9bf7f178777aa8669167406a9946c";
const NAME = `scf-alertmailer-e2e-${process.pid}`;

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Alertmanager → alert mailer → one e-mail", {
  skip: !ENABLED && "set SCF_ALERT_MAILER_E2E=1 (needs Docker)",
}, () => {
  let dir: string;
  let capture: Awaited<ReturnType<typeof startCapture>>;
  let worker: Awaited<ReturnType<typeof startWorkerd>>;
  let amPort: number;
  let rendered: string;
  let withFallback: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "scf-alertmailer-e2e-"));
    chmodSync(dir, 0o755);
    for (const d of ["out", "secrets"]) {
      execFileSync("mkdir", ["-m", "0777", join(dir, d)]);
    }
    capture = await startCapture();
    worker = await startWorkerd(capture.port);
    amPort = await freePort();

    // 1. The role's template, rendered by Ansible with the e-mail route on and the local-only fallback off.
    docker(
      "build",
      "-q",
      "-t",
      TOOLS_IMAGE,
      "-f",
      join(REPO, "infra/ansible/tools/Dockerfile"),
      join(REPO, "infra/ansible"),
    );
    const vars = {
      scf_alert_receivers_all: [
        "maintainers-critical",
        "maintainers-warning",
        "security-responders",
        "portal-notices",
      ],
      scf_alert_emails: {},
      scf_alert_smtp_smarthost: "",
      scf_alert_webhooks: {},
      scf_alert_deadman_url: "",
      scf_alert_local_only: false,
      scf_alert_email_worker_url: `${worker.url}/v1/alertmanager`,
      scf_alert_email_worker_receivers: [
        "maintainers-critical",
        "maintainers-warning",
        "security-responders",
      ],
      scf_alert_email_worker_max_alerts: 50,
    };
    const render = (v: Record<string, unknown>, file: string) => {
      writeFileSync(join(dir, "out", "vars.json"), JSON.stringify({ ...v, out: `/out/${file}` }));
      docker(
        "run",
        "--rm",
        "--network",
        "none",
        "--name",
        `${NAME}-render`,
        "-e",
        "HOME=/tmp",
        "-e",
        "ANSIBLE_LOCAL_TEMP=/tmp/.a",
        "-v",
        `${REPO}:/repo:ro`,
        "-v",
        `${join(dir, "out")}:/out`,
        "-w",
        "/repo/ops/alert-mailer/test",
        TOOLS_IMAGE,
        "ansible-playbook",
        "-i",
        "localhost,",
        "-c",
        "local",
        "render-alertmanager.yml",
        "-e",
        "@/out/vars.json",
      );
      return readFileSync(join(dir, "out", file), "utf8");
    };
    rendered = render(vars, "alertmanager.yml");
    withFallback = render({ ...vars, scf_alert_local_only: true }, "alertmanager-fallback.yml");

    // 2. Secrets as the role mounts them (files under /run/secrets, read by uid 65534).
    writeFileSync(join(dir, "secrets", "am_email_worker_token"), TOKEN, { mode: 0o644 });
    writeFileSync(join(dir, "secrets", "heartbeat_token"), "test-heartbeat-token", { mode: 0o644 });

    // 3. The pinned Alertmanager with that configuration (host network: it reaches workerd on 127.0.0.1).
    const mounts = [
      "-v",
      `${join(dir, "out")}:/etc/alertmanager:ro`,
      "-v",
      `${join(dir, "secrets")}:/run/secrets:ro`,
    ];
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "/bin/amtool",
      ...mounts,
      AM_IMAGE,
      "check-config",
      "/etc/alertmanager/alertmanager.yml",
    );
    docker(
      "run",
      "-d",
      "--name",
      NAME,
      "--network",
      "host",
      "--user",
      "65534:65534",
      ...mounts,
      AM_IMAGE,
      "--config.file=/etc/alertmanager/alertmanager.yml",
      "--storage.path=/tmp",
      `--web.listen-address=127.0.0.1:${amPort}`,
      "--cluster.listen-address=",
    );
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${amPort}/-/ready`)).ok) return;
      } catch {
        // not up yet
      }
      await sleep(500);
    }
    throw new Error(
      `Alertmanager did not start: ${spawnSync("docker", ["logs", NAME], { encoding: "utf8" }).stderr}`,
    );
  });

  after(() => {
    spawnSync("docker", ["rm", "-f", NAME, `${NAME}-render`], { stdio: "ignore" });
    worker?.proc.kill();
    capture?.server.closeAllConnections();
    capture?.server.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("the rendered configuration routes the receivers to the mailer with the secret as a file only", () => {
    assert.ok(!rendered.includes(TOKEN), "the bearer secret is never in the configuration");
    assert.ok(!rendered.includes("victorialogs"), "local-only fallback off");
    assert.equal(
      rendered.match(/credentials_file: \/run\/secrets\/am_email_worker_token/g)?.length,
      3,
    );
    assert.equal(rendered.match(/max_alerts: 50/g)?.length, 3);
  });

  test("the local-only fallback can stay on alongside the e-mail route (both receive)", () => {
    assert.equal(
      withFallback.match(/credentials_file: \/run\/secrets\/am_email_worker_token/g)?.length,
      3,
    );
    assert.equal(withFallback.match(/victorialogs:9428\/insert\/jsonline/g)?.length, 4);
  });

  test("a firing critical alert becomes exactly one well-formed e-mail without personal data or secrets", async () => {
    const fixture = (
      firingNotification().alerts as Array<{
        labels: Record<string, string>;
        annotations: Record<string, string>;
      }>
    )[0];
    assert.ok(fixture);
    const labels = { ...fixture.labels, alertname: "AlertMailerE2E" };
    const res = await fetch(`http://127.0.0.1:${amPort}/api/v2/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          labels,
          annotations: fixture.annotations,
          generatorURL: "http://prometheus:9090/graph?g0.expr=up&g0.tab=1",
        },
      ]),
    });
    assert.equal(res.status, 200, await res.text());

    // The route tree's group_wait is 30 s; then exactly one notification, and none again before group_interval.
    const deadline = Date.now() + 90_000;
    while (capture.messages.length === 0 && Date.now() < deadline) await sleep(500);
    assert.equal(capture.messages.length, 1, `one e-mail within 90 s; workerd: ${worker.output()}`);
    await sleep(10_000);
    assert.equal(capture.messages.length, 1, "no second e-mail for the same notification");

    const m = capture.messages[0] as Captured;
    assert.equal(m.from, FROM);
    assert.equal(m.to, TO);
    const msg = parseMessage(m.raw);
    assert.equal(
      decodeHeader(msg.headers.get("subject") ?? ""),
      "[UsageMap FIRING:1] critical AlertMailerE2E (maintainers-critical)",
    );
    assert.match(msg.body, /Runbook: +ops\/runbooks\/ingest-burn-rate\.md/);
    assert.match(msg.body, /Labels: .*instance=\[ip\]:9100/);
    assertNoForbidden(m.raw, "raw message");
    assertNoForbidden(msg.body, "decoded body");
    assertNoForbidden(worker.output(), "workerd output");
    const amLog = spawnSync("docker", ["logs", NAME], { encoding: "utf8" });
    assert.ok(
      !`${amLog.stdout}${amLog.stderr}`.includes(TOKEN),
      "Alertmanager never logs the secret",
    );
  });
});
