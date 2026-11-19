// SPDX-License-Identifier: Apache-2.0
// SCF Evidence Link against the mock control plane, under the production CSP and checked with axe: a tenant admin
// creates a v3 snapshot with the Growth Hack preset (whole ISO weeks enforced in the form), copies the evidence link,
// and the public evidence page — opened without a session — shows the funnel, the campaign vs baseline averages, the
// cohort position, the C4 wording and the verify link by URL.
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const DOCS = "a0000000-0000-4000-8000-000000000001";

test("create a v3 Growth Hack snapshot, copy the evidence link, open the public page", async ({
  page,
  browser,
}) => {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await page.goto(`/t/${DOCS}/traction-snapshots`);

  await page.getByLabel("Purpose (preset)").selectOption("growth_hack_during");
  await page.getByLabel("First day (UTC)").fill("2026-10-06"); // a Tuesday
  await page.getByLabel("Day after the last day (UTC)").fill("2026-11-03");
  await page.getByLabel("I understand that this snapshot will be listed publicly").check();
  await expect(page.getByTestId("snapshot-weeks-hint")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create snapshot" })).toBeDisabled();
  await page.getByLabel("First day (UTC)").fill("2026-10-05");
  await page.getByLabel("Day after the last day (UTC)").fill("2026-11-02");
  await expect(page.getByTestId("snapshot-weeks-hint")).toHaveCount(0);
  await page.getByRole("button", { name: "Create snapshot" }).click();

  const card = page.getByTestId("snapshot-created-link");
  await expect(card).toContainText("Your SCF Evidence Link");
  await expect(card.getByRole("button", { name: "Copy evidence link" })).toBeVisible();
  const url = (await page.getByTestId("snapshot-created-url").textContent()) ?? "";
  expect(url).toMatch(/\/evidence\/[0-9a-f-]{36}$/);
  const id = url.split("/").pop() as string;

  const row = page.getByTestId(`snapshot-${id}`);
  await expect(row.getByTestId("snapshot-state")).toHaveText("signed", { timeout: 15_000 });
  await expect(row.getByTestId("snapshot-preset")).toContainText("schema v3");
  await row.getByRole("button", { name: /^View/ }).click();
  await expect(page.getByTestId("snapshot-text").first()).toContainText("Evidence page:");
  await expect(page.getByTestId("snapshot-evidence-link").first()).toHaveText(url);
  await expectAccessible(page, "snapshots v3");

  // The public page, in a fresh context without a session.
  const anon = await browser.newContext();
  const pub = await anon.newPage();
  await pub.goto(new URL(url).pathname);
  await expect(pub.getByTestId("evidence-page")).toBeVisible();
  await expect(pub.getByRole("heading", { level: 1 })).toContainText("measured usage");
  await expect(pub.getByTestId("evidence-window")).toContainText("during Growth Hack campaign");
  await expect(pub.getByTestId("evidence-stage-web_visitors")).toContainText("verified");
  await expect(pub.getByTestId("evidence-stage-onchain_calls")).toContainText(
    "never joined to visitors",
  );
  await expect(pub.getByTestId("evidence-growth-hack")).toContainText("4 campaign weeks");
  await expect(pub.getByTestId("evidence-gh-share")).toContainText("SCF round 29");
  await expect(pub.getByTestId("evidence-comparison")).toContainText(
    "not enough projects to compare",
  );
  await expect(pub.getByTestId("evidence-wording")).toContainText("not an endorsement");
  await expect(pub.getByTestId("evidence-verify")).toHaveAttribute(
    "href",
    `/verify?snapshot=${id}`,
  );
  const html = await pub.content();
  expect(html).not.toMatch(/G[A-Z2-7]{55}/);
  expect(html).not.toMatch(/SCF[- ]verified|SDF[- ]approved|endorsed by (SCF|SDF)/i);
  await expectAccessible(pub, "evidence page");
  await anon.close();
});

test("an unknown snapshot id reads 'no signed snapshot'", async ({ page }) => {
  await page.goto("/evidence/d5100000-0000-4000-8000-0000000000ff");
  await expect(page.getByTestId("evidence-not-found")).toBeVisible();
});
