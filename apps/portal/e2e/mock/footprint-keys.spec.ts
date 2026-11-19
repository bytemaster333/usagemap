// SPDX-License-Identifier: Apache-2.0
// Footprint registration keys for build tools (migration 0081) on "Register your Stellar contracts": shown once with
// the two shell lines for the Scaffold Stellar extension, listed by their display form only, revoked after a
// confirmation. And the user-tracking paragraph on the traction-snapshots page: generated from what was
// measured, copyable, with the sources it names. Every page runs under the production CSP and is checked with axe.
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const DOCS_TENANT = "a0000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__mock/reset");
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
});

test("registration keys: shown once with the extension's environment, then revoked", async ({
  page,
}) => {
  await page.goto(`/t/${DOCS_TENANT}/setup/footprint`);
  const card = page.getByTestId("footprint-keys");
  await expect(
    card.getByRole("heading", { name: "Registration keys for build tools" }),
  ).toBeVisible();
  await expect(card.getByText("No registration keys yet.")).toBeVisible();
  await expect(card).toContainText("cannot verify, remove or read anything");
  await expectAccessible(page, "footprint keys");

  await card.getByLabel("Key label").fill("CI deploys");
  await card.getByLabel("Key network").selectOption("testnet");
  await card.getByRole("button", { name: "Create registration key" }).click();
  const secret = (await page.getByTestId("secret-value").textContent()) ?? "";
  expect(secret).toMatch(/^scfa_reg_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/);
  await expect(page.getByTestId("footprint-key-env")).toHaveText(
    `export USAGEMAP_TENANT_ID=${DOCS_TENANT}\nexport SCF_FOOTPRINT_KEY=${secret}`,
  );
  const row = page.getByTestId("footprint-key-CI deploys");
  await expect(row.getByTestId("footprint-key-state")).toHaveText("active");
  await expect(row).toContainText("testnet");
  await expect(row).toContainText(`…${secret.slice(-4)}`);
  await expect(row).not.toContainText(secret);
  await expectAccessible(page, "footprint keys with a new key");
  await page.getByRole("button", { name: "I have stored it — hide it" }).click();
  await expect(page.getByTestId("secret-once")).toHaveCount(0);
  expect(page.url()).not.toContain("scfa_reg_");

  await page.getByRole("button", { name: "Revoke registration key CI deploys" }).click();
  await page
    .getByRole("dialog", { name: "Revoke “CI deploys”?" })
    .getByRole("button", { name: "Revoke registration key" })
    .click();
  await expect(row.getByTestId("footprint-key-state")).toContainText("revoked");
});

test("user-tracking paragraph: generated from what was measured, copyable", async ({ page }) => {
  await page.goto(`/t/${DOCS_TENANT}/sharing?tab=statement`);
  const card = page.getByTestId("user-tracking");
  await expect(
    card.getByRole("heading", { name: "How Stellar Docs measures usage" }),
  ).toBeVisible();
  const text = page.getByTestId("user-tracking-paragraph");
  await expect(text).toContainText("measures usage with UsageMap");
  await expect(text).toContainText("No cookies, IP addresses");
  await expect(text).not.toContainText(/verified by|approved|certified|compliant/i);
  await expect(page.getByTestId("user-tracking-sources")).toContainText("Website page views");
  await expect(page.getByTestId("user-tracking-sources")).toContainText("Measured");
  await expect(card.getByRole("button", { name: "Copy paragraph" })).toBeVisible();
  await card.getByText("Data-flow diagram (Mermaid)").click();
  await expect(page.getByTestId("user-tracking-mermaid")).toContainText("flowchart LR");
  await expect(
    card.getByRole("link", { name: "what is collected and for how long" }),
  ).toHaveAttribute("href", "https://docs.example.invalid/privacy");
  await expectAccessible(page, "user-tracking paragraph");
});
