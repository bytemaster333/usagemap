// SPDX-License-Identifier: Apache-2.0
// The job runner: schedules named jobs, runs each under its single-instance lock (lock.ts), records metrics and
// structured logs, and stops gracefully. Two instances may run side by side (one per core, C-07): for each trigger
// exactly one of them obtains the lock and runs the job; the other records `skipped_locked`. Within one instance a
// trigger that arrives while the job is running is queued once and runs afterwards, so a daily run is never lost to an
// hourly run of the same job.

import type { JobName } from "./config.ts";
import type { Locker } from "./lock.ts";
import { errorFields, type Logger } from "./log.ts";
import type { JobMetrics } from "./metrics.ts";
import { nextRun, type Schedule } from "./schedule.ts";

export interface JobContext {
  /** Aborted at shutdown or when the lock connection is lost: stop at the next unit boundary. */
  signal: AbortSignal;
  /** The trigger that started the run (e.g. "hourly", "daily", "start", "manual"). */
  mode: string;
  /** The clock of this run (fixed at its start). */
  now: Date;
  log: Logger;
  metrics: JobMetrics;
}

export interface Trigger {
  schedule: Schedule;
  mode: string;
}

export interface JobDef {
  name: JobName;
  triggers: Trigger[];
  run(ctx: JobContext): Promise<void>;
}

export type Outcome = "success" | "failure" | "skipped_locked" | "aborted";

export interface RunnerOptions {
  locker: Locker;
  log: Logger;
  metrics: JobMetrics;
  clock?: () => Date;
}

export class Runner {
  readonly #jobs = new Map<JobName, JobDef>();
  readonly #running = new Map<JobName, Promise<Outcome>>();
  readonly #queued = new Map<JobName, string[]>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #shutdown = new AbortController();
  readonly #opts: RunnerOptions;
  #started = false;

  constructor(opts: RunnerOptions) {
    this.#opts = opts;
  }

  get stopping(): boolean {
    return this.#shutdown.signal.aborted;
  }

  get started(): boolean {
    return this.#started;
  }

  register(job: JobDef): void {
    if (this.#jobs.has(job.name)) throw new Error(`job ${job.name} registered twice`);
    this.#jobs.set(job.name, job);
  }

  jobs(): JobName[] {
    return [...this.#jobs.keys()];
  }

  /** Arms every trigger; with `runOnStart` each job also runs once now (mode "start"). */
  start(runOnStart: boolean): void {
    if (this.#started) return;
    this.#started = true;
    for (const job of this.#jobs.values()) {
      for (const t of job.triggers) this.#arm(job.name, t);
      if (runOnStart) void this.trigger(job.name, "start");
    }
  }

  #arm(name: JobName, t: Trigger): void {
    if (this.stopping) return;
    const now = this.#now();
    const delay = Math.max(0, nextRun(t.schedule, now).getTime() - now.getTime());
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.trigger(name, t.mode);
      this.#arm(name, t);
    }, delay);
    timer.unref();
    this.#timers.add(timer);
  }

  #now(): Date {
    return this.#opts.clock ? this.#opts.clock() : new Date();
  }

  /**
   * Runs the job now (subject to its lock). If this instance is already running it, the trigger is queued once per
   * mode and the returned promise resolves when the queued run has finished.
   */
  async trigger(name: JobName, mode: string): Promise<Outcome> {
    if (!this.#jobs.has(name)) throw new Error(`unknown job ${name}`);
    if (this.stopping) return "aborted";
    const current = this.#running.get(name);
    if (current) {
      const q = this.#queued.get(name) ?? [];
      if (!q.includes(mode)) q.push(mode);
      this.#queued.set(name, q);
      // The running loop drains the queue before it resolves, so this includes the queued run.
      return await current;
    }
    const p = this.#runLoop(name, mode);
    this.#running.set(name, p);
    try {
      return await p;
    } finally {
      if (this.#running.get(name) === p) this.#running.delete(name);
    }
  }

  async #runLoop(name: JobName, firstMode: string): Promise<Outcome> {
    let mode: string | undefined = firstMode;
    let last: Outcome = "aborted";
    while (mode !== undefined && !this.stopping) {
      last = await this.#runOnce(name, mode);
      const q = this.#queued.get(name);
      mode = q?.shift();
      if (q && q.length === 0) this.#queued.delete(name);
    }
    return last;
  }

  async #runOnce(name: JobName, mode: string): Promise<Outcome> {
    const job = this.#jobs.get(name) as JobDef;
    const { log, metrics, locker } = this.#opts;
    let lease: Awaited<ReturnType<Locker["tryAcquire"]>>;
    try {
      lease = await locker.tryAcquire(name);
    } catch (err) {
      metrics.runs.inc({ job: name, outcome: "failure" });
      log.error("job_lock_failed", { job: name, mode, ...errorFields(err) });
      return "failure";
    }
    if (!lease) {
      metrics.runs.inc({ job: name, outcome: "skipped_locked" });
      log.info("job_skipped_locked", { job: name, mode });
      return "skipped_locked";
    }
    const signal = AbortSignal.any([lease.signal, this.#shutdown.signal]);
    const started = performance.now();
    const now = this.#now();
    metrics.running.set({ job: name }, 1);
    log.info("job_started", { job: name, mode });
    let outcome: Outcome;
    try {
      await job.run({ signal, mode, now, log, metrics });
      outcome = signal.aborted ? "aborted" : "success";
    } catch (err) {
      outcome = signal.aborted ? "aborted" : "failure";
      log.error("job_failed", { job: name, mode, ...errorFields(err) });
    } finally {
      await lease.release();
      metrics.running.set({ job: name }, 0);
    }
    const seconds = (performance.now() - started) / 1000;
    metrics.runs.inc({ job: name, outcome });
    metrics.lastDuration.set({ job: name }, seconds);
    if (outcome === "success") metrics.lastSuccess.set({ job: name }, Date.now() / 1000);
    log.info("job_finished", {
      job: name,
      mode,
      outcome,
      duration_ms: Math.round(seconds * 1000),
    });
    return outcome;
  }

  /** Stops scheduling, aborts running jobs and waits for them up to `graceMs`. */
  async stop(graceMs: number): Promise<boolean> {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#shutdown.abort();
    this.#queued.clear();
    const running = [...this.#running.values()];
    if (running.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    });
    const done = Promise.allSettled(running).then(() => true as const);
    const ok = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    return ok;
  }
}

/** Throws an AbortError if the run must stop (call between units of work). */
export function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  }
}
