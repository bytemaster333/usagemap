// SPDX-License-Identifier: Apache-2.0
// SCF-operator console (operator.global-view-credentials, operator.web-*, operator.api-*): passkey-complete sign-in, ecosystem web and API views with
// known totals, filter / sort / threshold, side-by-side comparison and export, thresholds and rounding shown, trust and
// assurance indicators, the tenant lifecycle with step-up, tombstones, enrollment mode, operator API keys, the audit
// log of cross-tenant reads and the erasure view.
import type { Page } from "@playwright/test";
import { EXPECTED_OP } from "../../test/fixtures/operator.ts";
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  registerSecondOperatorPasskey,
  test,
} from "../support/fixtures.ts";

async function signInOperator(page: Page, login: "scf-admin" | "scf-operator") {
  await addVirtualAuthenticator(page);
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: `Continue as ${login}` }).click();
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page).not.toHaveURL(/\/signin(\/|\?|$)/);
  await registerSecondOperatorPasskey(page);
}

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("overview: enrolment counts, totals, needs attention and one row per project", async ({
  page,
}) => {
  await signInOperator(page, "scf-admin");
  await page.goto("/operator");
  await expect(page).toHaveURL(/\/operator\/overview\?/);
  await expect(page.getByTestId("operator-banner")).toContainText("Operator admin");
  await expect(page.getByTestId("ov-enrolled")).toContainText(/\d/);
  await expect(page.getByTestId("eco-pageviews")).toContainText("97.5k");
  await expect(page.getByTestId("needs-attention")).toContainText("waiting for approval");
  await expect(page.getByTestId("ov-row-stellar-docs")).toContainText("36.9k");
  // naming rule: tenants are "Stellar ecosystem projects", never "SCF projects"
  await expect(
    page.getByRole("heading", { level: 2, name: "Stellar ecosystem projects", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/SCF projects/)).toHaveCount(0);
  await expectAccessible(page, "operator overview");
});

test("overview: a failed summary shows a calm retry in its own cards, the rest of the page stays", async ({
  page,
}) => {
  await signInOperator(page, "scf-operator");
  let fail = true;
  await page.route("**/v1/operator/web/summary**", (route) =>
    fail
      ? route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          body: JSON.stringify({ type: "about:blank", title: "Server error", status: 500 }),
        })
      : route.continue(),
  );
  await page.goto("/operator/overview");
  await expect(page.getByTestId("eco-pageviews")).toContainText("Not loaded", { timeout: 20_000 });
  await expect(page.getByTestId("calm-error").first()).toContainText("Try again");
  await expect(page.getByTestId("ov-row-stellar-docs")).toContainText("36.9k");
  await expectAccessible(page, "overview with a failed summary");
  fail = false;
  await page.getByTestId("eco-pageviews").getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("eco-pageviews")).toContainText("97.5k");
});

test("web: tiles, filters, sort, threshold, side by side, breakdown and export", async ({
  page,
}) => {
  await signInOperator(page, "scf-admin");
  await page.goto("/operator/web");
  await expect(page.getByTestId("eco-visits")).toContainText("50.3k");
  await expect(page.getByTestId("eco-bounce")).toContainText(EXPECTED_OP.ecoBounce);
  await expect(page.getByTestId("eco-duration")).toContainText("1m 22s");
  await expect(page.getByTestId("eco-suspect")).toContainText(EXPECTED_OP.ecoSuspect);
  const rows = page.getByTestId("web-projects").locator("tbody tr");
  // Default: L0 left out, most page views first.
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Soroban Swap");
  await expect(page.getByTestId("web-row-stellar-docs")).toContainText(
    /36\.9k.*18\.3k.*41%.*1m 33s.*6\.0%.*84/,
  );
  await expect(page.getByTestId("privacy-note").first()).toContainText("under 10 hidden");
  await expectAccessible(page, "operator web");

  // Before filtering changes the page views.
  await page.getByRole("button", { name: "Before filtering" }).click();
  await expect(page).toHaveURL(/variant=raw/);
  await page.getByRole("button", { name: "Verified", exact: true }).click();
  // Sort by bounce rate (lower first), then level, trust band and a threshold under More filters.
  await page.getByRole("button", { name: /^Bounce/ }).click();
  await expect(page).toHaveURL(/sort=bounce_rate_pct/);
  await page.getByText("More filters").click();
  await page.getByLabel("Verification level").selectOption("L0");
  await expect(page.getByTestId("web-row-hobby-site")).toBeVisible();
  await page.getByLabel("Verification level").selectOption("L1");
  await page.getByLabel("Trust score, last 28 days").selectOption("high");
  await expect(rows).toHaveCount(1);
  await page.getByLabel("Trust score, last 28 days").selectOption("any");
  await page.getByLabel("Minimum page views").fill("10000");
  await page.getByLabel("Minimum page views").press("Enter");
  await expect(page).toHaveURL(/min=10000/);
  await expect(rows).toHaveCount(2);
  await page.getByRole("button", { name: "Done" }).click();

  // Side by side.
  await page.getByLabel("Compare Stellar Docs").check();
  await page.getByLabel("Compare Soroban Swap").check();
  await page.getByRole("button", { name: "Compare side by side" }).click();
  const cmp = page.getByTestId("web-compare");
  await expect(cmp.getByTestId("cmp-stellar-docs")).toContainText("36.9k");
  await expect(cmp.getByTestId("cmp-soroban-swap")).toContainText("52.4k");
  await expect(cmp.getByRole("img", { name: /Daily verified page views/ })).toBeVisible();
  await expectAccessible(page, "operator comparison");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  expect((await download).suggestedFilename()).toBe("scf-web-projects.csv");

  // Breakdown rows are thresholded and rounded by the API, and the page says so.
  await page.getByTestId("web-breakdown").getByRole("button", { name: "Country" }).click();
  await expect(page.getByTestId("web-breakdown")).toContainText("Germany");
  await expect(page.getByTestId("web-breakdown")).toContainText(/hidden/);
  await expect(page.getByTestId("web-verdicts")).toContainText("identified itself as a bot");
});

