// SPDX-License-Identifier: Apache-2.0
// UsageMap UI kit: data visualisation and the small interactive pieces of the dashboards — time-series chart (line,
// area, bars, stacked bars, annotations, hover read-out), sparkline, bar list, share bar, funnel, switch, code block
// with copy, step indicator and the source list. CSP-clean: geometry is SVG attributes only (no inline styles),
// colours are classes (`um-c-*` in ./ui.css, "viz" section). Presentation only; callers pass API numbers and never
// invented ones (a `null` point is drawn as a gap).

import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button, cx, Icon, type IconName, type Tone } from "./basics.tsx";
import "./viz.css";

/** Series colours (classes `um-c-<name>`). */
export type ChartColor =
  | "web"
  | "webmid"
  | "weblight"
  | "grey"
  | "ink"
  | "ink2"
  | "yellow"
  | "yellowdeep"
  | "api"
  | "apilight"
  | "apipale"
  | "bad"
  | "warn"
  | "line";

export interface ChartSeries {
  name: string;
  color: ChartColor;
  data: (number | null)[];
  area?: boolean | undefined;
  dash?: boolean | undefined;
  thin?: boolean | undefined;
}

const NF = new Intl.NumberFormat("en-US");
export const fmtCompact = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return NF.format(Math.round(n));
};

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Width of an element, kept current with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(240, Math.round(el.clientWidth)));
    set();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/**
 * True when a bucket that starts at `iso` is still running: today (unit day), this hour (unit hour) or this month
 * (unit month), in UTC. Its count is partial, so charts draw it apart instead of as a drop toward zero.
 */
export function isPartialBucket(
  iso: string,
  unit: "hour" | "day" | "month" = "day",
  now = new Date(),
): boolean {
  const t = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (unit === "hour")
    return now.getTime() - t.getTime() < 3_600_000 && now.getTime() >= t.getTime();
  if (unit === "month")
    return t.getUTCFullYear() === now.getUTCFullYear() && t.getUTCMonth() === now.getUTCMonth();
  return iso.slice(0, 10) === now.toISOString().slice(0, 10);
}

/** `partial` prop for `Chart` from the bucket starts: the last bucket's label when it is still running. */
export function partialLast(
  times: readonly string[],
  unit: "hour" | "day" | "month" = "day",
): string | undefined {
  const last = times[times.length - 1];
  if (!last || !isPartialBucket(last, unit)) return undefined;
  return unit === "hour"
    ? "This hour (partial)"
    : unit === "month"
      ? "This month (partial)"
      : "Today (partial)";
}

export interface ChartAnnotation {
  index: number;
  label: string;
}

/**
 * A time-series chart drawn at the container's width. Lines (optionally with an area) or bars (optionally
 * stacked). Hovering shows the bucket's values inside the SVG; the whole chart has a text summary for screen
 * readers (`label`), and the caller should offer the numbers elsewhere (KPIs, tables).
 */
