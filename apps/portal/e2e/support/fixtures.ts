// SPDX-License-Identifier: Apache-2.0
// Shared Playwright fixtures: every page is watched for Content-Security-Policy and Trusted Types violations and for
// uncaught errors — any of them fails the test (hardening.md §10: "CI loads every route under the production CSP and
// fails on violations"); `expectAccessible` runs axe-core (WCAG 2.1 A/AA rules).

import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test as base, type CDPSession, expect, type Page } from "@playwright/test";
import { MOCK_PASSPHRASE } from "./mock-team.ts";
import { signChallenge } from "./sep10.ts";

declare global {
  interface Window {
    __scfViolations?: string[];
  }
}

export const test = base.extend<{ violations: string[] }>({
  violations: [
    async ({ page }, use) => {
      const found: string[] = [];
      await page.addInitScript(() => {
        window.__scfViolations = [];
        document.addEventListener("securitypolicyviolation", (e) => {
          window.__scfViolations?.push(
            `${e.violatedDirective} blocked ${e.blockedURI || "inline"}`,
          );
        });
      });
      page.on("console", (m) => {
        const t = m.text();
        if (/Content Security Policy|Trusted Type|TrustedHTML|TrustedScript|Refused to/i.test(t))
          found.push(`console: ${t}`);
      });
      page.on("pageerror", (e) => found.push(`pageerror: ${e.message}`));
      await use(found);
      for (const p of page.context().pages()) {
        try {
          const v = await p.evaluate(() => window.__scfViolations ?? []);
          found.push(...v);
        } catch {
          // page closed or navigated away from our origin
        }
      }
      expect(found, "CSP / Trusted Types violations or page errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function expectAccessible(page: Page, label: string): Promise<void> {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const issues = r.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join("; ")})`,
  );
  expect(issues, `accessibility violations on ${label}`).toEqual([]);
}

// --- Stellar test wallet: a real Ed25519 key in the test process, signing SEP-53 messages ---

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function strKey(pub: Buffer): string {
  const body = Buffer.concat([Buffer.from([6 << 3]), pub]);
  const c = Buffer.alloc(2);
  c.writeUInt16LE(crc16(body));
  const all = Buffer.concat([body, c]);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of all) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export class TestWallet {
  readonly account: string;
  readonly #key: KeyObject;
  readonly #pub: Buffer;
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    this.#pub = Buffer.from(jwk.x, "base64url");
    this.account = strKey(this.#pub);
    this.#key = privateKey;
  }
  /** SEP-10: adds this account's signature to a server-signed challenge transaction (base64 XDR). */
  signSep10(xdr: string, passphrase = MOCK_PASSPHRASE): string {
    return signChallenge(xdr, this.#key, this.#pub, passphrase);
  }
  /** SEP-53: Ed25519 over SHA-256("Stellar Signed Message:\n" ‖ message), base64. */
  signMessage(message: string): string {
    const digest = createHash("sha256")
      .update(`Stellar Signed Message:\n${message}`, "utf8")
      .digest();
    return sign(null, digest, this.#key).toString("base64");
  }
}

/** On the sign-in page the Stellar form sits behind the "Freighter" method; elsewhere it is inline (no-op there). */
export async function openStellarForm(page: Page, scope = page.locator("body")): Promise<void> {
  const account = scope.getByLabel("Stellar account");
  const freighter = scope.getByRole("button", { name: /^Freighter/ });
  // Wait until one of the two has rendered: right after a navigation (e.g. /tenants → client-side redirect to
  // /signin) neither exists yet, and checking at that moment would skip the method choice.
  await expect(account.or(freighter).first()).toBeVisible();
  if ((await account.count()) > 0) return;
  if (await freighter.first().isEnabled()) {
    await freighter.first().click();
    return;
  }
  // Project mode lists Freighter as "Soon"; the wallet form stays reachable at /signin?method=wallet.
  const url = new URL(page.url());
  url.searchParams.set("method", "wallet");
  await page.goto(url.toString());
  await expect(account).toBeVisible();
}

/** Signs in through the "any wallet" path: account → message → signature pasted, like a person would. */
export async function signInWithWallet(
  page: Page,
  wallet: TestWallet,
  scope = page.locator("body"),
): Promise<void> {
  await openStellarForm(page, scope);
  await scope.getByLabel("Stellar account").fill(wallet.account);
  await scope.getByRole("button", { name: "Get message to sign" }).click();
  const message = await scope.getByTestId("sep53-message").textContent();
  if (!message) throw new Error("no SEP-53 message shown");
  await scope.getByLabel("Signature (base64 or hex)").fill(wallet.signMessage(message));
  await scope.getByRole("button", { name: /^(Sign in|Confirm)$/ }).click();
}

/** A CTAP2 platform authenticator with user verification, through Chromium's WebAuthn domain. */
export async function addVirtualAuthenticator(
  page: Page,
  transport: "internal" | "usb" = "internal",
): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}

/**
 * C-20: the operator console opens only with two live passkeys. Registers the second one on a
 * second virtual authenticator (a USB security key; the first one holds an excluded credential), from the console's own prompt.
 */
export async function registerSecondOperatorPasskey(page: Page): Promise<void> {
  // Only once the sign-in is complete: a navigation while the passkey step is still verifying lands back on it.
  await expect(page).not.toHaveURL(/\/signin(\/|\?|$)/);
  await page.goto("/operator");
  const prompt = page.getByTestId("second-passkey");
  await expect(prompt).toBeVisible();
  // Chrome allows one internal authenticator per environment: the second device is a security key.
  await addVirtualAuthenticator(page, "usb");
  await prompt.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page.getByTestId("operator-banner")).toBeVisible();
}
