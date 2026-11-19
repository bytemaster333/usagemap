// SPDX-License-Identifier: Apache-2.0
// "RPC calls from your users' browsers (daily totals)" on the site dashboard (tracker 1.2.0) against the mock control
// plane: the wallet site shows the fixture's figures (test/fixtures/browser-rpc.ts) and states that they are
// aggregate-only, not page views and not API usage; raw adds the suspect cells; a site without browser RPC calls shows
// how to start. CSP/Trusted Types are watched (support/fixtures.ts), axe runs.
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

test("browser RPC panel: daily totals per method and route, never page views or API usage", async ({
  page,
}) => {
  await page.goto(`${WALLET}/browser?range=30d`);
  const panel = page.getByTestId("browser-rpc");
  await expect(
    panel.getByRole("heading", { name: "RPC calls from your users' browsers (daily totals)" }),
  ).toBeVisible();
  await expect(panel).toContainText("never linked to a visitor, session or page");
  await expect(panel).toContainText("not page views and not API usage");
  await expect(panel.getByTestId("browser-rpc-totals")).toContainText("1,500");
  const sim = panel
    .getByTestId("browser-rpc-methods")
    .getByRole("row", { name: /simulateTransaction/ });
  await expect(sim).toContainText("JSON-RPC error 20");
  await expect(panel.getByTestId("browser-rpc-routes")).toContainText("/accounts/{id}");
  await expectAccessible(page, "site-dashboard-browser-rpc");

  await page.goto(`${WALLET}/browser?range=30d&variant=raw`);
  await expect(page.getByTestId("browser-rpc-totals")).toContainText("1,540");
});

test("a site without browser RPC calls shows how to attach the tracker's counter", async ({
  page,
}) => {
  await page.goto(`${DOCS}/browser?range=7d`);
  await expect(page.getByTestId("browser-rpc-empty")).toContainText(
    "@usagemap/tracker/stellar-rpc",
  );
});
