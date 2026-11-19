// SPDX-License-Identifier: Apache-2.0
// Tenant web dashboard (dashboard.*) with fixtures of known value (test/fixtures/web.ts): every metric, verified vs raw,
// compare, every read-path state, hour unit without visit metrics, custom whole-day ranges, anonymous-report rounding
// and "Other" (C-51) next to exact figures, and the browser's time zone never shifting UTC days.
import { EXPECTED_DOCS, EXPECTED_WALLET } from "../../test/fixtures/web.ts";
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const T = "a0000000-0000-4000-8000-000000000001";
const DOCS = `/t/${T}/sites/b0000000-0000-4000-8000-000000000001`;
const WALLET = `/t/${T}/sites/b0000000-0000-4000-8000-000000000002`;

test.beforeEach(async ({ page, request }) => {
  await request.post("/__mock/reset");
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
});

test("every metric of the 30-day view, verified then raw", async ({ page }) => {
  await page.goto(`${DOCS}?range=30d&variant=verified&compare=false`);
  await expect(page.getByTestId("range-text")).toHaveText("14 Oct 2026 – 12 Nov 2026 (UTC)");
  await expect(page.getByTestId("source-indicator")).toContainText("Source: Live.");
  await expect(page.getByTestId("tile-pageviews")).toContainText(EXPECTED_DOCS.pageviews);
  await expect(page.getByTestId("tile-pageviews")).toContainText(
    `Verified ${EXPECTED_DOCS.pageviews} · Raw ${EXPECTED_DOCS.pageviewsRaw} · 1,200 without visitor identifier`,
  );
  await expect(page.getByTestId("tile-visitors").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.visitors,
  );
  await expect(page.getByTestId("tile-visits").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.visits,
  );
  await expect(page.getByTestId("tile-bounce").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.bounceRate,
  );
  await expect(page.getByTestId("tile-duration").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.duration,
  );
  await expect(page.getByTestId("tile-suspect").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.suspect,
  );
  await expect(page.getByTestId("visit-metrics-note")).toContainText(
    "6.0% of this range's page views are suspect",
  );
  await expect(page.getByTestId("visitor-note")).toContainText("sum of daily uniques");
  // Time series: daily points, data table as the text alternative; first UTC day despite the browser's NZ zone.
  const pvTable = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Day (UTC)" }) })
    .first();
  await page.getByText("Show data table: Page views and unique visitors (verified)").click();
  await expect(pvTable.locator("tbody tr")).toHaveCount(30);
  await expect(pvTable.locator("tbody tr").first()).toHaveText(/14 Oct 2026\s*480\s*1,200/);
  await expect(page.getByTestId("visit-series").getByRole("img", { name: "Visits" })).toBeVisible();
  // Breakdowns: anonymous reports on → rounded rows and the merged "Other" row; the literal event "Other" stays.
  await expect(page.getByTestId("anonymized-note")).toContainText("rounded to the nearest 10");
  const countries = page.getByTestId("breakdown-country").locator("tbody tr");
  await expect(countries.nth(0)).toHaveText(/Germany\s*4,100\s*8,200\s*22\.4%/);
  await expect(countries.nth(2)).toHaveText(/Unknown\s*300\s*500/);
  await expect(countries.nth(3)).toHaveText(/Other\s*combined\s*40\s*90\s*0\.2%/);
  await expect(page.getByTestId("breakdown-country")).toContainText("IP Geolocation by DB-IP");
  const events = page.getByTestId("breakdown-event").locator("tbody tr");
  await expect(events.nth(1)).toHaveText(/^Other\s*200\s*20\.0%$/);
  await expect(events.nth(2)).toHaveText(/^Other\s*combined\s*10\s*1\.0%$/);
  await expect(page.getByTestId("breakdown-referrer").locator("tbody tr").nth(2)).toContainText(
    "Direct / none",
  );
  await expect(page.getByTestId("breakdown-path")).toContainText("/docs/getting-started");
  for (const d of ["device", "browser", "os"])
    await expect(page.getByTestId(`breakdown-${d}`).locator("tbody tr").first()).not.toContainText(
      "No data",
    );
  await expect(page.getByRole("link", { name: "Download daily figures (CSV)" })).toHaveAttribute(
    "href",
    `/v1/tenants/${T}/sites/b0000000-0000-4000-8000-000000000001/web/export?range=30d&variant=both`,
  );
  await expectAccessible(page, "dashboard");

  await page.getByRole("button", { name: "All received" }).click();
  await expect(page).toHaveURL(/variant=raw/);
  await expect(page.getByTestId("tile-pageviews").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.pageviewsRaw,
  );
  await expect(page.getByTestId("tile-visitors").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.visitorsRaw,
  );
  // One figure each: visits, bounce rate, duration do not change with the toggle (C-73).
  await expect(page.getByTestId("tile-visits").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.visits,
  );
  await expect(countries.nth(0)).toHaveText(/Germany\s*4,300\s*8,600/);
});

