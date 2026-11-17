// SPDX-License-Identifier: Apache-2.0
// UsageMap UI kit: tabs, segmented control, scrolling table frame and the KPI tile. Classes in ./ui.css.

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Chip, cx, Icon, type IconName, type ProvenanceKind, type Tone } from "./basics.tsx";

// ---------- tabs ----------

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  icon?: IconName | undefined;
  count?: number | string | undefined;
}

/**
 * In-page tabs (WAI-ARIA tablist; arrow keys move between tabs). Render the panel yourself with
 * `<div role="tabpanel" {...tabPanelProps(id, value)}>`. For tabs that are routes, use
 * `<nav><ul className="um-tabs"><li><Link activeProps={{"aria-current":"page"}}>…` instead.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idBase,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  /** stable prefix for the tab/panel ids (tabPanelProps uses the same) */
  idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + items.length) % items.length;
    const next = items[n];
    if (!next) return;
    onChange(next.id);
    refs.current[n]?.focus();
  };
  return (
    <div className="um-tabs" role="tablist" aria-label={label}>
      {items.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.id}`}
          aria-controls={`${idBase}-panel-${t.id}`}
          aria-selected={t.id === value}
          tabIndex={t.id === value ? 0 : -1}
          className="um-tab"
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.icon ? <Icon name={t.icon} size="sm" /> : null}
          {t.label}
          {t.count !== undefined ? <span className="um-tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function tabPanelProps(idBase: string, id: string) {
  return {
    id: `${idBase}-panel-${id}`,
    role: "tabpanel" as const,
    "aria-labelledby": `${idBase}-tab-${id}`,
    tabIndex: 0,
  };
}

// ---------- segmented control ----------

export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: IconName | undefined;
}

/** A group of toggle buttons (aria-pressed), e.g. the date range: 24h · 7d · 30d · 90d. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
  /** accessible name of the group, e.g. "Date range" */
  label: string;
  className?: string | undefined;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset
    <div className={cx("um-seg", className)} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.icon ? <Icon name={o.icon} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- tables ----------

/**
 * Frame for a wide table: scrolls horizontally inside the card, fades at the right edge while more columns hide
 * there, and (with `stickyFirst`) keeps the first column in place. The child is a
 * `<table className="um-table">`.
 */
export function TableScroll({
  children,
  stickyFirst = false,
  label,
}: {
  children: ReactNode;
  stickyFirst?: boolean | undefined;
  /** accessible name of the scroll region (it is focusable so keyboard users can scroll it) */
  label: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [state, setState] = useState({ overflow: false, end: true, scrolled: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const overflow = el.scrollWidth > el.clientWidth + 1;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    const scrolled = el.scrollLeft > 0;
    setState((s) =>
      s.overflow === overflow && s.end === end && s.scrolled === scrolled
        ? s
        : { overflow, end, scrolled },
    );
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const table = el.firstElementChild;
    if (table) ro.observe(table);
    return () => ro.disconnect();
  }, [measure]);
  return (
    <div
      className={cx(
        "um-tw",
        state.overflow && "um-tw--fade",
        state.end && "um-tw--end",
        state.scrolled && "um-tw--scrolled",
        stickyFirst && "um-tw--sticky",
      )}
    >
      <section
        className="um-tw-scroll"
        ref={ref}
        onScroll={measure}
        tabIndex={state.overflow ? 0 : -1}
        aria-label={label}
      >
        {children}
      </section>
    </div>
  );
}

// ---------- KPI tile ----------

export interface Delta {
  /** shown as-is, e.g. "+12%" */
  text: string;
  direction: "up" | "down" | "flat";
  /** screen-reader wording, e.g. "12% more than the previous 30 days" */
  label?: string | undefined;
}

/**
 * One headline number. `value === null` renders "Not measured" (never a made-up zero); `loading` a skeleton line.
 * `tone` draws the source-colour bar; `chip` marks where the number comes from.
 */
export function Kpi({
  label,
  value,
  unit,
  icon,
  tone = "neutral",
  chip,
  delta,
  foot,
  loading = false,
  testId,
}: {
  label: ReactNode;
  value: ReactNode | null;
  unit?: string | undefined;
  icon?: IconName | undefined;
  tone?: Tone | undefined;
  chip?: ProvenanceKind | undefined;
  delta?: Delta | undefined;
  foot?: ReactNode | undefined;
  loading?: boolean | undefined;
  testId?: string | undefined;
}) {
  const id = useId();
  return (
    <section
      className={cx("um-card", "um-card--bar", `um-tone-${tone}`, "um-kpi")}
      aria-labelledby={id}
      aria-busy={loading || undefined}
      data-testid={testId}
    >
      <h3 className="um-kpi-h" id={id}>
        {icon ? (
          <span className="um-tile um-tile--sm">
            <Icon name={icon} />
          </span>
        ) : null}
        <span className="um-kpi-l">{label}</span>
        {chip ? <Chip kind={chip} /> : null}
      </h3>
      {loading ? (
        <div className="um-skel" aria-hidden="true">
          <i />
        </div>
      ) : (
        <p className="um-kpi-v">
          {value === null ? (
            <span className="um-kpi-none">Not measured</span>
          ) : (
            <>
              <strong>{value}</strong>
              {unit ? <span className="um-kpi-u">{unit}</span> : null}
            </>
          )}
          {delta && value !== null ? (
            <span className={cx("um-delta", `um-delta--${delta.direction}`)}>
              {delta.text}
              {delta.label ? <span className="um-sr"> {delta.label}</span> : null}
            </span>
          ) : null}
        </p>
      )}
      {foot ? <div className="um-kpi-f">{foot}</div> : null}
    </section>
  );
}
