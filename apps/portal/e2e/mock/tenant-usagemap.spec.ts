// SPDX-License-Identifier: Apache-2.0
// The tenant's own Usage Map (getTenantUsageMap): reached from the project navigation, it lists only the registry
// projects the tenant has a confirmed registry link to — status, exact figures, per-day and weekly series, every
// listed contract with the tenant's footprint state, calls per function; window and network in the URL. Without a
// confirmed link it points to the registry claim; a project the user is not a member of is an error, not data. Every
// project here is FAKE.
import { expect, expectAccessible, test } from "../support/fixtures.ts";
import { FAKE_TENANT_CONTRACTS } from "../support/mock-usagemap.ts";

const DOCS_TENANT = "a0000000-0000-4000-8000-000000000001";
const PENDING_TENANT = "a0000000-0000-4000-8000-000000000002";
const DEX = "e0000000-0000-4000-8000-000000000001";
const KIT = "e0000000-0000-4000-8000-000000000003";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__mock/reset");
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
});

test("a tenant sees the usage of its confirmed registry projects", async ({ page }) => {
  // hold the first answer back a moment so the loading state is visible
  let held = false;
  await page.route("**/v1/tenants/*/onchain/usage-map*", async (route) => {
    if (!held) {
      held = true;
      await new Promise((r) => setTimeout(r, 400));
    }
    await route.continue();
  });
  await page.goto(`/t/${DOCS_TENANT}`);
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "On-chain" })
    .click();
  await page
    .getByRole("navigation", { name: "On-chain sections" })
    .getByRole("link", { name: "Usage map" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/t/${DOCS_TENANT}/usage-map\\?range=30d`));
  await expect(page.getByTestId("tenant-usage-loading")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Usage Map" })).toBeAttached();
  await expect(page.getByTestId("tenant-usage-loading")).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Project" }).getByRole("link", { name: "On-chain" }),
  ).toHaveAttribute("aria-current", "page");

  const dex = page.getByTestId(`tenant-usage-${DEX}`);
  const kit = page.getByTestId(`tenant-usage-${KIT}`);
  await expect(dex.getByRole("heading", { name: "Fakeswap DEX (FAKE)" })).toBeVisible();
  await expect(dex.getByTestId("tenant-usage-status")).toContainText("Verified");
  await expect(dex.getByTestId("tenant-usage-status")).toContainText(
    "1 of 2 listed contracts verified",
  );
  await expect(dex.getByTestId("tenant-usage-totals")).toContainText("4,200");
  await expect(
    dex.getByRole("img", { name: "Daily invocations of Fakeswap DEX (FAKE)" }),
  ).toBeVisible();
  // per day (exact: small distinct-invoker counts are shown, not withheld)
  await dex.getByText("Per day").click();
  await expect(dex.getByTestId("tenant-usage-daily").locator("tbody tr")).toHaveCount(7);
  await expect(dex.getByTestId("tenant-usage-weekly")).toContainText("380");
  // footprint state per contract
  await expect(
    dex.getByTestId(`tenant-usage-contract-${FAKE_TENANT_CONTRACTS.dexVerified}`),
  ).toContainText("Verified");
  await expect(
    dex.getByTestId(`tenant-usage-contract-${FAKE_TENANT_CONTRACTS.dexUndeclared}`),
  ).toContainText("Not declared");
  await expect(dex.getByTestId("tenant-usage-functions")).toContainText("another contract");
  await expect(kit.getByTestId("tenant-usage-status")).toContainText("Claimed");
  await expect(
    kit.getByTestId(`tenant-usage-contract-${FAKE_TENANT_CONTRACTS.kitDeclared}`),
  ).toContainText("Declared, not yet verified");
  await expect(
    kit.getByTestId(`tenant-usage-contract-${FAKE_TENANT_CONTRACTS.kitConflict}`),
  ).toContainText("Conflict — under review");
  // the registry lists a contract outside the footprint: the wizard is one click away
  await expect(page.getByTestId("tenant-usage-undeclared")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Declare and verify your contracts" }),
  ).toHaveAttribute("href", `/t/${DOCS_TENANT}/setup/footprint`);
  // unclaimed registry projects never appear
  await expect(page.getByText("Fakelend (FAKE)")).toHaveCount(0);
  await expectAccessible(page, "tenant usage map");

  // window and network go into the URL and the request
  const req = page.waitForRequest(
    (r) => r.url().includes("/onchain/usage-map") && r.url().includes("network=testnet"),
  );
  await page.getByLabel("Network").selectOption("testnet");
  await req;
  await expect(page).toHaveURL(/network=testnet/);
  await expect(page.getByTestId("tenant-usage-window")).toContainText("Testnet");
  await page.getByLabel("Window").selectOption("7d");
  await expect(page).toHaveURL(/range=7d/);
  await expect(page).toHaveURL(/network=testnet/);
  await expect(dex.getByTestId("tenant-usage-totals")).toContainText("4,200");
});

test("without a confirmed registry link the page points to the registry claim", async ({
  page,
}) => {
  await page.goto(`/t/${PENDING_TENANT}/usage-map`);
  const empty = page.getByTestId("tenant-usage-empty");
  await expect(
    empty.getByRole("heading", { name: "No confirmed SCF registry link" }),
  ).toBeVisible();
  await expect(page.getByTestId("tenant-usage-totals")).toHaveCount(0);
  await expectAccessible(page, "tenant usage map, empty");
  await expect(
    empty.getByRole("link", { name: "Check your verification and registry links" }),
  ).toHaveAttribute("href", `/t/${PENDING_TENANT}/verification`);
  await empty.getByRole("link", { name: "Find your project" }).click();
  await expect(page).toHaveURL(/\/onboard$/);
});

test("a project the user is not a member of shows an error, never data", async ({ page }) => {
  await page.goto("/t/a0000000-0000-4000-8000-0000000000ff/usage-map");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("tenant-usage-empty")).toHaveCount(0);
  await expect(page.locator("[data-testid^='tenant-usage-e0']")).toHaveCount(0);
});
