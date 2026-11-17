// SPDX-License-Identifier: Apache-2.0
// UsageMap UI kit: icons, buttons, form fields, cards, chips, status badges, page header, notes. Presentation only;
// no data fetching. Classes live in ./ui.css (prefix `um-`). See ./README.md.

import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  cloneElement,
  type ReactElement,
  type ReactNode,
  useId,
} from "react";
import { ICON_PATHS, type IconName } from "./iconPaths.tsx";

export type { IconName };

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export { cx };

/** A stroke icon. Decorative by default (aria-hidden); pass `label` when the icon alone carries meaning. */
export function Icon({
  name,
  size,
  className,
  label,
}: {
  name: IconName;
  size?: "xs" | "sm" | "md" | "lg" | undefined;
  className?: string | undefined;
  label?: string | undefined;
}) {
  const cls = cx("um-ic", size && size !== "md" && `um-ic--${size}`, className);
  if (label)
    return (
      <svg className={cls} viewBox="0 0 24 24" role="img" aria-label={label}>
        {ICON_PATHS[name]}
      </svg>
    );
  return (
    <svg className={cls} viewBox="0 0 24 24" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

// ---------- buttons ----------

export type ButtonVariant = "primary" | "secondary" | "highlight" | "ghost" | "danger";

/** Class string for anything that should look like a button (e.g. a router <Link>). */
export function buttonClass(
  variant: ButtonVariant = "secondary",
  opts: { size?: "sm" | "md" | undefined; block?: boolean | undefined } = {},
): string {
  return cx(
    "um-btn",
    `um-btn--${variant}`,
    opts.size === "sm" && "um-btn--sm",
    opts.block && "um-btn--block",
  );
}

type ButtonOwn = {
  variant?: ButtonVariant | undefined;
  size?: "sm" | "md" | undefined;
  block?: boolean | undefined;
  icon?: IconName | undefined;
  iconAfter?: IconName | undefined;
};

export function Button({
  variant = "secondary",
  size,
  block,
  icon,
  iconAfter,
  className,
  children,
  type = "button",
  ...rest
}: ButtonOwn & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={cx(buttonClass(variant, { size, block }), className)} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
      {iconAfter ? <Icon name={iconAfter} /> : null}
    </button>
  );
}

/** An external or plain link styled as a button (use buttonClass() on router <Link>s). */
export function ButtonAnchor({
  variant = "secondary",
  size,
  block,
  icon,
  iconAfter,
  className,
  children,
  ...rest
}: ButtonOwn & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a className={cx(buttonClass(variant, { size, block }), className)} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
      {iconAfter ? <Icon name={iconAfter} /> : null}
    </a>
  );
}

// ---------- form fields ----------

/**
 * Label + control + hint/error, wired with ids. The child is one control element (use className="um-inp"); Field
 * adds id, aria-describedby and aria-invalid.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode | undefined;
  error?: ReactNode | undefined;
  children: ReactElement<Record<string, unknown>>;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="um-fld">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        "aria-describedby": describedBy,
        ...(error ? { "aria-invalid": true } : {}),
      })}
      {hint ? (
        <small id={hintId} className="um-fld-hint">
          {hint}
        </small>
      ) : null}
      {error ? (
        <small id={errId} className="um-fld-err">
          {error}
        </small>
      ) : null}
    </div>
  );
}

// ---------- cards ----------

export type Tone = "web" | "api" | "chain" | "wallet" | "neutral";

/**
 * A white card. `tone` adds the straight full-width 3px accent bar in the source colour (web green, API orange,
 * on-chain yellow, wallets ink). With a `title` the card is a labelled <section>.
 */
