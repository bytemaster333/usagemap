// SPDX-License-Identifier: Apache-2.0
// "Stellar RPC & Horizon (from your backend)" on the API dashboard (C-153) against the mock control plane: the panel
// shows the fixture's figures (test/fixtures/stellar-client.ts) and states that they are not API usage; a service
// without Stellar client metrics shows how to start. CSP/Trusted Types are watched (support/fixtures.ts), axe runs.
import { SVC_HORIZON, SVC_RPC } from "../../test/fixtures/api.ts";
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const T = "a0000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__mock/reset");
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
});

test("Stellar RPC & Horizon panel: per method and route, outcomes, never API usage", async ({
  page,
}) => {
  await page.goto(`/t/${T}/services/${SVC_HORIZON}?range=7d&compare=false&sort=-requests&tab=sdk`);
  const panel = page.getByTestId("stellar-client");
  await expect(
    panel.getByRole("heading", { name: "Stellar RPC & Horizon (from your backend)" }),
  ).toBeVisible();
  await expect(panel).toContainText("it is not API usage");
  const send = panel.getByTestId("stellar-rpc-table").getByRole("row", { name: /sendTransaction/ });
  await expect(send).toContainText("1,200");
  await expect(send).toContainText("3.00%");
  await expect(send).toContainText("invalid params (-32602) 30");
  await expect(panel.getByTestId("stellar-horizon-table")).toContainText("GET /accounts/{id}");
  await expect(panel.getByTestId("stellar-submissions")).toContainText("bad_seq");
  await expectAccessible(page, "api-dashboard-stellar-client");
});

test("a service without Stellar client metrics shows how to instrument it", async ({ page }) => {
  await page.goto(`/t/${T}/services/${SVC_RPC}?range=30d&compare=false&sort=-requests&tab=sdk`);
  await expect(page.getByTestId("stellar-client-empty")).toContainText("@usagemap/stellar-otel");
});
