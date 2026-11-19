// SPDX-License-Identifier: Apache-2.0
// "Verify this number": the Verify control next to the headline figures of a public project
// card opens in place and shows the signed snapshot, the signature check, the inclusion proof, the seal chain, the
// operator actions log fixed by the seal and the seal transaction on Stellar testnet, with a plain-language verdict;
// tamper cases (a changed figure, a rewritten operator log, a forged inclusion path) are caught in the browser. The
// snapshot verify page shows the operator log check too. Mock data: e2e/support/mock-d1.ts (stellar-docs, snapshot 2
// sealed on 2026-11-12, testnet segment 2, ledger 1,200).

import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, expectAccessible, test } from "../support/fixtures.ts";

const DOCS = "a0000000-0000-4000-8000-000000000001";
const SNAP2 = "d5100000-0000-4000-8000-000000000002";
const HORIZON = "https://horizon-testnet.stellar.org";

/** RFC 8785 for the plain documents used here (strings, integers, arrays, objects). */
const jcs = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(jcs).join(",")}]`
      : `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`)
          .join(",")}}`;

async function makePublic(page: Page) {
  await page.goto("/signin?return_to=%2Ftenants");
  await page.getByRole("link", { name: "Sign in with GitHub" }).click();
  await page.getByRole("link", { name: "Continue as octo-dev" }).click();
  await page.goto(`/t/${DOCS}/sharing`);
  await page.getByRole("switch", { name: "Make statistics public" }).click();
  await page
    .getByRole("dialog", { name: "Make your statistics public?" })
    .getByRole("button", { name: "Make public" })
    .click();
  await expect(page.getByTestId("public-state")).toContainText("On.");
  await page.getByRole("button", { name: "Sign out" }).click();
}

/** A forged operator log: the head rewritten and the document's own hash recomputed (self-consistent). */
async function forgeAnchors(page: Page) {
  await page.route("**/public/v1/audit-anchors/**", async (route) => {
    const res = await route.fetch();
    const doc = (await res.json()) as { chains: { row_hash: string }[]; sha256?: string };
    (doc.chains[0] as { row_hash: string }).row_hash = "ab".repeat(32);
    const { sha256: _s, ...body } = doc;
    await route.fulfill({
      json: { ...body, sha256: createHash("sha256").update(jcs(body)).digest("hex") },
    });
  });
}

test.beforeEach(async ({ request }) => {
  await request.post("/__mock/reset");
});

