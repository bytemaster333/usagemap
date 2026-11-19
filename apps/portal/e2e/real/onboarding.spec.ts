// SPDX-License-Identifier: Apache-2.0
// Against the real control plane behind the real portal image (Caddy, production headers over http): Stellar sign-in
// with a test wallet (SEP-53, verified by the control plane) → create a project → add a website → SRI snippet →
// dashboard and installation check of the new site.
import {
  expect,
  expectAccessible,
  signInWithWallet,
  TestWallet,
  test,
} from "../support/fixtures.ts";

test("sign in with a Stellar wallet, create a project and a website, get the snippet", async ({
  page,
}) => {
  const resp = await page.request.get("/signin");
  expect(resp.headers()["content-security-policy"]).toContain("require-trusted-types-for 'script'");
  expect(resp.headers().server).toBeUndefined();

  const wallet = new TestWallet();
  await page.goto("/tenants");
  await expect(page).toHaveURL(/\/signin\?return_to=%2Ftenants/);
  await signInWithWallet(page, wallet);
  // an account without a project starts in onboarding
  await expect(page).toHaveURL(/\/onboard$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Welcome. Find your project" }),
  ).toBeVisible();
  await page.goto("/account");
  await expect(page.getByRole("cell", { name: wallet.account })).toBeVisible();
  await page.goto("/onboard");

  const slug = `wsh-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Not in the list? Start without the registry" }).click();
  await page.getByLabel("Your project's name").fill(`E2E ${slug}`);
  await page.getByRole("button", { name: "Create my project" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]+\/onboard\/kit/);
  const tenantId = new URL(page.url()).pathname.split("/")[2] as string;
  await expectAccessible(page, "onboarding: prove it (real)");
  await page.goto(`/t/${tenantId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  await expect(page.getByTestId("project-switcher")).toContainText(`E2E ${slug}`);
  await expectAccessible(page, "tenant home (real)");

  await page.goto(`/t/${tenantId}/settings?tab=sites`);
  await page.getByRole("link", { name: "Get the snippet" }).click();
  await expect(page).toHaveURL(/\/snippet\?format=html$/);
  const code = page.getByTestId("snippet-code");
  await expect(code).toContainText('integrity="sha384-');
  await expect(code).toContainText("data-site=");
  await expect(page.getByRole("cell", { name: "strict", exact: true }).first()).toBeVisible();
  await page.getByLabel("Format").selectOption("consent_html");
  await expect(code).toContainText('data-consent="required"');
  await expectAccessible(page, "snippet (real)");

  await page.goto(page.url().replace(/\/snippet\?.*$/, "/installation"));
  await expect(page.getByTestId("verdict-verified")).toContainText("0");
  await page.goto(page.url().replace(/\/installation.*$/, ""));
  await expect(page.getByTestId("source-indicator")).toBeVisible();
  await expect(page.getByTestId("tile-pageviews")).toBeVisible();
});