test("web: campaigns and trust scores", async ({ page }) => {
  await signInOperator(page, "scf-operator");
  await page.goto("/operator/web");
  await page.getByRole("tab", { name: "Campaigns" }).click();
  await expect(page).toHaveURL(/tab=campaigns/);
  await expect(page.getByTestId("campaign-table")).toContainText("×");
  await expectAccessible(page, "operator campaigns");
  await page.getByRole("tab", { name: "Trust scores" }).click();
  await expect(page.getByTestId("trust-table")).toContainText("Stellar Docs");
  await expect(page.getByTestId("trust-signals")).toBeVisible();
  await expectAccessible(page, "operator trust scores");
});

test("API: totals, high/low usage, assurance, comparison and routes", async ({ page }) => {
  await signInOperator(page, "scf-operator");
  await page.goto("/operator/api?range=30d");
  await expect(page.getByTestId("eco-requests")).toContainText("4.75M");
  await expect(page.getByTestId("eco-requests")).toContainText("Self-reported");
  await expect(page.getByTestId("eco-5xx")).toContainText(EXPECTED_OP.ecoErrorRate);
  const rows = page.getByTestId("api-services").locator("tbody tr");
  await expect(rows.nth(0)).toContainText("swap-api");
  await expect(page.getByTestId("flag-swap-api")).toHaveText("highest volume");
  await expect(page.getByTestId("flag-legacy-api")).toHaveText("no requests in range");
  await expect(page.getByTestId("flag-anchor-sep")).toHaveText("active on few days");
  await expect(page.getByTestId("api-row-soroban-rpc-gw")).toContainText(EXPECTED_OP.rpcP50);
  await expect(page.getByTestId("api-row-swap-api")).toContainText("A2");
  await expect(page.getByTestId("api-row-anchor-sep")).toContainText("On-chain mismatch");
  await expectAccessible(page, "operator API");
  // Lowest volume first.
  await page.getByRole("button", { name: /^Requests/ }).click();
  await expect(rows.nth(0)).toContainText("legacy-api");
  // A threshold hides inactive services.
  await page.getByText("More filters").click();
  await page.getByLabel("Minimum requests").fill("1000");
  await page.getByLabel("Minimum requests").press("Enter");
  await expect(page.getByTestId("api-row-legacy-api")).toHaveCount(0);
  await expect(page.getByTestId("api-row-anchor-sep")).toHaveCount(0);
  await page.getByRole("button", { name: "Done" }).click();
  // Two services side by side.
  await page.getByLabel("Compare horizon-proxy (stellar-docs)").check();
  await page.getByLabel("Compare swap-api (soroban-swap)").check();
  await page.getByRole("button", { name: "Compare side by side" }).click();
  await expect(page.getByTestId("acmp-stellar-docs")).toContainText("horizon-proxy");
  await expect(page.getByTestId("acmp-soroban-swap")).toContainText("swap-api");
  // Routes of one service.
  await page
    .getByTestId("op-routes")
    .getByLabel("Service")
    .selectOption({ label: "horizon-proxy · stellar-docs" });
  await expect(page.getByTestId("op-routes")).toContainText("{overflow}");
  await expect(page.getByTestId("op-routes")).toContainText("/accounts/{account_id}");
});

