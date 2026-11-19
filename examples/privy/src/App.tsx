// SPDX-License-Identifier: Apache-2.0
import { useLogin, usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { privyLoginCallbacks, wrapPrivyStellar } from "@usagemap/tracker/privy";
import { useState } from "react";

const networkPassphrase = "Test SDF Network ; September 2015";

export function App() {
  const [log, setLog] = useState("");
  const [address, setAddress] = useState("");
  // UsageMap: the same hooks, wrapped; only calls with chainType "stellar" are counted
  const { createWallet } = wrapPrivyStellar(useCreateWallet(), { networkPassphrase });
  const { signRawHash } = wrapPrivyStellar(useSignRawHash(), { networkPassphrase });
  const { logout } = wrapPrivyStellar(usePrivy());
  const { login } = useLogin(
    privyLoginCallbacks({
      onComplete: () => setLog("login: ok"),
      onError: () => setLog("login: failed"),
    }),
  );

  const step = (name: string, f: () => Promise<unknown>) => async () => {
    try {
      await f();
      setLog(`${name}: ok`);
    } catch {
      setLog(`${name}: failed`);
    }
  };

  return (
    <main>
      <h1>Example: Privy embedded Stellar wallet</h1>
      <button type="button" onClick={() => login()}>
        Log in
      </button>{" "}
      <button
        type="button"
        onClick={step("create", async () => {
          const { wallet } = await createWallet({ chainType: "stellar" });
          setAddress(wallet.address);
        })}
      >
        Create Stellar wallet
      </button>{" "}
      <button
        type="button"
        disabled={!address}
        onClick={step("sign", () =>
          // in a real app: the hash of the transaction you built with js-stellar-sdk
          signRawHash({ address, chainType: "stellar", hash: `0x${"00".repeat(32)}` }),
        )}
      >
        Sign transaction hash
      </button>{" "}
      <button type="button" onClick={step("logout", () => logout())}>
        Log out
      </button>
      <p id="log">{log}</p>
    </main>
  );
}
