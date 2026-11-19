// SPDX-License-Identifier: Apache-2.0
// Tenant API analytics (dashboard.api-*, isolation.api-dashboard), ingest tokens and erasure (privacy.tenant-erasure) against the mock control plane with fixtures of
// known value (test/fixtures/api.ts): every number on screen is asserted, CSP/Trusted Types are watched on every page
// (support/fixtures.ts) and axe runs on every new page.
import { EXPECTED_API, SVC_HORIZON, SVC_RPC } from "../../test/fixtures/api.ts";
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const T = "a0000000-0000-4000-8000-000000000001";
const HORIZON = `/t/${T}/services/${SVC_HORIZON}`;

test.beforeEach(async ({ page, request }) => {
  await request.post("/__mock/reset");
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
});

test("services list → API dashboard with every figure, accuracy class and self-attested label", async ({
  page,
}) => {
  await page.goto(`/t/${T}`);
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "API", exact: true })
    .click();
  // the API page opens the first service; the list of services is in Settings → API services
  await expect(page.getByRole("heading", { level: 1, name: "API" })).toBeVisible();
  await page.goto(`/t/${T}/settings?tab=services`);
  await expect(page.getByRole("heading", { name: "API services" })).toBeVisible();
  await expect(page.getByTestId("multi-soroban-rpc-gw")).toHaveText("more than one stream group");
  await expectAccessible(page, "services");

  await page.getByRole("link", { name: "Horizon proxy" }).click();
  await expect(page).toHaveURL(new RegExp(`${HORIZON}\\?`));
  await expect(page.getByTestId("range-text")).toHaveText(
    "6 Nov 2026 – 12 Nov 2026 (UTC) · data per hour",
  );
  await expect(page.getByTestId("self-attested")).toContainText("Self-attested telemetry");
  await expect(page.getByTestId("tile-requests").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.requests,
  );
  await expect(page.getByTestId("tile-5xx").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.errorRate5xx,
  );
  await expect(page.getByTestId("tile-4xx").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.errorRate4xx,
  );
  await expect(page.getByTestId("tile-p50").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.p50,
  );
  await expect(page.getByTestId("tile-p95").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.p95,
  );
  await expect(page.getByTestId("tile-p99").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.p99,
  );
  await expect(page.getByTestId("tile-p95")).toContainText("accuracy: ± 4.3 %");
  await expect(page.getByTestId("accuracy-note")).toContainText("within 4.3 %");
  // Time series: hourly buckets of the 7-day preset, first value of the fixture.
  await page.getByText("Show data table: Requests").click();
  const reqTable = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Hour (UTC)" }) })
    .first();
  await expect(reqTable.locator("tbody tr")).toHaveCount(168);
  await expect(reqTable.locator("tbody tr").first()).toContainText("6 Nov 2026 00:00");
  // Status distribution and per-code breakdown add up to the requests.
  await expect(page.getByTestId("class-s2xx")).toHaveText(/2xx success\s*1,201,000\s*93\.50%/);
  await expect(page.getByTestId("class-s5xx")).toHaveText(/5xx server error\s*9,800\s*0\.76%/);
  await page.getByText("Per status code", { exact: true }).click();
  await expect(page.getByTestId("status-codes")).toContainText("404");
  // Routes, with {unknown} and {overflow} explained.
  const routes = page.getByTestId("route-table").locator("tbody tr");
  await expect(routes).toHaveCount(5);
  await expect(routes.first()).toHaveText(
    /\/accounts\/\{account_id\}\s*640,000\s*49\.82%\s*0\.50%\s*38 ms\s*291 ms\s*870 ms\s*± 4\.3 %/,
  );
  await expect(page.getByTestId("placeholder-help")).toContainText("{overflow}");
  await expect(page.getByTestId("placeholder-help")).toContainText("matched no route");
  await expectAccessible(page, "API dashboard");
  // Data quality in plain language (its own tab).
  await page.getByRole("tab", { name: "Data quality" }).click();
  await expect(page.getByTestId("dq-issues")).toContainText("The ingest token had expired.");
  await expect(page.getByTestId("dq-design")).toContainText("120,400");
  await page.getByRole("group", { name: "Period" }).getByRole("button", { name: "30d" }).click();
  await expect(page.getByTestId("dq-design")).toContainText("481,600");
  await expectAccessible(page, "API data quality");
  await page.getByRole("tab", { name: "Traffic" }).click();

  // Sort by p95 (descending first), then narrow everything to one route.
  await page.getByRole("button", { name: /^p95/ }).click();
  await expect(page).toHaveURL(/sort=-p95_ms/);
  await expect(routes.first()).toContainText("{overflow}");
  await page.getByRole("button", { name: "/transactions/{tx_hash}" }).click();
  await expect(page.getByTestId("route-filter")).toContainText("/transactions/{tx_hash}");
  await expect(page.getByTestId("tile-requests").locator(".um-kpi-v strong")).toHaveText("410,000");
  await expect(page.getByTestId("tile-p99").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.transactionsP99,
  );
  await expect(page.getByTestId("route-table")).toHaveCount(0);
  await page.getByRole("button", { name: "Show all routes" }).click();
  await expect(page.getByTestId("route-table")).toBeVisible();
});

