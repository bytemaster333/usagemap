// SPDX-License-Identifier: Apache-2.0
// Programme outputs in the portal (share.signed-usage-report, ADR-0032, wire-formats §i): the public-statistics switch, share keys
// (shown once, recent sign-in for create/revoke, C-129), the public metrics page read anonymously or with a share key
// kept out of the URL (C-14), the in-browser verification of signed traction snapshots against the published JWKS
// (C-47) — and the tracker version check with two releases served side by side (tracker.intentional-upgrade). Every page runs under the
// production CSP (fixtures.ts) and is checked with axe.
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const DOCS_TENANT = "a0000000-0000-4000-8000-000000000001";
const DOCS_SITE = "b0000000-0000-4000-8000-000000000001";
const SIGNED = "d5000000-0000-4000-8000-000000000001";
const TAMPERED = "d5000000-0000-4000-8000-0000000000ff";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__mock/reset");
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
});

test("share keys: shown once, read the private metrics page with one, revoke it", async ({
  page,
  request,
}) => {
  await page.goto(`/t/${DOCS_TENANT}/sharing`);
  await expect(page.getByRole("heading", { level: 1, name: "Sharing" })).toBeVisible();
  await expect(page.getByTestId("public-state")).toContainText("Off.");
  await expect(page.getByTestId("metrics-path")).toHaveText(
    "/public/v1/projects/stellar-docs/metrics.json",
  );
  await expectAccessible(page, "sharing");
  // share keys live on the Keys page
  await page.goto(`/t/${DOCS_TENANT}/ingest-tokens`);
  await expect(page.getByText("No share keys yet.")).toBeVisible();
  await page.getByRole("button", { name: "New share key" }).click();
  await page.getByLabel("Share key label").fill("Grant programme");
  await page.getByRole("button", { name: "Create share key" }).click();
  const secret = (await page.getByTestId("secret-value").textContent()) ?? "";
  expect(secret).toMatch(/^scfa_pub_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/);
  const row = page.getByTestId("share-key-Grant programme");
  await expect(row.getByTestId("share-key-state")).toHaveText("active");
  await expect(row).toContainText(`…${secret.slice(-4)}`);
  await expect(row).not.toContainText(secret);
  await expectAccessible(page, "sharing with a new key");
  await page.getByRole("button", { name: "I have stored it — hide it" }).click();
  await expect(page.getByTestId("secret-once")).toHaveCount(0);

  // The public page: private without a key, readable with it; the key never reaches the URL.
  await page.goto("/p/stellar-docs");
  await expect(page.getByTestId("public-not-available")).toContainText("not public");
  await expectAccessible(page, "public page (private project)");
  await page.getByLabel("Share key", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Use key" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Stellar Docs" })).toBeVisible();
  await expect(page.getByTestId("public-pv-verified")).toContainText("48,213");
  await expect(page.getByTestId("public-api-label")).toHaveText("self-attested telemetry");
  await expect(page.getByTestId("public-daily").locator("tbody tr")).toHaveCount(3);
  expect(page.url()).not.toContain(secret);
  await expectAccessible(page, "public page (share key)");
  const log = (await (await request.get("/__mock/requests")).json()) as { path: string }[];
  expect(log.every((r) => !r.path.includes("scfa_pub_"))).toBe(true);

  // Revoke (recent sign-in still valid) → the key stops working.
  await page.goto(`/t/${DOCS_TENANT}/ingest-tokens`);
  // The read was recorded as the key's last use.
  await expect(row).not.toContainText("never");
  await page.getByRole("button", { name: "Revoke share key Grant programme" }).click();
  await page
    .getByRole("dialog", { name: "Revoke “Grant programme”?" })
    .getByRole("button", { name: "Revoke share key" })
    .click();
  await expect(row.getByTestId("share-key-state")).toContainText("revoked");
  await page.goto("/p/stellar-docs");
  await page.getByLabel("Share key", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "Use key" }).click();
  await expect(page.getByTestId("public-not-available")).toContainText(
    "not available with this share key",
  );
});

test("share keys need a recent sign-in; nothing is sent when it is cancelled", async ({
  page,
  request,
}) => {
  await request.post("/__mock/expire-recent-auth");
  await page.goto(`/t/${DOCS_TENANT}/ingest-tokens`);
  await page.getByRole("button", { name: "New share key" }).click();
  await page.getByLabel("Share key label").fill("late key");
  await page.getByRole("button", { name: "Create share key" }).click();
  const reauth = page.getByRole("dialog", { name: "Confirm it is you" });
  await expect(reauth).toBeVisible();
  await reauth.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alert")).toContainText("Confirmation cancelled");
  await expect(page.getByTestId("share-key-late key")).toHaveCount(0);
  const reqs = (await (await request.get("/__mock/requests")).json()) as {
    method: string;
    path: string;
  }[];
  expect(reqs.some((r) => r.method !== "GET" && r.path.includes("/share-keys"))).toBe(false);
});

