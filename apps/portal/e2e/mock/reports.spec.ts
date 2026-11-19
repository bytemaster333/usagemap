// SPDX-License-Identifier: Apache-2.0
// Web reports (funnel, goals, journeys; wire-formats §j.3 R6–R8) against the mock control plane, under the production
// CSP and checked with axe: building a funnel from the step editor, the live-window truncation, withheld counts with
// anonymous reports, goals, journeys with the floor, a validation error naming the step, the engine-down 503, the
// statement that there are no retention or campaign reports, and a `data-metric` key on every figure.
import type { Page } from "@playwright/test";
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const DOCS = "a0000000-0000-4000-8000-000000000001";
const DOCS_SITE = "b0000000-0000-4000-8000-000000000001"; // anonymous reports on
const WALLET_SITE = "b0000000-0000-4000-8000-000000000002"; // anonymous reports off

async function signIn(page: Page) {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await expect(
    page.getByRole("heading", { name: "Your Stellar ecosystem projects" }),
  ).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("funnel: built in the step editor, exact counts, the live window stated", async ({ page }) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}/sites/${WALLET_SITE}`);
  await page
    .getByRole("navigation", { name: "Web sections" })
    .getByRole("link", { name: "Funnels, goals and journeys" })
    .click();
  await expect(page).toHaveURL(/\/reports\?/);
  await expect(page.getByTestId("reports-not-offered")).toContainText("No retention or campaign");
  const editor = page.getByRole("form", { name: "Steps" });
  await editor.getByLabel("Step 2", { exact: true }).fill("/docs");
  await editor.getByRole("button", { name: "Add step" }).click();
  await editor.getByLabel("Step 3 type").selectOption("event");
  await editor.getByLabel("Step 3", { exact: true }).fill("wallet_connected");
  await editor.getByRole("button", { name: "Show funnel" }).click();
  const funnel = page.getByTestId("report-funnel");
  await expect(funnel.getByTestId("report-funnel-step-0")).toContainText("1,240");
  await expect(funnel.getByTestId("report-funnel-step-1")).toContainText("610");
  await expect(funnel.getByTestId("report-funnel-step-1")).toContainText("49.2%");
  await expect(funnel.getByTestId("report-funnel-step-2")).toContainText("Event: wallet_connected");
  await expect(funnel.getByTestId("report-funnel-step-2")).toContainText("96");
  // 7 days asked, the live window is 5: the rest is left out and said so
  await expect(page.getByTestId("report-truncated")).toContainText("live window only");
  await expect(page.getByTestId("report-anonymized")).toHaveCount(0);
  // every figure carries a metric key for its definition
  await expect(funnel.locator('[data-metric="report_funnel_visitors"]')).toHaveCount(3);
  await expect(funnel.locator('[data-metric="report_funnel_conversion"]')).toHaveCount(3);
  await expect(funnel.locator('[data-metric="report_funnel_step_conversion"]')).toHaveCount(2);
  // the steps live in the URL: a reload shows the same funnel
  await page.reload();
  await expect(page.getByTestId("report-funnel-step-2")).toContainText("96");
  await expectAccessible(page, "funnel report");
});

test("funnel: withheld counts with anonymous reports; a query string is refused naming the step", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(
    `/t/${DOCS}/sites/${DOCS_SITE}/reports?report=funnel&range=24h&step=%5B%22path%3A%2F%22%2C%22event%3Asignup%22%5D`,
  );
  const funnel = page.getByTestId("report-funnel");
  await expect(funnel.getByTestId("report-funnel-step-0")).toContainText("1,240");
  await expect(funnel.getByTestId("report-funnel-step-1")).toContainText("withheld");
  await expect(page.getByTestId("report-anonymized")).toBeVisible();
  await expect(page.getByTestId("report-truncated")).toHaveCount(0);

  const editor = page.getByRole("form", { name: "Steps" });
  await editor.getByLabel("Step 2", { exact: true }).fill("/pricing");
  await editor.getByRole("button", { name: "Show funnel" }).click();
  await expect(page.getByTestId("step-editor-problem")).toContainText("choose “Page path”");
  await editor.getByLabel("Step 2 type").selectOption("path");
  await editor.getByLabel("Step 2", { exact: true }).fill("/pricing?utm_source=x");
  await editor.getByRole("button", { name: "Show funnel" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "query string" })).toBeVisible();
});

test("funnel: the engine being down is a 503 with a retry hint, not empty figures", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(
    `/t/${DOCS}/sites/${WALLET_SITE}/reports?report=funnel&step=%5B%22path%3A%2F%22%2C%22event%3Aboom%22%5D`,
  );
  await expect(
    page.getByRole("alert").filter({ hasText: "Temporarily unavailable" }),
  ).toBeVisible();
  await expect(page.getByTestId("report-funnel")).toHaveCount(0);
});

test("goals: conversion of each goal of all visitors", async ({ page }) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}/sites/${WALLET_SITE}/reports?report=goals&range=30d`);
  const editor = page.getByRole("form", { name: "Goals" });
  await editor.getByLabel("Goal 1", { exact: true }).fill("/docs/*");
  await editor.getByRole("button", { name: "Add goal" }).click();
  await editor.getByLabel("Goal 2 type").selectOption("event");
  await editor.getByLabel("Goal 2", { exact: true }).fill("signup");
  await editor.getByRole("button", { name: "Show goals" }).click();
  const goals = page.getByTestId("report-goals");
  await expect(goals.getByTestId("report-goals-total")).toHaveText("1,500");
  await expect(goals.getByTestId("report-goal-0")).toContainText("/docs/*");
  await expect(goals.getByTestId("report-goal-0")).toContainText("46.8%");
  await expect(goals.getByTestId("report-goal-1")).toContainText("Event: signup");
  await expect(goals.locator('[data-metric="report_goal_visitors"]')).toHaveCount(2);
  await expect(goals.locator('[data-metric="report_goal_conversion"]')).toHaveCount(2);
  await expectAccessible(page, "goals report");
});

test("journeys: frequent sequences only, rarer ones counted, optional start", async ({ page }) => {
  await signIn(page);
  await page.goto(`/t/${DOCS}/sites/${WALLET_SITE}/reports?report=journey&range=7d`);
  const j = page.getByTestId("report-journey");
  await expect(j.getByTestId("report-journey-0")).toContainText("/ → /docs → /docs/{slug}");
  await expect(j.getByTestId("report-journey-0")).toContainText("412 visits");
  await expect(j.getByTestId("report-journey-1")).toContainText("/ → /pricing → Event: signup");
  await expect(j.getByTestId("report-journey-floor")).toContainText("at least 10 visits");
  await expect(j.getByTestId("report-journey-floor")).toContainText(
    "2 rarer journeys with 8 visits",
  );
  await expect(j.locator('[data-metric="report_journey_visits"]')).toHaveCount(3);
  await expect(j.locator('[data-metric="report_journey_other_visits"]')).toHaveCount(1);
  const opts = page.getByRole("form", { name: "Journey options" });
  await opts.getByLabel("Steps per journey").selectOption("2");
  await opts.getByLabel("Starting with (optional)").fill("/");
  await opts.getByRole("button", { name: "Show journeys" }).click();
  await expect(j.getByTestId("report-journey-0")).toHaveText(/^\/ → \/docs\s+412 visits$/);
  await expect(j.getByTestId("report-journey-floor")).toContainText(
    "1 rarer journeys with 6 visits",
  );
  await expectAccessible(page, "journey report");
});
