// SPDX-License-Identifier: Apache-2.0
// Explorer deep links (lib/explorers.ts, components/ExplorerLinks.tsx): the verified URL formats of StellarExpert,
// Stellar Lab (contracts only) and steexp on mainnet and testnet; nothing for a malformed id, a muxed or secret key, a
// network no public explorer serves; links never carry a referrer.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExplorerLinks } from "../../src/components/ExplorerLinks.tsx";
import { explorerLinks, explorerNetwork } from "../../src/lib/explorers.ts";

const TX = "7a".repeat(32);
const ACCOUNT = `G${"A".repeat(55)}`;
const CONTRACT = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";

describe("explorerLinks", () => {
  it("builds the verified formats per kind and network", () => {
    expect(explorerLinks("tx", TX, "testnet").map((l) => l.href)).toEqual([
      `https://stellar.expert/explorer/testnet/tx/${TX}`,
      `https://testnet.steexp.com/tx/${TX}`,
    ]);
    expect(explorerLinks("account", ACCOUNT, "mainnet").map((l) => l.href)).toEqual([
      `https://stellar.expert/explorer/public/account/${ACCOUNT}`,
      `https://steexp.com/account/${ACCOUNT}`,
    ]);
    expect(explorerLinks("contract", CONTRACT, "public").map((l) => l.href)).toEqual([
      `https://stellar.expert/explorer/public/contract/${CONTRACT}`,
      `https://lab.stellar.org/r/mainnet/contract/${CONTRACT}`,
      `https://steexp.com/contract/${CONTRACT}`,
    ]);
    expect(explorerLinks("contract", CONTRACT, "testnet")[1]?.href).toBe(
      `https://lab.stellar.org/r/testnet/contract/${CONTRACT}`,
    );
    expect(explorerLinks("tx", TX.toUpperCase(), "testnet")[0]?.href).toContain(`/tx/${TX}`);
  });
  it("gives nothing for a malformed id or a network without a public explorer", () => {
    for (const [kind, id, net] of [
      ["tx", "7a".repeat(31), "testnet"],
      ["tx", `${TX}/../x`, "testnet"],
      ["account", `S${"A".repeat(55)}`, "mainnet"], // a secret seed is never linked
      ["account", `M${"A".repeat(68)}`, "mainnet"], // muxed (end-user) addresses are not public chain objects here
      ["account", CONTRACT, "mainnet"],
      ["contract", ACCOUNT, "mainnet"],
      ["contract", `${CONTRACT}?a=1`, "mainnet"],
      ["contract", CONTRACT, "futurenet"],
      ["contract", CONTRACT, "standalone"],
      ["contract", CONTRACT, null],
    ] as const)
      expect(explorerLinks(kind, id, net), `${kind} ${id} ${net}`).toEqual([]);
    expect(explorerNetwork("pubnet")).toBe("mainnet");
  });
});

describe("ExplorerLinks", () => {
  it("renders new-tab links without a referrer, and nothing for an unsupported object", () => {
    const html = renderToStaticMarkup(
      <ExplorerLinks kind="contract" id={CONTRACT} network="mainnet" />,
    );
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain(">Stellar Lab<");
    expect(renderToStaticMarkup(<ExplorerLinks kind="tx" id={null} network="mainnet" />)).toBe("");
    expect(renderToStaticMarkup(<ExplorerLinks kind="tx" id={TX} network="local" />)).toBe("");
  });
});
