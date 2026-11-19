// SPDX-License-Identifier: Apache-2.0
// Product improvements of 2026-11-19 against the mock control plane: the secret-seed leak warning (shown on every
// project page while unacknowledged, guidance, acknowledge), traffic not counted by reason on the Trust page and the
// public card, … Every page runs under the production CSP (fixtures.ts) and is checked with axe.

import type { Page } from "@playwright/test";
import { SVC_HORIZON } from "../../test/fixtures/api.ts";
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  registerSecondOperatorPasskey,
  test,
} from "../support/fixtures.ts";

const T = "a0000000-0000-4000-8000-000000000001";
const DOCS_SITE = "b0000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__mock/reset");
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
});

test("secret seeds in API paths: banner on project pages, guidance, acknowledge", async ({
  page,
}) => {
  await page.goto(`/t/${T}/services`);
  const banner = page.getByRole("region", { name: "Secret-seed warning" });
  await expect(banner).toContainText(
    "3 Stellar secret seeds appeared in your API request paths since 4 Nov 2026 — rotate those keys",
  );
  await expect(banner.getByTestId("seed-warning-services")).toContainText("horizon-proxy: 2");
  await banner.getByText("What to do").click();
  await expect(banner.getByRole("link", { name: /guide to signers/ })).toBeVisible();
  await expectAccessible(page, "seed-warning");
  await page.goto(`/t/${T}/trust`);
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: /acknowledge/ }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Trust" })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test("traffic not counted: per website on the Trust page, tenant-wide on the public card", async ({
  page,
}) => {
  await page.goto(`/t/${T}/trust`);
  const f = page.getByTestId(`filtered-${DOCS_SITE}`);
  // 30 days of the seeded site: 48,000 verified, 2,560 suspect, 1,244 rejected
  await expect(f.getByTestId("filtered-traffic-headline")).toHaveText(
    "7.3 % of 51,804 events were not counted in the verified figures: 4.9 % suspect (counted in raw figures only) and 2.4 % rejected (never counted).",
  );
  const first = f.getByTestId("filtered-traffic-reasons").locator("tbody tr").first();
  await expect(first).toContainText("No proof-of-work");
  await expect(first).toContainText("suspect — raw figures only");
  await expect(first).toContainText("1,680");
  await expectAccessible(page, "trust with filtered traffic");

  await page.goto(`/t/${T}/ingest-tokens`);
  await page.getByRole("button", { name: "New share key" }).click();
  await page.getByLabel("Share key label").fill("filtered");
  await page.getByRole("button", { name: "Create share key" }).click();
  const secret = (await page.getByTestId("secret-value").textContent()) ?? "";
  await page.goto("/p/stellar-docs");
  await page.getByLabel("Share key", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Use key" }).click();
  const pub = page.getByTestId("public-filtered-section");
  await expect(pub.getByTestId("public-filtered-headline")).toContainText(
    "10 % of 60,000 events were not counted",
  );
  await expect(pub.getByTestId("public-filtered-reasons").locator("tbody tr")).toHaveCount(4);
  await expect(pub).toContainText("2 less frequent reasons are not shown");
  await expectAccessible(page, "public card with filtered traffic");
});

test("API dashboard: SLO card with an editable objective, Stellar surfaces, per-route CSV", async ({
  page,
}) => {
  await page.goto(`/t/${T}/services/${SVC_HORIZON}?tab=surfaces`);
  const slo = page.getByTestId("slo-card");
  await expect(slo.getByTestId("slo-availability")).toContainText("99.237 %");
  await expect(slo.getByTestId("slo-availability")).toContainText("objective 99.5 % · missed");
  await expect(slo.getByTestId("slo-budget")).toContainText("9,800 of 6,421 allowed 5xx responses");
  await expect(slo.getByTestId("slo-coverage")).toContainText("100 %");
  await expect(slo.getByTestId("slo-honesty")).toContainText("200 requests without a status code");
  await slo.getByRole("button", { name: "Change objective" }).click();
  await slo.getByLabel("Objective (%)").fill("99");
  await slo.getByRole("button", { name: "Save objective" }).click();
  await expect(slo.getByTestId("slo-availability")).toContainText("objective 99 % · met");

  const surfaces = page.getByTestId("api-surfaces");
  await expect(surfaces.getByTestId("surface-horizon")).toContainText("Horizon API");
  await expect(surfaces.getByTestId("surface-horizon")).toContainText("transactions");
  await expect(surfaces).toContainText("stellar-surfaces/1.0.0");
  await expectAccessible(page, "api dashboard with SLO and surfaces");

  await page.getByRole("tab", { name: "Traffic" }).click();
  const href = await page.getByTestId("routes-csv").getAttribute("href");
  expect(href).toContain(`/services/${SVC_HORIZON}/api/routes/export?`);
  const csv = await page.request.get(href as string); // the browser context's session cookie
  expect(csv.headers()["content-type"]).toContain("text/csv");
  expect((await csv.text()).split("\r\n")[0]).toMatch(/^route,rpc_method,surface,surface_group,/);
});

test("every metric card on the main pages carries its definition", async ({ page }) => {
  for (const url of [
    `/t/${T}`,
    `/t/${T}/services/${SVC_HORIZON}`,
    `/t/${T}/sites/${DOCS_SITE}?range=30d&variant=verified&compare=false`,
    `/t/${T}/sites/${DOCS_SITE}/installation`,
  ]) {
    await page.goto(url);
    // legacy tiles (installation check) and the kit's KPI cards
    const tiles = page.locator(".tile, .um-kpi");
    await expect(tiles.first()).toBeVisible();
    const n = await tiles.count();
    expect(n, url).toBeGreaterThan(2);
    await expect(page.locator(".tile:not([data-metric])")).toHaveCount(0);
    for (let i = 0; i < n; i++)
      await expect(tiles.nth(i).locator("details.metric-info")).toHaveCount(1);
  }
  const p95 = page.getByTestId("verdict-suspect");
  await p95.getByLabel(/^Definition: Events by verdict/).click();
  await expect(p95.locator("details.metric-info p")).toContainText("worst verdict");
  await expectAccessible(page, "installation with an open definition");
});

async function signInOperator(page: Page) {
  await page.context().clearCookies();
  await addVirtualAuthenticator(page);
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as scf-operator" }).click();
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page).not.toHaveURL(/\/signin(\/|\?|$)/);
  await registerSecondOperatorPasskey(page);
}

test("operator overview: one row per project with web and API columns and flags", async ({
  page,
}) => {
  await signInOperator(page);
  await page.goto("/operator");
  await page
    .getByRole("navigation", { name: "Operator" })
    .getByRole("link", { name: "Overview" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeAttached();
  const table = page.getByTestId("op-overview");
  await expect(table.getByTestId("ov-row-stellar-docs")).toContainText("36.9k");
  await expect(table.getByTestId("ov-row-soroban-swap")).toContainText("52.4k");
  await expectAccessible(page, "operator overview");
  await page.goto("/operator/overview?min_level=L0");
  await expect(table.getByTestId("ov-row-hobby-site")).toBeVisible();
});
