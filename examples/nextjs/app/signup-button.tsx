// SPDX-License-Identifier: Apache-2.0
// app/signup-button.tsx — a custom event from any client component
"use client";
import { init } from "@usagemap/tracker";
import { SITE } from "./analytics";

export function SignupButton() {
  // init() returns the running tracker (it never starts a second one)
  const signUp = () => init({ site: SITE })?.track("signup", { plan: "free" });
  return (
    <button type="button" onClick={signUp}>
      Sign up
    </button>
  );
}
