// SPDX-License-Identifier: Apache-2.0
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: "2026-11-01",
  telemetry: false,
  devtools: { enabled: false },
  // your site key (portal: site → Snippet); set NUXT_PUBLIC_SCF_SITE in the server's environment
  runtimeConfig: { public: { scfSite: "" } },
});
