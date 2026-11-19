// SPDX-License-Identifier: Apache-2.0
// Sign-in (GitHub, Stellar SEP-53, operator passkey step), account page, recent authentication and step-up prompts.
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  signInWithWallet,
  TestWallet,
  test,
} from "../support/fixtures.ts";

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("a signed-out visit goes to sign-in and comes back after GitHub sign-in", async ({ page }) => {
  await page.goto("/t/a0000000-0000-4000-8000-000000000001");
  await expect(page).toHaveURL(/\/signin\?return_to=/);
  await expect(page.getByRole("heading", { name: "Sign in to your project" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Ecosystem project" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "SCF operator" })).not.toBeChecked();
  await expectAccessible(page, "sign-in");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(page).toHaveURL(/\/t\/a0000000-0000-4000-8000-000000000001$/);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("project-switcher")).toContainText("Stellar Docs");
  await expectAccessible(page, "tenant home");
});

test("Stellar wallet sign-in with SEP-53 (test wallet) and sign-out", async ({ page }) => {
  const wallet = new TestWallet();
  await page.goto("/signin");
  await signInWithWallet(page, wallet);
  // an account without a project goes straight to onboarding
  await expect(page).toHaveURL(/\/onboard$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Welcome. Find your project" }),
  ).toBeVisible();
  await expectAccessible(page, "onboarding (no project yet)");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin/);
  await page.goto("/tenants");
  await expect(page).toHaveURL(/\/signin\?return_to=%2Ftenants/);
});

test("a wrong signature is refused and shown as a problem", async ({ page }) => {
  const wallet = new TestWallet();
  const other = new TestWallet();
  await page.goto("/signin?method=wallet");
  await page.getByLabel("Stellar account").fill(wallet.account);
  await page.getByRole("button", { name: "Get message to sign" }).click();
  const message = (await page.getByTestId("sep53-message").textContent()) ?? "";
  await page.getByLabel("Signature (base64 or hex)").fill(other.signMessage(message));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toContainText("Signature not accepted");
  await expect(page).toHaveURL(/\/signin/);
});

test("return_to never leaves the portal (C-114)", async ({ page }) => {
  await page.goto("/signin?return_to=%2F%2Fevil.example%2Fx");
  const href = await page.getByRole("link", { name: "Sign in with GitHub" }).getAttribute("href");
  expect(href).toBe("/v1/auth/github/start?return_to=%2Ftenants");
  const wallet = new TestWallet();
  await signInWithWallet(page, wallet);
  await expect(page).toHaveURL(/localhost:\d+\/(tenants|onboard)$/);
});

test("an SCF operator enrols a first passkey, then completes sign-in with it (C-09)", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as scf-operator" }).click();
  await expect(page).toHaveURL(/\/signin\/passkey/);
  await expect(page.getByRole("heading", { name: "Register your first passkey" })).toBeVisible();
  await expectAccessible(page, "passkey step");
  // Partial session: the dashboard routes are refused until the passkey step.
  const status = await page.evaluate(async () => (await fetch("/v1/me")).status);
  expect(status).toBe(401);
  await page.getByLabel("Passkey name (optional)").fill("ci key");
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page).toHaveURL(/\/tenants$/);
  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByText("SCF operator role: operator")).toBeVisible();
  await expect(page.getByRole("cell", { name: "ci key", exact: true })).toBeVisible();
});

test("account: adding a passkey after recent authentication expired asks for a fresh Stellar sign-in (C-114)", async ({
  page,
  request,
}) => {
  await addVirtualAuthenticator(page);
  const wallet = new TestWallet();
  await page.goto("/signin?return_to=%2Faccount");
  await signInWithWallet(page, wallet);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByRole("cell", { name: wallet.account })).toBeVisible();
  await expectAccessible(page, "account");
  // The OAuth connections of AI assistants are reachable from the account page (C-168).
  await expect(page.getByRole("link", { name: "Connected apps" })).toHaveAttribute(
    "href",
    "/oauth/apps",
  );
  await request.post("/__mock/expire-recent-auth");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page, "re-authentication dialog");
  await signInWithWallet(page, wallet, dialog);
  await expect(dialog).toBeHidden();
  // The registration was repeated after the fresh sign-in.
  await expect(page.getByRole("cell", { name: "Passkey", exact: true })).toBeVisible();
});

test("account: with a passkey, only a passkey counts as recent authentication (C-87)", async ({
  page,
  request,
}) => {
  await addVirtualAuthenticator(page);
  const wallet = new TestWallet();
  await page.goto("/signin?return_to=%2Faccount");
  await signInWithWallet(page, wallet);
  await page.getByLabel("Passkey name (optional)").fill("laptop");
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByRole("cell", { name: "laptop", exact: true })).toBeVisible();
  await request.post("/__mock/expire-recent-auth");
  await page.reload();
  await page.getByRole("button", { name: "Remove laptop" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(dialog.getByRole("button", { name: "Confirm with passkey" })).toBeVisible();
  await expect(dialog.getByLabel("Stellar account")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("No passkeys registered.")).toBeVisible();
});

test("an operator's sensitive action asks for a step-up passkey confirmation", async ({
  page,
  request,
}) => {
  await addVirtualAuthenticator(page);
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as scf-operator" }).click();
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page).toHaveURL(/\/tenants$/);
  await request.post("/__mock/expire-recent-auth");
  await page.goto("/account");
  await page.getByRole("button", { name: /^Remove / }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm with your passkey" });
  await expect(dialog).toContainText("SCF operator action");
  await dialog.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page.getByText("No passkeys registered.")).toBeVisible();
});
