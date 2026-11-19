// SPDX-License-Identifier: Apache-2.0
// Plan C1 #6 (feature.signed-snapshot-v2): the methodology URL signed into v2 snapshots serves the published document under the portal
// CSP. ops.end-of-window-read-only: the read-only banner appears at start and after a write is refused in read-only mode.
import { expect, expectAccessible, test } from "../support/fixtures.ts";

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("/docs/methodology/1.0.0 is the published methodology, read-only and CSP-clean", async ({
  page,
  request,
}) => {
  const res = await page.goto("/docs/methodology/1.0.0");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["content-security-policy"]).toContain("default-src 'none'");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /Measurement methodology scf-methodology\/1\.0\.0/,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Small-count floors" })).toBeVisible();
  // The stylesheet loaded (SRI and style-src 'self' passed): tables have borders.
  const border = await page
    .locator("td")
    .first()
    .evaluate((el) => getComputedStyle(el).borderTopStyle);
  expect(border).toBe("solid");
  await page.getByRole("link", { name: "Flags and appeals" }).first().click();
  await expect(page).toHaveURL(/#flags-and-appeals$/);
  await expectAccessible(page, "methodology");
  // An unknown version is a 404, never the SPA shell.
  expect((await request.get("/docs/methodology/9.9.9")).status()).toBe(404);
});

test("read-only mode: banner at start, and after a refused write", async ({ page, request }) => {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
  await expect(page.getByTestId("read-only-banner")).toHaveCount(0);

  // The operator switches read-only mode on while the page is open: the next write is refused and the banner shows.
  await request.post("/__mock/read-only", { data: { enabled: true, ingest: "accept" } });
  await page.getByLabel("Project name").fill("Refused Project");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByText("the platform is in read-only mode")).toBeVisible();
  const banner = page.getByRole("status").filter({ hasText: "Read-only mode" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Data collection continues");
  await expectAccessible(page, "read-only banner");

  // A fresh load shows it at once; paused ingest is stated.
  await request.post("/__mock/read-only", { data: { enabled: true, ingest: "pause" } });
  await page.reload();
  await expect(page.getByTestId("read-only-banner")).toContainText("data collection is paused");
  await request.post("/__mock/read-only", { data: { enabled: false } });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
  await expect(page.getByTestId("read-only-banner")).toHaveCount(0);
});
