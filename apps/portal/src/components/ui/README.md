# UsageMap UI kit (`src/components/ui/`)

The Ink & Yellow design system for the portal, built from the approved designs (sign-in, operator console, project
dashboard). Import from `src/components/ui/index.ts`, or from the individual files.

```tsx
import { Card, Chip, Kpi, PageHeader, QueryState, Segmented, TableScroll } from "../components/ui/index.ts";
import { TopBarSlot } from "../components/shell/TopBarSlot.tsx";
```

## Rules that apply to every page

- **CSP: no inline styles.** No `style=` attributes and no React `style` props. Every variant is a class. For a size
  that depends on data (bar lengths, chart geometry), use SVG attributes (`width`, `x`, `height` on `<rect>`) or a
  native `<meter>`/`<progress>`.
- **Light only, white surfaces, cool greys.** No cream, no beige, no blue. Native checkboxes and radios are ink
  (`accent-color`).
- **Never put a coloured one-sided edge on a rounded element.** That means no `border-left`/`border-top` colours, no
  inset shadows, no `::before` bars. Accent bars are only the full-width 3px bar of `Card tone=…` / `Kpi`.
- **Never invent a number.** Every widget that shows API data renders through `QueryState` (or `LoadingState`,
  `ErrorState`, `EmptyState`). A missing value is `Kpi value={null}`, which shows "Not measured".
- **Wording.** Tenants are "Stellar ecosystem projects" (the sign-in switch reads "Ecosystem project | SCF operator"). "SCF" appears only for SCF data ("SCF-awarded", "SCF round") and on
  the operator side ("SCF operator"). Plain, positive, developer-friendly. No "Example"/"Sample"/"Demo" labels.
- **Class prefix.** Everything is `um-`, and tokens are `--um-*` (in `ui.css`). Legacy classes in `src/styles.css`
  (`card`, `tabs`, `tile`, `alert`, …) belong to pages that have not moved yet. When your page moves, delete the
  legacy rules it no longer uses.

## Page layout inside the shell

The shell (`components/AppShell.tsx`) already renders the sidebar, the top bar and the scrolling content pane
`.um-main > .um-page`. The page pane is a flex column with an 18px gap. A page renders its content directly:

```tsx
<>
  <PageHeader title="Web" sub="Verified page views and visitors for the last 30 days." actions={<Button …/>} />
  <TopBarSlot><Segmented label="Date range" options={RANGES} value={range} onChange={setRange} /></TopBarSlot>
  <div className="um-grid um-g4">{/* Kpi × 4 */}</div>
  <Card title="Page views" tone="web">…</Card>
</>
```

- `TopBarSlot` (`components/shell/TopBarSlot.tsx`): its children appear on the right of the top bar (the range
  picker, an export button) and leave when the page unmounts. On phones the slot wraps to a second row and a
  `Segmented` stretches to the full width.
- Grids: `um-grid` plus `um-g2` / `um-g3` / `um-g4` / `um-g21` (2fr + 1fr). They collapse at 1100px and at 640px.
- In the operator shell the top bar shows "group · page" from `OPERATOR_PAGES` in `components/shell/nav.tsx`. Keep
  one `<h1>` per page (`PageHeader`).
- Navigation entries live in `components/shell/nav.tsx` (`ProjectNav`, `OperatorNav`, `OPERATOR_PAGES`). When you
  add a route, add its entry there.
- Every page sets its tab title with `useTitle("Web")` from `components/AppShell.tsx` (it renders "Web · UsageMap").

## Components

### basics.tsx

