// SPDX-License-Identifier: Apache-2.0
// Usage, trust and snapshot pages against the mock control plane (C-136, C-137), each under the
// production CSP (fixtures.ts) and checked with axe: the project overview with its verified-usage panel and the live
// first-event panel; trust and anomalies with annotations; the band chart with markers and click-to-filter; the wallet
// funnel with the network toggle; the footprint step (contracts only, conflict state); snapshot v2 with presets, the
// publication notice and the pasteable text; the public card with badge, series list and gap check; /verify with the
// signature, the series, the seal (inclusion, head path, segment break) and the Horizon lookup ("outside this
// endpoint's history" vs "not found"); the operator cohorts with withheld figures.
import type { Page } from "@playwright/test";
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  registerSecondOperatorPasskey,
  test,
} from "../support/fixtures.ts";

const DOCS = "a0000000-0000-4000-8000-000000000001";
const DOCS_SITE = "b0000000-0000-4000-8000-000000000001";
const WALLET_SITE = "b0000000-0000-4000-8000-000000000002";
const SNAP1 = "d5100000-0000-4000-8000-000000000001";
const SNAP2 = "d5100000-0000-4000-8000-000000000002";
const SWAP3 = "d5200000-0000-4000-8000-000000000003";
const HORIZON = "https://horizon-testnet.stellar.org";

async function signIn(page: Page) {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
}

/** An SCF operator's sign-in is complete only after the passkey (C-09). */
async function signInOperator(page: Page) {
  await addVirtualAuthenticator(page);
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as scf-operator" }).click();
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page).not.toHaveURL(/\/signin(\/|\?|$)/);
  await registerSecondOperatorPasskey(page);
}

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("overview: headline numbers, verified usage with trust and confidence, privacy card", async ({
  page,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
  await page.goto(`/t/${DOCS}`);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  const panel = page.getByTestId("verified-usage");
  await expect(panel.getByTestId("usage-web")).toContainText("verified of");
  await expect(panel.getByTestId("usage-web").getByTestId("trust-band")).toHaveText(
    "Trust 84 · high",
  );
  await expect(panel.getByTestId("usage-api")).toContainText("self-attested telemetry");
  await expect(panel.getByTestId("assurance-level")).toHaveText("assurance A0");
  // verified mainnet contract only: 30 days of the router, never the declared vault or the testnet copy
  await expect(panel.getByTestId("usage-chain")).toContainText("verified contract");
  await expect(panel.getByTestId("usage-chain-testnet")).toContainText("15,000 invocations");
  await expect(panel.getByTestId("confidence-level")).toHaveText("Medium");
  await expect(panel.getByTestId("usage-confidence")).toContainText("open anomaly flags");
  await expect(page.getByTestId("open-flags")).toHaveText("1");
  await expect(page.getByTestId("privacy-stellar")).toContainText(
    "No visitor's address is ever collected.",
  );
  await expect(page.getByText("never as a list of visitors")).toBeVisible();
  // no per-visitor view anywhere in the project's navigation
  await expect(page.getByRole("link", { name: /sessions|visitors list|replay/i })).toHaveCount(0);
  await expectAccessible(page, "overview");
});

test("first-event panel: dev origins, a dev event arriving live, debug mode on and off (E2/E4)", async ({
  page,
  request,
}) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}`);
  const panel = page.getByTestId(`first-event-${WALLET_SITE}`);
  await expect(
    panel.getByRole("heading", { name: "Waiting for the first event: Wallet app" }),
  ).toBeVisible();
  await expect(panel.getByTestId("first-event-none")).toBeVisible();
  await panel.getByLabel("Add a dev or preview origin").fill("*.vercel.app");
  await panel.getByRole("button", { name: "Add origin" }).click();
  await expect(panel.getByRole("alert")).toContainText("public suffix");
  await panel.getByLabel("Add a dev or preview origin").fill("localhost:3000");
  await panel.getByRole("button", { name: "Add origin" }).click();
  await expect(panel.getByRole("alert")).toContainText("without scheme, port or path");
  await panel.getByLabel("Add a dev or preview origin").fill("localhost");
  await panel.getByRole("button", { name: "Add origin" }).click();
  await expect(panel.getByTestId("dev-origins")).toContainText("localhost");
  await request.post("/__mock/dev-event", {
    data: {
      site_id: WALLET_SITE,
      path: "/swap/{id}",
      would_be_verdict: "suspect",
      reason: "proof_missing",
    },
  });
  // polled every 5 s: the event appears without a reload, marked as never counted
  await expect(panel.getByTestId("dev-events")).toContainText("/swap/{id}", { timeout: 10_000 });
  await expect(panel.getByTestId("dev-events")).toContainText("would be suspect");
  await expect(panel.getByTestId("dev-events")).toContainText("proof_missing");
  await panel.getByRole("button", { name: "Switch debug mode on for 1 hour" }).click();
  await expect(panel.getByTestId("debug-state")).toContainText("on until");
  await expectAccessible(page, "first-event panel");
  await panel.getByRole("button", { name: "Switch debug mode off" }).click();
  await expect(panel.getByTestId("debug-state")).toHaveText("Debug mode: off");
});

test("trust and anomalies: components, flagged days, a tenant annotation explains a day", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}`);
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "Trust", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Trust" })).toBeVisible();
  const site = page.getByTestId(`trust-site-${DOCS_SITE}`);
  await expect(site.getByTestId("trust-band")).toHaveText("Trust 84 · high");
  await expect(site.getByTestId("trust-components")).toContainText(
    "94% of page views carried a valid browser proof",
  );
  await expect(page.getByTestId(`trust-site-${WALLET_SITE}`)).toContainText("not scored yet");
  const launch = page.getByTestId(`flag-${DOCS_SITE}-2026-11-09`);
  await expect(launch.getByTestId("flag-state")).toHaveText("explained");
  await expect(launch.getByTestId("flag-annotations")).toContainText("Mainnet launch announced");
  const open = page.getByTestId(`flag-${DOCS_SITE}-2026-11-03`);
  await expect(open.getByTestId("flag-state")).toHaveText("open");
  await expect(open).toContainText("A high share of traffic came from data-centre networks");
  await expect(page.getByTestId("assurance-horizon-proxy")).toContainText("assurance A2");
  await expectAccessible(page, "trust");
  await open.getByRole("button", { name: /^Annotate this day/ }).click();
  await open.getByLabel(/What happened on/).fill("Load test from our CI by mistake");
  await expectAccessible(page, "trust annotate form");
  await open.getByRole("button", { name: "Add annotation" }).click();
  await expect(open.getByTestId("flag-state")).toHaveText("explained");
  await expect(open.getByTestId("flag-annotations")).toContainText(
    "Load test from our CI by mistake",
  );
  await page.goto(`/t/${DOCS}`);
  await expect(page.getByTestId("overview-flags")).toContainText("0 open");
});

