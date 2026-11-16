// SPDX-License-Identifier: Apache-2.0
// Schedules the snapshot builder: every interval (default 10 s) and, when a direct connection is configured, within a
// moment of `NOTIFY scf_edge` (wire-formats §e.1). LISTEN needs a session, so it never goes through PgBouncer.

import pg from "pg";
import type { SnapshotBuilder } from "./snapshot.ts";

export interface LoopLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export class SnapshotLoop {
  readonly #builder: SnapshotBuilder;
  readonly #intervalMs: number;
  readonly #listenUrl: string | undefined;
  readonly #log: LoopLogger;
  #timer: NodeJS.Timeout | undefined;
  #listener: pg.Client | undefined;
  #running = false;
  #again = false;
  #stopped = false;
  readonly #onOutcome: ((o: "success" | "failure") => void) | undefined;

  constructor(
    builder: SnapshotBuilder,
    opts: {
      intervalMs: number;
      listenUrl: string | undefined;
      log: LoopLogger;
      onOutcome?: (o: "success" | "failure") => void;
    },
  ) {
    this.#onOutcome = opts.onOutcome;
    this.#builder = builder;
    this.#intervalMs = opts.intervalMs;
    this.#listenUrl = opts.listenUrl;
    this.#log = opts.log;
  }

  async start(): Promise<void> {
    await this.trigger();
    this.#timer = setInterval(() => void this.trigger(), this.#intervalMs);
    if (this.#listenUrl) await this.#listen(this.#listenUrl);
  }

  async #listen(url: string): Promise<void> {
    const client = new pg.Client({
      connectionString: url,
      application_name: "scf-edge-snapshot-listen",
    });
    client.on("error", () => {
      // Reconnect later; the interval keeps the snapshot fresh meanwhile.
      this.#listener = undefined;
      if (!this.#stopped) setTimeout(() => void this.#listen(url).catch(() => {}), 5000);
    });
    client.on("notification", () => void this.trigger());
    await client.connect();
    await client.query("LISTEN scf_edge");
    this.#listener = client;
  }

  /** Runs one build; concurrent triggers coalesce into one extra run. */
  async trigger(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    try {
      do {
        this.#again = false;
        const r = await this.#builder.build();
        if (r.issued) this.#log.info({ sequence: r.sequence }, "edge snapshot issued");
      } while (this.#again && !this.#stopped);
      this.#onOutcome?.("success");
    } catch (err) {
      this.#onOutcome?.("failure");
      this.#log.error(
        { err: err instanceof Error ? err.name : "error" },
        "edge snapshot build failed",
      );
    } finally {
      this.#running = false;
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#listener?.end().catch(() => {});
  }
}
