// SPDX-License-Identifier: Apache-2.0
// Starts the mock control plane for Playwright's webServer: node e2e/support/run-mock.ts <port>
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer } from "./mock-server.ts";

const port = Number(process.argv[2] ?? 56230);
const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist");
const s = await startMockServer({ port, distDir });
console.log(`mock control plane at ${s.url}`);