test("compare with the previous period", async ({ page }) => {
  await page.goto(`${DOCS}?range=30d&variant=verified&compare=false`);
  await page.getByLabel("Compare with previous period").check();
  await expect(page.getByTestId("tile-pageviews-delta")).toHaveText(
    `${EXPECTED_DOCS.deltaPageviews} vs previous period`,
  );
  await expect(page.getByTestId("tile-visitors-delta")).toHaveText(
    `${EXPECTED_DOCS.deltaVisitors} vs previous period`,
  );
  await expect(page.getByTestId("tile-visits-delta")).toHaveText(
    `${EXPECTED_DOCS.deltaVisits} vs previous period`,
  );
  await expect(page.getByTestId("tile-bounce-delta")).toHaveText(
    `${EXPECTED_DOCS.deltaBounce} vs previous period`,
  );
  await expect(page.getByTestId("tile-duration-delta")).toHaveText(
    `${EXPECTED_DOCS.deltaDuration} vs previous period`,
  );
  await expect(page.getByTestId("comparison-unavailable")).toHaveCount(0);
});

test("90 days: mixed read path and comparison unavailable (C-109, C-112)", async ({ page }) => {
  await page.goto(`${DOCS}?range=90d&variant=verified&compare=true`);
  await expect(page.getByTestId("source-indicator")).toContainText(
    "Mixed: daily rollups before 20 Oct 2026, live from then on.",
  );
  await expect(page.getByTestId("comparison-unavailable")).toBeVisible();
  await expect(page.getByTestId("tile-pageviews-delta")).toHaveCount(0);
  await expect(page.getByTestId("tile-pageviews").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.pageviews,
  );
  await expect(page.getByTestId("breakdown-country")).toContainText(
    "Older days keep only their top 50 rows",
  );
});

test("12 months: rollup path with partial today; monthly series", async ({ page }) => {
  await page.goto(`${DOCS}?range=12m&variant=verified&compare=false`);
  await expect(page.getByTestId("source-indicator")).toContainText("Source: Daily rollups.");
  await expect(page.getByTestId("partial-today")).toContainText("up to an hour behind");
  await expect(page.getByLabel("Interval")).toHaveValue("month");
  await page.getByText("Show data table: Page views and unique visitors (verified)").click();
  await expect(page.getByRole("columnheader", { name: "Month" }).first()).toBeVisible();
});

test("24 hours: hourly series hide the visit metrics (C-112(4))", async ({ page }) => {
  await page.goto(`${DOCS}?range=24h&variant=verified&compare=false`);
  await expect(page.getByLabel("Interval")).toHaveValue("hour");
  await expect(page.getByTestId("visit-series-hidden")).toContainText("not shown by hour");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByTestId("range-text")).toHaveText(
    "11 Nov 2026, 10:00 UTC – 12 Nov 2026, 10:00 UTC (UTC)",
  );
  // Visit tiles still show the range's single figures.
  await expect(page.getByTestId("tile-visits").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_DOCS.visits,
  );
  await page.getByLabel("Interval").selectOption("day");
  await expect(page.getByTestId("visit-series").getByRole("img", { name: "Visits" })).toBeVisible();
});

test("custom whole-day range", async ({ page }) => {
  await page.goto(`${DOCS}?range=30d&variant=verified&compare=false`);
  await page
    .getByRole("group", { name: "Date range" })
    .getByRole("button", { name: "Custom" })
    .click();
  await page.getByLabel("First day (UTC)").fill("2026-10-01");
  await page.getByLabel("Last day (UTC)").fill("2026-10-07");
  const req = page.waitForRequest(
    (r) => r.url().includes("/web/stats") && r.url().includes("range=custom"),
  );
  await page.getByRole("button", { name: "Apply" }).click();
  const url = new URL((await req).url());
  expect(url.searchParams.get("start")).toBe("2026-10-01T00:00:00Z");
  expect(url.searchParams.get("end")).toBe("2026-10-08T00:00:00Z");
  await expect(page).toHaveURL(/range=custom/);
  await expect(page).toHaveURL(/from=2026-10-01/);
  await expect(page).toHaveURL(/to=2026-10-07/);
  await expect(page.getByTestId("range-text")).toHaveText("1 Oct 2026 – 7 Oct 2026 (UTC)");
  await expect(page.getByLabel("Interval")).toHaveValue("day");
  await page.getByLabel("Last day (UTC)").fill("2026-09-01");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The last day must not be before the first day.",
  );
});

test("anonymous reports off: exact counts and no merged row", async ({ page }) => {
  await page.goto(`${WALLET}?range=7d&variant=verified&compare=false`);
  await expect(page.getByTestId("tile-pageviews").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_WALLET.pageviews,
  );
  await expect(page.getByTestId("tile-visitors").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_WALLET.visitors,
  );
  await expect(page.getByTestId("tile-visits").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_WALLET.visits,
  );
  await expect(page.getByTestId("tile-bounce").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_WALLET.bounceRate,
  );
  await expect(page.getByTestId("tile-duration").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_WALLET.duration,
  );
  await expect(page.getByTestId("tile-suspect").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_WALLET.suspect,
  );
  await expect(page.getByTestId("exact-note")).toBeVisible();
  await expect(page.getByTestId("anonymized-note")).toHaveCount(0);
  await expect(page.getByTestId("breakdown-country").locator("tbody tr").nth(1)).toHaveText(
    /Nigeria\s*3\s*4\s*0\.3%/,
  );
  await expect(page.getByText("combined")).toHaveCount(0);
  await expectAccessible(page, "dashboard (exact)");
});
