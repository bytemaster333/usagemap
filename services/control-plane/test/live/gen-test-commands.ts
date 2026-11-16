// SPDX-License-Identifier: Apache-2.0
// Prints a card's test command exactly as the integration catalogue renders it (used by integration-test-commands.sh):
//   node gen-test-commands.ts <ctx.json> <card id>
// ctx.json holds the rows the handler would load: { site, service, tenant, versions (GET /v1/tracker/versions),
// hosts (the ingest origins compiled into the active version), ingestOrigin (where the curl goes; the local stack's
// port differs from the compiled hosts), otlpEndpoint, portalOrigin }. The pin comes from the real trackerPin, as in
// listIntegrations.
import { readFileSync } from "node:fs";
import { definition, type RenderCtx, render } from "../../src/integrations/catalogue.ts";
import { trackerPin } from "../../src/onboarding/kit.ts";
import type { TrackerVersionView } from "../../src/tracker.ts";

const [file, id] = process.argv.slice(2);
if (!file || !id) throw new Error("usage: gen-test-commands.ts <ctx.json> <card id>");
const raw = JSON.parse(readFileSync(file, "utf8")) as Omit<RenderCtx, "pin" | "ingestOrigins"> & {
  versions: TrackerVersionView[];
  hosts: string[];
};
const d = definition(id);
if (!d) throw new Error(`unknown card ${id}`);
const ctx: RenderCtx = {
  site: raw.site,
  pin: raw.site ? trackerPin(raw.versions, () => raw.hosts, raw.site.tracker_profile) : null,
  ingestOrigin: raw.ingestOrigin,
  otlpEndpoint: raw.otlpEndpoint,
  service: raw.service,
  portalOrigin: raw.portalOrigin,
  ingestOrigins: raw.hosts,
  tenant: raw.tenant,
};
const card = render(d, ctx);
if (card.needs || !card.test.command)
  throw new Error(`${id}: no test command (${card.needs ?? "none"})`);
process.stdout.write(`${card.test.command.code}\n`);
