// SPDX-License-Identifier: Apache-2.0
// Modal confirmation for consequential actions: what will happen, an optional reason (recorded in the audit log by
// the API) and, for irreversible actions, typing a word to confirm. The confirmation is only the person's intent; the
// API still requires step-up / recent authentication (see auth/fresh.ts).

import { type ReactNode, useEffect, useId, useRef, useState } from "react";

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger = false,
  reason = false,
  typeToConfirm,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** ask for a reason (required, 3–500 characters) */
  reason?: boolean;
  /** irreversible actions: the person types this word */
  typeToConfirm?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const d = ref.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }, []);
  const reasonOk = !reason || text.trim().length >= 3;
  const typedOk = !typeToConfirm || typed.trim() === typeToConfirm;
  return (
    <dialog
      className="um-dialog"
      ref={ref}
      aria-labelledby={`${id}-t`}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
    >
      <form
        className="um-dialog-f"
        onSubmit={(e) => {
          e.preventDefault();
          if (reasonOk && typedOk) onConfirm(text.trim());
        }}
      >
        <h2 id={`${id}-t`} className="um-h2">
          {title}
        </h2>
        <div className="um-dialog-b">{children}</div>
        {reason ? (
          <div className="um-fld">
            <label htmlFor={`${id}-r`}>Reason (recorded in the audit log)</label>
            <textarea
              className="um-inp"
              id={`${id}-r`}
              required
              minLength={3}
              maxLength={500}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        ) : null}
        {typeToConfirm ? (
          <div className="um-fld">
            <label htmlFor={`${id}-c`}>
              Type <code>{typeToConfirm}</code> to confirm
            </label>
            <input
              className="um-inp um-inp--mono"
              id={`${id}-c`}
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
          </div>
        ) : null}
        <div className="um-dialog-act">
          <button type="button" className="um-btn um-btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className={danger ? "um-btn um-btn--danger" : "um-btn um-btn--primary"}
            disabled={busy || !reasonOk || !typedOk}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
