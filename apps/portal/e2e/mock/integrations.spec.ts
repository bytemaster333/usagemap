// SPDX-License-Identifier: Apache-2.0
// Integration catalogue (integration plan I1.0): the four steps of the loop — pick → generated config → test → see it
// arrive live — for one web integration (script tag: dev origin added with one click, test curl, the edge's dev-event
// report arriving in the first-event panel) and one API integration (OpenTelemetry for Node.js: test curl, the
// writer's baseline-point counter going up). The arrivals are what the edge and the writer report for the generated
// curls (`/__mock/dev-event`, `/__mock/otlp-test-point`); both stay "not counted".
import { SVC_HORIZON } from "../../test/fixtures/api.ts";
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const T = "a0000000-0000-4000-8000-000000000001";
const SITE = "b0000000-0000-4000-8000-000000000001";

test.beforeEach(async ({ page, request }) => {
  await request.post("/__mock/reset");
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
});

test("web: pick the script tag → copy the tag → add localhost and run the test → see it arrive", async ({
  page,
  request,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/t/${T}`);
  await page
    .getByRole("navigation", { name: "Project" })
    .getByRole("link", { name: "Integrations" })
    .click();
  await expect(page.getByRole("heading", { name: "Integrations", level: 1 })).toBeVisible();
  const tagCard = page.getByTestId("integration-web_script_tag");
  await expect(tagCard.getByTestId("integration-status")).toHaveText("Not started");
  await expect(tagCard.getByTestId("integration-recommended")).toContainText("Start here");
  await expect(
    page.getByTestId("integration-tool_cli").getByTestId("integration-status"),
  ).toHaveText("Runs locally");
  await expectAccessible(page, "integration catalogue");

  // 1. pick
  await page.getByRole("button", { name: "Set up Script tag (any website)" }).click();
  await expect(page).toHaveURL(/card=web_script_tag/);
  const detail = page.getByTestId("integration-detail");
  const siteKey = (
    (await (await page.request.get(`/v1/tenants/${T}/sites/${SITE}`)).json()) as {
      site_key: string;
    }
  ).site_key;

  // 2. generated configuration, with this site's key
  await expect(detail.getByTestId("setup-0")).toContainText(`data-site="${siteKey}"`);
  await detail.getByRole("button", { name: "Copy" }).first().click();
  await expect(detail.getByText("Copied.").first()).toBeVisible();

  // 3. the test: localhost first (one click), then the curl
  await detail.getByRole("button", { name: "Add localhost as a dev origin" }).click();
  await expect(detail.getByTestId("localhost-ok")).toContainText(
    "localhost is a dev origin of Docs site",
  );
  await expect(detail.getByTestId("test-command")).toContainText("/v1/e");
  await expect(detail.getByTestId("test-command")).toContainText("Origin: http://localhost:5173");
  await expect(detail.getByTestId("test-command")).toContainText(siteKey);

  // 4. live check: waiting, then the edge reports the curl's page view (dev origin, never counted)
  await detail.getByRole("button", { name: "Start live check" }).click();
  await expect(detail.getByTestId("live-waiting")).toBeVisible();
  await expectAccessible(page, "integration detail");
  await request.post("/__mock/dev-event", {
    data: {
      site_id: SITE,
      kind: "pageview",
      event_name: "pageview",
      path: "/usagemap-test",
      would_be_verdict: "rejected",
      reason: "challenge_missing",
    },
  });
  await expect(detail.getByTestId("live-arrived")).toContainText("/usagemap-test", {
    timeout: 15_000,
  });
  await expect(detail.getByTestId("live-arrived")).toContainText("never counted");
  await expect(detail.getByTestId("dev-events")).toContainText("would be rejected");

  // the catalogue now says so
  await page.getByRole("button", { name: "Back to all integrations" }).click();
  await expect(tagCard.getByTestId("integration-status")).toHaveText("Test received", {
    timeout: 15_000,
  });
});

test("API: pick OpenTelemetry for Node.js → copy the env → run the test → see the baseline point arrive", async ({
  page,
  request,
}) => {
  await page.goto(`/t/${T}/integrations?group=api`);
  await expect(page.getByTestId("integration-web_script_tag")).toHaveCount(0);
  await expect(page.getByTestId("integration-api_edge")).toContainText("Beta");

  // 1. pick
  await page.getByRole("button", { name: "Set up OpenTelemetry: Node.js / Express" }).click();
  const detail = page.getByTestId("integration-detail");

  // 2. generated configuration for the selected service; the token stays a placeholder
  await expect(detail.getByTestId("setup-0")).toContainText("OTEL_SERVICE_NAME=horizon-proxy");
  await expect(detail.getByTestId("setup-0")).toContainText("<INGEST_TOKEN>");

  // 3. the test command reads the token from the shell
  await expect(detail.getByTestId("test-command")).toContainText("/v1/metrics");
  await expect(detail.getByTestId("test-command")).toContainText("$SCF_OTLP_TOKEN");

  // 4. live check against the service's baseline-point counter
  await expect(detail.getByTestId("baseline-count")).toHaveText("0");
  await detail.getByRole("button", { name: "Start live check" }).click();
  await expect(detail.getByTestId("live-waiting")).toBeVisible();
  await request.post("/__mock/otlp-test-point", { data: { service_id: SVC_HORIZON } });
  await expect(detail.getByTestId("live-arrived")).toContainText("never counted", {
    timeout: 15_000,
  });
  await expect(detail.getByTestId("baseline-count")).toHaveText("1");
  await expectAccessible(page, "API integration detail");

  await page.getByRole("button", { name: "Back to all integrations" }).click();
  await expect(
    page.getByTestId("integration-api_otel_node").getByTestId("integration-status"),
  ).toHaveText("Test received");
});

test("filters by kind and text; a foreign service id is a not-found answer", async ({ page }) => {
  await page.goto(`/t/${T}/integrations`);
  await page.getByLabel("Kind").selectOption("wallets");
  await expect(page.getByTestId("integrations").getByRole("listitem")).toHaveCount(1);
  await page.getByLabel("Kind").selectOption("");
  await page.getByLabel("Stack or name").fill("workers");
  await expect(page.getByTestId("integrations").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("integration-api_edge")).toBeVisible();
  const r = await page.request.get(
    `/v1/tenants/${T}/integrations?service_id=d0000000-0000-4000-8000-0000000000ff`,
  );
  expect(r.status()).toBe(404);
});
