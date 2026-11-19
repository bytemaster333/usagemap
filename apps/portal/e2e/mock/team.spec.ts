// SPDX-License-Identifier: Apache-2.0
// docs.quickstarts-run portal screens: SEP-10 sign-in (challenge transaction, for hardware wallets and multisig, C-15/C-19), the
// project team — invitation codes shown once, accepted by a new member, roles changed, invitations revoked, members
// removed (tenancy.sites-and-services) — and the L2 verification flow (link the project's Stellar account with SEP-53 or SEP-10; each of the
// control plane's checks fails visibly with its reason, C-19). Every page runs under the production CSP (fixtures.ts)
// and is checked with axe.
import {
  expect,
  expectAccessible,
  openStellarForm,
  signInWithWallet,
  TestWallet,
  test,
} from "../support/fixtures.ts";

const DOCS_TENANT = "a0000000-0000-4000-8000-000000000001";

async function signInGithub(page: import("@playwright/test").Page) {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
}

async function sep10SignIn(
  page: import("@playwright/test").Page,
  wallet: TestWallet,
  signer = wallet,
) {
  await openStellarForm(page);
  await page.getByLabel(/Sign a challenge transaction \(SEP-10\)/).check();
  await page.getByLabel("Stellar account").fill(wallet.account);
  await page.getByRole("button", { name: "Get transaction to sign" }).click();
  const xdr = (await page.getByTestId("sep10-xdr").textContent()) ?? "";
  await page.getByLabel("Signed transaction (base64 XDR)").fill(signer.signSep10(xdr));
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("SEP-10 sign-in with a challenge transaction signed by the test wallet", async ({ page }) => {
  const wallet = new TestWallet();
  await page.goto("/signin");
  await openStellarForm(page);
  await page.getByLabel(/Sign a challenge transaction \(SEP-10\)/).check();
  await expect(page.getByRole("button", { name: "Get transaction to sign" })).toBeVisible();
  await expectAccessible(page, "sign-in (SEP-10 chosen)");
  await page.getByLabel("Stellar account").fill(wallet.account);
  await page.getByRole("button", { name: "Get transaction to sign" }).click();
  await expect(page.getByText("Test SDF Network ; September 2015")).toBeVisible();
  const xdr = (await page.getByTestId("sep10-xdr").textContent()) ?? "";
  expect(xdr).toMatch(/^[A-Za-z0-9+/]+=*$/);
  await expectAccessible(page, "sign-in (SEP-10 challenge)");
  await page.getByLabel("Signed transaction (base64 XDR)").fill(wallet.signSep10(xdr));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/(tenants|onboard)$/);
  const session = (await (await page.request.get("/v1/auth/session")).json()) as {
    first_factor: string;
  };
  expect(session.first_factor).toBe("stellar_sep10");
});

