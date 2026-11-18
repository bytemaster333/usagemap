// SPDX-License-Identifier: Apache-2.0
// src/env.ts — your site key (portal: site → Snippet), public and fixed at build time:
// PUBLIC_SCF_SITE=… pnpm build
import { defineEnvVars } from "@sveltejs/kit/env";

export const variables = defineEnvVars({ PUBLIC_SCF_SITE: { public: true, static: true } });
