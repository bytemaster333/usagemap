// SPDX-License-Identifier: Apache-2.0
// Tenant area: switcher, create tenant, create site → snippet (both profiles, consent mode), domains, installation
// check (C-39), anonymous-reports switch; every write carries the CSRF header (C-20).
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const DOCS_TENANT = "a0000000-0000-4000-8000-000000000001";
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

test("create a project and a website, then get its SRI snippet", async ({ page, request }) => {
  await expectAccessible(page, "tenants");
  await page.getByLabel("Project name").fill("Soroban Explorer");
  await expect(page.getByLabel("Short name (used in links)")).toHaveValue("soroban-explorer");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("project-switcher")).toContainText("Soroban Explorer");
  await expect(page.getByText("No website yet").first()).toBeVisible();
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("link", { name: "Websites" }).click();
  await page.getByRole("button", { name: "New website" }).click();
  await page.getByLabel("Website name").fill("Explorer web");
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/\/snippet\?format=html$/);
  await expect(page.getByTestId("site-profile")).toHaveText("standard");
  const code = page.getByTestId("snippet-code");
  await expect(code).toContainText('integrity="sha384-');
  await expect(code).toContainText("standard.js");
  await expect(page.getByTestId("snippet-integrity")).toHaveText(/^sha384-/);
  await expectAccessible(page, "snippet");
  // The other profile.
  await page.getByRole("button", { name: "Switch to the strict profile" }).click();
  await expect(page.getByTestId("site-profile")).toHaveText("strict");
  await expect(code).toContainText("strict.js");
  // Consent mode.
  await page.getByLabel("Format").selectOption("consent_html");
  await expect(code).toContainText('data-consent="required"');
  await expect(page.getByTestId("consent-help")).toContainText("grantConsent()");
  // Both profiles of the published versions are listed with their integrity.
  await expect(page.getByRole("cell", { name: "strict", exact: true })).toBeVisible();
  // Switcher lists the new project.
  await expect(page.getByTestId("project-switcher")).toContainText("Soroban Explorer");
  const log = (await (await request.get("/__mock/requests")).json()) as {
    method: string;
    csrfHeader: boolean;
    origin: string | null;
  }[];
  const writes = log.filter((r) => r.method !== "GET");
  expect(writes.length).toBeGreaterThanOrEqual(3);
  for (const w of writes) {
    expect(w.csrfHeader).toBe(true);
    expect(w.origin).toMatch(/^http:\/\/localhost:\d+$/);
  }
});

test("the tenant switcher moves between projects; a pending project says so", async ({ page }) => {
  await page.getByRole("button", { name: /^Switch project/ }).click();
  await page
    .getByRole("list", { name: "Your Stellar ecosystem projects" })
    .getByRole("link", { name: /Pending Labs/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("project-switcher")).toContainText("Pending Labs");
  await expect(page.getByText("awaiting approval by an SCF operator")).toBeVisible();
  await page.getByRole("button", { name: /^Switch project/ }).click();
  await page
    .getByRole("list", { name: "Your Stellar ecosystem projects" })
    .getByRole("link", { name: /Stellar Docs/ })
    .click();
  await expect(page.getByTestId("project-switcher")).toContainText("Stellar Docs");
  await expect(page.getByRole("list", { name: "Your sources" })).toBeVisible();
});

test("domains: add, verify by DNS TXT, remove", async ({ page }) => {
  await page.goto(`/t/${DOCS_TENANT}/sites/${DOCS_SITE}/settings`);
  await page.getByLabel("Add a domain").fill("docs.example.org");
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page.getByTestId("domain-state-docs.example.org")).toHaveText("unverified");
  await page.getByRole("button", { name: "Start verification of docs.example.org" }).click();
  await expect(page.getByTestId("verification-instructions")).toContainText(
    "_scf-verify.docs.example.org",
  );
  await expectAccessible(page, "settings");
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByTestId("domain-state-docs.example.org")).toHaveText("verified");
  await page.getByLabel("Add a domain").fill("not a host");
  await page.getByRole("button", { name: "Add domain" }).click();
  await expect(page.getByRole("alert")).toContainText("/host");
  await page.getByRole("button", { name: "Remove docs.example.org" }).click();
  await expect(page.getByTestId("domain-state-docs.example.org")).toHaveCount(0);
});

test("anonymous reports can be switched off and on", async ({ page }) => {
  await page.goto(`/t/${DOCS_TENANT}/sites/${DOCS_SITE}/settings`);
  await expect(page.getByTestId("anon-state")).toHaveText("on");
  await page.getByRole("button", { name: "Switch anonymous reports off" }).click();
  await expect(page.getByTestId("anon-state")).toHaveText("off");
  await page.getByRole("button", { name: "Switch anonymous reports on" }).click();
  await expect(page.getByTestId("anon-state")).toHaveText("on");
});