| Component | Props | Notes |
|---|---|---|
| `Icon` | `name: IconName`, `size?: "xs"\|"sm"\|"md"\|"lg"` (13/15/18/22px), `className?`, `label?` | Stroke icons from `iconPaths.tsx` (Lucide-style, ISC). Decorative unless `label` is given. Names: activity alert arrow back badge ban book bot branch cal chain check chev clock code coins columns copy cube device dna down download eraser eye eyeoff ext filecheck filter fingerprint freighter gear github globe hand home info key landmark layers left link list lock logout mail map menu network passkey pause pen phone plug plus pointer qr repeat ruler scale scripted search server share shield sparkle swap term trash undo up updown userplus users wallet x |
| `Button` | `variant?: "primary"\|"secondary"\|"highlight"\|"ghost"\|"danger"` (default secondary), `size?: "sm"`, `block?`, `icon?`, `iconAfter?`, plus all `<button>` props | `type="button"` by default. |
| `ButtonAnchor` | same as Button + `<a>` props | For plain/external links. |
| `buttonClass(variant, {size, block})` | — | Class string for router `<Link>`s: `<Link className={buttonClass("primary")} …>`. |
| `Field` | `label`, `hint?`, `error?`, `children` (one control) | Wires the id, `aria-describedby` and `aria-invalid`. Controls use `className="um-inp"` (`um-inp um-inp--mono` for keys and URLs; `<select>`/`<textarea>` too). |
| `Card` | `title?`, `sub?`, `icon?`, `actions?`, `tone?: Tone`, `flush?`, `headingLevel?: 2\|3`, `className?`, `data-testid?` | A white card. `tone` adds the straight 3px source bar: `web` green, `api` orange, `chain` yellow, `wallet` ink, `neutral` grey. `flush` removes the padding (for edge-to-edge tables; the header keeps it). Labelled `<section>` when titled. |
| `Tile` | `icon`, `tone?`, `size?: "sm"\|"lg"` | Square icon tile (34px; sm 26, lg 42). |
| `PageHeader` | `title`, `sub?`, `badges?`, `actions?` | The page's `<h1>` + one-line sub. |
| `Chip` | `kind: "verified"\|"ledger"\|"filtered"\|"self"\|"none"`, `children?` (label override), `title?` | Data provenance: Verified, Ledger-checked, Filtered (warn), Self-reported, Not measured. |
| `PrivateChip` | `children?` | "Private · only your team" (already in the project top bar). |
| `StatusBadge` | `status: "live"\|"wait"\|"set"\|"off"\|"gone"\|"bad"\|"run"`, `children` | Small pill with a dot: live/receiving, waiting/test, set up, off, removed, failing, running. `gone` text is #973f12 (darker than `--um-orange`) so it passes WCAG AA on the soft orange (operator console, 2026-11-20). |
| `Tag` | `children` | Mono tag for slugs, keys and versions. |
| `Note` | `tone?: "info"\|"warn"\|"good"\|"bad"`, `icon?`, `role?`, `children` | Inline note row. |
| `cx(...)` | — | Class joiner. |

### controls.tsx

| Component | Props | Notes |
|---|---|---|
| `Tabs` | `items: {id, label, icon?, count?}[]`, `value`, `onChange`, `label`, `idBase` | In-page tablist (arrow keys). Render each panel with `<div {...tabPanelProps(idBase, id)}>`. For tabs that are routes, use `<nav aria-label="…"><ul className="um-tabs"><li><Link …>`: the active link gets `aria-current="page"`, which the CSS draws. |
| `Segmented` | `options: {value, label, icon?}[]`, `value`, `onChange`, `label` (group name), `className?` | Toggle buttons with `aria-pressed`, e.g. the range picker 24h · 7d · 30d · 90d. |
| `TableScroll` | `label` (region name), `stickyFirst?`, `children` (a `<table className="um-table">`) | Horizontal scroll inside the card. A right-edge fade shows while columns are hidden. With `stickyFirst` the first column stays in place and gets a shadow once scrolled. Numeric cells: `className="um-r"`. Sortable headers: `<th aria-sort=…><button className="um-sort">`. Put it in `<Card flush>` for edge-to-edge tables. |
| `Kpi` | `label`, `value` (`null` = "Not measured"), `unit?`, `icon?`, `tone?`, `chip?`, `delta?: {text, direction: "up"\|"down"\|"flat", label?}`, `foot?`, `loading?`, `testId?` | Headline number tile with the source bar. `loading` shows a skeleton line. |

### states.tsx

| Component | Props | Notes |
|---|---|---|
| `QueryState<T>` | `query` (a TanStack Query result), `children: (data) => node`, `isEmpty?`, `empty?`, `loading?`, `plain?` | Loading → skeleton. Error → `ErrorState` with "Try again". Empty (default: empty array) → `empty`. Otherwise `children(data)`. |
| `LoadingState` | `label?`, `block?` (chart-sized block) | `role="status"`, skeleton lines. |
| `EmptyState` | `title`, `children?`, `icon?`, `action?`, `plain?` | Dashed frame; `plain` inside a card. |
| `ErrorState` | `error`, `onRetry?`, `plain?` | RFC 9457 problem: title, detail, hint, request id. A 403 becomes `AccessNotice kind="forbidden"`. |
| `AccessNotice` | `kind?: "read-only"\|"forbidden"`, `title?`, `children?` | Friendly notice for role limits (`data-testid="access-notice"`). |
| `isForbidden(error)` | — | True for a 403 that re-authentication cannot fix. False for step-up, recent-auth, CSRF and platform read-only refusals. |

