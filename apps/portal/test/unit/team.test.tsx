// @vitest-environment happy-dom
// SPDX-License-Identifier: Apache-2.0
// docs.quickstarts-run portal screens: the Stellar proof flow (SEP-53 and SEP-10) shared by sign-in and the L2 link, the wallet
// adapter's SEP-10 path, the SEP-10 transaction codec of the mock control plane, and the team/verification texts.
import { generateKeyPairSync } from "node:crypto";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChallenge, parseEnvelope, signChallenge, signedBy } from "../../e2e/support/sep10.ts";
import { OPERATIONS } from "../../src/api/client.ts";
import { StellarProof } from "../../src/auth/components.tsx";
import { freighterAdapter, normaliseXdr } from "../../src/auth/wallet.ts";
import {
  ASSIGNABLE_ROLES,
  canManage,
  INVITATION_CODE_RE,
  ROLE_TEXT,
} from "../../src/pages/Team.tsx";
import { EVIDENCE_KIND_TEXT, LEVEL_TEXT, NEXT_STEP_TEXT } from "../../src/pages/Trust.tsx";

afterEach(cleanup);

const ACCOUNT = `G${"A".repeat(55)}`;
const XDR = Buffer.alloc(180, 7).toString("base64");

describe("SEP-10 in the wallet adapter", () => {
  it("normalises pasted XDR and refuses what is not a base64 envelope", () => {
    expect(normaliseXdr(` ${XDR.slice(0, 60)}\n${XDR.slice(60)} `)).toBe(XDR);
    expect(() => normaliseXdr("AAAA")).toThrow(/whole envelope/);
    expect(() => normaliseXdr(`${XDR}!`)).toThrow();
  });

  it("asks Freighter to sign the transaction for the account on the given network and checks the signer", async () => {
    const api = {
      isConnected: vi.fn(async () => ({ isConnected: true })),
      requestAccess: vi.fn(async () => ({ address: ACCOUNT })),
      signMessage: vi.fn(),
      signTransaction: vi.fn(async () => ({ signedTxXdr: XDR, signerAddress: ACCOUNT })),
    };
    const w = freighterAdapter(api as never);
    expect(await w.signTransaction?.("challenge", ACCOUNT, "pp")).toBe(XDR);
    expect(api.signTransaction).toHaveBeenCalledWith("challenge", {
      address: ACCOUNT,
      networkPassphrase: "pp",
    });
    api.signTransaction.mockResolvedValueOnce({
      signedTxXdr: XDR,
      signerAddress: `G${"B".repeat(55)}`,
    });
    await expect(w.signTransaction?.("c", ACCOUNT, "pp")).rejects.toThrow(/different account/);
    api.signTransaction.mockResolvedValueOnce({
      signedTxXdr: "",
      signerAddress: "",
      error: { message: "User declined" },
    } as never);
    await expect(w.signTransaction?.("c", ACCOUNT, "pp")).rejects.toThrow("User declined");
  });
});

