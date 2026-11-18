# Web: consent-gated mode

**Status (docs.quickstarts-run): checked against the code and the tracker's end-to-end fixtures.** Checked against `tracker/README.md` §"Consent-gated mode", the portal's `consent_html`
snippet (`services/control-plane/src/lifecycle/handlers.ts`) and `tracker/e2e/privacy.spec.ts` (nothing — not even
the challenge request — is sent before `grantConsent()`; sending stops on `revokeConsent()`). Decision: C-55.

Use it wherever your visitors' opt-in is required. `docs/privacy/jurisdictions.md` is the authoritative list (C-41);
for the `standard` profile that includes Germany and Belgium. This is not legal advice; the privacy pack is marked
"needs counsel review".

## Script tag

```html
<script>
  // Calls made before the tracker has loaded are queued and replayed in order.
  window.scf = window.scf || [];
</script>
<script
  src="https://ingest-a.example-analytics.org/lib/1.2.0/standard.js"
  integrity="sha384-…from the portal snippet…"
  crossorigin="anonymous"
  data-site="YOUR_22_CHAR_SITE_KEY"
  data-consent="required"
  defer
></script>
<script>
  // Call these from your consent tool. Nothing is sent before grantConsent().
  function onAnalyticsConsentGiven() {
    Array.isArray(window.scf) ? window.scf.push(["grantConsent"]) : window.scf.grantConsent();
  }
  function onAnalyticsConsentWithdrawn() {
    Array.isArray(window.scf) ? window.scf.push(["revokeConsent"]) : window.scf.revokeConsent();
  }
</script>
```

## npm

```ts
import { init } from "@usagemap/tracker";
const scf = init({ site: "YOUR_22_CHAR_SITE_KEY", consent: "required" });
// from your consent tool:
scf?.grantConsent();   // the current page view is counted now
scf?.revokeConsent();  // stops sending
```

## Behaviour to rely on

- On `grantConsent()` the current page view is counted.
- Consent is held **in memory only**. Your consent tool keeps its own record and must call `grantConsent()` again on
  every page load.
- `track()` calls made before consent are **dropped, not queued** (C-100).
- Global Privacy Control, Do Not Track and the visitor's own `optOut()` still win: with any of them nothing is sent,
  consent or not.
- The tracker itself sets no cookie and writes no storage except the visitor's opt-out flag (`localStorage`
  `scf_optout`), so consent mode does not add a storage access of its own.
