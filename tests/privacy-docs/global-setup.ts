// SPDX-License-Identifier: Apache-2.0
// Starts the throwaway database of the privacy-documents suite (compose.yaml, project scf-tg-w1 unless
// SCF_PRIVACY_DOCS_PROJECT is set), builds the real db/Dockerfile images and applies every migration with the real
// runner. No Docker is a failure, not a skip (C-114: a suite never reports ok without having run). KEEP=1 keeps it.

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPOSE_FILE = join(dirname(fileURLToPath(import.meta.url)), "compose.yaml");
export const PROJECT = process.env.SCF_PRIVACY_DOCS_PROJECT ?? "scf-tg-w1";

const dc = (...args: string[]) =>
  execFileSync("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

export async function setup(): Promise<void> {
  try {
    dc("up", "-d", "--build", "--wait", "pg");
    dc("--profile", "tools", "build", "migrate");
    dc("--profile", "tools", "run", "--rm", "-T", "migrate", "migrate");
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `privacy-docs: database setup failed (Docker required): ${err.message}\n${err.stdout ?? ""}${err.stderr ?? ""}`,
    );
  }
}

export async function teardown(): Promise<void> {
  if (process.env.KEEP === "1") return;
  dc("--profile", "tools", "down", "-v", "--remove-orphans");
}