describe("StellarProof", () => {
  const challenge = (method: "sep53" | "sep10") =>
    method === "sep10"
      ? {
          challenge_id: "11111111-1111-4111-8111-111111111111",
          method,
          transaction_xdr: XDR,
          network_passphrase: "Test SDF Network ; September 2015",
          expires_at: "2026-11-14T00:15:00Z",
        }
      : {
          challenge_id: "22222222-2222-4222-8222-222222222222",
          method,
          message: "x wants you to sign in\nNetwork: testnet",
          network_passphrase: "Test SDF Network ; September 2015",
          expires_at: "2026-11-14T00:10:00Z",
        };

  it("SEP-10: requests a transaction for the account and sends the pasted signed envelope", async () => {
    const requestChallenge = vi.fn(async (_a: string, m: "sep53" | "sep10") => challenge(m));
    const submit = vi.fn(async () => undefined);
    render(
      <StellarProof
        requestChallenge={requestChallenge as never}
        submit={submit}
        submitLabel="Link account"
        walletLabel="Link with"
      />,
    );
    fireEvent.click(screen.getByLabelText(/Sign a challenge transaction \(SEP-10\)/));
    fireEvent.change(screen.getByLabelText("Stellar account"), { target: { value: ACCOUNT } });
    fireEvent.click(screen.getByRole("button", { name: "Get transaction to sign" }));
    await screen.findByTestId("sep10-xdr");
    expect(requestChallenge).toHaveBeenCalledWith(ACCOUNT, "sep10");
    expect(screen.getByTestId("sep10-xdr").textContent).toBe(XDR);
    expect(screen.getByText(/Test SDF Network ; September 2015/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Signed transaction (base64 XDR)"), {
      target: { value: `${XDR}\n` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        {
          challenge_id: "11111111-1111-4111-8111-111111111111",
          signed_transaction_xdr: XDR,
        },
        ACCOUNT,
      ),
    );
    // single use: back at the account step
    await screen.findByRole("button", { name: "Get transaction to sign" });
  });

  it("SEP-53 stays the default and sends a normalised signature; bad input is explained", async () => {
    const requestChallenge = vi.fn(async (_a: string, m: "sep53" | "sep10") => challenge(m));
    const submit = vi.fn(async () => undefined);
    render(
      <StellarProof
        requestChallenge={requestChallenge as never}
        submit={submit}
        submitLabel="Sign in"
        walletLabel="Sign in with"
      />,
    );
    fireEvent.change(screen.getByLabelText("Stellar account"), { target: { value: "GBAD" } });
    fireEvent.click(screen.getByRole("button", { name: "Get message to sign" }));
    expect((await screen.findByRole("alert")).textContent).toContain("starts with G");
    fireEvent.change(screen.getByLabelText("Stellar account"), { target: { value: ACCOUNT } });
    fireEvent.click(screen.getByRole("button", { name: "Get message to sign" }));
    await screen.findByTestId("sep53-message");
    expect(requestChallenge).toHaveBeenCalledWith(ACCOUNT, "sep53");
    const hex = "ab".repeat(64);
    fireEvent.change(screen.getByLabelText("Signature (base64 or hex)"), {
      target: { value: hex },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        {
          challenge_id: "22222222-2222-4222-8222-222222222222",
          signature: Buffer.from(hex, "hex").toString("base64"),
        },
        ACCOUNT,
      ),
    );
  });

  it("shows the service's refusal and keeps the step so the person can start again", async () => {
    const submit = vi.fn(async () => {
      throw new Error("the account has no home_domain");
    });
    render(
      <StellarProof
        requestChallenge={(async () => challenge("sep53")) as never}
        submit={submit}
        submitLabel="Link account"
        walletLabel="Link with"
      />,
    );
    fireEvent.change(screen.getByLabelText("Stellar account"), { target: { value: ACCOUNT } });
    fireEvent.click(screen.getByRole("button", { name: "Get message to sign" }));
    await screen.findByTestId("sep53-message");
    fireEvent.change(screen.getByLabelText("Signature (base64 or hex)"), {
      target: { value: "ab".repeat(64) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no home_domain");
    fireEvent.click(screen.getByRole("button", { name: "Use another account" }));
    expect(screen.getByRole("button", { name: "Get message to sign" })).toBeTruthy();
  });
});

describe("SEP-10 challenge codec (mock control plane and test wallet)", () => {
  const server = generateKeyPairSync("ed25519");
  const client = generateKeyPairSync("ed25519");
  const raw = (k: typeof server) =>
    Buffer.from((k.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const pp = "Test SDF Network ; September 2015";
  const c = buildChallenge({
    serverPub: raw(server),
    serverKey: server.privateKey,
    clientPub: raw(client),
    homeDomain: "localhost",
    passphrase: pp,
    nowS: 1_800_000_000,
    ttlS: 900,
  });

  it("a challenge carries only the server's signature; the client's signature is appended", () => {
    expect(parseEnvelope(c.xdr, c.tx.length).sigs).toHaveLength(1);
    expect(signedBy(c.xdr, c.tx, client.publicKey, pp)).toBe(false);
    const signed = signChallenge(c.xdr, client.privateKey, raw(client), pp);
    expect(parseEnvelope(signed, c.tx.length).sigs).toHaveLength(2);
    expect(signedBy(signed, c.tx, client.publicKey, pp)).toBe(true);
    expect(signedBy(signed, c.tx, server.publicKey, pp)).toBe(true);
  });

  it("another network, another key or a changed transaction does not verify", () => {
    const signed = signChallenge(c.xdr, client.privateKey, raw(client), pp);
    expect(
      signedBy(signed, c.tx, client.publicKey, "Public Global Stellar Network ; September 2015"),
    ).toBe(false);
    const other = generateKeyPairSync("ed25519");
    expect(
      signedBy(signChallenge(c.xdr, other.privateKey, raw(other), pp), c.tx, client.publicKey, pp),
    ).toBe(false);
    const b = Buffer.from(signed, "base64");
    b[20] = (b[20] as number) ^ 1;
    expect(signedBy(b.toString("base64"), c.tx, client.publicKey, pp)).toBe(false);
    expect(() => signChallenge(signed, client.privateKey, raw(client), pp)).toThrow(/exactly/);
  });
});

describe("team and verification texts", () => {
  it("only owners and admins manage; the owner role is never assignable", () => {
    expect(["owner", "admin", "member", "viewer"].map((r) => canManage(r as never))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(canManage(undefined)).toBe(false);
    expect(ASSIGNABLE_ROLES).toEqual(["admin", "member", "viewer"]);
    expect(Object.keys(ROLE_TEXT)).toEqual(["owner", "admin", "member", "viewer"]);
  });

  it("invitation codes have the contract's shape", () => {
    expect(INVITATION_CODE_RE.test(`scfi_${"a1B2".repeat(5)}xy`)).toBe(true);
    expect(INVITATION_CODE_RE.test(`scfi_${"a".repeat(21)}`)).toBe(false);
    expect(INVITATION_CODE_RE.test(`scfa_${"a".repeat(22)}`)).toBe(false);
  });

  it("every level, next step and evidence kind of the contract has a text", () => {
    expect(Object.keys(LEVEL_TEXT)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
    expect(Object.keys(NEXT_STEP_TEXT).sort()).toEqual([
      "await_operator_approval",
      "await_registry_match",
      "link_stellar_account",
      "verify_domain",
    ]);
    expect(Object.keys(EVIDENCE_KIND_TEXT).sort()).toEqual([
      "domain",
      "operator_approval",
      "registry_match",
      "stellar_account",
    ]);
  });

  it("the client knows the member, invitation and verification operations", () => {
    expect(OPERATIONS.acceptInvitation).toEqual({ method: "post", path: "/v1/invitations/accept" });
    expect(OPERATIONS.verificationStellarVerify.path).toBe(
      "/v1/tenants/{tenantId}/verification/stellar/verify",
    );
    expect(OPERATIONS.revokeInvitation.method).toBe("delete");
  });
});
