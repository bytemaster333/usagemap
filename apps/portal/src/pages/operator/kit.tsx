// SPDX-License-Identifier: Apache-2.0
// Presentation pieces of the SCF operator console (approved design, 2026-11-20) built on the UI kit: the page intro
// (one <h1> for screen readers, the visible title sits in the top bar), the privacy floor line, level and trust
// marks, hidden-value marks, change pills, sparklines, bar lists, the line chart, the modal, the toast and the "More
// filters" popover. No inline styles anywhere (CSP style-src 'self'): data-dependent sizes are SVG attributes.
// Classes are `um-op-*` in ./operator.css.

import type { UseQueryResult } from "@tanstack/react-query";
import type { ControlPlane } from "@usagemap/api-types";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ProblemAlert } from "../../components/ProblemAlert.tsx";
import { TopBarSlot } from "../../components/shell/TopBarSlot.tsx";
import {
  AccessNotice,
  Button,
  cx,
  Icon,
  isForbidden,
  LoadingState,
  QueryState,
  Segmented,
} from "../../components/ui/index.ts";
import { partialLast } from "../../components/ui/viz.tsx";
import { saveText } from "../../lib/download.ts";
import { type Band, changePct, deltaOf, fmtCompact, fmtExact } from "./model.ts";

// ---------------------------------------------------------------------------------------------- page intro

/**
 * The page's <h1> (visually hidden: the shell's top bar shows the title) and the design's lead row: one muted line,
 * with an optional chip or privacy line on the right.
 */
export function OpIntro({
  title,
  lead,
  aside,
}: {
  title: string;
  lead?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <>
      <h1 className="um-sr">{title}</h1>
      {lead || aside ? (
        <div className="um-op-lead-row">
          {lead ? <p className="um-op-lead">{lead}</p> : null}
          {aside}
        </div>
      ) : null}
    </>
  );
}