test("band chart: the suspect gap, anomaly markers and their reasons, click-to-filter (D-3)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}/sites/${DOCS_SITE}?range=30d&variant=verified&compare=false`);
  const chart = page.getByTestId("band-chart");
  await expect(chart.locator("path.band")).toHaveCount(1);
  await expect(page.getByTestId("band-marker-2026-11-09")).toHaveCount(1);
  await expect(page.getByTestId("band-marker-2026-11-03")).toHaveCount(1);
  await expectAccessible(page, "dashboard with band chart");
  // hover reads a day
  const plot = page.getByTestId("band-plot");
  const box = await plot.boundingBox();
  if (!box) throw new Error("no plot");
  await plot.hover({ position: { x: box.width / 3, y: box.height / 2 } });
  await expect(page.getByTestId("band-hover")).toBeVisible();
  await expect(page.getByTestId("band-readout")).toContainText("verified");
  // a flag's reasons and annotation
  await page
    .getByTestId("band-flags")
    .getByRole("button", { name: /9 Nov 2026/ })
    .click();
  await expect(page.getByTestId(`flag-${DOCS_SITE}-2026-11-09`)).toContainText(
    "Traffic jumped abruptly",
  );
  // keyboard: first day, Enter filters the page to it
  await plot.focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("band-readout")).toContainText("14 Oct 2026");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(
    /range=custom&from=2026-10-14&to=2026-10-14|from=2026-10-14.*to=2026-10-14/,
  );
  await expect(page.getByTestId("privacy-card")).toBeVisible();
});