test("compare with the previous period and custom whole-day ranges", async ({ page }) => {
  await page.goto(`${HORIZON}?range=7d&compare=false&sort=-requests`);
  await page.getByLabel("Compare with previous period").check();
  await expect(page.getByTestId("tile-requests")).toContainText(
    `${EXPECTED_API.requestsDelta} vs previous period`,
  );
  await expect(page.getByTestId("tile-p95")).toContainText("+6.1% vs previous period");
  await expect(page.getByTestId("previous-range")).toHaveText(
    "Previous period: 30 Oct 2026 – 5 Nov 2026 (UTC).",
  );
  await page
    .getByRole("group", { name: "Date range" })
    .getByRole("button", { name: "Custom" })
    .click();
  await page.getByLabel("First day (UTC)").fill("2026-10-01");
  await page.getByLabel("Last day (UTC)").fill("2026-10-10");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("range-text")).toHaveText(
    "1 Oct 2026 – 10 Oct 2026 (UTC) · data per UTC day",
  );
  await expect(page.getByTestId("tile-requests").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.requestsPrevious,
  );
});

test("explicit 15-bucket service: ≤ 5 ms, bucket-width caveat, stream-group warning", async ({
  page,
}) => {
  await page.goto(`/t/${T}/services/${SVC_RPC}?range=30d&compare=false&sort=-requests`);
  await expect(page.getByTestId("tile-p50").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.rpcP50,
  );
  await expect(page.getByTestId("tile-p95").locator(".um-kpi-v strong")).toHaveText(
    EXPECTED_API.rpcP95,
  );
  await expect(page.getByTestId("accuracy-note")).toContainText("“≤ 5 ms”");
  await expect(page.getByTestId("stream-warning")).toContainText("Two stream groups report");
  await expect(page.getByTestId("route-table")).toContainText("getLedgerEntries");
});

test("a foreign or unknown service is the same not-found", async ({ page }) => {
  await page.goto(`/t/${T}/services/d9999999-0000-4000-8000-000000000001?range=7d`);
  await expect(page.getByRole("alert").first()).toContainText("Not found");
  await page.goto(`/t/a0000000-0000-4000-8000-000000000003/services/${SVC_HORIZON}?range=7d`);
  await expect(page.getByRole("alert").first()).toContainText("Not found");
});

test("ingest tokens: created token shown once, rotation reminder, revoke, limit of five", async ({
  page,
}) => {
  await page.goto(`/t/${T}/ingest-tokens`);
  await expect(page.getByTestId("token-count")).toHaveText("2 of 5 active tokens in use.");
  await expect(page.getByTestId("token-old staging")).toContainText(
    "older than 12 months — rotate",
  );
  await expectAccessible(page, "ingest tokens");
  await page.getByRole("button", { name: "New token" }).click();
  await page.getByLabel("Label", { exact: true }).fill("ci exporter");
  await page.getByLabel("horizon-proxy").check();
  await page.getByRole("button", { name: "Create token" }).click();
  const secret = page.getByTestId("secret-value");
  await expect(secret).toHaveText(/^scfa_ing_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/);
  const value = (await secret.textContent()) as string;
  await expect(page.getByTestId("token-ci exporter")).toContainText(`${value.slice(0, 22)}…`);
  await expect(page.getByTestId("token-ci exporter")).not.toContainText(value.slice(23));
  await expectAccessible(page, "token shown once");
  await page.getByRole("button", { name: "I have stored it — hide it" }).click();
  await expect(page.getByTestId("secret-once")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(value)).toHaveCount(0);
  // Revoke with a confirmation.
  await page.getByRole("button", { name: "Revoke old staging" }).click();
  const dialog = page.getByRole("dialog", { name: "Revoke “old staging”?" });
  await expect(dialog).toContainText("within 60 seconds");
  await expectAccessible(page, "revoke dialog");
  await dialog.getByRole("button", { name: "Revoke token" }).click();
  await expect(page.getByTestId("token-old staging")).toContainText("revoked");
  await expect(page.getByTestId("token-count")).toHaveText("2 of 5 active tokens in use.");
  for (const l of ["t3", "t4", "t5"]) {
    await page.getByRole("button", { name: "New token" }).click();
    await page.getByLabel("Label", { exact: true }).fill(l);
    await page.getByRole("button", { name: "Create token" }).click();
    await expect(page.getByTestId(`token-${l}`)).toBeVisible();
  }
  await expect(page.getByText("All 5 active tokens are in use")).toBeVisible();
});

