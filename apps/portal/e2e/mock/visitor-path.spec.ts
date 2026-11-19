// SPDX-License-Identifier: Apache-2.0
// The 3-minute visitor path, against the mock control plane; the same steps run against the seeded demo
// (tools/demo-seed). Every page runs
// under the production CSP and is checked with axe.
//   1. Public project card → verify a snapshot's signature and its testnet seal in the browser (a demonstration).
//   2. Sign in → the overview's verified usage panel. (The mock signs in with GitHub; Stellar-wallet sign-in is the
//      subject of auth.spec.ts.)
//   3. Web dashboard: the verified-vs-raw gap, an anomaly marker with its reasons and the tenant's annotation, and no
//      per-visitor view.
//   4. Wallet funnel by wallet type (daily), then mainnet ↔ testnet.
//   5. API routes with percentile accuracy.
//   6. Evidence pack: create a signed snapshot, copy its pasteable text.
//   7. As operator: an SCF-round cohort, compare projects, export, then the audit log of those reads.
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  registerSecondOperatorPasskey,
  test,
} from "../support/fixtures.ts";

const DOCS = "a0000000-0000-4000-8000-000000000001";
const DOCS_SITE = "b0000000-0000-4000-8000-000000000001";
const SVC = "d0000000-0000-4000-8000-000000000001";

