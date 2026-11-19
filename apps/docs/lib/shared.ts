// SPDX-License-Identifier: Apache-2.0
export const appName = "UsageMap";
/** Page URLs: the docs own the whole docs.usagemap.dev host. */
export const docsRoute = "/";

/** Public hosts of the product; the docs link to them, never into the (private) source repository. */
export const origins = {
  docs: "https://docs.usagemap.dev",
  site: "https://usagemap.dev",
  app: "https://app.usagemap.dev",
  status: "https://status.usagemap.dev",
} as const;
