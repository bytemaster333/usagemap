// SPDX-License-Identifier: Apache-2.0
// Copies text to the clipboard (Permissions-Policy allows clipboard-write for our origin only) and says so.

import { useState } from "react";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <span className="um-copy">
      <button
        type="button"
        className="um-btn um-btn--secondary um-btn--sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {label}
      </button>
      <span role="status" className="um-copy-st">
        {state === "copied"
          ? " Copied."
          : state === "failed"
            ? " Copy failed — select the text instead."
            : ""}
      </span>
    </span>
  );
}