test("the 3-minute visitor path", async ({ page, request }) => {
  test.setTimeout(90_000);
  await request.post("/__mock/reset");
  // Set-up (not part of the path): the project has made its statistics public.
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await page.goto(`/t/${DOCS}/sharing`);
  await page.getByRole("switch", { name: "Make statistics public" }).click();
  await page
    .getByRole("dialog", { name: "Make your statistics public?" })
    .getByRole("button", { name: "Make public" })
    .click();
  await expect(page.getByTestId("public-state")).toContainText("On.");
  await page.getByRole("button", { name: "Sign out" }).click();

  // 1. Public card → verify signature and testnet seal.
  const proof = (await (
    await request.get("/public/v1/snapshots/d5100000-0000-4000-8000-000000000002/seal")
  ).json()) as {
    proofs: { root: string; source_account: string; ledger: number }[];
  };
  const p = proof.proofs[0] as { root: string; source_account: string; ledger: number };
  await page.route("https://horizon-testnet.stellar.org/**", (route) =>
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
  await page.goto("/p/stellar-docs");
  await expect(page.getByTestId("project-card")).toContainText("verified visitors");
  await expect(page.getByTestId("public-series-check")).toContainText("no gap");
  await expectAccessible(page, "path 1: public card");
  await page
    .getByTestId("public-snapshot-2")
    .getByRole("link", { name: /^Verify/ })
    .click();
  await expect(page.getByTestId("verify-result")).toContainText("Valid");
  const seal = page.getByTestId("seal-testnet");
  await expect(seal.getByTestId("seal-demo-label")).toHaveText("demonstration");
  await expect(seal.getByTestId("seal-check-head")).toHaveClass("pass");
  await seal.getByRole("button", { name: "Look up the transaction on Horizon" }).click();
  await expect(seal.getByTestId("seal-lookup")).toContainText("Found");
  await expectAccessible(page, "path 1: verify");

  // 2. Sign in → overview, verified usage panel.
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await page.getByRole("link", { name: "Stellar Docs" }).first().click();
  const usage = page.getByTestId("verified-usage");
  await expect(usage.getByTestId("usage-web")).toContainText("verified of");
  await expect(usage.getByTestId("usage-api")).toContainText("self-attested");
  await expect(usage.getByTestId("usage-chain")).toContainText("invocations on mainnet");
  await expect(usage.getByTestId("confidence-level")).toBeVisible();
  await expectAccessible(page, "path 2: overview");

  // 3. Web dashboard: the gap, a marker with reasons and annotation, no per-visitor view.
  await page.goto(`/t/${DOCS}/sites/${DOCS_SITE}?range=30d&variant=verified&compare=false`);
  await expect(page.getByTestId("band-chart").locator("path.band")).toHaveCount(1);
  await page
    .getByTestId("band-flags")
    .getByRole("button", { name: /9 Nov 2026/ })
    .click();
  const flag = page.getByTestId(`flag-${DOCS_SITE}-2026-11-09`);
  await expect(flag).toContainText("Traffic jumped abruptly");
  await expect(flag.getByTestId("flag-annotations")).toContainText("Mainnet launch announced");
  await expect(page.getByTestId("privacy-never-shown")).toContainText(
    "No visitor or session lists",
  );
  await expect(page.getByRole("link", { name: /session|visitor list|replay/i })).toHaveCount(0);
  await expectAccessible(page, "path 3: web dashboard");

  // 4. Wallet funnel, mainnet ↔ testnet.
  await page.getByRole("link", { name: "Wallets", exact: true }).click();
  await expect(page.getByTestId("funnel-note")).toContainText("Daily counts.");
  await expect(page.getByTestId("wallet-freighter")).toBeVisible();
  await page.getByRole("button", { name: "Testnet" }).click();
  await expect(page.getByTestId("funnel-range")).toContainText("Testnet");
  await page.getByRole("button", { name: "Mainnet" }).click();
  await expect(page.getByTestId("funnel-range")).toContainText("Mainnet");
  await expectAccessible(page, "path 4: wallet funnel");

  // 5. API routes with percentile accuracy.
  await page.goto(`/t/${DOCS}/services/${SVC}?range=30d&compare=false&sort=-requests`);
  await expect(page.getByTestId("tile-p95")).toContainText("accuracy");
  await expect(page.getByText("{account_id}").first()).toBeVisible();
  await expectAccessible(page, "path 5: API dashboard");

  // 6. Evidence pack: a signed snapshot and its pasteable text.
  await page.goto(`/t/${DOCS}/traction-snapshots`);
  await page.getByLabel("Purpose (preset)").selectOption("build_tranche");
  await page.getByLabel("First day (UTC)").fill("2026-08-01");
  await page.getByLabel("Day after the last day (UTC)").fill("2026-11-01");
  await page.getByLabel("I understand that this snapshot will be listed publicly").check();
  await page.getByRole("button", { name: "Create snapshot" }).click();
  await expect(page.getByTestId("snapshot-pending")).toBeVisible();
  await expect(page.getByTestId("snapshots").locator("tbody tr")).toHaveCount(4);
  const fresh = page.getByTestId("snapshots").locator("tbody tr").first();
  await expect(fresh.getByTestId("snapshot-state")).toHaveText("signed", { timeout: 15_000 });
  await fresh.getByRole("button", { name: /^View/ }).click();
  await expect(page.getByTestId("snapshot-text").first()).toContainText(
    "Snapshot 3 of this project",
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy text" }).first().click();
  await expect(page.getByText("Copied.")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();

  // 7. Operator: a round cohort, compare, export, audit log.
  await addVirtualAuthenticator(page);
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as scf-operator" }).click();
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page).not.toHaveURL(/\/signin(\/|\?|$)/);
  await registerSecondOperatorPasskey(page);
  await page.goto("/operator/cohorts?by=round&range=90d&min_level=L1");
  await expect(page.getByTestId("cohort-45")).toContainText("Round #45");
  await expectAccessible(page, "path 7: cohorts");
  await page.getByRole("link", { name: "project table" }).click();
  await page.getByLabel("Compare Stellar Docs").check();
  await page.getByLabel("Compare Soroban Swap").check();
  await page.getByRole("button", { name: "Compare side by side" }).click();
  const cmp = page.getByTestId("web-compare");
  await expect(cmp.getByTestId("cmp-stellar-docs")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  expect((await download).suggestedFilename()).toBe("scf-web-projects.csv");
  await page.getByRole("link", { name: "Audit log" }).click();
  await expect(page.getByTestId("audit")).toContainText("operator.read.op_cohorts");
  await expectAccessible(page, "path 7: audit log");
});
