// SPDX-License-Identifier: Apache-2.0
// Hand-made SVG line chart: no chart library, nothing injected into the page, CSP- and Trusted-Types-clean (only
// SVG elements and attributes; colours from the stylesheet). One y-axis per chart (series of one unit only), a
// legend for two series, a native tooltip per point and a data table as the text alternative (ADR-0024).

import { useId } from "react";
import { fmtAxis, fmtBucket } from "../lib/format.ts";
import type { Unit } from "../lib/range.ts";

export interface Series {
  name: string;
  points: { t: string; v: number | null }[];
}

const W = 640;
const H = 220;
const PAD = { top: 12, right: 12, bottom: 28, left: 56 };

/** A "nice" upper bound (1, 2, 2.5, 5 × 10ⁿ) at or above `max`. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

export function LineChart({
  title,
  series,
  unit,
  format,
}: {
  title: string;
  series: Series[];
  unit: Unit;
  format: (v: number | null) => string;
}) {
  const id = useId();
  const times = series[0]?.points.map((p) => p.t) ?? [];
  const n = times.length;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v ?? 0))));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / 6));

  const path = (s: Series) => {
    let d = "";
    let pen = false;
    s.points.forEach((p, i) => {
      if (p.v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  return (
    <figure className="chart">
      <figcaption>
        <h3>{title}</h3>
      </figcaption>
      {series.length > 1 ? (
        <ul className="legend" aria-hidden="true">
          {series.map((s, i) => (
            <li key={s.name}>
              <span className={`swatch series-${i}`} />
              {s.name}
            </li>
          ))}
        </ul>
      ) : null}
      {n === 0 ? (
        <p className="muted">No data in this range.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
          <title id={`${id}-t`}>{title}</title>
          <desc id={`${id}-d`}>
            {`${series.map((s) => s.name).join(" and ")}, ${n} points; the data table below lists every value.`}
          </desc>
          {ticks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="axis-label" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {times.map((t, i) =>
            i % labelEvery === 0 ? (
              <text key={t} className="axis-label" x={x(i)} y={H - 8} textAnchor="middle">
                {fmtAxis(t, unit)}
              </text>
            ) : null,
          )}
          {series.map((s, si) => (
            <g key={s.name}>
              <path className={`line series-${si}`} d={path(s)} />
              {s.points.map((p, i) =>
                p.v === null ? null : (
                  <circle
                    key={p.t}
                    className={`point series-${si}`}
                    cx={x(i)}
                    cy={y(p.v)}
                    r={n > 60 ? 2 : 4}
                  >
                    <title>{`${fmtBucket(p.t, unit)} — ${s.name}: ${format(p.v)}`}</title>
                  </circle>
                ),
              )}
            </g>
          ))}
        </svg>
      )}
      {n > 0 ? (
        <details>
          <summary>Show data table: {title}</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">
                  {unit === "hour" ? "Hour (UTC)" : unit === "month" ? "Month" : "Day (UTC)"}
                </th>
                {series.map((s) => (
                  <th key={s.name} scope="col" className="num">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {times.map((t, i) => (
                <tr key={t}>
                  <th scope="row">{fmtBucket(t, unit)}</th>
                  {series.map((s) => (
                    <td key={s.name} className="num">
                      {format(s.points[i]?.v ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </figure>
  );
}
