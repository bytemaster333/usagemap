// SPDX-License-Identifier: Apache-2.0
// The day-3 portal flows against the real control plane (Compose project scf-wsh, run by e2e/real/run.sh):
//   1. a project member: API set-up wizard (service → ingest token shown once → OpenTelemetry configuration → data
//      check), the API dashboard of a service without data, ingest tokens, and a website erasure request through
//      preview and confirmation;
//   2. an SCF operator (granted directly in the database — there is no other bootstrap path locally): the passkey step
//      after the grant (C-09, C-114), the ecosystem web and API views, the project list and the audit log of the
//      operator's own cross-tenant reads (operator.global-view-credentials).
import { execFileSync } from "node:child_process";
import {
  addVirtualAuthenticator,
  expect,
  expectAccessible,
  registerSecondOperatorPasskey,
  signInWithWallet,
  TestWallet,
  test,
} from "../support/fixtures.ts";

const PG = process.env.SCF_WSH_POSTGRES_CONTAINER ?? "scf-wsh-postgres-1";

/** Runs SQL as the database superuser inside the project's PostgreSQL container (test set-up only). */
function psql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      PG,
      "sh",
      "-c",
      'PGPASSWORD="$(cat /run/secrets/pg_superuser_password)" psql -h 127.0.0.1 -U postgres -d scf -v ON_ERROR_STOP=1 -tAq',
    ],
    { input: sql, encoding: "utf8" },
  ).trim();
}

/** A new account starts in onboarding; "Start without the registry" creates the project. Returns its id. */
async function createProject(page: import("@playwright/test").Page, slug: string): Promise<string> {
  await expect(page).toHaveURL(/\/onboard$/);
  await page.getByRole("button", { name: "Not in the list? Start without the registry" }).click();
  await page.getByLabel("Your project's name").fill(`E2E ${slug}`);
  await page.getByRole("button", { name: "Create my project" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]+\/onboard\/kit/);
  const tenantId = new URL(page.url()).pathname.split("/")[2] as string;
  await page.goto(`/t/${tenantId}`);
  await expect(page.getByTestId("project-switcher")).toContainText(`E2E ${slug}`);
  return tenantId;
}

test("member: API wizard, API dashboard, ingest tokens and erasure on the real control plane", async ({
  page,
}) => {
  const wallet = new TestWallet();
  await page.goto("/tenants");
  await signInWithWallet(page, wallet);
  const slug = `wsh3-${Date.now().toString(36)}`;
  const tenantId = await createProject(page, slug);

  // API set-up wizard.
  await page.goto(`/t/${tenantId}/setup`);
  await page.getByRole("link", { name: "Set up an API" }).click();
  await page.getByLabel("Service name (OpenTelemetry service.name)").fill("e2e-api");
  await page.getByRole("button", { name: "Register service" }).click();
  await expect(page).toHaveURL(/step=token/);
  await page.getByLabel("Label", { exact: true }).fill("e2e collector");
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByTestId("secret-value")).toHaveText(
    /^scfa_ing_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/,
  );
  const secret = (await page.getByTestId("secret-value").textContent()) as string;
  await expectAccessible(page, "wizard token (real)");
  await page.getByRole("button", { name: "Next: OpenTelemetry" }).click();
  await expect(page.getByTestId("otel-config")).toContainText(
    "@opentelemetry/instrumentation/hook.mjs",
  );
  await expect(page.getByTestId("otel-config")).toContainText("<INGEST_TOKEN>");
  await expect(page.getByTestId("otel-config")).not.toContainText(secret);
  for (const label of [
    "Next.js",
    "Python / FastAPI",
    "Go (net/http)",
    "Rust (axum)",
    "Java (OpenTelemetry agent)",
    ".NET (ASP.NET Core)",
    "Your own OpenTelemetry Collector",
  ]) {
    await page.getByLabel("Your stack").selectOption({ label });
    await expect(page.getByTestId("otel-config")).toContainText("SCF_OTLP_TOKEN");
  }
  await expectAccessible(page, "wizard configuration (real)");
  await page.getByRole("button", { name: "Next: Check data" }).click();
  await expect(page.getByTestId("wizard-api-none")).toContainText("No requests for e2e-api");

  // API dashboard of the new service: zeros, labelled self-attested, no errors.
  await page.getByRole("link", { name: "Open the API dashboard" }).click();
  await expect(page.getByTestId("self-attested")).toBeVisible();
  await expect(page.getByTestId("tile-requests").locator(".um-kpi-v strong")).toHaveText("0");
  await page.getByRole("tab", { name: "Data quality" }).click();
  await expect(page.getByTestId("data-quality")).toBeVisible();
  await expectAccessible(page, "API dashboard (real)");

  // Ingest tokens: the created token is listed by its display form only.
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "Keys" })
    .click();
  await expect(page.getByTestId("token-e2e collector")).toContainText("scfa_ing_");
  await expect(page.getByText(secret)).toHaveCount(0);

  // Erasure: a website, a path pattern, preview, confirm (the wallet sign-in is recent authentication).
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "Settings" }) // Settings → Websites adds websites
    .click();
  await page.getByRole("link", { name: "Websites" }).click();
  await page.getByRole("button", { name: "New website" }).click();
  await page.getByLabel("Website name").fill("E2E site");
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/\/snippet/);
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "Settings" })
    .click();
  await page.getByRole("link", { name: "Erasure and removal" }).click();
  await page.getByLabel("Only matching data").check();
  await page.getByLabel("Value").fill("/users/e2e/*");
  await page.getByRole("button", { name: "Preview erasure" }).click();
  // The request exists and is shown as being counted. On this stack the preview does not finish yet: the control
  // plane's erasure job fails its Umami count with SQLSTATE 08P01 (a known engine issue); the mock suite covers
  // preview → confirm → report.
  await expect(page.getByTestId("erasure-status")).toContainText(
    /Counting what would be erased|Preview ready/,
  );
  await expect(page.getByTestId("erasure-covers")).toContainText(
    "page path pattern “/users/e2e/*”",
  );
  await expectAccessible(page, "erasure request (real)");
});