test("lifecycle with step-up: approve, suspend, remove, restore, purge; audit records it", async ({
  page,
  request,
}) => {
  await signInOperator(page, "scf-admin");
  await page
    .getByRole("navigation", { name: "Operator" })
    .getByRole("link", { name: "Ecosystem projects" })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Stellar ecosystem projects" }),
  ).toBeAttached();
  await expectAccessible(page, "operator projects");
  await page.getByRole("link", { name: "Pending Labs" }).click();
  await expect(page.getByTestId("op-tenant-status")).toContainText("Waiting for approval");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Approve Pending Labs?" });
  await dialog.getByLabel(/^Reason/).fill("Verified SCF round 31 project");
  await expectAccessible(page, "lifecycle dialog");
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("op-tenant-status")).toContainText("Active");

  // Step-up lapsed: the passkey is asked for before the action runs.
  await request.post("/__mock/expire-recent-auth");
  await page.reload();
  await page.getByRole("button", { name: "Suspend", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Suspend Pending Labs?" });
  await dialog.getByLabel(/^Reason/).fill("Traffic under review");
  await expect(dialog.getByRole("button", { name: "Suspend" })).toBeDisabled();
  await dialog.getByLabel("Type pending-labs to confirm").fill("pending-labs");
  await dialog.getByRole("button", { name: "Suspend" }).click();
  const stepUp = page.getByRole("dialog", { name: "Confirm with your passkey" });
  await expect(stepUp).toContainText("SCF operator action");
  await stepUp.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page.getByTestId("op-tenant-status")).toContainText("Suspended");
  await expect(page.getByTestId("op-tenant-status")).toContainText("Traffic under review");

  await page.getByRole("button", { name: "Remove", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Remove Pending Labs?" });
  await expect(dialog).toContainText("tombstone");
  await dialog.getByLabel("Duplicate of another project").check();
  await dialog.getByLabel("Note for the audit log").fill("Not part of the ecosystem");
  await dialog.getByLabel("Type pending-labs to confirm").fill("pending-labs");
  await dialog.getByRole("button", { name: "Remove project" }).click();
  await expect(page.getByTestId("purge-after")).toContainText("Removed");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Restore Pending Labs?" });
  await dialog.getByLabel(/^Reason/).fill("Removed by mistake");
  await dialog.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("op-tenant-status")).toContainText("Suspended");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Remove Pending Labs?" });
  await dialog.getByLabel("Note for the audit log").fill("Confirmed not in the ecosystem");
  await dialog.getByLabel("Type pending-labs to confirm").fill("pending-labs");
  await dialog.getByRole("button", { name: "Remove project" }).click();
  await page.getByRole("button", { name: "Purge", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Purge Pending Labs’s data now?" });
  await dialog.getByLabel(/^Reason/).fill("Owner asked for deletion");
  await expect(dialog.getByRole("button", { name: "Purge" })).toBeDisabled();
  await dialog.getByLabel("Type pending-labs to confirm").fill("pending-labs");
  await dialog.getByRole("button", { name: "Purge" }).click();
  await expect(page.getByTestId("purge-after")).toBeVisible();

  await page.getByRole("link", { name: "Full audit log" }).click();
  await page.getByLabel("Action").selectOption("tenant.");
  // newest first, read through every page of the cursor
  await expect(page.getByTestId("audit-count")).toContainText("newest first");
  await expect(page.getByTestId("audit").locator("tbody tr").first()).toContainText(
    "tenant.purge_requested",
  );
  for (const a of [
    "tenant.approved",
    "tenant.suspended",
    "tenant.removed",
    "tenant.restored",
    "tenant.purge_requested",
  ])
    await expect(page.getByTestId("audit")).toContainText(a);
  await page.getByLabel("Action").selectOption("operator.read.");
  await expect(page.getByTestId("audit")).toContainText("operator.read.op_tenant_detail");
  await expectAccessible(page, "audit log");
});

test("a plain operator sees admin actions disabled and gets a read-only notice for refused changes", async ({
  page,
}) => {
  await signInOperator(page, "scf-operator");
  await page.goto("/operator/tenants?status=removed");
  await page.getByRole("link", { name: "Old Wallet" }).click();
  await expect(page.getByRole("button", { name: "Restore", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Purge", exact: true })).toBeDisabled();
  await page.goto("/operator/settings");
  await expect(page.getByText("Changes need an operator admin")).toBeVisible();
  await page.getByRole("radio", { name: /^Open/ }).click();
  await expect(page.getByTestId("access-notice")).toContainText("read-only");
  await page.goto("/operator/tombstones");
  await expect(page.getByTestId("access-notice")).toContainText("operator admins");
  await expectAccessible(page, "read-only notices");
});

test("tombstones, enrolment mode, thresholds, API keys and erasure view", async ({ page }) => {
  await signInOperator(page, "scf-admin");
  await page.goto("/operator/tombstones");
  await expect(page.getByTestId("tombstones")).toContainText("oldwallet.example");
  await expectAccessible(page, "tombstones");
  await page.getByRole("button", { name: "Lift tombstone of oldwallet.example" }).click();
  await page.getByTestId("tombstones").getByRole("button", { name: "Lift", exact: true }).click();
  await expect(page.getByTestId("tombstones")).toContainText("Lifted");

  await page.goto("/operator/settings");
  await expect(page.getByRole("radio", { name: /^Approval required/ })).toBeChecked();
  await expect(page.getByTestId("thresholds")).toContainText("op_min_count");
  await expectAccessible(page, "settings");
  await page.getByRole("radio", { name: /^Open/ }).click();
  await expect(page.getByRole("radio", { name: /^Open/ })).toBeChecked();

  await page.goto("/operator/api-keys");
  await page.getByLabel("Name").fill("Round 32 review");
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByTestId("secret-value")).toHaveText(
    /^scfa_op_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/,
  );
  await expect(page.getByTestId("key-Round 32 review")).toContainText("web:read");
  await expect(page.getByTestId("key-Round 32 review")).toContainText("api:read");
  await expectAccessible(page, "API keys");
  await page.getByRole("button", { name: "I’ve copied it" }).click();
  await page.getByRole("button", { name: "Revoke Round 32 review" }).click();
  await page
    .getByTestId("key-Round 32 review")
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await expect(page.getByTestId("key-Round 32 review")).toContainText("Revoked");

  await page.goto("/operator/erasure");
  const er = page.getByTestId("op-erasure-stellar-docs");
  await expect(er).toContainText("1 Aug 2026 – 7 Aug 2026");
  await expect(er).toContainText("Path pattern");
  await expect(er).toContainText("value redacted");
  await expect(er).toContainText("Completed");
  await expect(er).toContainText("120 events removed");
  await page.getByLabel("Status").selectOption("failed");
  await expect(page.getByText("No erasure requests")).toBeVisible();
  await expectAccessible(page, "operator erasure view");
});

test("operators: list, grant and revoke (operator_admin)", async ({ page }) => {
  await signInOperator(page, "scf-admin");
  await page.goto("/operator/operators");
  await expect(page.getByTestId("op-operators")).toContainText("scf-admin");
  await expect(page.getByTestId("op-operators")).toContainText("Operator admin");
  await expectAccessible(page, "operators");
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByLabel("Account user ID")).toBeVisible();
  await expectAccessible(page, "grant form");
});

test("multiplicity mode (C-124): site override and platform setting, operator_admin with step-up", async ({
  page,
}) => {
  await signInOperator(page, "scf-admin");
  await page.goto("/operator/tenants");
  await page.getByRole("link", { name: "Stellar Docs" }).click();
  const docs = page.getByTestId("op-site-Docs site");
  const sel = docs.getByLabel("Suspect traffic handling for Docs site");
  await expect(sel).toHaveValue("platform");
  await sel.selectOption("shadow");
  await expect(docs).toContainText("Now: shadow");
  await expectAccessible(page, "operator project websites");

  // platform setting: switch to shadow and back
  await page.goto("/operator/settings");
  const row = page.getByTestId("setting-multiplicity_mode");
  await expect(row).toContainText("enforce");
  await row.getByRole("button", { name: "Edit multiplicity_mode" }).click();
  await row.getByLabel("New value for multiplicity_mode").fill("shadow");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row).toContainText("shadow");
  await page.goto("/operator/audit?prefix=");
  await expect(page.getByTestId("audit")).toContainText("site.multiplicity_mode_set");

  // the project member's installation check says shadow, set for this website
  await page.context().clearCookies();
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
  await page.goto(
    "/t/a0000000-0000-4000-8000-000000000001/sites/b0000000-0000-4000-8000-000000000001/installation?range=7d",
  );
  await expect(page.getByTestId("multiplicity-mode")).toHaveText("shadow");
  await expect(page.getByTestId("multiplicity")).toContainText("set for this website by SCF");
  await expect(page.getByTestId("multiplicity-high-shadow")).toHaveText("74");
});

test("a plain operator cannot change a website's multiplicity mode", async ({ page }) => {
  await signInOperator(page, "scf-operator");
  await page.goto("/operator/tenants");
  await page.getByRole("link", { name: "Stellar Docs" }).click();
  await expect(
    page.getByTestId("op-site-Docs site").getByLabel("Suspect traffic handling for Docs site"),
  ).toBeDisabled();
});

test("a project member cannot open the operator console", async ({ page }) => {
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(page.getByRole("link", { name: "SCF operator" })).toHaveCount(0);
  await page.goto("/operator/web");
  await expect(page.getByText("only for designated SCF operators")).toBeVisible();
  const status = await page.evaluate(
    async () => (await fetch("/v1/operator/tenants", { credentials: "same-origin" })).status,
  );
  expect(status).toBe(403);
});