export function Chart({
  labels,
  series,
  type = "line",
  stack = false,
  height = 220,
  label,
  format = fmtCompact,
  annotations = [],
  testId,
  table,
  max,
  partial,
}: {
  labels: string[];
  series: ChartSeries[];
  type?: "line" | "bar" | undefined;
  stack?: boolean | undefined;
  height?: number | undefined;
  /** accessible description of the chart */
  label: string;
  format?: ((v: number) => string) | undefined;
  annotations?: ChartAnnotation[] | undefined;
  testId?: string | undefined;
  /** fixed top of the y axis (e.g. 100 for scores) */
  max?: number | undefined;
  /**
   * The last bucket is still running (today, this hour): pass its label (see `partialLast()`), e.g. "Today (partial)".
   * Lines reach it with a dashed segment and a hollow dot, bars are drawn faint, and the label is written above it.
   */
  partial?: string | undefined;
  /** text alternative: a collapsible data table (`rows` are the full bucket names, e.g. "14 Oct 2026") */
  table?:
    | { title: string; firstColumn: string; rows: string[]; format?: (v: number | null) => string }
    | undefined;
}) {
  const [ref, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const clipId = useId();
  const H = height;
  const pl = 46;
  const pr = 10;
  const pt = 10;
  const pb = 24;
  const iw = W - pl - pr;
  const ih = H - pt - pb;
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.data[i] ?? 0), 0));
  const rawMax =
    type === "bar" && stack
      ? Math.max(0, ...totals)
      : Math.max(0, ...series.flatMap((s) => s.data.map((v) => v ?? 0)));
  const maxV = max ?? niceCeil(rawMax * 1.05);
  const y = (v: number) => pt + ih - (v / maxV) * ih;
  const step = n > 0 ? iw / n : iw;
  const x = (i: number) =>
    type === "bar" ? pl + step * i + step / 2 : pl + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 72))));
  const bw = Math.max(1.5, Math.min(22, step * 0.62));

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - r.left) / Math.max(1, r.width);
    const i = type === "bar" ? Math.floor(fx * n) : Math.round(fx * Math.max(0, n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const part = !!partial && n >= 2;
  const complete = (d: (number | null)[]) => (part ? d.map((v, i) => (i === n - 1 ? null : v)) : d);
  const partialPath = (d: (number | null)[]) => {
    const a = d[n - 2];
    const b = d[n - 1];
    if (!part || a === null || a === undefined || b === null || b === undefined) return "";
    return `M${x(n - 2).toFixed(1)},${y(a).toFixed(1)}L${x(n - 1).toFixed(1)},${y(b).toFixed(1)}`;
  };
  const linePath = (d: (number | null)[]) => {
    let p = "";
    let pen = false;
    d.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      p += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return p;
  };
  const areaPath = (d: (number | null)[]) => {
    const pts = d.map((v, i) => (v === null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`));
    const first = pts.findIndex((p) => p !== null);
    const last = pts.length - 1 - [...pts].reverse().findIndex((p) => p !== null);
    if (first < 0) return "";
    const seg = pts.slice(first, last + 1).map((p, k) => p ?? `${x(first + k).toFixed(1)},${y(0)}`);
    return `M${seg.join("L")}L${x(last).toFixed(1)},${y(0)}L${x(first).toFixed(1)},${y(0)}Z`;
  };

  // hover read-out, positioned inside the SVG
  const tipRows = hover === null ? [] : series.map((s) => ({ s, v: s.data[hover] ?? null }));
  const ann = hover === null ? undefined : annotations.find((a) => a.index === hover);
  const tipW = 168;
  const tipH = 22 + tipRows.length * 17 + (ann ? 16 : 0);
  const hx = hover === null ? 0 : x(hover);
  const tipX = hx + 12 + tipW > W ? hx - 12 - tipW : hx + 12;

  return (
    <div className="um-chart" ref={ref} data-testid={testId}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        aria-label={label}
        className="um-chart-svg"
      >
        <defs>
          <clipPath id={clipId}>
            <rect x={pl} y={pt - 4} width={iw} height={ih + 4} />
          </clipPath>
        </defs>
        {[0, 1, 2, 3, 4].map((k) => {
          const v = (maxV / 4) * k;
          const yy = y(v);
          return (
            <g key={k}>
              <line
                className={k ? "um-chart-grid um-chart-grid--dash" : "um-chart-grid"}
                x1={pl}
                x2={W - pr}
                y1={yy}
                y2={yy}
              />
              <text className="um-chart-ax" x={pl - 8} y={yy + 4} textAnchor="end">
                {format(v)}
              </text>
            </g>
          );
        })}
        {labels.map((l, i) =>
          i % every === 0 ? (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: axis labels are positional
              key={i}
              className="um-chart-ax"
              x={x(i)}
              y={H - 6}
              textAnchor={i === 0 && type !== "bar" ? "start" : "middle"}
            >
              {l}
            </text>
          ) : null,
        )}
        <g clipPath={`url(#${clipId})`}>
          {type === "bar"
            ? labels.map((_, i) => {
                let acc = 0;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
                  <g key={i}>
                    {series.map((s, si) => {
                      const v = s.data[i] ?? 0;
                      const base = stack ? acc : 0;
                      const y1 = y(base + v);
                      const y0 = y(base);
                      if (stack) acc += v;
                      const off =
                        stack || series.length === 1
                          ? 0
                          : (si - (series.length - 1) / 2) * (bw / series.length);
                      const w = stack || series.length === 1 ? bw : bw / series.length;
                      return (
                        <rect
                          key={s.name}
                          className={cx(
                            `um-c-${s.color}`,
                            "um-chart-bar",
                            part && i === n - 1 && "um-chart-bar--partial",
                          )}
                          x={x(i) - w / 2 + off}
                          y={y1}
                          width={w}
                          height={Math.max(0, y0 - y1)}
                          rx={Math.min(3, w / 3)}
                        />
                      );
                    })}
                  </g>
                );
              })
            : series.map((s, si) => (
                <g key={s.name} className={`um-c-${s.color}`}>
                  {s.area ? (
                    <path className="um-chart-area" d={areaPath(complete(s.data))} />
                  ) : null}
                  <path
                    className={cx(
                      "um-chart-line",
                      s.dash && "um-chart-line--dash",
                      s.thin && "um-chart-line--thin",
                    )}
                    d={linePath(complete(s.data))}
                  />
                  {part ? (
                    <path
                      className={cx(
                        "um-chart-line",
                        "um-chart-line--partial",
                        s.thin && "um-chart-line--thin",
                      )}
                      d={partialPath(s.data)}
                    />
                  ) : null}
                  {si === 0 && n > 0 && s.data[n - 1] !== null && s.data[n - 1] !== undefined ? (
                    <circle
                      className={part ? "um-chart-dot um-chart-dot--partial" : "um-chart-dot"}
                      cx={x(n - 1)}
                      cy={y(s.data[n - 1] as number)}
                      r={3.5}
                    />
                  ) : null}
                </g>
              ))}
        </g>
        {annotations
          .filter((a) => a.index >= 0 && a.index < n)
          .map((a) => (
            <g key={`${a.index}-${a.label}`} className="um-chart-ann">
              <line x1={x(a.index)} x2={x(a.index)} y1={pt} y2={pt + ih} />
              <circle cx={x(a.index)} cy={pt + 4} r={4} />
            </g>
          ))}
        {part ? (
          <text className="um-chart-partial" x={x(n - 1)} y={pt + 9} textAnchor="end">
            {partial}
          </text>
        ) : null}
        {hover !== null ? (
          <g className="um-chart-hov">
            <line x1={hx} x2={hx} y1={pt} y2={pt + ih} />
            <g transform={`translate(${tipX.toFixed(1)},${pt})`}>
              <rect className="um-chart-tip" width={tipW} height={tipH} rx={8} />
              <text className="um-chart-tip-h" x={10} y={16}>
                {part && hover === n - 1 ? `${labels[hover]} · ${partial}` : labels[hover]}
              </text>
              {ann ? (
                <text className="um-chart-tip-a" x={10} y={31}>
                  {ann.label.length > 26 ? `${ann.label.slice(0, 25)}…` : ann.label}
                </text>
              ) : null}
              {tipRows.map((r, k) => (
                <g key={r.s.name} transform={`translate(10,${(ann ? 46 : 32) + k * 17})`}>
                  <rect
                    className={`um-c-${r.s.color} um-chart-key`}
                    y={-8}
                    width={8}
                    height={8}
                    rx={2}
                  />
                  <text className="um-chart-tip-k" x={14} y={0}>
                    {r.s.name.length > 16 ? `${r.s.name.slice(0, 15)}…` : r.s.name}
                  </text>
                  <text className="um-chart-tip-v" x={tipW - 20} y={0} textAnchor="end">
                    {r.v === null ? "–" : NF.format(Math.round(r.v * 100) / 100)}
                  </text>
                </g>
              ))}
            </g>
          </g>
        ) : null}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only read-out; the same numbers are in the KPIs, tables and the optional data table */}
        <rect
          className="um-chart-ov"
          x={pl}
          y={pt}
          width={Math.max(0, iw)}
          height={Math.max(0, ih)}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      {table ? (
        <details className="um-chart-table">
          <summary>Show data table: {table.title}</summary>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the table scrolls; keyboard users must reach it */}
          <section className="um-tw-scroll" tabIndex={0} aria-label={`Data table: ${table.title}`}>
            <table className="um-table">
              <thead>
                <tr>
                  <th scope="col">{table.firstColumn}</th>
                  {series.map((s) => (
                    <th key={s.name} scope="col" className="um-r">
                      {s.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: buckets are positional
                  <tr key={i}>
                    <th scope="row">{r}</th>
                    {series.map((s) => (
                      <td key={s.name} className="um-r">
                        {(
                          table.format ?? ((v: number | null) => (v === null ? "—" : NF.format(v)))
                        )(s.data[i] ?? null)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </details>
      ) : null}
    </div>
  );
}

/** Legend row for a chart. */
export function Legend({
  items,
}: {
  items: {
    label: string;
    color: ChartColor;
    dash?: boolean | undefined;
    dot?: boolean | undefined;
  }[];
}) {
  return (
    <ul className="um-legend">
      {items.map((i) => (
        <li key={i.label}>
          <svg width="16" height="10" aria-hidden="true" className={`um-c-${i.color}`}>
            {i.dot ? (
              <circle cx="8" cy="5" r="4" className="um-legend-dot" />
            ) : i.dash ? (
              <line x1="0" x2="16" y1="5" y2="5" className="um-legend-dash" />
            ) : (
              <rect y="3" width="16" height="4" rx="2" className="um-legend-sw" />
            )}
          </svg>
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** A small area sparkline (decorative: the number next to it carries the meaning). */
export function Spark({
  values,
  color,
  partial = false,
}: {
  values: (number | null)[];
  color: ChartColor;
  /** the last value is a running bucket (today): the line ends at the last complete one */
  partial?: boolean | undefined;
}) {
  const W = 200;
  const H = 34;
  const vs = (partial ? values.slice(0, -1) : values).map((v) => v ?? 0);
  const n = vs.length;
  if (n < 2) return null;
  const mx = Math.max(...vs) * 1.08 || 1;
  const pts = vs.map(
    (v, i) => `${((W * i) / (n - 1)).toFixed(1)},${(H - (v / mx) * H).toFixed(1)}`,
  );
  return (
    <svg
      className={`um-spark um-c-${color}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="um-chart-area" d={`M${pts.join("L")}L${W},${H}L0,${H}Z`} />
      <path className="um-spark-line" d={`M${pts.join("L")}`} />
    </svg>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: ReactNode;
  /** share of the whole, 0–100 (null: no bar) */
  share: number | null;
  other?: boolean | undefined;
}

/** A ranked list with a share bar behind each row (pages, referrers, protocols…). */
export function BarList({
  rows,
  tone = "neutral",
  head,
  label,
}: {
  rows: BarRow[];
  tone?: Tone | undefined;
  /** column headings: [name, value] */
  head?: [string, string] | undefined;
  label?: string | undefined;
}) {
  return (
    <div className={cx("um-bl", `um-tone-${tone}`)}>
      {head ? (
        <div className="um-bl-head" aria-hidden="true">
          <span>{head[0]}</span>
          <span>{head[1]}</span>
          <span>Share</span>
        </div>
      ) : null}
      <ul aria-label={label}>
        {rows.map((r) => (
          <li key={r.key} className={r.other ? "um-bl-oth" : undefined}>
            {r.share !== null ? (
              <svg className="um-bl-bar" aria-hidden="true" preserveAspectRatio="none">
                <rect width={`${Math.max(1.5, Math.min(100, r.share))}%`} height="100%" rx="6" />
              </svg>
            ) : null}
            <span className="um-bl-k">{r.label}</span>
            <span className="um-bl-v">{r.value}</span>
            <span className="um-bl-p">
              {r.share === null ? "" : `${r.share.toFixed(r.share < 10 ? 1 : 0)}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One horizontal bar split into parts (status classes, verdicts) with its legend. */
export function ShareBar({
  parts,
  label,
}: {
  parts: { label: string; share: number; color: ChartColor; value?: ReactNode }[];
  label: string;
}) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.share), 0) || 1;
  let acc = 0;
  return (
    <div className="um-sb">
      <svg className="um-sb-bar" role="img" aria-label={label} preserveAspectRatio="none">
        {parts.map((p) => {
          const w = (Math.max(0, p.share) / total) * 100;
          const r = (
            <rect
              key={p.label}
              className={`um-c-${p.color}`}
              x={`${acc}%`}
              width={`${w}%`}
              height="100%"
            />
          );
          acc += w;
          return r;
        })}
      </svg>
      <ul className="um-sb-leg">
        {parts.map((p) => (
          <li key={p.label}>
            <svg width="8" height="8" aria-hidden="true" className={`um-c-${p.color}`}>
              <rect width="8" height="8" rx="2" className="um-legend-sw" />
            </svg>
            {p.label} <b>{p.value ?? `${p.share.toFixed(1)}%`}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface FunnelStep {
  key: string;
  name: ReactNode;
  code?: ReactNode | undefined;
  /** null: hidden (fewer than the small-number threshold) */
  value: number | null;
  testId?: string | undefined;
  /** shown instead of the number (e.g. "withheld") when value is null */
  nullText?: string | undefined;
}

/** Ordered funnel: one bar per step with the share of the first step and of the previous one. */
export function Funnel({
  steps,
  color = "ink",
  dropWord = "dropped",
  label,
}: {
  steps: FunnelStep[];
  color?: ChartColor | undefined;
  dropWord?: string | undefined;
  label: string;
}) {
  const first = steps[0]?.value ?? null;
  return (
    <ol className="um-fn" aria-label={label}>
      {steps.map((s, i) => {
        const prev = i > 0 ? (steps[i - 1]?.value ?? null) : null;
        const ofFirst = first && s.value !== null ? (s.value / first) * 100 : null;
        const ofPrev = prev && s.value !== null ? (s.value / prev) * 100 : null;
        return (
          <li key={s.key} data-testid={s.testId}>
            {i > 0 && prev !== null && s.value !== null ? (
              <p className="um-fn-drop">
                − {NF.format(Math.max(0, prev - s.value))} {dropWord}
              </p>
            ) : null}
            <div className="um-fn-row">
              <div className="um-fn-nm">
                <span>{s.name}</span>
                {s.code ? <code>{s.code}</code> : null}
              </div>
              <svg
                className={`um-fn-track um-c-${color}`}
                aria-hidden="true"
                preserveAspectRatio="none"
              >
                <rect className="um-fn-bg" width="100%" height="100%" rx="7" />
                {ofFirst !== null ? (
                  <rect
                    className="um-fn-fill"
                    width={`${Math.max(1, ofFirst)}%`}
                    height="100%"
                    rx="7"
                  />
                ) : null}
                {s.value !== null ? (
                  ofFirst !== null && ofFirst >= 18 ? (
                    <text className="um-fn-in" x="8" y="17">
                      {NF.format(s.value)}
                    </text>
                  ) : (
                    <text className="um-fn-out" x={`${Math.max(1, ofFirst ?? 0)}%`} dx="6" y="17">
                      {NF.format(s.value)}
                    </text>
                  )
                ) : null}
              </svg>
              <div className="um-fn-cv">
                <b>
                  {s.value === null
                    ? (s.nullText ?? "Hidden")
                    : ofFirst === null
                      ? "–"
                      : `${ofFirst.toFixed(1)}%`}
                </b>
                <small>
                  {s.value === null
                    ? "fewer than 10"
                    : i === 0
                      ? "start"
                      : ofPrev === null
                        ? ""
                        : `${ofPrev.toFixed(0)}% of prev.`}
                </small>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** An on/off switch (role="switch"). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  onText = "On",
  offText = "Off",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean | undefined;
  onText?: string | undefined;
  offText?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="um-sw"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="um-sw-tr" aria-hidden="true" />
      <b aria-hidden="true">{checked ? onText : offText}</b>
    </button>
  );
}

/** Copy-to-clipboard button; says "Copied" for two seconds. */
export function CopyText({
  text,
  label = "Copy",
  size = "sm",
  variant = "ghost",
}: {
  text: string;
  label?: string | undefined;
  size?: "sm" | "md" | undefined;
  variant?: "ghost" | "secondary" | undefined;
}) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 2000);
    return () => clearTimeout(t);
  }, [done]);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      setDone(false);
    }
  }, [text]);
  return (
    <Button
      size={size}
      variant={variant}
      icon={done ? "check" : "copy"}
      onClick={() => void copy()}
    >
      {done ? "Copied" : label}
    </Button>
  );
}

/** Code with a title bar and a copy button. */
export function CodeBlock({
  title,
  code,
  copyLabel,
  testId,
}: {
  title: ReactNode;
  code: string;
  copyLabel?: string | undefined;
  testId?: string | undefined;
}) {
  return (
    <div className="um-codeblock">
      <div className="um-codeblock-h">
        <span>{title}</span>
        <CopyText text={code} label={copyLabel ?? "Copy"} />
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a wide code block scrolls sideways; keyboard users must reach it */}
      <pre data-testid={testId} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Numbered step indicator (done ✓ / current / next). */
export function Steps({
  items,
  current,
  label,
  allDone = false,
  onSelect,
}: {
  items: string[];
  /** 1-based */
  current: number;
  label: string;
  allDone?: boolean | undefined;
  onSelect?: ((step: number) => void) | undefined;
}) {
  return (
    <ol className="um-steps" aria-label={label}>
      {items.map((s, i) => {
        const n = i + 1;
        const done = allDone || n < current;
        const cur = !allDone && n === current;
        const inner = (
          <>
            <i aria-hidden="true">{done ? "✓" : n}</i>
            <b>{s}</b>
            {done ? <span className="um-sr"> (done)</span> : null}
          </>
        );
        return (
          <li
            key={s}
            className={cx(done && "um-steps-done", cur && "um-steps-cur")}
            aria-current={cur ? "step" : undefined}
          >
            {onSelect && done ? (
              <button type="button" onClick={() => onSelect(n)}>
                {inner}
              </button>
            ) : (
              <span>{inner}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export interface SourceItem {
  key: string;
  icon: IconName;
  tone: Tone;
  title: ReactNode;
  sub?: ReactNode | undefined;
  status?: ReactNode | undefined;
}

/** "Your sources": a list of connected sources with a tone tile and a status badge. */
export function SourceList({ items, label }: { items: SourceItem[]; label?: string | undefined }) {
  return (
    <ul className="um-src" aria-label={label}>
      {items.map((s) => (
        <li key={s.key}>
          <span className={`um-tile um-tone-${s.tone}`}>
            <Icon name={s.icon} />
          </span>
          <div className="um-src-t">
            <b>{s.title}</b>
            {s.sub ? <small>{s.sub}</small> : null}
          </div>
          {s.status}
        </li>
      ))}
    </ul>
  );
}

/** Key/value definition list. */
export function KeyValues({ items }: { items: { k: ReactNode; v: ReactNode }[] }) {
  return (
    <dl className="um-kv">
      {items.map((i, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static pairs
        <div key={n}>
          <dt>{i.k}</dt>
          <dd>{i.v}</dd>
        </div>
      ))}
    </dl>
  );
}
