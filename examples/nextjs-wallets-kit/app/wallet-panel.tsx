// SPDX-License-Identifier: Apache-2.0
// app/wallet-panel.tsx — connect, sign a message, disconnect. Signing and disconnecting go through the method
// references wallet.ts copied at load (Scaffold Stellar's pattern). The analytics adapter observes these calls; this
// component knows nothing about analytics.
"use client";
import { useEffect, useState } from "react";
import { disconnectWallet, signMessage, startWallets } from "./wallet";

type Kit = ReturnType<typeof startWallets>;

export function WalletPanel() {
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState("");
  useEffect(() => {
    startWallets();
    setReady(true);
  }, []);

  const run = (name: string, f: (k: Kit) => Promise<unknown>) => async () => {
    try {
      await f(startWallets());
      setLog(`${name}: ok`);
    } catch {
      setLog(`${name}: failed`);
    }
  };

  return (
    <section>
      <p id="wallet-state">{connected ? "Wallet connected" : "No wallet connected"}</p>
      <button
        type="button"
        disabled={!ready}
        onClick={run("connect", async (k) => {
          await k.authModal();
          setConnected(true);
        })}
      >
        Connect wallet
      </button>{" "}
      <button
        type="button"
        disabled={!ready || !connected}
        onClick={run("sign", () => signMessage("Sign in to the example dApp"))}
      >
        Sign message
      </button>{" "}
      <button
        type="button"
        disabled={!ready || !connected}
        onClick={run("disconnect", async () => {
          await disconnectWallet();
          setConnected(false);
        })}
      >
        Disconnect
      </button>
      <p id="log">{log}</p>
    </section>
  );
}