test("SEP-10: a transaction signed by another key is refused; without a SEP-10 key the reason is shown", async ({
  page,
  request,
}) => {
  const wallet = new TestWallet();
  await page.goto("/signin");
  await sep10SignIn(page, wallet, new TestWallet());
  await expect(page.getByRole("alert")).toContainText("Signature not accepted");
  await expect(page).toHaveURL(/\/signin/);
  // the challenge is single use: the form is back at the account step only after "Use another account"
  await page.getByRole("button", { name: "Use another account" }).click();
  await request.post("/__mock/sep10", { data: { enabled: false } });
  await openStellarForm(page);
  await page.getByLabel(/Sign a challenge transaction \(SEP-10\)/).check();
  await page.getByLabel("Stellar account").fill(wallet.account);
  await page.getByRole("button", { name: "Get transaction to sign" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "SEP-10 is not configured on this deployment",
  );
  // SEP-53 still works
  await page.getByLabel("Sign a message (SEP-53)").check();
  await signInWithWallet(page, wallet);
  await expect(page).toHaveURL(/\/(tenants|onboard)$/);
});

test("team: an invitation code is shown once, accepted by a new member; roles changed, invitations revoked, members removed", async ({
  page,
}) => {
  await signInGithub(page);
  await page.goto(`/t/${DOCS_TENANT}/team`);
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  await expect(page.getByTestId("member-octo-dev").getByTestId("member-role")).toHaveText("Owner");
  await expect(page.getByText("No open invitations.")).toBeVisible();
  await expectAccessible(page, "team");

  // one invitation to revoke, one to accept
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByLabel("Role").selectOption("viewer");
  await page.getByLabel("Note for your records (optional)").fill("old link");
  await page.getByRole("button", { name: "Create invitation code" }).click();
  await expect(page.getByTestId("secret-value")).toHaveText(/^scfi_[0-9A-Za-z]{22}$/);
  await page.getByRole("button", { name: "I have stored it — hide it" }).click();
  await page.getByRole("button", { name: "Revoke old link" }).click();
  await page
    .getByRole("dialog", { name: "Revoke “old link”?" })
    .getByRole("button", { name: "Revoke invitation" })
    .click();
  await expect(page.getByTestId("invitation-old link")).toHaveCount(0);

  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByLabel("Role").selectOption("member");
  await page.getByLabel("Note for your records (optional)").fill("backend developer");
  await page.getByLabel("Valid for (hours, 1–168)").fill("24");
  await page.getByRole("button", { name: "Create invitation code" }).click();
  const code = (await page.getByTestId("secret-value").textContent()) ?? "";
  expect(code).toMatch(/^scfi_[0-9A-Za-z]{22}$/);
  await expectAccessible(page, "team with a new code");
  await page.getByRole("button", { name: "I have stored it — hide it" }).click();
  await expect(page.getByTestId("secret-once")).toHaveCount(0);
  const inv = page.getByTestId("invitation-backend developer");
  await expect(inv).toContainText("Member");
  await expect(inv).not.toContainText(code);
  const log = (await (await page.request.get("/__mock/requests")).json()) as { path: string }[];
  expect(log.every((r) => !r.path.includes("scfi_"))).toBe(true);

  // a new person signs in with a Stellar wallet and accepts the code
  await page.getByRole("button", { name: "Sign out" }).click();
  const wallet = new TestWallet();
  await page.goto("/signin");
  await signInWithWallet(page, wallet);
  // no project yet: onboarding, which also offers joining with an invitation
  await expect(
    page.getByRole("heading", { level: 1, name: "Welcome. Find your project" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Accept an invitation" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Accept an invitation" })).toBeVisible();
  await expectAccessible(page, "accept invitation");
  await page.getByLabel("Invitation code").fill("scfi_0000000000000000000000");
  await page.getByRole("button", { name: "Join project" }).click();
  await expect(page.getByRole("alert")).toContainText("This code is not valid");
  await page.getByLabel("Invitation code").fill(code);
  await page.getByRole("button", { name: "Join project" }).click();
  await expect(page.getByTestId("joined")).toHaveText("You joined Stellar Docs as member.");
  // single use
  await page.getByLabel("Invitation code").fill(code);
  await page.getByRole("button", { name: "Join project" }).click();
  await expect(page.getByRole("alert")).toContainText("This code is not valid");
  await page.getByRole("link", { name: "Stellar Docs" }).first().click();
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "Team" })
    .click();
  await expect(page.getByText("Only the owner and admins can invite people")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create invitation code" })).toHaveCount(0);
  const short = `${wallet.account.slice(0, 5)}…${wallet.account.slice(-4)}`;
  await expect(page.getByTestId(`member-${short}`)).toContainText("You");

  // the owner changes the new member's role, then removes them
  await page.getByRole("button", { name: "Sign out" }).click();
  await signInGithub(page);
  await page.goto(`/t/${DOCS_TENANT}/team`);
  const row = page.getByTestId(`member-${short}`);
  await row.getByLabel(`Role of ${short}`).selectOption("viewer");
  await page.reload();
  await expect(row.getByLabel(`Role of ${short}`)).toHaveValue("viewer");
  await row.getByRole("button", { name: `Remove ${short}` }).click();
  await page
    .getByRole("dialog", { name: `Remove ${short}?` })
    .getByRole("button", { name: "Remove member" })
    .click();
  await expect(row).toHaveCount(0);
  // the owner has no controls on their own row
  await expect(page.getByTestId("member-octo-dev").getByRole("button")).toHaveCount(0);
});

