// SPDX-License-Identifier: Apache-2.0
import Link from "next/link";
import type { ReactNode } from "react";
import { Analytics } from "./analytics";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/">Home</Link> <Link href="/about">About</Link>
        </nav>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
