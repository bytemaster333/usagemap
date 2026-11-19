// SPDX-License-Identifier: Apache-2.0
// Ecosystem Usage Map (operator console): every registry project with contracts in one sortable table — sparkline,
// claim/verified badge, the "ownership not verified" caveat — filters by round, category and status, CSV download,
// and a project's detail (weekly active accounts, listed contracts, calls per function by caller kind). Tenants are
// refused. Every project here is FAKE.
import type { Page } from "@playwright/test";
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  registerSecondOperatorPasskey,
  test,
} from "../support/fixtures.ts";

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

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

test("SCF operator: usage map table, sorting, filters, CSV and a project's detail", async ({
  page,
}) => {
  await signInOperator(page);
  await page.goto("/operator/web");
  await page.getByRole("link", { name: "Usage map" }).click();
  await expect(page).toHaveURL(/\/operator\/usage-map/);
  await expect(page.getByRole("heading", { level: 1, name: "Usage map" })).toBeAttached();
  await expect(page.getByTestId("usage-map-caveat")).toContainText("ownership not verified");
  await expect(page.getByTestId("usage-map-totals")).toContainText("Projects with contracts");
  await expect(page.getByTestId("usage-map-verified")).toContainText("1");

  const table = page.getByTestId("usage-map-table");
  const names = () => table.locator("tbody th[scope=row] a").allTextContents();
  // default: most invocations first
  await expect
    .poll(names)
    .toEqual(["Fakeswap DEX (FAKE)", "Fakelend (FAKE)", "Fakewallet Kit (FAKE)"]);
  await expect(
    table.getByRole("img", { name: "Daily invocations of Fakelend (FAKE)" }),
  ).toBeVisible();
  const lend = page.getByTestId("usage-row-e0000000-0000-4000-8000-000000000002");
  await expect(lend).toContainText("Unclaimed");
  await expect(lend).toContainText("−20.8%");
  await expect(page.getByTestId("usage-row-e0000000-0000-4000-8000-000000000001")).toContainText(
    "1/2",
  );
  // sort by project name, then reverse
  await table.getByRole("button", { name: "Project" }).click();
  await expect(page).toHaveURL(/sort=name/);
  await expect
    .poll(names)
    .toEqual(["Fakelend (FAKE)", "Fakeswap DEX (FAKE)", "Fakewallet Kit (FAKE)"]);
  await expect(table.getByRole("columnheader", { name: "Project" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  );
  await table.getByRole("button", { name: "Project" }).click();
  await expect
    .poll(names)
    .toEqual(["Fakewallet Kit (FAKE)", "Fakeswap DEX (FAKE)", "Fakelend (FAKE)"]);
  await expectAccessible(page, "usage map");

  // filters (applied by the server)
  await page.getByLabel("SCF round").selectOption("35");
  await expect(page).toHaveURL(/round=35/);
  await expect.poll(names).toEqual(["Fakewallet Kit (FAKE)", "Fakelend (FAKE)"]);
  await page.getByLabel("Category").selectOption("developer_tooling");
  await expect.poll(names).toEqual(["Fakewallet Kit (FAKE)"]);
  await page.getByLabel("Category").selectOption("");
  await page.getByLabel("Claim status").selectOption("unclaimed");
  await expect.poll(names).toEqual(["Fakelend (FAKE)"]);

  // CSV of the filtered list
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^usage-map-\d{4}-\d{2}-\d{2}\.csv$/);

  // detail
  await table.getByRole("link", { name: "Fakelend (FAKE)" }).click();
  await expect(page).toHaveURL(/\/operator\/usage-map\/e0000000-0000-4000-8000-000000000002/);
  await expect(page.getByRole("heading", { level: 1, name: "Fakelend (FAKE)" })).toBeVisible();
  await expect(page.getByTestId("usage-project-status")).toContainText("Unclaimed");
  await expect(page.getByTestId("usage-project-weekly")).toContainText("2026-11-09");
  await expect(page.getByTestId("usage-project-weekly")).toContainText("95");
  await expect(page.getByTestId("usage-project-contracts")).toContainText("Listed only");
  const fns = page.getByTestId("usage-project-functions");
  await expect(fns).toContainText("swap");
  await expect(fns).toContainText("contract");
  await expectAccessible(page, "usage map project");
  await page.getByRole("main").getByRole("link", { name: "Usage map" }).click();
  await expect(page).toHaveURL(/\/operator\/usage-map\?/);
});

test("a tenant user cannot open the usage map", async ({ page }) => {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
  await page.goto("/operator/usage-map");
  await expect(
    page.getByRole("heading", { name: "This account has no operator access" }),
  ).toBeVisible();
  await expect(page.getByTestId("usage-map-table")).toHaveCount(0);
});