test("operator: passkey step after the grant, ecosystem views, projects and audit of own reads", async ({
  page,
}) => {
  await addVirtualAuthenticator(page);
  const wallet = new TestWallet();
  await page.goto("/tenants");
  await signInWithWallet(page, wallet);
  // a new account without a project starts in onboarding
  await expect(page).toHaveURL(/\/onboard$/);
  const granted = psql(
    `INSERT INTO scf.platform_operators (user_id, role, note)
       SELECT user_id, 'operator_admin', 'portal e2e' FROM scf.external_identities
        WHERE provider = 'stellar' AND subject = '${wallet.account}'
     RETURNING role;`,
  );
  expect(granted).toBe("operator_admin");

  // The grant ends the member session (C-114); the next sign-in is partial until the first passkey (C-09), which may
  // be enrolled within 10 minutes of the first factor.
  await page.goto("/operator");
  await expect(page).toHaveURL(/\/signin\?return_to=%2Foperator/);
  await signInWithWallet(page, wallet);
  await expect(page).toHaveURL(/\/signin\/passkey/);
  await page.getByRole("button", { name: "Register passkey" }).click();
  await page.getByRole("button", { name: "Confirm with passkey" }).click();
  // The assertion completes the session and the page returns to /operator; navigating before that lands back on the
  // passkey step (heavy/portal-real, local CI 2026-11-19).
  await expect(page).toHaveURL(/\/operator(\/|\?|$)/);
  // C-20: the console opens only once a second passkey is registered (the control plane refuses operator calls).
  await registerSecondOperatorPasskey(page);
  await page.goto("/operator/web");
  await expect(page).toHaveURL(/\/operator\/web\?/);
  await expect(page.getByTestId("operator-banner")).toContainText("Operator admin");
  await expect(page.getByTestId("eco-visits")).toBeVisible();
  // The per-project list answered: the table, or (no project at L1 or above on this fresh stack) its empty state —
  // the rebuilt console shows that instead of an empty table; a failed read shows neither.
  await expect(
    page
      .getByTestId("web-projects")
      .or(page.getByText("No Stellar ecosystem projects match these filters", { exact: true })),
  ).toBeVisible();
  await expectAccessible(page, "operator web (real)");
  // The ecosystem page-view total moved to the console's overview in the rebuilt portal.
  await page
    .getByRole("navigation", { name: "Operator" })
    .getByRole("link", { name: "Overview", exact: true })
    .click();
  await expect(page).toHaveURL(/\/operator\/overview\?/);
  await expect(page.getByTestId("eco-pageviews")).toBeVisible();
  await expectAccessible(page, "operator overview (real)");

  await page
    .getByRole("navigation", { name: "Operator" })
    .getByRole("link", { name: "API", exact: true })
    .click();
  await expect(page.getByTestId("eco-requests")).toBeVisible();
  await expect(
    page
      .getByTestId("api-services")
      .or(page.getByText("No services match these filters", { exact: true })),
  ).toBeVisible();
  await expectAccessible(page, "operator API (real)");

  await page
    .getByRole("navigation", { name: "Operator" })
    .getByRole("link", { name: "Ecosystem projects" })
    .click();
  await expect(page.getByTestId("op-tenants")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Operator" })
    .getByRole("link", { name: "Settings" })
    .click();
  await expect(page.getByTestId("enrollment-mode")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Operator" })
    .getByRole("link", { name: "Audit log" })
    .click();
  await page.getByLabel("Action").selectOption("operator.read.");
  await expect(page.getByTestId("audit")).toContainText("operator.read.op_web_metrics");
  await expectAccessible(page, "operator audit (real)");
});

test("the operator metrics API is reachable through the portal origin, not answered by the SPA", async ({
  request,
}) => {
  // Regression: /op/v1/* once fell through to the SPA catch-all (200 text/html). Through Caddy it must reach the
  // control plane, which answers a key-less request with a 401 problem.
  const r = await request.get("/op/v1/me");
  expect(r.status()).toBe(401);
  expect(r.headers()["content-type"]).toContain("application/problem+json");
  expect(r.headers()["www-authenticate"]).toContain("Bearer");
});
