// SPDX-License-Identifier: Apache-2.0
// Docker Compose access for the suites: SQL as the PostgreSQL superuser through `docker compose exec` (the database
// publishes no port), service logs, stop/kill/start for chaos, reading named volumes through a throwaway container.
// Only the configured project is ever touched.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT, type StackEnv } from "./env.ts";

const run = promisify(execFile);

/** Pinned Node image for helper containers (same digest as infra/compose's fake Horizon). */
export const NODE_IMAGE =
  "node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995";

export class Compose {
  readonly env: StackEnv;
  constructor(env: StackEnv) {
    this.env = env;
  }

  private base(): string[] {
    const a = ["compose", "-p", this.env.project];
    for (const f of this.env.composeFiles) a.push("-f", f);
    return a;
  }

  async dc(args: string[], timeoutMs = 300_000): Promise<string> {
    // The superuser password reaches `exec -e PGPASSWORD` through this process's environment, never through argv
    // (argv is echoed in error messages and visible in the process table).
    const { stdout } = await run("docker", [...this.base(), ...args], {
      timeout: timeoutMs,
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, ...this.extraEnv(), PGPASSWORD: this.superuserPassword() },
    });
    return stdout;
  }

  /** Variables the override needs to parse (its paths are resolved at parse time). */
  extraEnv(): Record<string, string> {
    return {
      SCF_WSL_WORK: this.env.workDir,
      SCF_INGEST_PORT: process.env.SCF_INGEST_PORT ?? "56300",
      SCF_CONTROL_PLANE_PORT: process.env.SCF_CONTROL_PLANE_PORT ?? "56302",
      SCF_PORTAL_PORT: process.env.SCF_PORTAL_PORT ?? "56303",
    };
  }

  superuserPassword(): string {
    // SCF_COMPOSE_SECRETS_DIR: the stack's secrets when it was started from another checkout (default: this one).
    const dir = process.env.SCF_COMPOSE_SECRETS_DIR ?? join(REPO_ROOT, "infra/compose/.secrets");
    return readFileSync(join(dir, "pg_superuser_password"), "utf8").trim();
  }

  /** Runs SQL as the superuser; returns rows as arrays of strings (psql -At, field separator \x1f). */
  async sql(db: "scf" | "umami", query: string): Promise<string[][]> {
    const out = await this.dc([
      "exec",
      "-T",
      "-e",
      "PGPASSWORD",
      "postgres",
      "psql",
      "-X",
      "-At",
      "-F",
      "\x1f",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      db,
      "-c",
      query,
    ]);
    return out
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.split("\x1f"));
  }

  async scalar(db: "scf" | "umami", query: string): Promise<string> {
    const rows = await this.sql(db, query);
    return rows[0]?.[0] ?? "";
  }

  /** Full logical dump of a database (data + schema), as text. */
  async pgDump(db: "scf" | "umami"): Promise<string> {
    return this.dc(
      [
        "exec",
        "-T",
        "-e",
        "PGPASSWORD",
        "postgres",
        "pg_dump",
        "-U",
        "postgres",
        "--no-owner",
        "--inserts",
        "-d",
        db,
      ],
      600_000,
    );
  }

  async services(all = true): Promise<string[]> {
    const out = await this.dc(["ps", ...(all ? ["-a"] : []), "--services"]);
    return out.split("\n").filter(Boolean);
  }

  async logs(service: string): Promise<string> {
    const { stdout, stderr } = await run(
      "docker",
      [...this.base(), "logs", "--no-color", "--no-log-prefix", service],
      { maxBuffer: 512 * 1024 * 1024, env: { ...process.env, ...this.extraEnv() } },
    );
    return stdout + stderr;
  }

  async containerId(service: string): Promise<string> {
    return (await this.dc(["ps", "-q", service])).trim();
  }

  /** Concatenated content of every regular file in a named volume of this project (read-only mount). */
  async volumeFiles(volume: string): Promise<{ path: string; text: string }[]> {
    const name = `${this.env.project}_${volume}`;
    const { stdout } = await run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        // read-only access to files owned by the service's own uid (gateway 65532, Collector …), nothing else
        "--cap-add",
        "DAC_READ_SEARCH",
        "-v",
        `${name}:/v:ro`,
        "--entrypoint",
        "sh",
        NODE_IMAGE,
        "-c",
        'cd /v && find . -type f | while read -r f; do printf "\\n==FILE== %s\\n" "$f"; cat "$f"; done',
      ],
      { maxBuffer: 1024 * 1024 * 1024, encoding: "latin1" },
    );
    const parts = stdout.split("\n==FILE== ").slice(1);
    return parts.map((p) => {
      const nl = p.indexOf("\n");
      return { path: p.slice(0, nl), text: p.slice(nl + 1) };
    });
  }

  /** One file of a named volume (read-only mount, read-search capability only). */
  async volumeFile(volume: string, path: string): Promise<string> {
    const { stdout } = await run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "DAC_READ_SEARCH",
        "-v",
        `${this.env.project}_${volume}:/v:ro`,
        "--entrypoint",
        "cat",
        NODE_IMAGE,
        `/v/${path}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return stdout;
  }

  async volumeExists(volume: string): Promise<boolean> {
    try {
      await run("docker", ["volume", "inspect", `${this.env.project}_${volume}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Gateway addresses of the project's networks: the address a host-originated connection appears to come from. */
  async networkGateways(): Promise<string[]> {
    const { stdout } = await run("docker", [
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${this.env.project}`,
      "--format",
      "{{.Name}}",
    ]);
    const out: string[] = [];
    for (const n of stdout.split("\n").filter(Boolean)) {
      const { stdout: g } = await run("docker", [
        "network",
        "inspect",
        "-f",
        "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
        n,
      ]);
      out.push(...g.split(/\s+/).filter(Boolean));
    }
    return out;
  }

  async stop(service: string): Promise<void> {
    await this.dc(["stop", "-t", "5", service]);
  }
  async kill(service: string): Promise<void> {
    await this.dc(["kill", "-s", "SIGKILL", service]);
  }
  async start(service: string): Promise<void> {
    await this.dc(["start", service]);
    // `compose start umami` also re-runs its dependency chain umami-views-drop → umami-migrate, which drops the
    // scf_ro views the rollup reads; umami-views (not a dependency of umami) must run again afterwards.
    if (service === "umami") await this.dc(["start", "umami-views"]);
  }
  /**
   * Starts a stopped or SIGKILLed service's own container again and nothing else: `up -d --no-deps --no-build
   * --no-recreate`. `compose start` would also start its dependencies (and re-run one-shot steps such as
   * umami-views-drop → umami-migrate), which is not the fault being injected (chaos runners).
   */
  async upNoDeps(service: string): Promise<void> {
    await this.dc(["up", "-d", "--no-deps", "--no-build", "--no-recreate", service]);
  }
  async restart(service: string): Promise<void> {
    await this.dc(["restart", service]);
  }
}
