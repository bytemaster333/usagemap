// SPDX-License-Identifier: Apache-2.0
// app/plugins/scf-analytics.client.ts — `.client`: runs in the browser only, once per page load
import { init } from "@usagemap/tracker"; // or "@usagemap/tracker/strict"

export default defineNuxtPlugin(() => {
  const scf = init({ site: useRuntimeConfig().public.scfSite });
  // available as useNuxtApp().$scf in components (undefined if the tracker did not start)
  return { provide: { scf } };
});