test("installation check shows verdict and reason counters (C-39)", async ({ page }) => {
  await page.goto(`/t/${DOCS_TENANT}/sites/${DOCS_SITE}/installation?range=7d`);
  await expect(page.getByTestId("receiving")).toHaveText(
    "Events are arriving: 25,902 in this period.",
  );
  await expect(page.getByTestId("verdict-verified")).toContainText("24,000");
  await expect(page.getByTestId("verdict-suspect")).toContainText("1,280");
  await expect(page.getByTestId("verdict-rejected")).toContainText("622");
  await expect(page.getByTestId("kit-present")).toContainText("1,900");
  const reasons = page.getByTestId("reasons").locator("tbody tr");
  await expect(reasons).toHaveCount(4);
  await expect(reasons.nth(0)).toContainText("proof_missing");
  await expect(reasons.nth(0)).toContainText("840");
  await expect(reasons.nth(1)).toContainText("ua_bot");
  await expect(reasons.nth(1)).toContainText("The browser identified itself as a bot.");
  await expect(page.getByTestId("drops")).toContainText("engine_bot_drop");
  await expect(page.getByTestId("limits")).toContainText("6,000 events per minute");
  await expect(page.getByTestId("multiplicity-mode")).toHaveText("enforce");
  await expect(page.getByTestId("multiplicity")).toContainText("the platform setting");
  await expect(page.getByTestId("multiplicity-high-shadow")).toContainText(
    "74 events in this period were only counted while shadow mode was on",
  );
  await expectAccessible(page, "installation");
  await page.getByLabel("Period").selectOption("30d");
  await expect(page.getByTestId("verdict-verified")).toContainText("48,000");
  await expect(page).toHaveURL(/range=30d/);
});

test("a new site's installation check says no events yet", async ({ page }) => {
  await page.goto(`/t/${DOCS_TENANT}/settings?tab=sites`);
  await page.getByRole("button", { name: "New website" }).click();
  await page.getByLabel("Website name").fill("Fresh");
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/\/snippet\?format=html$/);
  await page.goto(page.url().replace(/\/snippet\?format=html$/, "/installation"));
  await expect(page.getByTestId("no-events")).toBeVisible();
});

test("traction snapshots: create (pending until signed), list status, revoke", async ({ page }) => {
  await page.goto(`/t/${DOCS_TENANT}/traction-snapshots`);
  const rows = page.getByTestId("snapshots").locator("tbody tr");
  // two v2 snapshots (series 1 and 2) and one v1 snapshot from before the series (C-136, C-137)
  await expect(rows).toHaveCount(3);
  const v1 = page.getByTestId("snapshot-d5000000-0000-4000-8000-000000000001");
  await expect(v1.getByTestId("snapshot-state")).toHaveText("signed");
  await expect(v1.getByRole("link", { name: /^JSON/ })).toHaveAttribute(
    "href",
    /\/public\/v1\/snapshots\/d5000000-0000-4000-8000-000000000001$/,
  );
  await expect(v1.getByRole("link", { name: /^Verify/ })).toHaveAttribute(
    "href",
    "/verify/d5000000-0000-4000-8000-000000000001",
  );
  await expectAccessible(page, "traction snapshots");
  await page.getByLabel("First day (UTC)").fill("2026-09-01");
  await page.getByLabel("Day after the last day (UTC)").fill("2026-11-01");
  await expect(page.getByRole("button", { name: "Create snapshot" })).toBeDisabled();
  await page.getByLabel("I understand that this snapshot will be listed publicly").check();
  await page.getByRole("button", { name: "Create snapshot" }).click();
  // 202: recorded, signed by the jobs service shortly; the list polls until it is signed
  await expect(page.getByTestId("snapshot-pending")).toBeVisible();
  await expect(rows).toHaveCount(4);
  const fresh = rows.first();
  await expect(fresh.getByTestId("snapshot-state")).toHaveText("signing…");
  await expect(fresh).toContainText("available once signed");
  await expect(fresh.getByTestId("snapshot-state")).toHaveText("signed", { timeout: 15_000 });
  await expect(fresh.getByRole("link", { name: /^Verify/ })).toBeVisible();
  await fresh.getByRole("button", { name: /^Revoke/ }).click();
  await page
    .getByRole("dialog", { name: "Revoke this snapshot?" })
    .getByRole("button", { name: "Revoke snapshot" })
    .click();
  await expect(fresh.getByTestId("snapshot-state")).toContainText("revoked");
});
