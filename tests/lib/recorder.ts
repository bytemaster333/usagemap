// SPDX-License-Identifier: Apache-2.0
// Collects the outcome of every test in a suite and writes one evidence file pair per suite run (lib/evidence.ts).
// Nothing is written when no test ran (every test NOT RUN): evidence only comes from real runs.

import type { StackEnv } from "./env.ts";
import { type Check, writeEvidence } from "./evidence.ts";

interface TaskCtx {
  task: {
    name: string;
    result?: { state?: string; note?: string; errors?: { message?: string }[] };
  };
  onTestFinished: (fn: (c: TaskCtx) => void) => void;
}

export class Recorder {
  readonly checks: Check[] = [];
  readonly data: Record<string, unknown> = {};
  notes = "";

  readonly env: StackEnv;
  readonly layer: string;
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  constructor(env: StackEnv, layer: string, name: string, title: string, summary: string) {
    this.env = env;
    this.layer = layer;
    this.name = name;
    this.title = title;
    this.summary = summary;
  }

  /** Call first in a test: registers the check with its capability ids (docs/capabilities.md); `detail` may be set later via the return. */
  start(ctx: TaskCtx, ids: string[] = []): { detail: (s: string) => void } {
    let detail = "";
    ctx.onTestFinished((c) => {
      const r = c.task.result;
      const outcome =
        r?.state === "pass" ? "pass" : r?.state === "skip" ? "not_run" : ("fail" as const);
      const err = r?.errors?.[0]?.message?.split("\n")[0] ?? "";
      this.checks.push({
        name: c.task.name,
        outcome,
        ids,
        detail: [
          detail,
          outcome === "not_run" ? (r?.note ?? "") : "",
          outcome === "fail" ? err : "",
        ]
          .filter(Boolean)
          .join(" — ")
          .slice(0, 600),
      });
    });
    return { detail: (s) => (detail = s) };
  }

  write(): { json: string; md: string } | null {
    if (!this.checks.some((c) => c.outcome !== "not_run")) return null;
    return writeEvidence(this.env.evidenceDir, {
      layer: this.layer,
      name: this.name,
      title: this.title,
      summary: this.summary,
      checks: this.checks,
      data: this.data,
      notes: this.notes,
    });
  }
}
