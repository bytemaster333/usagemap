// SPDX-License-Identifier: Apache-2.0
// The operator console opens only with two live passkeys (C-20: one lost device must not lock an
// operator out). Shown by the app shell in place of the operator console while the signed-in operator has fewer.

import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PasskeyRegister } from "../../auth/components.tsx";
import { useTitle } from "../../components/AppShell.tsx";
import { buttonClass } from "../../components/ui/basics.tsx";
import { AuthFrame, PasskeyTrack } from "./AuthFrame.tsx";

export function SecondPasskeyScreen({ passkeys }: { passkeys: number }) {
  useTitle("Add a second passkey");
  const qc = useQueryClient();
  return (
    <AuthFrame mode="operator">
      <section className="um-auth-view" aria-labelledby="um-pk2" data-testid="second-passkey">
        <div className="um-auth-hd">
          <h1 id="um-pk2">Add a second passkey to open the operator console</h1>
          <p>Use a different device or security key, so losing one never locks you out.</p>
        </div>
        <PasskeyTrack count={passkeys} />
        <PasskeyRegister
          buttonLabel="Add a passkey"
          onDone={() => {
            void qc.invalidateQueries({ queryKey: ["me"] });
          }}
        />
        <p className="um-auth-note">The console opens as soon as both passkeys are registered.</p>
        <Link to="/tenants" className={buttonClass("ghost", { size: "sm" })}>
          Go to my projects instead
        </Link>
      </section>
    </AuthFrame>
  );
}
