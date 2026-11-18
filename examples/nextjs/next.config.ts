// SPDX-License-Identifier: Apache-2.0
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The example lives in a monorepo with two lockfiles; the examples workspace is the root.
const root = dirname(dirname(fileURLToPath(import.meta.url)));

const config: NextConfig = { turbopack: { root }, outputFileTracingRoot: root };
export default config;
