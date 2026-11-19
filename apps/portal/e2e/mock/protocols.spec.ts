// SPDX-License-Identifier: Apache-2.0
// Protocol interactions (migration 0082): the tenant's "Protocols your users interact with" page (from the project
// navigation; protocols ordered by use, shares, the verified contracts with explorer links), the SCF operator's list
// (network totals, per subject, active-only filter), and the explorer deep links of the public verify pages — seal
// transaction and sealing account on StellarExpert and steexp, never anything of a visitor. Every figure is FAKE.
import type { Page } from "@playwright/test";
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  registerSecondOperatorPasskey,
  test,
} from "../support/fixtures.ts";
import { SEAL_ACCOUNT } from "../support/mock-d1.ts";
import { FAKE_PROTOCOL_CONTRACT } from "../support/mock-protocols.ts";

const DOCS_TENANT = "a0000000-0000-4000-8000-000000000001";
const PENDING_TENANT = "a0000000-0000-4000-8000-000000000002";
const SNAP1 = "d5100000-0000-4000-8000-000000000001";
const HORIZON = "https://horizon-testnet.stellar.org";

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

async function signInTenant(page: Page) {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
}

test("a tenant sees the protocols its users interact with, and its contracts' explorer links", async ({
  page,
}) => {
  await signInTenant(page);
  await page.goto(`/t/${DOCS_TENANT}`);
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "On-chain" })
    .click();
  await page
    .getByRole("navigation", { name: "On-chain sections" })
    .getByRole("link", { name: "DeFi protocols" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/t/${DOCS_TENANT}/protocols\\?range=30d`));
  await expect(
    page.getByRole("heading", { level: 2, name: "Protocols your users interact with" }),
  ).toBeVisible();
  await expect(page.getByTestId("protocols-totals")).toContainText("400");
  await expect(page.getByTestId("protocols-totals")).toContainText("Reflector: 30");
  const rows = page.getByTestId("protocols-table").locator("tbody tr");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toHaveAttribute("data-testid", "protocols-row-reflector");
  await expect(rows.nth(1)).toHaveAttribute("data-testid", "protocols-row-blend");
  await expect(page.getByTestId("protocols-row-blend")).toContainText("10");
  await expect(page.getByTestId("protocols-window")).toContainText("registry 2026-11-19.1");
  const links = page.getByTestId(`protocols-explorers-${FAKE_PROTOCOL_CONTRACT}`).getByRole("link");
  await expect(links).toHaveCount(3);
  await expect(links.nth(0)).toHaveAttribute(
    "href",
    `https://stellar.expert/explorer/public/contract/${FAKE_PROTOCOL_CONTRACT}`,
  );
  await expect(links.nth(1)).toHaveAttribute(
    "href",
    `https://lab.stellar.org/r/mainnet/contract/${FAKE_PROTOCOL_CONTRACT}`,
  );
  await expect(links.nth(2)).toHaveAttribute(
    "href",
    `https://steexp.com/contract/${FAKE_PROTOCOL_CONTRACT}`,
  );
  await expect(links.nth(0)).toHaveAttribute("rel", "noopener noreferrer");
  await expectAccessible(page, "tenant protocols");

  // Testnet: the explorer links follow the network.
  await page.getByLabel("Network").selectOption("testnet");
  await expect(page).toHaveURL(/network=testnet/);
  await expect(
    page.getByTestId(`protocols-explorers-${FAKE_PROTOCOL_CONTRACT}`).getByRole("link").nth(2),
  ).toHaveAttribute("href", `https://testnet.steexp.com/contract/${FAKE_PROTOCOL_CONTRACT}`);

  // A project without figures says what is missing.
  await page.goto(`/t/${PENDING_TENANT}/protocols?range=7d`);
  await expect(page.getByTestId("protocols-empty")).toContainText("verified contract");
});

test("SCF operator: protocol interactions per registry project and tenant; tenants are refused", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  await page.goto("/signin");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as scf-operator" }).click();
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  await expect(page).not.toHaveURL(/\/signin(\/|\?|$)/);
  await registerSecondOperatorPasskey(page);
  await page.goto("/operator/web");
  await page.getByRole("link", { name: "Protocols" }).click();
  await expect(page).toHaveURL(/\/operator\/protocols/);
  await expect(page.getByRole("heading", { level: 1, name: "Protocols" })).toBeAttached();
  await expect(page.getByTestId("op-protocols-network")).toContainText("52.0k");
  const subjects = page.getByTestId("op-protocols-subjects").locator("tbody tr");
  await expect(subjects).toHaveCount(3);
  const dex = page.getByTestId("op-protocols-e0000000-0000-4000-8000-000000000001");
  await expect(dex).toContainText("Fakeswap DEX (FAKE)");
  await expect(dex).toContainText("public chain data — ownership not verified");
  await expect(dex).toContainText("50%");
  await expectAccessible(page, "operator protocols");
  await page.getByLabel("Only projects with protocol use").check();
  await expect(page).toHaveURL(/active=true/);
  await expect(subjects).toHaveCount(2);
});

test("a tenant cannot read the operator list", async ({ page }) => {
  await signInTenant(page);
  const res = await page.request.get(
    "/v1/operator/protocols?start=2026-11-09T00:00:00Z&end=2026-11-16T00:00:00Z",
  );
  expect(res.status()).toBe(403);
});

test("verify page: the seal transaction and the sealing account link to public explorers", async ({
  page,
}) => {
  await page.route(`${HORIZON}/**`, (route) =>
    route.fulfill({ status: 404, json: { status: 404 } }),
  );
  await page.goto(`/verify?snapshot=${SNAP1}`);
  const seal = page.getByTestId("seal-testnet");
  const tx = seal.getByTestId("seal-explorers-tx").getByRole("link");
  await expect(tx).toHaveCount(2); // StellarExpert and steexp (Stellar Lab has no transaction deep link)
  await expect(tx.nth(0)).toHaveAttribute(
    "href",
    /^https:\/\/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}$/,
  );
  await expect(tx.nth(1)).toHaveAttribute(
    "href",
    /^https:\/\/testnet\.steexp\.com\/tx\/[0-9a-f]{64}$/,
  );
  const acct = seal.getByTestId("seal-explorers-account").getByRole("link");
  await expect(acct.nth(0)).toHaveAttribute(
    "href",
    `https://stellar.expert/explorer/testnet/account/${SEAL_ACCOUNT}`,
  );
  await expect(acct.nth(1)).toHaveAttribute(
    "href",
    `https://testnet.steexp.com/account/${SEAL_ACCOUNT}`,
  );
});
