// SPDX-License-Identifier: Apache-2.0
// The top bar's right-hand slot (range picker, export button, …). A page renders <TopBarSlot>…</TopBarSlot> anywhere
// in its tree; the content appears in the shell's top bar and leaves with the page.

import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

export const TopBarSlotContext = createContext<HTMLElement | null>(null);

export function TopBarSlot({ children }: { children: ReactNode }) {
  const el = useContext(TopBarSlotContext);
  return el ? createPortal(children, el) : null;
}
