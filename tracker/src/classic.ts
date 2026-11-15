// SPDX-License-Identifier: Apache-2.0
// Classic-script entry: `<script src="…/lib/<semver>/<profile>.js" data-site="…" integrity="sha384-…"
// crossorigin="anonymous" defer></script>`. Configuration comes only from the tag's attributes (no remote config).
import { type Config, createTracker } from "./core.js";

const tag = document.currentScript;
const site = tag?.getAttribute("data-site");
if (tag && site) {
  const w = window as unknown as { scf?: unknown };
  const t = createTracker(
    // createTracker treats any value other than "required" as no consent gating.
    { site, consent: tag.getAttribute("data-consent") as Config["consent"] },
    w.scf,
  );
  if (t) w.scf = t;
}