test("public card: verify this number in place — signature, proof, chain, operator log, Stellar transaction", async ({
  page,
}) => {
  await makePublic(page);
  await page.goto("/p/stellar-docs");
  const v = page.getByTestId("verify-number-visitors");
  await v.getByRole("button", { name: "Verify this number" }).click();
  await expect(v.getByRole("button", { name: "Verify this number" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(v.getByTestId("verify-number-verdict")).toContainText(
    "This number is exactly what UsageMap published on",
  );
  await expect(v.getByTestId("verify-number-verdict")).toContainText(
    "and sealed on Stellar testnet in ledger 1,200.",
  );
  for (const id of ["vn-signature", "vn-listed", "vn-inclusion", "vn-chain", "vn-operator-log"])
    await expect(v.getByTestId(id)).toHaveClass("pass");
  await expect(v.getByTestId("vn-operator-log")).toContainText("Operator actions log: sealed");
  await expect(v.getByTestId("verify-number-source")).toContainText("From signed snapshot 2");
  await expect(v.getByTestId("vn-testnet-notice")).toContainText("not durable evidence");
  await expect(v.getByRole("link", { name: "open in a public explorer" })).toHaveAttribute(
    "href",
    `https://stellar.expert/explorer/testnet/tx/${"7a".repeat(32)}`,
  );
  // The transaction and the sealing account also open in StellarExpert and steexp (public chain objects only).
  await expect(v.getByTestId("vn-explorers-tx").getByRole("link").nth(1)).toHaveAttribute(
    "href",
    `https://testnet.steexp.com/tx/${"7a".repeat(32)}`,
  );
  await expect(v.getByTestId("vn-explorers-account").getByRole("link").first()).toHaveAttribute(
    "href",
    /^https:\/\/stellar\.expert\/explorer\/testnet\/account\/G[A-Z2-7]{55}$/,
  );
  await expect(page).toHaveURL(/\/p\/stellar-docs$/); // never leaves the page
  await expectAccessible(page, "verify this number");

  // The transaction on Stellar (on request): Horizon answers with the day's root as MEMO_HASH.
  const proof = (await (await page.request.get(`/public/v1/snapshots/${SNAP2}/seal`)).json()) as {
    proofs: { root: string; source_account: string; ledger: number }[];
  };
  const p = proof.proofs[0] as { root: string; source_account: string; ledger: number };
  await page.route(`${HORIZON}/**`, (route) =>
    route.fulfill({
      json: {
        successful: true,
        source_account: p.source_account,
        memo_type: "hash",
        memo: Buffer.from(p.root, "hex").toString("base64"),
        ledger: p.ledger,
      },
    }),
  );
  await v.getByRole("button", { name: "Check the transaction on Stellar" }).click();
  await expect(v.getByTestId("vn-lookup")).toContainText("Found on Stellar");

  // The badges served by UsageMap are offered for a public project.
  await page.getByText("Live badges (updated hourly)").click();
  await expect(page.getByTestId("server-badge-shields")).toContainText(
    "img.shields.io/endpoint?url=",
  );
});

test("tamper: a changed figure fails the signature; a forged operator log fails the seal check", async ({
  page,
}) => {
  await makePublic(page);
  await page.route(`**/public/v1/snapshots/${SNAP2}`, async (route) => {
    const res = await route.fetch();
    const doc = (await res.json()) as { snapshot: { web: { verified: { visitors_sum: number } } } };
    doc.snapshot.web.verified.visitors_sum *= 10;
    await route.fulfill({ json: doc });
  });
  await page.goto("/p/stellar-docs");
  const v = page.getByTestId("verify-number-visitors");
  await v.getByRole("button", { name: "Verify this number" }).click();
  await expect(v.getByTestId("vn-signature")).toHaveClass("fail");
  await expect(v.getByTestId("verify-number-verdict")).toContainText("cannot be verified");

  await page.unroute(`**/public/v1/snapshots/${SNAP2}`);
  await forgeAnchors(page);
  await page.reload();
  const w = page.getByTestId("verify-number-visitors");
  await w.getByRole("button", { name: "Verify this number" }).click();
  await expect(w.getByTestId("vn-signature")).toHaveClass("pass");
  await expect(w.getByTestId("vn-operator-log")).toHaveClass("fail");
  await expect(w.getByTestId("vn-operator-log")).toContainText("changed after sealing");
  await expect(w.getByTestId("verify-number-verdict")).toContainText("cannot be verified");
});

test("tamper: a forged inclusion path is caught", async ({ page }) => {
  await makePublic(page);
  await page.route(`**/public/v1/snapshots/${SNAP2}/seal`, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { proofs: { audit_path: string[] }[] };
    (body.proofs[0] as { audit_path: string[] }).audit_path[0] = "cd".repeat(32);
    await route.fulfill({ json: body });
  });
  await page.goto("/p/stellar-docs");
  const v = page.getByTestId("verify-number-visitors");
  await v.getByRole("button", { name: "Verify this number" }).click();
  await expect(v.getByTestId("vn-inclusion")).toHaveClass("fail");
  await expect(v.getByTestId("verify-number-verdict")).toContainText("cannot be verified");
});

test("snapshot verify page: the operator actions log is sealed; a forged one is caught", async ({
  page,
}) => {
  await page.goto(`/verify/${SNAP2}`);
  const seal = page.getByTestId("seal-testnet");
  await expect(seal.getByTestId("seal-check-operator-log")).toHaveClass("pass");
  await expect(seal.getByTestId("seal-check-operator-log")).toContainText(
    "Operator actions log: sealed",
  );
  await expect(seal.getByTestId("seal-plain")).toContainText(
    "sealed on Stellar testnet in ledger 1,200",
  );
  await forgeAnchors(page);
  await page.reload();
  await expect(page.getByTestId("seal-testnet").getByTestId("seal-check-operator-log")).toHaveClass(
    "fail",
  );
});