`ProblemAlert` (`components/ProblemAlert.tsx`) shows mutation errors in the same style. A refused write (viewer role,
read-only operator) automatically shows `AccessNotice kind="read-only"`, so forms need no special code for 403s.

### viz.tsx (charts and data widgets, added by the project-pages build)

Styles in `viz.css` (imported by `viz.tsx`). Series colours are classes `um-c-<color>` (`web webmid weblight grey ink
ink2 yellow yellowdeep api apilight apipale bad warn line`); geometry is SVG attributes only (CSP-clean).

| Component | Props | Notes |
|---|---|---|
| `Chart` | `labels`, `series: {name, color, data: (number\|null)[], area?, dash?, thin?}[]`, `type?: "line"\|"bar"`, `stack?`, `height?`, `label` (accessible description), `format?`, `annotations?: {index, label}[]`, `max?`, `table?: {title, firstColumn, rows, format?}`, `testId?` | Drawn at the container width (`useWidth`). Hover shows the bucket inside the SVG. `null` points are gaps. `table` adds a "Show data table" text alternative. |
| `partialLast(times, unit)`, `isPartialBucket(iso, unit)` | bucket starts (ISO), `"hour"\|"day"\|"month"` | **Running bucket (today / this hour):** pass `<Chart partial={partialLast(times, unit)} />` on every time chart, so the last point is dashed and faint with the label "Today (partial)" instead of a drop toward zero; `<Spark partial />` ends the line at the last complete bucket. |
| `Legend` | `items: {label, color, dash?, dot?}[]` | For a card's `actions`. |
| `Spark` | `values`, `color` | Decorative area sparkline (put the number next to it). |
| `BarList` | `rows: {key, label, value, share (0–100 or null), other?}[]`, `tone?`, `head?: [name, value]`, `label?` | Ranked rows with a share bar behind each (pages, referrers, protocols). |
| `ShareBar` | `parts: {label, share, color, value?}[]`, `label` | One split bar with its legend (status classes, verdicts). |
| `Funnel` | `steps: {key, name, code?, value (null = hidden), testId?, nullText?}[]`, `color?`, `dropWord?`, `label` | Bars with the share of the first step and of the previous one. |
| `Switch` | `checked`, `onChange`, `label`, `disabled?`, `onText?`, `offText?` | `role="switch"`. |
| `CopyText` | `text`, `label?`, `size?`, `variant?` | Copy button that says "Copied" for 2 s. |
| `CodeBlock` | `title`, `code`, `copyLabel?`, `testId?` (on the `<pre>`) | Dark code block with a title bar and copy. |
| `Steps` | `items`, `current` (1-based), `label`, `allDone?`, `onSelect?` | Step indicator (done ✓, current, next); done steps are buttons when `onSelect` is set. |
| `SourceList` | `items: {key, icon, tone, title, sub?, status?}[]`, `label?` | "Your sources" / evidence lists. |
| `KeyValues` | `items: {k, v}[]` | Definition list. |
| `fmtCompact(n)`, `useWidth()` | — | 1.2k / 4.82M formatting; element width hook. |

`Kpi`'s `foot` renders in a `<div>`, so block content is allowed there.

Shared helpers outside the kit now use kit classes as well: `components/CopyButton.tsx` (`.um-copy`),
`components/SecretOnce.tsx` (`.um-secret`), `components/ConfirmDialog.tsx` (`<dialog class="um-dialog">`).

### Logo.tsx

`Logo` (`inverse?`, `label?`): the mark plus the wordmark (white with `inverse`, for ink backgrounds). `LogoMark`
(`className?`): the magnet mark alone.

## Shell pieces (`src/components/shell/`)

- `nav.tsx`: `ProjectNav`, `OperatorNav`, `NavLink` (a typed router link drawn as a sidebar item; props `icon`,
  `count?`), `OPERATOR_PAGES`, `useOperatorPage()`.
- `ProjectSwitcher.tsx`: the top-bar switcher (`data-testid="project-switcher"`), with `roleLabel()`.
- `TopBarSlot.tsx`: see above.
- Geometry and colours: `shell.css` (sidebar 236px project / 252px operator, top bar ≥59px, content padding 22px 28px
  48px; at ≤900px the sidebar is a drawer and the gutters are 16px).
