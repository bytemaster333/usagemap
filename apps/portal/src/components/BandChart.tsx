// SPDX-License-Identifier: Apache-2.0
// Verified-vs-raw band chart (plan D-3): daily verified page views as a line, raw page views as a second line, and
// the band between them — the suspect page views — filled, so the gap that the trust story is about is drawn rather
// than toggled. Anomaly flags (days with trust reason codes) are markers above the plot. Hover or arrow keys show the
// day's figures (in the SVG, as the slider's value text and below the chart); a click or Enter filters the page to that
// day (Plausible-style). The flags' reasons open from the buttons the page lists under the chart.
// Hand-made SVG like LineChart: no library, CSP- and Trusted-Types-clean; a data table is the text alternative.

import { type KeyboardEvent, useState } from "react";
import { fmtDay, fmtInt, fmtShare } from "../lib/format.ts";
import { niceMax } from "./LineChart.tsx";

export interface BandPoint {
  /** midnight UTC, ISO */
  t: string;
  verified: number | null;
  raw: number | null;
}

export interface BandMarker {
  /** YYYY-MM-DD */
  day: string;
  label: string;
  explained: boolean;
}

const W = 720;
const H = 260;
const PAD = { top: 26, right: 12, bottom: 28, left: 56 };

/** The suspect share of a day: (raw − verified) / raw, null without raw page views. */
export function suspectShare(p: BandPoint): number | null {
  if (p.raw === null || p.verified === null || p.raw <= 0) return null;
  return Math.max(0, p.raw - p.verified) / p.raw;
}

export function describePoint(p: BandPoint, marker: BandMarker | null = null): string {
  const base = `${fmtDay(p.t)}: ${fmtInt(p.verified)} verified, ${fmtInt(p.raw)} raw page views (${fmtShare(
    suspectShare(p),
  )} suspect)`;
  return marker
    ? `${base}; anomaly flag${marker.explained ? ", explained" : ""}: ${marker.label}`
    : base;
}

