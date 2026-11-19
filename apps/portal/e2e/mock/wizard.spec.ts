// SPDX-License-Identifier: Apache-2.0
// Onboarding wizard: web (site → domain verification → SRI snippet → installation check) and API (service →
// token shown once → OpenTelemetry dual-export configuration per supported stack → data check).
import { EXPECTED_API } from "../../test/fixtures/api.ts";
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

test("web: new website → verified domain → SRI snippet → installation check", async ({ page }) => {
  await page.goto(`/t/${T}/setup`);
  await expectAccessible(page, "wizard start");
  await page.getByRole("link", { name: "Set up a website" }).click();
  await expect(
    page.getByRole("list", { name: "Set-up steps" }).locator('[aria-current="step"]'),
  ).toHaveText("Website");
  await page.getByLabel("Website name").fill("Docs preview");
  await page.getByRole("button", { name: "Add website" }).click();
  await expect(page).toHaveURL(/step=domain/);
  await expect(page.getByRole("heading", { name: "Set up a website: Docs preview" })).toBeVisible();
  await page.getByLabel("Add a domain").fill("preview.stellar-docs.example");
  await page.getByRole("button", { name: "Add domain" }).click();
  await page
    .getByRole("button", { name: "Start verification of preview.stellar-docs.example" })
    .click();
  await expect(page.getByTestId("verification-instructions")).toContainText(
    "_scf-verify.preview.stellar-docs.example",
  );
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.getByTestId("domain-state-preview.stellar-docs.example")).toHaveText(
    "verified",
  );
  await expectAccessible(page, "wizard domain");
  await page.getByRole("button", { name: "Next: Snippet" }).click();
  await expect(page.getByTestId("wizard-snippet")).toContainText('integrity="sha384-');
  await expect(page.getByTestId("wizard-snippet")).toContainText('crossorigin="anonymous"');
  await expectAccessible(page, "wizard snippet");
  await page.getByRole("button", { name: "Next: Installation check" }).click();
  await expect(page.getByTestId("wizard-check-none")).toContainText(
    "No events in the last 24 hours",
  );
  await expectAccessible(page, "wizard check");
});

test("web: an existing website with traffic passes the installation check", async ({ page }) => {
  await page.goto(`/t/${T}/setup/web?step=site`);
  await page.getByLabel("Continue with an existing website").selectOption({ label: "Docs site" });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Next: Snippet" }).click();
  await page.getByRole("button", { name: "Next: Installation check" }).click();
  await expect(page.getByTestId("wizard-check-ok")).toContainText(
    "12,000 verified, 640 suspect, 311 rejected · tracker 1.0.0",
  );
});

test("API: new service → token once → configuration for every stack → data check", async ({
  page,
}) => {
  await page.goto(`/t/${T}/setup`);
  await page.getByRole("link", { name: "Set up an API" }).click();
  await page.getByLabel("Service name (OpenTelemetry service.name)").fill("payments-api");
  await page.getByRole("button", { name: "Register service" }).click();
  await expect(page).toHaveURL(/step=token/);
  await expectAccessible(page, "wizard token");
  await page.getByLabel("Label").fill("payments collector");
  await expect(page.getByLabel("payments-api")).toBeChecked();
  await page.getByRole("button", { name: "Create token" }).click();
  await expect(page.getByTestId("secret-value")).toHaveText(
    /^scfa_ing_[0-9A-Za-z]{12}_[0-9A-Za-z]{33}$/,
  );
  const secret = (await page.getByTestId("secret-value").textContent()) as string;
  expect(page.url()).not.toContain(secret.slice(10));
  await page.getByRole("button", { name: "Next: OpenTelemetry" }).click();
  expect(page.url()).not.toContain(secret.slice(10));
  await expect(page.getByTestId("otel-file-otel.mjs")).toContainText(
    "@opentelemetry/instrumentation/hook.mjs",
  );
  await expect(page.getByTestId("otel-file-otel.mjs")).toContainText("serviceName: 'payments-api'");
  await expect(page.getByTestId("otel-file-otel.mjs")).toContainText(
    "https://apm.example/v1/traces",
  );
  await expect(page.getByTestId("otel-env")).toContainText("SCF_OTLP_TOKEN='<INGEST_TOKEN>'");
  await expect(page.getByTestId("otel-config")).not.toContainText(secret);
  await expectAccessible(page, "wizard configuration");
  const expectations: [string, string, string][] = [
    ["Next.js", "otel-file-instrumentation.js", "NEXT_MANUAL_SIG_HANDLE"],
    ["Python / FastAPI", "otel_setup.py", "OnlyHttpServer"],
    ["Go (net/http)", "otel.go", "onlyHTTPServer"],
    ["Rust (axum)", "main.rs (excerpt)", "with_periodic_exporter(scf)"],
    ["Java (OpenTelemetry agent)", "sdk.yaml", "temporality_preference: cumulative"],
    [".NET (ASP.NET Core)", "Program.cs (excerpt)", "OtlpExportProtocol.HttpProtobuf"],
    ["Your own OpenTelemetry Collector", "otel-collector.yaml", "IsRootSpan()"],
  ];
  for (const [label, file, text] of expectations) {
    await page.getByLabel("Your stack").selectOption({ label });
    const testId = file.startsWith("otel-file-") ? file : `otel-file-${file}`;
    await expect(page.getByTestId(testId)).toContainText(text);
  }
  await expect(page.getByTestId("otel-notes")).toContainText("Span-only services");
  await page.getByRole("button", { name: "Next: Check data" }).click();
  await expect(page.getByTestId("wizard-api-none")).toContainText("No requests for payments-api");
  await expectAccessible(page, "wizard API check");
});

test("API: an existing service with data passes the check", async ({ page }) => {
  await page.goto(`/t/${T}/setup/api?step=service&stack=node`);
  await page
    .getByLabel("Continue with an existing service")
    .selectOption({ label: "horizon-proxy" });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Next: OpenTelemetry" }).click();
  await page.getByRole("button", { name: "Next: Check data" }).click();
  await expect(page.getByTestId("wizard-api-ok")).toContainText(
    `${EXPECTED_API.requests} requests in the last 24 hours`,
  );
});
