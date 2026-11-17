// SPDX-License-Identifier: Apache-2.0
// The "user tracking" paragraph of an ecosystem grant application. Grant programmes such as SCF ask applicants to
// "provide an explanation of plans for user tracking and efforts to limit and protect users". This module turns the facts of one project's actual setup — what delivered data in the
// window, with which privacy settings — into that paragraph, a Mermaid flow of the measured data and a source list.
//
// Rules:
//   - It never claims more than is measured: a source that is set up but delivered nothing in the window is listed as
//     `configured` and is not named in the paragraph. With nothing measured, the paragraph says so.
//   - Every privacy statement is a property of the platform's design that holds for every tenant (no cookies, no IP
//     address or wallet address stored, …; docs/privacy/tenant-privacy-notice.md) or of the tenant's own settings
//     (profile, visitor identifier, retention, anonymous reports, public statistics).
//   - Wording rule: it describes a measurement, never an endorsement — no "verified by" a third party, "approved",
//     "certified" or "compliant".
// Pure: no I/O; user-tracking-handler.ts loads the facts.

export interface SiteFacts {
  name: string;
  profile: "standard" | "strict";
  /** `on`, `off`, or `off_in` (off for the listed countries). */
  visitorId: "on" | "off" | "off_in";
  anonymousReports: boolean;
  retentionDays: number;
  /** counted (verified or suspect) page views in the window */
  pageviews: boolean;
  wallet: boolean;
  passkey: boolean;
}

export interface UserTrackingFacts {
  projectName: string;
  window: { start: Date; end: Date };
  sites: SiteFacts[];
  services: { name: string; requests: boolean; stellarClient: boolean }[];
  contracts: { declared: number; verified: number; activity: boolean };
  publicStatsUrl: string | null;
  snapshotUrl: string | null;
  privacyUrl: string;
}

export type SourceId = "web" | "wallet" | "passkey" | "api" | "stellar_client" | "onchain";

export interface SourceOut {
  source: SourceId;
  status: "measured" | "configured";
  detail: string;
}

export interface UserTrackingOut {
  paragraph: string;
  mermaid: string;
  sources: SourceOut[];
  never_collected: string[];
}

/** Design properties of the platform; true for every tenant (docs/privacy, the privacy invariants). */
export const NEVER_COLLECTED = [
  "IP addresses (used in memory for the country lookup, then discarded)",
  "raw user-agent strings",
  "cookies or cross-site identifiers",
  "end-user wallet addresses and transaction hashes",
  "query strings, URL fragments and page titles",
  "request or response contents of API calls",
] as const;

/** Words the paragraph must never contain (wording rule C4); checked by the tests. */
export const FORBIDDEN_WORDING =
  /\b(verified by|approved|endorse|certif|compliant|guarantee|SCF[- ]verified)/i;

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const day = (d: Date) => d.toISOString().slice(0, 10);

function webSentence(measured: SiteFacts[]): string {
  const standard = measured.filter((s) => s.profile === "standard");
  const strict = measured.filter((s) => s.profile === "strict");
  const parts: string[] = [];
  const n = measured.length;
  const where = n === 1 ? "our website" : `our ${n} websites`;
  parts.push(
    `On ${where} we count page views with UsageMap, a privacy-preserving analytics service, without cookies or any data stored on the visitor's device (except a note of an opt-out).`,
  );
  if (standard.length > 0 && strict.length === 0)
    parts.push(
      "For each page view it keeps the page path (identifiers in it replaced by placeholders), the referring host, the country, a screen-size class, the browser language and the browser, operating system and device family.",
    );
  else if (strict.length > 0 && standard.length === 0)
    parts.push(
      "For each page view it keeps only the page path (identifiers in it replaced by placeholders), the country and the browser, operating system and device family (strict profile).",
    );
  else
    parts.push(
      "For each page view it keeps the page path (identifiers in it replaced by placeholders), the country and the browser, operating system and device family; our standard-profile sites also keep the referring host, a screen-size class and the browser language.",
    );
  const daily = measured.filter((s) => s.visitorId !== "off");
  if (daily.length === 0)
    parts.push("No visitor identifier is used: we count page views, not visitors.");
  else
    parts.push(
      `${daily.every((s) => s.visitorId === "on") && daily.length === measured.length ? "Unique visitors are" : "Where enabled, unique visitors are"} counted with a code derived from a secret that changes every day and is then destroyed, so a visitor cannot be followed across days or sites.`,
    );
  const ret = [...new Set(measured.map((s) => s.retentionDays))].sort((a, b) => a - b);
  parts.push(
    `Individual page-view records are deleted after ${ret.length === 1 ? ret[0] : `${ret[0]} to ${ret[ret.length - 1]}`} days; only aggregated figures are kept longer.`,
  );
  return parts.join(" ");
}