test("public statistics: switched on, the page is readable without signing in", async ({
  page,
}) => {
  await page.goto(`/t/${DOCS_TENANT}/sharing`);
  await page.getByRole("switch", { name: "Make statistics public" }).click();
  const dialog = page.getByRole("dialog", { name: "Make your statistics public?" });
  await expectAccessible(page, "make public dialog");
  await dialog.getByRole("button", { name: "Make public" }).click();
  await expect(page.getByTestId("public-state")).toContainText("On.");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your project" })).toBeVisible();
  await page.goto("/p/stellar-docs");
  await expect(page.getByRole("heading", { level: 1, name: "Stellar Docs" })).toBeVisible();
  await expect(page.getByTestId("public-level")).toHaveText("L3");
  await expect(page.getByTestId("public-visitors")).toContainText("9,118");
  await expect(page.getByTestId("public-requests")).toContainText("1,204,513");
  await expectAccessible(page, "public page (public project)");
  // Unknown and non-active projects read the same: no existence oracle.
  await page.goto("/p/no-such-project");
  await expect(page.getByTestId("public-not-available")).toBeVisible();
  await page.goto("/p/anchor-hub");
  await expect(page.getByTestId("public-not-available")).toBeVisible();
});

test("snapshot verification in the browser: valid, revoked, altered, unknown", async ({ page }) => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to your project" })).toBeVisible();
  await page.goto(`/verify/${SIGNED}`);
  await expect(page.getByTestId("verify-result")).toContainText(
    "Valid: signed with the platform's published snapshot key",
  );
  await expect(page.getByTestId("verify-result")).toContainText("snap-mock-1");
  await expect(page.getByTestId("verify-figures")).toContainText("48,213");
  await expect(page.getByTestId("verify-steps")).toContainText(
    "/.well-known/scf-snapshot-keys.json",
  );
  await expect(page.getByTestId("verify-script")).toContainText("createPublicKey");
  await expectAccessible(page, "verify (valid)");

  await page.goto(`/verify/${TAMPERED}`);
  await expect(page.getByTestId("verify-result")).toContainText("Not valid.");
  await expect(page.getByTestId("verify-result")).toContainText("altered");
  await expectAccessible(page, "verify (altered)");

  await page.goto("/verify/d5000000-0000-4000-8000-00000000abcd");
  await expect(page.getByTestId("verify-not-found")).toBeVisible();

  // The project revokes it: the signature still holds, the page says revoked.
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await page.goto(`/t/${DOCS_TENANT}/traction-snapshots`);
  const v1 = page.getByTestId(`snapshot-${SIGNED}`);
  await v1.getByRole("link", { name: /^Verify/ }).click();
  await expect(page).toHaveURL(new RegExp(`/verify/${SIGNED}$`));
  await expect(page.getByTestId("verify-result")).toContainText("Valid");
  // A snapshot from before the series was introduced is verifiable by its id but not listed (C-137).
  await expect(page.getByTestId("series-not-listed")).toContainText(
    "before snapshots were numbered",
  );
  await page.goto(`/t/${DOCS_TENANT}/traction-snapshots`);
  await v1.getByRole("button", { name: /^Revoke/ }).click();
  await page
    .getByRole("dialog", { name: "Revoke this snapshot?" })
    .getByRole("button", { name: "Revoke snapshot" })
    .click();
  await expect(v1.getByTestId("snapshot-state")).toContainText("revoked");
  await page.goto(`/verify/${SIGNED}`);
  await expect(page.getByTestId("verify-result")).toContainText("Revoked by the project");
});

test("tracker version: current vs latest, update available, both versions' snippets served (tracker.intentional-upgrade)", async ({
  page,
  request,
}) => {
  await page.goto(`/t/${DOCS_TENANT}/sites/${DOCS_SITE}/installation`);
  await expect(page.getByTestId("tracker-seen")).toHaveText("1.0.0");
  await expect(page.getByTestId("tracker-latest")).toHaveText("1.0.0");
  await expect(page.getByTestId("tracker-update")).toHaveText("Up to date.");

  await request.post("/__mock/release-tracker");
  await page.reload();
  await expect(page.getByTestId("tracker-latest")).toHaveText("1.1.0");
  await expect(page.getByTestId("tracker-update")).toContainText("Update available: 1.0.0 → 1.1.0");
  await expect(page.getByTestId("tracker-update")).toContainText("keep working with 1.0.0");
  await expectAccessible(page, "installation (update available)");
  await page.getByRole("link", { name: "Get the 1.1.0 snippet" }).click();
  await expect(page).toHaveURL(/\/snippet\?format=html&version=1\.1\.0$/);
  const code = page.getByTestId("snippet-code");
  await expect(code).toContainText("/t/1.1.0/standard.js");
  const newer = await page.getByTestId("snippet-integrity").textContent();
  // The installed version stays available: its snippet and SRI hash are still served.
  await page.getByLabel("Tracker version", { exact: true }).selectOption("1.0.0");
  await expect(code).toContainText("/t/1.0.0/standard.js");
  const older = await page.getByTestId("snippet-integrity").textContent();
  expect(older).toMatch(/^sha384-/);
  expect(newer).toMatch(/^sha384-/);
  expect(older).not.toBe(newer);
  await expect(page.getByRole("cell", { name: "1.1.0" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "1.0.0" }).first()).toBeVisible();
});