export function BandChart({
  title,
  points,
  markers = [],
  onSelectDay,
}: {
  title: string;
  points: BandPoint[];
  markers?: BandMarker[];
  /** click-to-filter: the page narrows to this day (YYYY-MM-DD) */
  onSelectDay?: (day: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const max = niceMax(Math.max(0, ...points.flatMap((p) => [p.verified ?? 0, p.raw ?? 0])));
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(n / 7));
  const dayIndex = new Map(points.map((p, i) => [p.t.slice(0, 10), i]));

  const line = (key: "verified" | "raw") => {
    let d = "";
    let pen = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  // The band: raw forward, verified backward, over runs of days that have both values.
  const band = () => {
    let d = "";
    let run: number[] = [];
    const flush = () => {
      if (run.length > 0) {
        const top = run.map((i) => `${x(i).toFixed(1)},${y(points[i]?.raw ?? 0).toFixed(1)}`);
        const bottom = [...run]
          .reverse()
          .map((i) => `${x(i).toFixed(1)},${y(points[i]?.verified ?? 0).toFixed(1)}`);
        d += `M${top.join("L")}L${bottom.join("L")}Z`;
      }
      run = [];
    };
    points.forEach((p, i) => {
      if (p.raw === null || p.verified === null) flush();
      else run.push(i);
    });
    flush();
    return d;
  };

  const select = (i: number | null) => {
    const p = i === null ? undefined : points[i];
    if (p && onSelectDay) onSelectDay(p.t.slice(0, 10));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const cur = hover ?? (e.key === "ArrowRight" ? -1 : n);
      setHover(Math.min(n - 1, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(hover);
    } else if (e.key === "Escape") setHover(null);
  };
  const hp = hover === null ? undefined : points[hover];
  const markerOf = (p: BandPoint) => markers.find((m) => m.day === p.t.slice(0, 10)) ?? null;
  const hm = hp ? markerOf(hp) : null;
  /** The day under a pointer position (the plot scales with its box). */
  const indexAt = (el: HTMLElement, clientX: number): number | null => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || n === 0) return null;
    const vx = ((clientX - r.left) / r.width) * W;
    const i = n <= 1 ? 0 : Math.round(((vx - PAD.left) / innerW) * (n - 1));
    return Math.min(n - 1, Math.max(0, i));
  };
  const tipX =
    hover === null ? 0 : Math.min(W - PAD.right - 220, Math.max(PAD.left, x(hover) - 110));

  return (
    <figure className="chart band-chart" data-testid="band-chart">
      <figcaption>
        <h3>{title}</h3>
      </figcaption>
      <ul className="legend" aria-hidden="true">
        <li>
          <span className="swatch series-0" />
          Verified page views
        </li>
        <li>
          <span className="swatch series-1" />
          Raw page views
        </li>
        <li>
          <span className="swatch band-swatch" />
          Suspect (the gap)
        </li>
        {markers.length > 0 ? (
          <li>
            <span className="swatch marker-swatch" />
            Anomaly flag
          </li>
        ) : null}
      </ul>
      {n === 0 ? (
        <p className="muted">No data in this range.</p>
      ) : (
        // A slider over the days: arrow keys move, Enter (or a click) filters to the day; the value text reads it.
        <div
          className="band-plot"
          role="slider"
          tabIndex={0}
          aria-label={`Daily chart: choose a day${onSelectDay ? ", Enter shows only that day" : ""}`}
          aria-valuemin={0}
          aria-valuemax={n - 1}
          aria-valuenow={hover ?? 0}
          aria-valuetext={hp ? describePoint(hp, markerOf(hp)) : "no day chosen"}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          onMouseMove={(e) => setHover(indexAt(e.currentTarget, e.clientX))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => select(indexAt(e.currentTarget, e.clientX))}
          data-testid="band-plot"
        >
          <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            {ticks.map((t) => (
              <g key={t}>
                <line className="gridline" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
                <text className="axis-label" x={PAD.left - 6} y={y(t) + 4} textAnchor="end">
                  {fmtInt(t)}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <text key={p.t} className="axis-label" x={x(i)} y={H - 8} textAnchor="middle">
                  {fmtDay(p.t).replace(/ \d{4}$/, "")}
                </text>
              ) : null,
            )}
            <path className="band" d={band()} />
            <path className="line series-1" d={line("raw")} />
            <path className="line series-0" d={line("verified")} />
            {markers.map((m) => {
              const i = dayIndex.get(m.day);
              if (i === undefined) return null;
              return (
                <g
                  key={m.day}
                  className={m.explained ? "marker explained" : "marker"}
                  data-testid={`band-marker-${m.day}`}
                >
                  <line
                    className="marker-line"
                    x1={x(i)}
                    x2={x(i)}
                    y1={PAD.top - 14}
                    y2={H - PAD.bottom}
                  />
                  <path className="marker-flag" d={`M${x(i)},${PAD.top - 20}l9,4l-9,4z`} />
                </g>
              );
            })}
            {hover !== null && hp ? (
              <g className="hover" data-testid="band-hover">
                <line
                  className="hover-line"
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PAD.top}
                  y2={H - PAD.bottom}
                />
                <rect
                  className="tip"
                  x={tipX}
                  y={PAD.top}
                  width={220}
                  height={hm ? 67 : 52}
                  rx={4}
                />
                <text className="tip-text" x={tipX + 8} y={PAD.top + 16}>
                  {fmtDay(hp.t)}
                </text>
                <text className="tip-text" x={tipX + 8} y={PAD.top + 31}>
                  {`Verified ${fmtInt(hp.verified)} · raw ${fmtInt(hp.raw)}`}
                </text>
                <text className="tip-text" x={tipX + 8} y={PAD.top + 46}>
                  {`Suspect ${fmtShare(suspectShare(hp))}`}
                </text>
                {hm ? (
                  <text className="tip-text" x={tipX + 8} y={PAD.top + 61}>
                    {`Anomaly flag${hm.explained ? " (explained)" : ""}`}
                  </text>
                ) : null}
              </g>
            ) : null}
          </svg>
        </div>
      )}
      <p className="small muted" data-testid="band-readout">
        {hp
          ? describePoint(hp, hm)
          : "Hover over the chart, or focus it and use the arrow keys, to read a day."}
      </p>
      {n > 0 ? (
        <details>
          <summary>Show data table: {title}</summary>
          <table>
            <thead>
              <tr>
                <th scope="col">Day (UTC)</th>
                <th scope="col" className="num">
                  Verified
                </th>
                <th scope="col" className="num">
                  Raw
                </th>
                <th scope="col" className="num">
                  Suspect share
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.t}>
                  <th scope="row">{fmtDay(p.t)}</th>
                  <td className="num">{fmtInt(p.verified)}</td>
                  <td className="num">{fmtInt(p.raw)}</td>
                  <td className="num">{fmtShare(suspectShare(p))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </figure>
  );
}

/** A tiny inline trend line (no axes) for cards; decorative, the figure next to it carries the meaning. */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const n = values.length;
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const w = 120;
  const h = 28;
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const px = n <= 1 ? w / 2 : (i * w) / (n - 1);
    const py = h - 2 - (v / max) * (h - 4);
    d += `${pen ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
    pen = true;
  });
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <path className="line series-0" d={d} />
    </svg>
  );
}
