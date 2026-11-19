// SPDX-License-Identifier: Apache-2.0
// Onboarding of Stellar ecosystem projects, the whole flow: pick the project from the registry → check the pre-filled
// details and create it (claim, not grab: nothing is trusted yet) → verify the domain with one click → choose the
// framework → copy the personalised snippet. Also: a project another tenant already holds ("already claimed —
// dispute"), and the SCF operator's coverage view with invite links. Every registry row here is FAKE.
import type { Page } from "@playwright/test";
import { FAKE_CONTRACT } from "../../test/fixtures/registry.ts";
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  registerSecondOperatorPasskey,
  test,
} from "../support/fixtures.ts";

async function signIn(page: Page) {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("pick → create → verify the domain → choose the framework → copy the snippet", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  await page.getByRole("main").getByRole("link", { name: "Find your project" }).first().click();
  await expect(page).toHaveURL(/\/onboard$/);
  await expectAccessible(page, "registry picker");
  // 1. find your project
  await page.getByLabel("Project name or website").fill("fakeorbit");
  const results = page.getByTestId("registry-results");
  await expect(results).toContainText("Fakeorbit Wallet (FAKE)");
  await expect(results).toContainText("Round 33");
  await page.getByRole("button", { name: "Select Fakeorbit Wallet (FAKE)" }).click();
  await expect(page).toHaveURL(/\/onboard\?project=d0000000-0000-4000-8000-000000000001/);
  // pre-filled from the registry; nothing claimed is trusted
  await expect(page.getByTestId("selected-project")).toContainText("fakeorbit.example");
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Fakeorbit Wallet (FAKE)",
  );
  await expect(page.getByLabel("Production website domain")).toHaveValue("fakeorbit.example");
  await expect(page.getByRole("checkbox", { name: FAKE_CONTRACT })).toBeChecked();
  await expectAccessible(page, "pre-filled sign-up");
  await page.getByRole("button", { name: "Continue with Fakeorbit Wallet (FAKE)" }).click();
  // 2. prove it: the domain, with one click per method
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]+\/onboard\/kit\?/);
  await expect(
    page.getByRole("heading", { name: "Prove Fakeorbit Wallet (FAKE) is yours" }),
  ).toBeVisible();
  await expectAccessible(page, "prove it");
  await page.getByRole("radio", { name: /Confirm your domain/ }).click();
  await page.getByRole("button", { name: "DNS TXT record" }).click();
  await expect(page.getByTestId("kit-verification")).toContainText("_scf-verify.fakeorbit.example");
  await page.getByRole("button", { name: "Copy name" }).click();
  await expect(page.getByText("Copied.").first()).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByTestId("kit-domain-verified")).toContainText("fakeorbit.example");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // 3. framework
  await expect(page.getByRole("heading", { name: "What is your site built with?" })).toBeVisible();
  await page.getByRole("radio", { name: "Nuxt" }).click();
  await expect(page).toHaveURL(/framework=nuxt/);
  await expectAccessible(page, "framework");
  await page.getByRole("button", { name: "Get my snippet" }).click();
  // 4. the personalised snippet
  const key = (await page.getByTestId("kit-site-key").textContent()) as string;
  expect(key).toMatch(/^[0-9A-Za-z]{22}$/);
  const snippet = page.getByTestId("kit-framework-snippet");
  await expect(snippet).toContainText(`init({ site: "${key}" })`);
  await page.getByRole("button", { name: "Copy", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Copied" }).first()).toBeVisible();
  await expectAccessible(page, "snippet");
  // 5. first event
  await page.getByRole("button", { name: "I added it" }).click();
  await expect(page.getByRole("heading", { name: "See your first event arrive" })).toBeVisible();
  // back in the picker, the project is now ours
  await page.goto("/onboard?project=d0000000-0000-4000-8000-000000000001");
  await expect(page.getByTestId("claim-yours")).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue with/ })).toHaveCount(0);
});

test("a project another tenant holds: already claimed — dispute, enrolling needs an explicit choice", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/onboard");
  await page.getByLabel("Project name or website").fill("fakeclaimed");
  await page.getByRole("button", { name: "Select Fakeclaimed Labs (FAKE)" }).click();
  await expect(page.getByTestId("claim-claimed")).toContainText("Already claimed — dispute");
  const create = page.getByRole("button", { name: "Continue with Fakeclaimed Labs (FAKE)" });
  await expect(create).toBeDisabled();
  await page.getByLabel("This is my project; enrol anyway and let an SCF operator decide").check();
  await expect(create).toBeEnabled();
  await expectAccessible(page, "claimed project");
});

test("the picker needs two characters and says when nothing matches", async ({ page }) => {
  await signIn(page);
  await page.goto("/onboard");
  await page.getByLabel("Project name or website").fill("f");
  await expect(page.getByTestId("registry-results")).toHaveCount(0);
  await page.getByLabel("Project name or website").fill("no-such-project");
  await expect(
    page.getByRole("status").filter({ hasText: "No listed project matches" }),
  ).toBeVisible();
});

test("SCF operator: onboarding coverage with copyable invite links", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await addVirtualAuthenticator(page);
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as scf-operator" }).click();
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page).not.toHaveURL(/\/signin(\/|\?|$)/);
  await registerSecondOperatorPasskey(page);
  await page.goto("/operator/web");
  await page.getByRole("link", { name: "Registry coverage" }).click();
  await expect(page).toHaveURL(/\/operator\/onboarding/);
  await expect(page.getByTestId("coverage-totals")).toContainText("SCF registry projects");
  await expect(page.getByTestId("coverage-verified")).toContainText(/\d/);
  const table = page.getByTestId("coverage-table");
  await expect(table).toContainText("Fakeorbit Wallet (FAKE)");
  await page.getByRole("button", { name: "Copy invite link for Fakeorbit Wallet (FAKE)" }).click();
  await expect(
    table.getByRole("button", { name: "Copy invite link for Fakeorbit Wallet (FAKE)" }),
  ).toContainText("Copied");
  await page.getByLabel("Status").selectOption("verified");
  await expect(page).toHaveURL(/status=verified/);
  await expect(table).toContainText("Fakeclaimed Labs (FAKE)");
  await expect(table).not.toContainText("Fakeorbit Wallet (FAKE)");
  await expectAccessible(page, "onboarding coverage");
});