test("ingest tokens need recent authentication (C-119): asked for before the request", async ({
  page,
  request,
}) => {
  await request.post("/__mock/expire-recent-auth");
  await page.goto(`/t/${T}/ingest-tokens`);
  await page.getByRole("button", { name: "New token" }).click();
  await page.getByLabel("Label", { exact: true }).fill("late token");
  await page.getByRole("button", { name: "Create token" }).click();
  const reauth = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(reauth).toBeVisible();
  await reauth.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alert")).toContainText("Confirmation cancelled");
  await expect(page.getByTestId("token-late token")).toHaveCount(0);
  await page.getByRole("button", { name: "Revoke old staging" }).click();
  await page
    .getByRole("dialog", { name: "Revoke “old staging”?" })
    .getByRole("button", { name: "Revoke token" })
    .click();
  await expect(page.getByRole("dialog", { name: "Confirm it is you" })).toBeVisible();
  const reqs = (await (await request.get("/__mock/requests")).json()) as {
    method: string;
    path: string;
  }[];
  expect(reqs.some((r) => r.method !== "GET" && r.path.includes("/ingest-tokens"))).toBe(false);
});

test("erasure: request → preview → confirm with a fresh sign-in → completion report", async ({
  page,
  request,
}) => {
  await page.goto(`/t/${T}/erasure`);
  await expect(page.getByRole("heading", { name: "Data erasure" })).toBeVisible();
  // The historic request shows a redacted selector: type and length only.
  await expect(
    page.getByRole("cell", { name: /page path pattern \(redacted, 17 characters\)/ }),
  ).toBeVisible();
  await expectAccessible(page, "erasure list");
  await page.getByLabel("Website", { exact: true }).selectOption({ label: "Docs site" });
  await page.getByLabel("First day (UTC)").fill("2026-10-01");
  await page.getByLabel("Last day (UTC)").fill("2026-10-31");
  await page.getByLabel("Only matching data").check();
  await page.getByLabel("Value").fill("users/jane/*");
  await page.getByRole("button", { name: "Preview erasure" }).click();
  await expect(page.getByRole("alert")).toContainText("starts with “/”");
  await page.getByLabel("Value").fill("/users/jane/*");
  await page.getByRole("button", { name: "Preview erasure" }).click();
  await expect(page.getByTestId("erasure-covers")).toHaveText(
    "page path pattern “/users/jane/*”, 1 Oct 2026 – 31 Oct 2026",
  );
  await expect(page.getByTestId("erasure-status")).toContainText("Preview ready");
  await expect(page.getByTestId("erasure-preview")).toContainText(
    /Website events \(page views and custom events\)\s*120/,
  );
  await expect(page.getByTestId("erasure-preview")).toContainText("2026-09-14, 2026-09-15");
  await expectAccessible(page, "erasure preview");

  // Recent authentication lapsed: confirming asks for a fresh sign-in first; cancelling erases nothing.
  await request.post("/__mock/expire-recent-auth");
  await page.reload();
  await page.getByRole("button", { name: "Erase this data" }).click();
  let dialog = page.getByRole("dialog", { name: "Erase this data permanently?" });
  await expect(dialog.getByRole("button", { name: "Erase permanently" })).toBeDisabled();
  await dialog.getByLabel("Type erase to confirm").fill("erase");
  await dialog.getByRole("button", { name: "Erase permanently" }).click();
  const reauth = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(reauth).toBeVisible();
  await reauth.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alert")).toContainText("Confirmation cancelled");
  await expect(page.getByTestId("erasure-status")).toContainText("Preview ready");

  // Fresh sign-in (GitHub, same account), then confirm.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await page.goto(`/t/${T}/erasure`);
  await page.getByRole("link", { name: /UTC/ }).first().click();
  await page.getByRole("button", { name: "Erase this data" }).click();
  dialog = page.getByRole("dialog", { name: "Erase this data permanently?" });
  await dialog.getByLabel("Type erase to confirm").fill("erase");
  await dialog.getByRole("button", { name: "Erase permanently" }).click();
  await expect(page.getByTestId("erasure-status")).toContainText("Completed");
  await expect(page.getByTestId("erasure-result")).toContainText(
    /Visits left without events \(removed too\)\s*3/,
  );
  await expect(page.getByTestId("backup-note")).toHaveText(
    "Erased data leaves all backups within 56 days.",
  );
  await expect(page.getByTestId("erasure-report")).toContainText(
    "kept for 56 days after the job ended",
  );
  await expectAccessible(page, "erasure report");
});