/** "Privacy floor: values under 10 hidden, rounded to 10, projects below L1 left out" from the API's echo. */
export function PrivacyFloor({
  privacy,
  extra,
}: {
  privacy: ControlPlane.PrivacyEcho | undefined;
  extra?: ReactNode;
}) {
  if (!privacy) return null;
  return (
    <span className="um-op-privfloor" data-testid="privacy-note">
      <Icon name="shield" size="sm" />
      <span>
        Privacy floor: breakdown values under <b>{privacy.min_count}</b> hidden, rounded to{" "}
        <b>{privacy.round_to}</b>
        {privacy.excluded_levels_below ? (
          <>
            , projects below <b>{privacy.excluded_levels_below}</b> left out
          </>
        ) : null}
        {extra}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------- marks

export function Lvl({ level }: { level: string }) {
  const hi = level === "L3" || level === "L4";
  return (
    <span className={cx("um-op-lvl", hi && "um-op-lvl--hi")} title={`Verification level ${level}`}>
      {level}
    </span>
  );
}

export function bandOf(score: number | null | undefined): Band {
  if (score === null || score === undefined) return "unscored";
  return score >= 80 ? "high" : score >= 50 ? "medium" : "low";
}

/** Trust score with its band dot; "—" with an explanation when there is no score yet. */
export function TrustCell({
  score,
  suffix,
}: {
  score: number | null | undefined;
  suffix?: string;
}) {
  if (score === null || score === undefined)
    return (
      <span className="um-op-na" title="Not scored yet: too few days of traffic.">
        —<span className="um-sr"> not scored yet</span>
      </span>
    );
  return (
    <span className="um-op-trust">
      <i className={`um-op-dot um-op-dot--${bandOf(score)}`} aria-hidden="true" />
      {Math.round(score)}
      {suffix}
    </span>
  );
}

/** A value withheld by the privacy minimum: "<10", with the reason on hover/focus. */
export function Hid({ min, why }: { min: number; why?: string }) {
  const text =
    why ?? `Hidden: fewer than ${min}. Small numbers could point to one project or person.`;
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users can read the reason
    <span className="um-op-hid" tabIndex={0} title={text}>
      &lt;{min}
      <span className="um-sr"> ({text})</span>
    </span>
  );
}

export function NotAvailable({ why }: { why: string }) {
  return (
    <span className="um-op-na" title={why}>
      —<span className="um-sr"> ({why})</span>
    </span>
  );
}

/** A change pill (+12.4% green, −3.0% red). Nothing when there is no base to compare with. */
export function DeltaPill({ pct, label }: { pct: number | null; label?: string }) {
  const d = deltaOf(pct);
  if (!d) return <span className="um-op-na">—</span>;
  return (
    <span className={`um-delta um-delta--${d.direction}`}>
      {d.text}
      {label ? <span className="um-sr"> {label}</span> : null}
    </span>
  );
}

export function deltaProps(
  cur: number | null | undefined,
  prev: number | null | undefined,
  what: string,
) {
  const d = deltaOf(changePct(cur, prev));
  return d ? { ...d, label: `${what}` } : undefined;
}

/** A name over a muted second line (project · round · stage). */
export function PName({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <span className="um-op-pname">
      {children}
      {sub ? <span className="um-op-pname-sub">{sub}</span> : null}
    </span>
  );
}

/** Compact number with the exact figure on hover. */
export function Num({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="um-op-na">—</span>;
  const c = fmtCompact(value);
  const e = fmtExact(value);
  return c === e ? c : <span title={e}>{c}</span>;
}

// ---------------------------------------------------------------------------------------------- sparkline, bars

/** A small line of daily values (nulls break the line). */
export function Spark({
  values: all,
  days,
  color = "#111111",
  label,
}: {
  values: readonly (number | null)[];
  /** the days of `values`; when the last one is today (still being counted) the line ends the day before */
  days?: readonly string[] | undefined;
  color?: string;
  label: string;
}) {
  const values = days && partialLast(days, "day") ? all.slice(0, -1) : all;
  const w = 84;
  const h = 26;
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <span className="um-op-na">—</span>;
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const n = values.length;
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const x = ((i / (n - 1)) * (w - 4) + 2).toFixed(1);
    const y = (h - 3 - ((v - min) / (max - min || 1)) * (h - 6)).toFixed(1);
    d += `${pen ? "L" : "M"}${x} ${y}`;
    pen = true;
  });
  return (
    <svg className="um-op-spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

const pct = (v: number, max: number) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);

/** A horizontal track filled to value/max (SVG, so no inline style). */
export function Track({
  value,
  max,
  className,
  minFill = 0,
}: {
  value: number;
  max: number;
  className?: string;
  minFill?: number;
}) {
  const p = value > 0 ? Math.max(minFill, pct(value, max)) : 0;
  return (
    <svg
      className={cx("um-op-trk", className)}
      viewBox="0 0 100 10"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <rect className="um-op-trk-bg" x="0" y="0" width="100" height="10" />
      <rect className="um-op-trk-fill" x="0" y="0" width={p} height="10" />
    </svg>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  /** what the value column shows (defaults to the compact value) */
  shown?: ReactNode;
  /** the right-hand column (share, success rate…) */
  aside?: ReactNode;
  hint?: string;
}

/** The design's bar list: label, value and share over a tinted bar proportional to the value. */
export function BarList({
  rows,
  tint = "neutral",
  head,
  testId,
  wrap = false,
}: {
  rows: BarRow[];
  tint?: "web" | "api" | "chain" | "neutral" | "warn";
  head?: [string, string, string];
  testId?: string;
  /** long labels wrap instead of being cut */
  wrap?: boolean;
}) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <div className="um-op-blw" data-testid={testId}>
      {head ? (
        <div className="um-op-bhead" aria-hidden="true">
          <span>{head[0]}</span>
          <span>{head[1]}</span>
          <span>{head[2]}</span>
        </div>
      ) : null}
      <ul className={cx("um-op-bl", `um-op-bl--${tint}`, wrap && "um-op-bl--wrap")}>
        {rows.map((r) => (
          <li key={r.key} title={r.hint}>
            <svg
              className="um-op-bl-bar"
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <rect x="0" y="0" width={pct(r.value, max)} height="10" />
            </svg>
            <span className="um-op-bl-k">{r.label}</span>
            <span className="um-op-bl-v">{r.shown ?? <Num value={r.value} />}</span>
            <span className="um-op-bl-p">{r.aside}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A stacked share bar (status classes, trust bands) with its legend. */
export function StackBar({
  parts,
  label,
}: {
  parts: { key: string; value: number; cls: string; label: string; shown?: string }[];
  label: string;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  let x = 0;
  return (
    <div className="um-op-stack">
      <svg
        className="um-op-sbar"
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.shown ?? p.value}`).join(", ")}`}
      >
        {total > 0
          ? parts.map((p) => {
              const w = (p.value / total) * 100;
              const r = <rect key={p.key} className={p.cls} x={x} y="0" width={w} height="10" />;
              x += w;
              return r;
            })
          : null}
      </svg>
      <ul className="um-op-sleg">
        {parts.map((p) => (
          <li key={p.key}>
            <i className={cx("um-op-sw", p.cls)} aria-hidden="true" />
            {p.label} <b>{p.shown ?? p.value}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- line chart

export interface ChartSeries {
  name: string;
  color: string;
  values: readonly (number | null)[];
  dash?: boolean;
  area?: boolean;
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

const DAY_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
/** "2026-11-12" or an ISO time → "12 Nov". */
export const dayLabel = (d: string) =>
  DAY_FMT.format(new Date(d.length === 10 ? `${d}T00:00:00Z` : d));

/**
 * Daily line chart (SVG). The width follows the container; hovering shows the day's values in an SVG tooltip.
 * `band` shades a span of days (the campaign window).
 */
export function LineChart({
  series,
  days,
  height = 230,
  band,
  format = fmtCompact,
  label,
}: {
  series: ChartSeries[];
  days: readonly string[];
  height?: number;
  band?: { from: number; to: number; label: string } | undefined;
  format?: (v: number) => string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(760);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(280, Math.round(el.clientWidth || 760)));
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = height;
  const L = 46;
  const R = 12;
  const T = 10;
  const B = 26;
  const n = days.length;
  // the kit's partial-bucket rule (viz.tsx, shared with the project charts): today is still being counted
  const partial = n > 1 ? partialLast(days, "day") : undefined;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const max = (Math.max(0, ...all) || 1) * 1.08;
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const x = (i: number) => (n <= 1 ? L : L + ((W - L - R) * i) / (n - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const ticks: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  const xt0 =
    n <= 1
      ? [0]
      : W < 520
        ? [0, Math.floor((n - 1) / 2), n - 1]
        : [0, 1, 2, 3, 4].map((k) => Math.round(((n - 1) * k) / 4));
  const xt = [...new Set(xt0)];
  const path = (vals: readonly (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - L) / (W - L - R)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  // tooltip geometry (inside the SVG)
  const tipW = 168;
  const tipH = 24 + series.length * 18;
  const tipX = hover === null ? 0 : x(hover) + 14 + tipW > W ? x(hover) - tipW - 14 : x(hover) + 14;
  return (
    <div className="um-op-chart" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        onPointerMove={n > 1 ? onMove : undefined}
        onPointerLeave={() => setHover(null)}
      >
        {band && n > 1 ? (
          <>
            <rect
              x={x(band.from)}
              y={T}
              width={Math.max(0, x(band.to) - x(band.from))}
              height={H - T - B}
              fill="#ffd43b"
              fillOpacity=".18"
            />
            <text className="um-op-ax-t" x={x(band.from) + 6} y={T + 13} fill="#5d636b">
              {band.label}
            </text>
          </>
        ) : null}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#e3e6ea" />
            <text className="um-op-ax" x={L - 8} y={y(v) + 4} textAnchor="end">
              {format(v)}
            </text>
          </g>
        ))}
        {xt.map((i, k) =>
          days[i] ? (
            <text
              key={`x${i}`}
              className="um-op-ax"
              x={x(i)}
              y={H - 6}
              textAnchor={k === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            >
              {dayLabel(days[i])}
            </text>
          ) : null,
        )}
        {series.map((s) => {
          // today is still being counted: solid up to the last complete day, a dashed step into today
          const solid = partial ? s.values.map((v, i) => (i === n - 1 ? null : v)) : s.values;
          const d = path(solid);
          const today = s.values[n - 1];
          const before = s.values[n - 2];
          const dPartial =
            partial &&
            today !== null &&
            today !== undefined &&
            before !== null &&
            before !== undefined
              ? `M${x(n - 2).toFixed(1)} ${y(before).toFixed(1)}L${x(n - 1).toFixed(1)} ${y(today).toFixed(1)}`
              : "";
          const lastAt = partial ? n - 2 : n - 1;
          const last = solid[lastAt];
          return (
            <g key={s.name}>
              {dPartial ? (
                <path
                  d={dPartial}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeDasharray="3 4"
                  strokeOpacity=".55"
                  strokeLinecap="round"
                />
              ) : null}
              {dPartial && today !== null && today !== undefined ? (
                <circle
                  cx={x(n - 1)}
                  cy={y(today)}
                  r="3.5"
                  fill="#fff"
                  stroke={s.color}
                  strokeOpacity=".7"
                  strokeWidth="1.5"
                />
              ) : null}
              {s.area && d && !d.slice(1).includes("M") ? (
                <path
                  d={`${d}L${x(lastAt)} ${y(0)}L${x(0)} ${y(0)}Z`}
                  fill={s.color}
                  fillOpacity=".06"
                />
              ) : null}
              <path
                d={d}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeDasharray={s.dash ? "4 4" : undefined}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {!s.dash && last !== null && last !== undefined ? (
                <circle
                  cx={x(lastAt)}
                  cy={y(last)}
                  r="4"
                  fill={s.color}
                  stroke="#fff"
                  strokeWidth="2"
                />
              ) : null}
            </g>
          );
        })}
        {hover !== null ? (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#111" opacity=".25" />
            {series.map((s) => {
              const v = s.values[hover];
              return v === null || v === undefined ? null : (
                <circle
                  key={s.name}
                  cx={x(hover)}
                  cy={y(v)}
                  r="4"
                  fill={s.color}
                  stroke="#fff"
                  strokeWidth="2"
                />
              );
            })}
            <rect x={tipX} y={T} width={tipW} height={tipH} rx="8" fill="#111" />
            <text className="um-op-tip-d" x={tipX + 10} y={T + 17}>
              {days[hover]
                ? `${dayLabel(days[hover])}${partial && hover === n - 1 ? ` · ${partial}` : ""}`
                : ""}
            </text>
            {series.map((s, k) => {
              const v = s.values[hover];
              return (
                <g key={s.name}>
                  <rect
                    x={tipX + 10}
                    y={T + 27 + k * 18}
                    width="8"
                    height="8"
                    rx="2"
                    fill={s.color}
                  />
                  <text className="um-op-tip-k" x={tipX + 24} y={T + 35 + k * 18}>
                    {s.name.length > 16 ? `${s.name.slice(0, 15)}…` : s.name}
                  </text>
                  <text
                    className="um-op-tip-v"
                    x={tipX + tipW - 10}
                    y={T + 35 + k * 18}
                    textAnchor="end"
                  >
                    {v === null || v === undefined ? "—" : fmtExact(v)}
                  </text>
                </g>
              );
            })}
          </g>
        ) : null}
        {partial ? (
          <text className="um-op-ax-t" x={x(n - 1)} y={T + 10} textAnchor="end" fill="#5d636b">
            {partial}
          </text>
        ) : null}
        <rect x={L} y={T} width={Math.max(0, W - L - R)} height={H - T - B} fill="transparent" />
      </svg>
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color?: string; dash?: boolean }[] }) {
  return (
    <ul className="um-op-legend">
      {items.map((i) => (
        <li key={i.name}>
          <svg className="um-op-legend-i" viewBox="0 0 14 3" aria-hidden="true">
            <line
              x1="0"
              x2="14"
              y1="1.5"
              y2="1.5"
              stroke={i.color ?? "#111111"}
              strokeWidth="3"
              strokeDasharray={i.dash ? "4 3" : undefined}
            />
          </svg>
          {i.name}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------- modal, toast

/** A modal dialog (native <dialog>: focus stays inside, Escape closes). */
export function OpModal({
  title,
  sub,
  icon,
  tone = "dang",
  onClose,
  children,
  footer,
}: {
  title: string;
  sub?: ReactNode;
  icon: Parameters<typeof Icon>[0]["name"];
  tone?: "dang" | "good" | "neutral";
  onClose: () => void;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal?.();
    return () => d?.close?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`um-op-modal um-op-modal--${tone}`}
      aria-labelledby={`${id}-t`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="um-op-modal-h">
        <span className={`um-op-mtile um-op-mtile--${tone}`}>
          <Icon name={icon} />
        </span>
        <div>
          <h2 className="um-h2 um-op-modal-t" id={`${id}-t`}>
            {title}
          </h2>
          {sub ? <p className="um-op-modal-sub">{sub}</p> : null}
        </div>
      </div>
      {children ? <div className="um-op-modal-b">{children}</div> : null}
      <div className="um-op-modal-f">{footer}</div>
    </dialog>
  );
}

/** A short confirmation at the bottom of the screen; `show(text)` replaces the current one. */
export function useToast(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((t: string) => {
    setText(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setText(null), 3200);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const node = (
    <div className="um-op-toast-host" role="status" aria-live="polite">
      {text ? (
        <div className="um-op-toast">
          <Icon name="check" size="sm" />
          <span>{text}</span>
        </div>
      ) : null}
    </div>
  );
  return [node, show];
}

/** A refused write (read-only operator) explained in operator words; any other error as a problem. */
export function OpProblem({ error }: { error: unknown }) {
  if (!error) return null;
  if (isForbidden(error))
    return (
      <AccessNotice kind="read-only" title="Your operator role is read-only here">
        Your account can see everything in the console but not change it. An operator admin can make
        this change or give your account the operator admin role.
      </AccessNotice>
    );
  return <ProblemAlert error={error} />;
}

// ---------------------------------------------------------------------------------------------- filters

/** The "More filters" popover (a native disclosure). */
export function MoreFilters({
  count,
  children,
  onReset,
}: {
  count: number;
  children: ReactNode;
  onReset: () => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      const d = ref.current;
      if (d?.open && e.target instanceof Node && !d.contains(e.target)) d.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  return (
    <details className="um-op-more" ref={ref}>
      <summary className="um-btn um-btn--secondary um-btn--sm um-op-more-btn">
        <Icon name="filter" />
        More filters
        {count ? <span className="um-op-badge">{count}</span> : null}
      </summary>
      <div className="um-op-pop">
        {children}
        <div className="um-op-pop-f">
          <Button variant="ghost" size="sm" onClick={onReset}>
            Reset
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (ref.current) ref.current.open = false;
            }}
          >
            Done
          </Button>
        </div>
      </div>
    </details>
  );
}

/** A search box that applies after a short pause. */
export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  const [text, setText] = useState(value);
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim() !== value) cb.current(text.trim());
    }, 300);
    return () => clearTimeout(t);
  }, [text, value]);
  return (
    <label className="um-op-search">
      <Icon name="search" size="sm" />
      <input
        type="search"
        value={text}
        placeholder={placeholder}
        aria-label={label}
        maxLength={100}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------------------------- top bar

export const RANGES = [
  { value: "7d" as const, label: "7d" },
  { value: "30d" as const, label: "30d" },
  { value: "90d" as const, label: "90d" },
];

/** The top bar's range picker and, optionally, a CSV download of the page's main table. */
export function TopActions({
  range,
  onRange,
  csv,
}: {
  range?: "7d" | "30d" | "90d" | "custom" | undefined;
  onRange?: ((r: "7d" | "30d" | "90d") => void) | undefined;
  csv?: { file: string; fetch: () => Promise<string> } | undefined;
}) {
  const [error, setError] = useState<unknown>(null);
  return (
    <TopBarSlot>
      {onRange && range ? (
        <Segmented
          label="Date range"
          options={RANGES}
          value={range === "custom" ? ("30d" as const) : range}
          onChange={onRange}
        />
      ) : null}
      {csv ? (
        <Button
          size="sm"
          icon="download"
          className="um-op-hide-sm"
          title={error ? "The download failed. Try again." : "Download the table as CSV"}
          onClick={async () => {
            try {
              setError(null);
              saveText(csv.file, await csv.fetch(), "text/csv");
            } catch (e) {
              setError(e);
            }
          }}
        >
          CSV
        </Button>
      ) : null}
    </TopBarSlot>
  );
}

/** A select with the design's look. */
export function Sel({
  label,
  value,
  onChange,
  children,
  id,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  id?: string;
}) {
  return (
    <select
      id={id}
      className="um-op-sel"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {children}
    </select>
  );
}

/** Brings a panel that just opened (side by side) into view. */
export function ScrollIntoView({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);
  return (
    <div ref={ref} className="um-op-anchor">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- slow summaries

/**
 * Loading for the operator summaries, which can take half a minute over every project (QA 2026-11-20): skeleton
 * lines first, then a calm line saying it is still counting.
 */
export function SlowLoading({ block = false, label }: { block?: boolean; label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="um-op-slow">
      <LoadingState block={block} label={label ?? "Loading…"} />
      {slow ? (
        <p className="um-op-hint" role="status">
          Still counting. Summaries over every Stellar ecosystem project can take up to half a
          minute.
        </p>
      ) : null}
    </div>
  );
}

/** A failed read in one card: a short, calm line and "Try again" (403 keeps the access notice). */
export function CalmError({
  error,
  onRetry,
  what = "these figures",
}: {
  error: unknown;
  onRetry: () => void;
  what?: string | undefined;
}) {
  if (isForbidden(error)) return <AccessNotice kind="forbidden" />;
  return (
    <div className="um-op-calm" role="status" data-testid="calm-error">
      <Icon name="clock" size="sm" />
      <span>Could not load {what} this time. The service may be busy.</span>
      <Button size="sm" icon="repeat" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/** QueryState with the calm loading and error states of the operator summaries. */
export function OpQueryState<T>(props: {
  query: Pick<UseQueryResult<T>, "data" | "error" | "isPending" | "refetch">;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean | undefined;
  empty?: ReactNode | undefined;
  loading?: ReactNode | undefined;
  plain?: boolean | undefined;
  what?: string | undefined;
}) {
  const { query, what, loading } = props;
  if (query.isPending) return <>{loading ?? <SlowLoading />}</>;
  if (query.error)
    return <CalmError error={query.error} what={what} onRetry={() => void query.refetch()} />;
  const { what: _w, ...rest } = props;
  return <QueryState {...rest} />;
}

/** KPI overrides while its read failed: "Not loaded" and a retry, instead of a blank or a made-up value. */
export function kpiErr(q: { error: unknown; refetch: () => unknown }) {
  if (!q.error) return {};
  return {
    value: <span className="um-op-kpi-na">Not loaded</span>,
    delta: undefined,
    foot: (
      <button type="button" className="um-op-tlink" onClick={() => void q.refetch()}>
        <Icon name="repeat" size="xs" />
        Try again
      </button>
    ),
  };
}