test("L2: linking the project's Stellar account — each check fails with its reason, then SEP-53 and SEP-10 succeed", async ({
  page,
  request,
}) => {
  await request.post("/__mock/verification", {
    data: { tenant_id: DOCS_TENANT, level: "L1", domains: ["docs.stellar.example"] },
  });
  await signInGithub(page);
  await page.goto(`/t/${DOCS_TENANT}/verification`);
  await expect(page.getByRole("heading", { level: 1, name: "Trust" })).toBeVisible();
  await expect(page.getByTestId("verification-level")).toContainText("L1");
  await expect(page.getByTestId("next-steps")).toContainText("Link the project's Stellar account");
  await expect(page.getByTestId("evidence-domain")).toContainText("docs.stellar.example");
  await expectAccessible(page, "verification (L1)");
  await page.getByRole("button", { name: "Link the project's Stellar account (L2)" }).click();

  const w1 = new TestWallet();
  const link53 = async () => {
    await page.getByRole("textbox", { name: "Project's Stellar account" }).fill(w1.account);
    await page.getByRole("button", { name: "Get message to sign" }).click();
    const message = (await page.getByTestId("sep53-message").textContent()) ?? "";
    expect(message).toContain("Purpose: prove control of the project's Stellar account (L2)");
    await page.getByLabel("Signature (base64 or hex)").fill(w1.signMessage(message));
    await page.getByRole("button", { name: "Link account" }).click();
  };
  const reset = async () => {
    const back = page.getByRole("button", { name: "Use another account" });
    if (await back.isVisible()) await back.click();
  };
  await link53();
  await expect(page.getByRole("alert")).toContainText("the account has no home_domain");
  await reset();
  await request.post("/__mock/stellar-account", {
    data: { account: w1.account, home_domain: "other.example", listed: true },
  });
  await link53();
  await expect(page.getByRole("alert")).toContainText(
    "the account's home_domain is not a verified domain of this project",
  );
  await reset();
  await request.post("/__mock/stellar-account", {
    data: { account: w1.account, home_domain: "docs.stellar.example", listed: false },
  });
  await link53();
  await expect(page.getByRole("alert")).toContainText(
    "the home domain's stellar.toml does not list the account in ACCOUNTS",
  );
  await reset();
  await request.post("/__mock/stellar-account", {
    data: { account: w1.account, home_domain: "docs.stellar.example", listed: true },
  });
  await link53();
  await expect(page.getByTestId("linked")).toContainText(w1.account);
  await expect(page.getByTestId("verification-level")).toContainText("L2");
  await expect(page.getByTestId("evidence-stellar_account")).toContainText(w1.account);
  await expectAccessible(page, "verification (L2)");

  // a multisig / hardware-wallet account links with SEP-10
  const w2 = new TestWallet();
  await request.post("/__mock/stellar-account", {
    data: { account: w2.account, home_domain: "docs.stellar.example", listed: true },
  });
  await openStellarForm(page);
  await page.getByLabel(/Sign a challenge transaction \(SEP-10\)/).check();
  await page.getByRole("textbox", { name: "Project's Stellar account" }).fill(w2.account);
  await page.getByRole("button", { name: "Get transaction to sign" }).click();
  const xdr = (await page.getByTestId("sep10-xdr").textContent()) ?? "";
  await page.getByLabel("Signed transaction (base64 XDR)").fill(w2.signSep10(xdr));
  await page.getByRole("button", { name: "Link account" }).click();
  await expect(page.getByTestId("linked")).toContainText(w2.account);
  await expect(page.getByTestId("evidence-stellar_account")).toHaveCount(2);
  // the project page shows the new level
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("link", { name: /Verification\s*Level L2/ })).toBeVisible();
});
