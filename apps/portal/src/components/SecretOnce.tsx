// SPDX-License-Identifier: Apache-2.0
// A secret the API returns exactly once (ingest token, SCF-operator API key; wire-formats §k). It lives only in this
// component's memory: never in the URL, storage, the query cache or a log; dismissing it forgets it for good.

import { useId } from "react";
import { CopyButton } from "./CopyButton.tsx";

export function SecretOnce({
  label,
  secret,
  onDismiss,
  children,
}: {
  label: string;
  secret: string;
  onDismiss: () => void;
  children?: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className="um-secret" aria-labelledby={`${id}-h`} data-testid="secret-once">
      <h3 id={`${id}-h`} className="um-h3">
        {label}
      </h3>
      <p>
        <strong>Copy it now: it is shown only once.</strong> We store only a hash; if you lose it,
        revoke it and create a new one.
      </p>
      <pre className="um-secret-v">
        <code data-testid="secret-value">{secret}</code>
      </pre>
      <CopyButton text={secret} label="Copy secret" />
      {children}
      <p>
        <button type="button" className="um-btn um-btn--primary um-btn--sm" onClick={onDismiss}>
          I have stored it — hide it
        </button>
      </p>
    </section>
  );
}