/** The paragraph, Mermaid flow and source list for one project. */
export function userTrackingStatement(f: UserTrackingFacts): UserTrackingOut {
  const sources: SourceOut[] = [];
  const measuredSites = f.sites.filter((s) => s.pageviews);
  const walletSites = f.sites.filter((s) => s.wallet);
  const passkeySites = f.sites.filter((s) => s.passkey);
  const apiServices = f.services.filter((s) => s.requests);
  const clientServices = f.services.filter((s) => s.stellarClient);

  if (f.sites.length > 0)
    sources.push(
      measuredSites.length > 0
        ? {
            source: "web",
            status: "measured",
            detail: `Page views on ${list(measuredSites.map((s) => `${s.name} (${s.profile})`))}.`,
          }
        : {
            source: "web",
            status: "configured",
            detail: `${f.sites.length} ${plural(f.sites.length, "website", "websites")} set up; no counted page view in the window.`,
          },
    );
  if (walletSites.length > 0)
    sources.push({
      source: "wallet",
      status: "measured",
      detail: `Wallet events on ${list(walletSites.map((s) => s.name))}: wallet type, network and outcome, never the address.`,
    });
  if (passkeySites.length > 0)
    sources.push({
      source: "passkey",
      status: "measured",
      detail: `Passkey / smart-wallet events on ${list(passkeySites.map((s) => s.name))}: counts only.`,
    });
  if (f.services.length > 0)
    sources.push(
      apiServices.length > 0
        ? {
            source: "api",
            status: "measured",
            detail: `Request metrics of ${list(apiServices.map((s) => s.name))} (OpenTelemetry).`,
          }
        : {
            source: "api",
            status: "configured",
            detail: `${f.services.length} API ${plural(f.services.length, "service", "services")} registered; no request counted in the window.`,
          },
    );
  if (clientServices.length > 0)
    sources.push({
      source: "stellar_client",
      status: "measured",
      detail: `Calls of ${list(clientServices.map((s) => s.name))} to Stellar RPC / Horizon (method, outcome, duration).`,
    });
  if (f.contracts.declared > 0)
    sources.push(
      f.contracts.activity
        ? {
            source: "onchain",
            status: "measured",
            detail: `Public ledger activity of ${f.contracts.declared} registered ${plural(f.contracts.declared, "contract", "contracts")} (${f.contracts.verified} with proven ownership).`,
          }
        : {
            source: "onchain",
            status: "configured",
            detail: `${f.contracts.declared} ${plural(f.contracts.declared, "contract", "contracts")} registered; no on-chain activity read in the window.`,
          },
    );

  const sentences: string[] = [];
  const anyMeasured = sources.some((s) => s.status === "measured");
  if (!anyMeasured) {
    sentences.push(
      `${f.projectName} has set up UsageMap, a privacy-preserving analytics service for Stellar ecosystem projects, but no usage data was received between ${day(f.window.start)} and ${day(f.window.end)}, so no user activity is being tracked yet.`,
      "When it is, the service by design stores no IP addresses, raw user-agent strings, cookies, end-user wallet addresses, query strings or request contents.",
    );
  } else {
    sentences.push(
      `${f.projectName} measures usage with UsageMap, a privacy-preserving analytics service for Stellar ecosystem projects; this statement describes what was measured between ${day(f.window.start)} and ${day(f.window.end)}.`,
    );
    if (measuredSites.length > 0) sentences.push(webSentence(measuredSites));
    if (walletSites.length > 0 || passkeySites.length > 0) {
      const what = [
        walletSites.length > 0
          ? "wallet connections (the wallet type, the network and whether it succeeded)"
          : "",
        passkeySites.length > 0 ? "passkey and smart-wallet use (counts only)" : "",
      ].filter(Boolean);
      sentences.push(
        `In our app we also count ${list(what)}; wallet addresses are never sent, and signatures and submitted transactions are kept only as daily totals, never linked to a visit.`,
      );
    }
    if (apiServices.length > 0)
      sentences.push(
        `Our ${plural(apiServices.length, "API sends", "APIs send")} technical usage metrics through OpenTelemetry — the endpoint pattern with identifiers replaced, the method, the status code and the response time — and no IP addresses, user identifiers, request contents or query parameters of API users.`,
      );
    if (clientServices.length > 0)
      sentences.push(
        "Our backend also reports the outcome and duration of its own calls to Stellar RPC and Horizon, by method; these are infrastructure metrics, not user data.",
      );
    if (f.contracts.declared > 0 && f.contracts.activity)
      sentences.push(
        `On-chain usage is read from public Stellar ledger data for our registered ${plural(f.contracts.declared, "contract", "contracts")} and is never joined to website visitors.`,
      );
    const browser = measuredSites.length > 0 || walletSites.length > 0 || passkeySites.length > 0;
    sentences.push(
      `No cookies, IP addresses, raw user-agent strings, end-user wallet addresses or query strings are stored${browser ? "; browsers that send Global Privacy Control or Do Not Track are not measured, and the tracker offers visitors an opt-out" : ""}.`,
    );
    const anonymous = measuredSites.length > 0 && measuredSites.every((s) => s.anonymousReports);
    const share = f.publicStatsUrl
      ? `Aggregated figures are public at ${f.publicStatsUrl}`
      : "Only aggregated figures leave the service (for example in the reports we share with grant programmes)";
    sentences.push(
      `${share}${anonymous ? "; our own reports round small numbers so that no individual visit can be singled out" : ""}.`,
    );
    if (f.snapshotUrl)
      sentences.push(
        `Our latest signed traction snapshot, which anyone can check against its signature, is at ${f.snapshotUrl}.`,
      );
  }
  sentences.push(`Details of what is collected and how long it is kept: ${f.privacyUrl}.`);

  return {
    paragraph: sentences.join(" "),
    mermaid: mermaidOf(
      f,
      measuredSites.length > 0,
      walletSites.length + passkeySites.length > 0,
      apiServices.length > 0,
      clientServices.length > 0,
    ),
    sources,
    never_collected: [...NEVER_COLLECTED],
  };
}

function mermaidOf(
  f: UserTrackingFacts,
  web: boolean,
  wallet: boolean,
  api: boolean,
  client: boolean,
): string {
  const lines = ["flowchart LR"];
  if (web || wallet) {
    lines.push(
      `  V[Visitor browser] -->|${wallet ? "page views and wallet events, no address" : "page views, no cookies"}| E[UsageMap edge]`,
      "  E -->|IP used in memory only, then discarded| S[(Aggregates, EU)]",
    );
  }
  if (api || client)
    lines.push(
      `  B[Our backend] -->|OpenTelemetry metrics: ${api ? "route pattern, status, duration" : "Stellar RPC/Horizon call outcomes"}| S[(Aggregates, EU)]`,
    );
  if (f.contracts.declared > 0 && f.contracts.activity)
    lines.push(
      "  L[Public Stellar ledger] -->|calls to our registered contracts| S[(Aggregates, EU)]",
    );
  if (lines.length === 1) lines.push("  N[No usage data received yet]");
  else
    lines.push(
      f.publicStatsUrl
        ? "  S --> P[Public aggregated statistics]"
        : "  S --> P[Aggregated reports only]",
    );
  return lines.join("\n");
}