test("wallet funnel: by wallet type, daily counts, mainnet / testnet / all (D-6)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}/sites/${DOCS_SITE}?range=30d&variant=verified&compare=false`);
  await page.getByRole("link", { name: "Wallets", exact: true }).click();
  await expect(page.getByTestId("funnel-note")).toContainText("Daily counts.");
  await expect(page.getByTestId("funnel-wallet_connect")).toContainText("1,450");
  await expect(page.getByTestId("funnel-tx_submitted")).toContainText("505");
  await expect(page.getByTestId("wallet-freighter")).toContainText("880");
  await expect(page.getByTestId("funnel-rejections")).toContainText("user rejected 52");
  await expect(page.getByTestId("funnel-onchain")).toContainText("not a step of the funnel");
  await expectAccessible(page, "wallet funnel (mainnet)");
  await page.getByRole("button", { name: "Testnet" }).click();
  await expect(page).toHaveURL(/network=testnet/);
  await expect(page.getByTestId("funnel-wallet_connect")).toContainText("240");
  await expect(page.getByTestId("funnel-onchain")).toContainText("15,000 invocations");
  await page.getByRole("button", { name: "All networks" }).click();
  await expect(page.getByTestId("funnel-wallet_connect")).toContainText("1,690");
  await expect(page.getByTestId("funnel-onchain")).toHaveCount(0);
  await page.goto(
    `/t/${DOCS}/sites/${WALLET_SITE}/wallets?network=mainnet&range=30d&variant=verified`,
  );
  await expect(page.getByTestId("funnel-wallets")).toContainText("No wallet events");
});

test("footprint step: contracts only, ownership check, conflict under review, none declared (A5)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}/setup`);
  await page.getByRole("link", { name: "Register contracts" }).click();
  const step = page.getByTestId("footprint-step");
  await expect(step).toContainText("only addresses your project controls");
  await expect(step.getByTestId("footprint-contracts").locator("tbody tr")).toHaveCount(4);
  // accounts are in the contract but not shown until they are counted
  await expect(step).not.toContainText("issuer");
  const conflict = step.getByTestId("footprint-conflict");
  await expect(conflict).toContainText("counted for neither");
  await expect(step.getByText("conflict — under review")).toBeVisible();
  await expect(step.getByTestId("footprint-status")).toContainText(
    "at least one contract verified",
  );
  await expectAccessible(page, "footprint step");
  await step.getByLabel("Contract id").fill("CNOTVALID");
  await step.getByRole("button", { name: "Register contract" }).click();
  await expect(step.getByRole("alert")).toContainText("56 characters");
  const owned = `C${"A".repeat(55)}`;
  const foreign = `C${"Z".repeat(55)}`;
  for (const c of [owned, foreign]) {
    await step.getByLabel("Contract id").fill(c);
    await step.getByRole("button", { name: "Register contract" }).click();
    await expect(step.getByTestId(`footprint-${c}`)).toContainText("claimed, not yet verified");
    await step
      .getByTestId(`footprint-${c}`)
      .getByRole("button", { name: /^Check ownership/ })
      .click();
  }
  await expect(step.getByTestId(`footprint-${owned}`).getByTestId("footprint-state")).toHaveText(
    "verified",
  );
  await expect(
    step.getByTestId(`footprint-${foreign}`).getByTestId("footprint-state"),
  ).toContainText("neither its deployer nor its admin");
});

test("snapshots v2: preset, publication notice, signed pasteable text, seal opt-in (C1, A2)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}/traction-snapshots`);
  await expect(page.getByTestId("seal-network-notice")).toContainText(
    "a demonstration, not durable evidence",
  );
  const s2 = page.getByTestId(`snapshot-${SNAP2}`);
  await expect(s2.getByTestId("snapshot-preset")).toHaveText(
    "Public Goods renewal quarter · schema v2 · sealed",
  );
  await s2.getByRole("button", { name: /^View/ }).click();
  await expect(page.getByTestId("snapshot-text")).toContainText("Snapshot 2 of this project");
  await expect(page.getByTestId("snapshot-text")).toContainText("not endorsed by SCF or SDF");
  await expect(page.getByRole("button", { name: "Copy text" })).toBeVisible();
  await expectAccessible(page, "snapshots v2");
  await page.getByLabel("Purpose (preset)").selectOption("pg_renewal_quarter");
  await expect(page.getByLabel("First day (UTC)")).toHaveCount(0);
  await expect(page.getByTestId("publication-notice")).toContainText(
    "whether or not your statistics are public",
  );
  await page.getByLabel("I understand that this snapshot will be listed publicly").check();
  await page.getByRole("button", { name: "Create snapshot" }).click();
  await expect(page.getByTestId("snapshot-pending")).toBeVisible();
  await expect(page.getByTestId("snapshots").locator("tbody tr")).toHaveCount(5);
  const fresh = page.getByTestId("snapshots").locator("tbody tr").first();
  await expect(fresh.getByTestId("snapshot-state")).toHaveText("signed", { timeout: 15_000 });
  await expect(fresh.getByTestId("snapshot-preset")).toContainText("Public Goods renewal quarter");
  await fresh.getByRole("button", { name: /^View/ }).click();
  await expect(page.getByTestId("snapshot-text").first()).toContainText(
    "Snapshot 3 of this project",
  );
  await page.getByLabel("Seal my signed snapshots daily").click();
  await expect(page.getByLabel("Seal my signed snapshots daily")).not.toBeChecked();
});

