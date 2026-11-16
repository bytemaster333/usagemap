// SPDX-License-Identifier: Apache-2.0
// Entry point of the jobs service: load configuration, start the health listener and the runner, stop gracefully on
// SIGTERM/SIGINT (running jobs finish their current unit of work, locks are released, pools closed).

import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger, errorFields } from "./log.ts";

const bootLog = createLogger({ service: "jobs" });

let cfg: ReturnType<typeof loadConfig>;
try {
  cfg = loadConfig();
} catch (err) {
  bootLog.error("config_invalid", {
    reason:
      err instanceof ConfigError
        ? err.message.replace(/[^A-Za-z0-9_.]+/g, "_").slice(0, 96)
        : "unreadable",
  });
  process.exit(2);
}

const app = buildApp(cfg);
const port = await app.listen();
app.log.info("jobs_started", { port, jobs: app.runner.jobs().join("+") });
app.runner.start(cfg.runOnStart);
try {
  await app.startCoreWorkers();
} catch (err) {
  app.log.error("core_workers_failed", errorFields(err));
  process.exit(2);
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info("jobs_stopping", { signal });
  try {
    await app.stop();
    app.log.info("jobs_stopped", {});
    process.exit(0);
  } catch (err) {
    app.log.error("jobs_stop_failed", errorFields(err));
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  app.log.error("unhandled_rejection", errorFields(err));
});