export function Card({
  title,
  sub,
  icon,
  actions,
  tone,
  flush,
  className,
  children,
  headingLevel = 2,
  ...rest
}: {
  title?: ReactNode | undefined;
  sub?: ReactNode | undefined;
  icon?: IconName | undefined;
  actions?: ReactNode | undefined;
  tone?: Tone | undefined;
  /** no padding: for tables that run edge to edge (the header keeps its padding) */
  flush?: boolean | undefined;
  className?: string | undefined;
  children?: ReactNode | undefined;
  headingLevel?: 2 | 3 | undefined;
  "data-testid"?: string | undefined;
}) {
  const id = useId();
  const H = headingLevel === 3 ? "h3" : "h2";
  return (
    <section
      className={cx(
        "um-card",
        tone && `um-card--bar um-tone-${tone}`,
        flush && "um-card--flush",
        className,
      )}
      aria-labelledby={title ? id : undefined}
      {...rest}
    >
      {title ? (
        <div className="um-card-h">
          <div className="um-card-title">
            {icon ? (
              <span className="um-tile">
                <Icon name={icon} />
              </span>
            ) : null}
            <div>
              <H id={id} className={headingLevel === 3 ? "um-h3" : "um-h2"}>
                {title}
              </H>
              {sub ? <p className="um-card-sub">{sub}</p> : null}
            </div>
          </div>
          {actions ? <div className="um-ph-act">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Square icon tile in a source tone (34px; `sm` 26px, `lg` 42px). */
export function Tile({
  icon,
  tone = "neutral",
  size,
}: {
  icon: IconName;
  tone?: Tone | undefined;
  size?: "sm" | "lg" | undefined;
}) {
  return (
    <span className={cx("um-tile", `um-tone-${tone}`, size && `um-tile--${size}`)}>
      <Icon name={icon} />
    </span>
  );
}

// ---------- page header ----------

export function PageHeader({
  title,
  sub,
  badges,
  actions,
}: {
  title: ReactNode;
  sub?: ReactNode | undefined;
  /** chips next to the title */
  badges?: ReactNode | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <header className="um-ph">
      <div className="um-ph-t">
        <div className="um-ph-row">
          <h1 className="um-h1">{title}</h1>
          {badges}
        </div>
        {sub ? <p className="um-ph-sub">{sub}</p> : null}
      </div>
      {actions ? <div className="um-ph-act">{actions}</div> : null}
    </header>
  );
}

// ---------- chips and badges ----------

const CHECK = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M2.5 6.2l2.2 2.2 4.8-4.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const DOT = (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="6" r="3.2" fill="currentColor" />
  </svg>
);
const PERSON = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="6" cy="4.2" r="2" />
    <path d="M2.5 10.5c.6-2 2-3 3.5-3s2.9 1 3.5 3" />
  </svg>
);
const FUNNEL = (
  <svg
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M2 3h8M3.5 6h5M5 9h2" />
  </svg>
);
const LOCK = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="2.5" y="5.5" width="7" height="5" rx="1" />
    <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
  </svg>
);
const DASH = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="M3 6h6" strokeLinecap="round" />
  </svg>
);

export type ProvenanceKind = "verified" | "ledger" | "filtered" | "self" | "none";

const CHIP: Record<ProvenanceKind, { cls: string; icon: ReactNode; label: string }> = {
  verified: { cls: "um-chip--verified", icon: CHECK, label: "Verified" },
  ledger: { cls: "um-chip--ledger", icon: DOT, label: "Ledger-checked" },
  filtered: { cls: "um-chip--filtered", icon: FUNNEL, label: "Filtered" },
  self: { cls: "um-chip--self", icon: PERSON, label: "Self-reported" },
  none: { cls: "um-chip--none", icon: DASH, label: "Not measured" },
};

/** Where a number comes from: verified (bot-filtered), ledger-checked, filtered (with a reason), self-reported, not measured. */
export function Chip({
  kind,
  children,
  title,
}: {
  kind: ProvenanceKind;
  children?: ReactNode | undefined;
  title?: string | undefined;
}) {
  const c = CHIP[kind];
  return (
    <span className={cx("um-chip", c.cls)} title={title}>
      {c.icon}
      {children ?? c.label}
    </span>
  );
}

/** The project top bar's privacy chip. */
export function PrivateChip({ children = "Private · only your team" }: { children?: ReactNode }) {
  return (
    <span className="um-chip um-chip--private">
      {LOCK}
      <span className="um-chip-t">{children}</span>
    </span>
  );
}

export type StatusKind = "live" | "wait" | "set" | "off" | "gone" | "bad" | "run";

/** Small status pill with a dot: live, waiting/test, set up, off, removed, failing, running. */
export function StatusBadge({ status, children }: { status: StatusKind; children: ReactNode }) {
  return <span className={cx("um-st", `um-st--${status}`)}>{children}</span>;
}

/** Mono tag for keys, slugs, versions. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="um-tag">{children}</span>;
}

// ---------- notes ----------

export function Note({
  tone = "info",
  icon,
  children,
  role,
}: {
  tone?: "info" | "warn" | "good" | "bad" | undefined;
  icon?: IconName | undefined;
  children: ReactNode;
  role?: "status" | "alert" | undefined;
}) {
  const fallback: Record<string, IconName> = {
    info: "info",
    warn: "alert",
    good: "check",
    bad: "alert",
  };
  return (
    <div className={cx("um-note", tone !== "info" && `um-note--${tone}`)} role={role}>
      <Icon name={icon ?? fallback[tone] ?? "info"} />
      <div className="um-note-b">{children}</div>
    </div>
  );
}