test("public card: badge, signed snapshots in series order, no gap; a gap is shown (D-5)", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}/sharing`);
  await page.getByRole("switch", { name: "Make statistics public" }).click();
  await page
    .getByRole("dialog", { name: "Make your statistics public?" })
    .getByRole("button", { name: "Make public" })
    .click();
  await expect(page.getByTestId("public-state")).toContainText("On.");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto("/p/stellar-docs");
  await expect(page.getByTestId("card-visitors")).toHaveText("9,118");
  await expect(page.getByTestId("project-card")).toContainText(
    "not an endorsement by SCF, SDF or anyone else",
  );
  await expect(page.getByTestId("public-series-check")).toContainText("1–2, no gap");
  await expect(page.getByTestId("public-snapshot-1")).toContainText("SCF Build tranche");
  await expect(page.getByTestId("badge-code")).toContainText("9,118 verified visitors / 30 d");
  await expect(page.getByTestId("badge-code")).toContainText('href="http://localhost');
  await expect(page.getByTestId("privacy-card")).toBeVisible();
  await expectAccessible(page, "public card");
  await page
    .getByTestId("public-snapshot-2")
    .getByRole("link", { name: /^Verify/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/verify\\?snapshot=${SNAP2}$`));
  await expect(page.getByTestId("verify-result")).toContainText("Valid");
});

test("verify: v2 signature, series, seal with testnet reset; Horizon outside history vs not found (A2, D-5)", async ({
  page,
}) => {
  // The contract form of links.verify (wire-formats §i.3.2): /verify?snapshot=<id>
  let elder = 5000;
  await page.route(`${HORIZON}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return route.fulfill({ json: { history_elder_ledger: elder } });
    return route.fulfill({ status: 404, json: { status: 404 } });
  });
  await page.goto(`/verify?snapshot=${SNAP1}`);
  await expect(page.getByTestId("verify-result")).toContainText("Valid");
  await expect(page.getByTestId("verify-onchain")).toContainText("4,820 invocations");
  await expect(page.getByTestId("series-position")).toContainText("Snapshot 1 of 2");
  await expect(page.getByTestId("series-gaps")).toHaveClass("pass");
  const seal = page.getByTestId("seal-testnet");
  await expect(seal.getByTestId("seal-demo-label")).toHaveText("demonstration");
  await expect(seal.getByTestId("seal-testnet-notice")).toContainText("not durable evidence");
  await expect(seal.getByTestId("seal-status")).toHaveText("network reset");
  for (const id of [
    "seal-check-hash",
    "seal-check-leaf",
    "seal-check-inclusion",
    "seal-check-head",
    "seal-check-chain",
  ])
    await expect(seal.getByTestId(id)).toHaveClass("pass");
  await expect(seal.getByTestId("seal-reset-note")).toContainText(
    "anchored through the chain by the confirmed transaction of 12 Nov 2026",
  );
  await seal.getByText("The chain of days").click();
  await expect(seal.getByTestId("segment-break")).toHaveCount(1);
  await expect(seal.getByTestId("seal-statement")).toHaveText(
    "Tamper-evidence of a published snapshot. It does not show that the numbers are genuine.",
  );
  await expectAccessible(page, "verify v2 with seal");
  // Horizon keeps ledgers from 5,000 on; the anchoring transaction is in ledger 1,200
  await seal.getByRole("button", { name: "Look up the transaction on Horizon" }).click();
  await expect(seal.getByTestId("seal-lookup")).toContainText("Outside this endpoint's history");
  await expect(seal.getByTestId("seal-ledger-file")).toContainText("/FFFFFB4F--1200.xdr.zst");
  elder = 2;
  await seal.getByRole("button", { name: "Look up the transaction on Horizon" }).click();
  await expect(seal.getByTestId("seal-lookup")).toContainText("Not found");
});

test("verify: a matching Horizon transaction; a gap in the series is shown (A2, C1)", async ({
  page,
}) => {
  await page.goto(`/verify/${SNAP2}`);
  const seal = page.getByTestId("seal-testnet");
  await expect(seal.getByTestId("seal-status")).toHaveText("confirmed");
  await expect(seal.getByTestId("seal-check-inclusion")).toHaveClass("pass");
  // the memo is the day's root, recomputed by the page; answer with the root the proof names
  const proof = (await (await page.request.get(`/public/v1/snapshots/${SNAP2}/seal`)).json()) as {
    proofs: { root: string; source_account: string; tx_hash: string; ledger: number }[];
  };
  const p = proof.proofs[0] as {
    root: string;
    source_account: string;
    tx_hash: string;
    ledger: number;
  };
  await page.route(`${HORIZON}/**`, (route) =>
    route.fulfill({
      json: {
        successful: true,
        source_account: p.source_account,
        memo_type: "hash",
        memo: Buffer.from(p.root, "hex").toString("base64"),
        ledger: p.ledger,
      },
    }),
  );
  await seal.getByRole("button", { name: "Look up the transaction on Horizon" }).click();
  await expect(seal.getByTestId("seal-lookup")).toContainText(
    "Found: a successful transaction from the sealing account",
  );

  await page.goto(`/verify?snapshot=${SWAP3}`);
  await expect(page.getByTestId("verify-result")).toContainText("Valid");
  await expect(page.getByTestId("series-gaps")).toHaveClass("fail");
  await expect(page.getByTestId("series-gaps")).toContainText(
    "Snapshot 2 is missing from the list.",
  );
  await expect(page.getByTestId("verify-no-seal")).toBeVisible();
  await expectAccessible(page, "verify with a gap");
});

test("operator cohorts: by round, category and stage; small cohorts and small counts withheld (C3)", async ({
  page,
}) => {
  await signInOperator(page);
  await page.goto("/operator/cohorts?by=round&range=90d&min_level=L1");
  await expect(page.getByTestId("cohort-45")).toContainText("Round #45");
  await expect(page.getByTestId("cohort-45")).toContainText("184k");
  await expect(page.getByTestId("cohort-43").getByTestId("cohort-suppressed")).toContainText(
    "Hidden · fewer than 5 projects in this group",
  );
  await expect(page.getByTestId("cohort-42")).toContainText("<");
  await expect(page.getByTestId("cohort-note")).toContainText("not a privacy boundary");
  await expectAccessible(page, "cohorts");
  await page.getByRole("button", { name: "Category", exact: true }).click();
  await expect(page.getByTestId("cohort-financial_protocols")).toContainText("Financial Protocols");
  await page.getByRole("button", { name: "Award stage", exact: true }).click();
  await expect(page.getByTestId("cohort-t3_mainnet")).toContainText("#3 Mainnet");
});

test("verify: the whole seal history against the ledger; a rewritten past root is caught (plan C1 #10)", async ({
  page,
}) => {
  const days = (
    (await (
      await page.request.get("/public/v1/seals?start=2026-01-01T00:00:00Z&end=2026-12-31T00:00:00Z")
    ).json()) as {
      days: {
        day: string;
        root: string;
        status: string;
        tx_hash: string | null;
        ledger: number | null;
        source_account: string | null;
      }[];
    }
  ).days;
  const sealed = days.filter((d) => d.status === "confirmed" && d.tx_hash && d.source_account);
  expect(sealed.length).toBeGreaterThan(0);
  let rewrite = false;
  await page.route(`${HORIZON}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/") return route.fulfill({ json: { history_elder_ledger: 1 } });
    const account = u.pathname.split("/")[2];
    const records = sealed
      .filter((d) => d.source_account === account)
      .map((d, i) => ({
        hash: d.tx_hash,
        successful: true,
        source_account: account,
        memo_type: "hash",
        // the ledger keeps what was sealed; the rewritten case publishes another root for the first sealed day
        memo: Buffer.from(rewrite && i === 0 ? "ab".repeat(32) : d.root, "hex").toString("base64"),
        ledger: d.ledger,
      }));
    return route.fulfill({
      json: { _embedded: { records }, _links: { next: { href: u.toString() } } },
    });
  });
  await page.goto(`/verify/${SNAP2}`);
  const seal = page.getByTestId("seal-testnet");
  const button = seal.getByRole("button", {
    name: "Check the whole seal history against the ledger",
  });
  await button.click();
  await expect(seal.getByTestId("seal-history-result")).toContainText(
    "The published seal history matches the ledger",
  );
  rewrite = true;
  await button.click();
  await expect(seal.getByTestId("seal-history-result")).toContainText(
    "The published seal history does not match the ledger",
  );
  await expect(seal.getByTestId("seal-history-result")).toContainText(
    "the day's transaction carries another root",
  );
  await expectAccessible(page, "verify: seal history mismatch");
});
